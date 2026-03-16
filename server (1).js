const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const https      = require('https');
const httpModule = require('http');
const path       = require('path');
const urlModule  = require('url');

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── CORS — allow requests from file:// and any origin ────────────────────────
// This is needed because BrowserChat.html is opened as a local file://
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── In-memory chat store ──────────────────────────────────────────────────────
const MAX_MSGS = 200;
const store = { school: [], global: [] };

function pushMsg(channel, msg) {
  const arr = store[channel];
  if (arr.find(m => m.id === msg.id)) return;
  arr.push(msg);
  if (arr.length > MAX_MSGS) arr.splice(0, arr.length - MAX_MSGS);
}

// ── Chat WebSocket (/api/chat) ────────────────────────────────────────────────
const chatWss = new WebSocket.Server({ noServer: true });
const chatClients = new Set();

function broadcast(data, exclude) {
  const text = JSON.stringify(data);
  for (const c of chatClients) {
    if (c !== exclude && c.readyState === WebSocket.OPEN) {
      try { c.send(text); } catch (_) {}
    }
  }
}

chatWss.on('connection', (ws) => {
  chatClients.add(ws);

  // Send recent history to new client
  ['school', 'global'].forEach(ch => {
    const recent = store[ch].slice(-60);
    if (recent.length) {
      try { ws.send(JSON.stringify({ type: 'history', channel: ch, messages: recent })); } catch (_) {}
    }
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
      return;
    }
    if (data.type === 'msg') {
      const ch = data.channel === 'global' ? 'global' : 'school';
      pushMsg(ch, {
        id: data.id, uid: data.uid, user: data.user,
        text: data.text, ts: data.ts, type: data.type,
        ...(ch === 'global' ? { school: data.school } : { subnet: data.subnet || null })
      });
      broadcast(data, ws);
      return;
    }
    if (data.type === 'delete') {
      ['school', 'global'].forEach(ch => {
        const i = store[ch].findIndex(m => m.id === data.id);
        if (i !== -1) store[ch].splice(i, 1);
      });
      broadcast(data, ws);
      return;
    }
    // Everything else (voice/video signaling, etc.) — relay to all
    broadcast(data, ws);
  });

  ws.on('close', () => chatClients.delete(ws));
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

// ── Gun relay WebSocket (/gun) ────────────────────────────────────────────────
// Gun.js uses this for DM delivery and voice/video call signaling
const Gun = require('gun');
const gunWss = new WebSocket.Server({ noServer: true });

// Attach Gun to the express app — Gun handles its own WS upgrade
const gunServer = Gun({ web: gunWss });

// ── HTTP upgrade routing ──────────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const pathname = urlModule.parse(req.url).pathname;
  if (pathname === '/api/chat') {
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      chatWss.emit('connection', ws, req);
    });
  } else if (pathname === '/gun') {
    gunWss.handleUpgrade(req, socket, head, (ws) => {
      gunWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── POST /api/send — HTTP polling fallback ────────────────────────────────────
app.post('/api/send', (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: 'no body' });
  if (data.type === 'msg') {
    const ch = data.channel === 'global' ? 'global' : 'school';
    pushMsg(ch, {
      id: data.id, uid: data.uid, user: data.user,
      text: data.text, ts: data.ts, type: data.type,
      ...(ch === 'global' ? { school: data.school } : { subnet: data.subnet || null })
    });
  }
  broadcast(data);
  res.json({ ok: true });
});

// ── POST /api/delete ──────────────────────────────────────────────────────────
app.post('/api/delete', (req, res) => {
  const data = req.body;
  if (data && data.id) {
    ['school', 'global'].forEach(ch => {
      const i = store[ch].findIndex(m => m.id === data.id);
      if (i !== -1) store[ch].splice(i, 1);
    });
    broadcast({ type: 'delete', id: data.id });
  }
  res.json({ ok: true });
});

// ── GET /api/poll ─────────────────────────────────────────────────────────────
app.get('/api/poll', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  res.json({
    school:  store.school.filter(m => m.ts > since),
    global:  store.global.filter(m => m.ts > since),
    deleted: []
  });
});

// ── GET /api/proxy ────────────────────────────────────────────────────────────
function proxyFetch(targetUrl, callback) {
  let parsed;
  try { parsed = urlModule.parse(targetUrl); } catch(e) { return callback(e); }
  const mod = parsed.protocol === 'https:' ? https : httpModule;
  const opts = {
    hostname: parsed.hostname,
    port:     parsed.port,
    path:     parsed.path || '/',
    method:   'GET',
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 12000
  };
  const req = mod.request(opts, (res) => {
    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
      return proxyFetch(res.headers.location, callback);
    }
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => callback(null, { statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('timeout', () => { req.destroy(); callback(new Error('timeout')); });
  req.on('error', callback);
  req.end();
}

app.get('/api/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url');
  proxyFetch(target, (err, result) => {
    if (err) return res.status(500).send('Proxy error: ' + err.message);
    res.setHeader('content-type', result.headers['content-type'] || 'text/html');
    res.send(result.body);
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, clients: chatClients.size, uptime: Math.floor(process.uptime()) });
});

// ── Keep-alive ping (Render free tier sleeps after 15 min inactivity) ─────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    const u = urlModule.parse(RENDER_URL + '/health');
    const mod = u.protocol === 'https:' ? https : httpModule;
    mod.get({ hostname: u.hostname, path: u.path, timeout: 10000 }, () => {}).on('error', () => {});
  }, 14 * 60 * 1000);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('BrowserChat server running on port', PORT);
  if (RENDER_URL) console.log('Public URL:', RENDER_URL);
});
