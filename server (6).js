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

// CORS first — must come before static so all responses get the header
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname)));

// ── Message store with sequence numbers ──────────────────────────────────────
// Every group message gets a global seq number. Clients poll with ?after=N
// and get everything with seq > N. No timestamp math, no gaps.
let seq = 0;
const MAX_MSGS = 300;
const store = { school: [], global: [] };

function pushMsg(channel, msg) {
  const arr = store[channel];
  if (arr.find(m => m.id === msg.id)) return null;
  msg._seq = ++seq;
  arr.push(msg);
  if (arr.length > MAX_MSGS) arr.splice(0, arr.length - MAX_MSGS);
  return msg;
}

// Per-user queue for DMs and signals (for polling clients)
const pending = new Map();
function queueForUid(uid, data) {
  if (!uid) return;
  if (!pending.has(uid)) pending.set(uid, []);
  const q = pending.get(uid);
  q.push(data);
  if (q.length > 200) q.splice(0, q.length - 200);
}

// ── WebSocket clients ─────────────────────────────────────────────────────────
const chatWss     = new WebSocket.Server({ noServer: true });
const chatClients = new Set();
const uidToWs     = new Map(); // uid → Set<ws>

function registerUid(uid, ws) {
  if (!uid) return;
  if (!uidToWs.has(uid)) uidToWs.set(uid, new Set());
  uidToWs.get(uid).add(ws);
}

function sendToUid(uid, data) {
  const sockets = uidToWs.get(uid);
  if (!sockets || sockets.size === 0) return false;
  const text = JSON.stringify(data);
  let sent = false;
  for (const c of sockets) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(text); sent = true; } catch (_) {}
    }
  }
  return sent;
}

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
  let myUid = null;

  // Send full recent history on connect
  ['school', 'global'].forEach(ch => {
    const recent = store[ch].slice(-80);
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

    // Register uid from any message that carries one
    const senderUid = data.uid || data.from;
    if (senderUid && senderUid !== myUid) {
      myUid = senderUid;
      registerUid(myUid, ws);
      // Flush any queued DMs/signals that arrived while they were offline
      const q = pending.get(myUid);
      if (q && q.length) {
        const items = q.splice(0);
        pending.delete(myUid);
        for (const m of items) { try { ws.send(JSON.stringify(m)); } catch (_) {} }
      }
    }

    if (data.type === 'msg') {
      const ch = data.channel === 'global' ? 'global' : 'school';
      const stored = pushMsg(ch, {
        id: data.id, uid: data.uid, user: data.user,
        text: data.text, ts: data.ts, type: data.type,
        ...(ch === 'global' ? { school: data.school } : { subnet: data.subnet || null })
      });
      // Broadcast with seq number so polling clients can use it
      if (stored) broadcast({ ...data, _seq: stored._seq }, ws);
      else broadcast(data, ws);
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

    if (data.type === 'dm') {
      const delivered = sendToUid(data.to, data);
      if (!delivered) queueForUid(data.to, data);
      return;
    }

    if (data.type === 'signal') {
      const delivered = sendToUid(data.to, data);
      if (!delivered) queueForUid(data.to, data);
      return;
    }

    broadcast(data, ws);
  });

  ws.on('close', () => {
    chatClients.delete(ws);
    if (myUid) {
      const s = uidToWs.get(myUid);
      if (s) { s.delete(ws); if (s.size === 0) uidToWs.delete(myUid); }
    }
  });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

// ── Gun relay (DM + call signaling fallback) ──────────────────────────────────
const Gun = require('gun');
const gunWss = new WebSocket.Server({ noServer: true });
Gun({ web: gunWss });

server.on('upgrade', (req, socket, head) => {
  const pathname = urlModule.parse(req.url).pathname;
  if (pathname === '/api/chat') {
    chatWss.handleUpgrade(req, socket, head, ws => chatWss.emit('connection', ws, req));
  } else if (pathname === '/gun') {
    gunWss.handleUpgrade(req, socket, head, ws => gunWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── POST /api/send ────────────────────────────────────────────────────────────
app.post('/api/send', (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: 'no body' });

  if (data.type === 'msg') {
    const ch = data.channel === 'global' ? 'global' : 'school';
    const stored = pushMsg(ch, {
      id: data.id, uid: data.uid, user: data.user,
      text: data.text, ts: data.ts, type: data.type,
      ...(ch === 'global' ? { school: data.school } : { subnet: data.subnet || null })
    });
    broadcast(stored ? { ...data, _seq: stored._seq } : data);
    return res.json({ ok: true, seq: stored ? stored._seq : null });
  }

  if (data.type === 'delete') {
    ['school', 'global'].forEach(ch => {
      const i = store[ch].findIndex(m => m.id === data.id);
      if (i !== -1) store[ch].splice(i, 1);
    });
    broadcast(data);
    return res.json({ ok: true });
  }

  if (data.type === 'dm') {
    const delivered = sendToUid(data.to, data);
    if (!delivered) queueForUid(data.to, data);
    return res.json({ ok: true });
  }

  if (data.type === 'signal') {
    const delivered = sendToUid(data.to, data);
    if (!delivered) queueForUid(data.to, data);
    return res.json({ ok: true });
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
// Clients send ?after=N (last seq they saw) and their uid.
// Returns all messages with _seq > N plus any queued DMs/signals.
app.get('/api/poll', (req, res) => {
  const after = parseInt(req.query.after ?? '-1', 10);
  const uid   = req.query.uid || null;

  const queued = uid && pending.has(uid) ? pending.get(uid).splice(0) : [];
  if (uid && pending.has(uid) && pending.get(uid).length === 0) pending.delete(uid);

  const schoolMsgs  = store.school.filter(m => m._seq > after);
  const globalMsgs  = store.global.filter(m => m._seq > after);
  const latestSeq   = seq; // current highest seq on server

  res.json({ school: schoolMsgs, global: globalMsgs, queued, seq: latestSeq });
});

// ── GET /api/ice — returns fresh TURN credentials ─────────────────────────────
// Uses Metered.ca free tier REST API for real working TURN servers.
// Sign up free at https://www.metered.ca/ and set METERED_API_KEY env var.
// Falls back to a list of public TURN servers if no key is set.
app.get('/api/ice', async (req, res) => {
  const apiKey = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME || 'browserchat';

  if (apiKey) {
    try {
      const url = `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
      const mod = https;
      const parsed = urlModule.parse(url);
      const data = await new Promise((resolve, reject) => {
        const r = mod.get({ hostname: parsed.hostname, path: parsed.path, timeout: 5000 }, (resp) => {
          let body = '';
          resp.on('data', c => body += c);
          resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
      });
      return res.json({ iceServers: data });
    } catch(e) {
      console.error('Metered ICE fetch failed:', e.message);
    }
  }

  // Fallback — public STUN only (no TURN = P2P only, won't work behind strict NAT)
  // Set METERED_API_KEY for full TURN support
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]
  });
});

// ── GET /api/proxy ────────────────────────────────────────────────────────────
function proxyFetch(targetUrl, callback) {
  let parsed;
  try { parsed = urlModule.parse(targetUrl); } catch(e) { return callback(e); }
  const mod = parsed.protocol === 'https:' ? https : httpModule;
  const opts = {
    hostname: parsed.hostname, port: parsed.port,
    path: parsed.path || '/', method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 12000
  };
  const req = mod.request(opts, (r) => {
    if ((r.statusCode === 301 || r.statusCode === 302) && r.headers.location) return proxyFetch(r.headers.location, callback);
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => callback(null, { headers: r.headers, body: Buffer.concat(chunks) }));
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

// ── Root / Health ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>BrowserChat Server</title>
  <style>body{font-family:sans-serif;background:#0f0f17;color:#cdd6f4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}
  h1{color:#89b4fa;font-size:1.4rem}p{color:#6a6a8a;font-size:.9rem}</style></head>
  <body><h1>✅ BrowserChat Server is running</h1><p>Open BrowserChat.html on your device to connect.</p></body></html>`);
});
app.get('/health', (req, res) => res.json({ ok: true, clients: chatClients.size, seq, uptime: Math.floor(process.uptime()) }));

// Keep-alive ping so Render free tier doesn't sleep
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    const u = urlModule.parse(RENDER_URL + '/health');
    const mod = u.protocol === 'https:' ? https : httpModule;
    mod.get({ hostname: u.hostname, path: u.path, timeout: 10000 }, () => {}).on('error', () => {});
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('BrowserChat server running on port', PORT);
  if (RENDER_URL) console.log('Public URL:', RENDER_URL);
});
