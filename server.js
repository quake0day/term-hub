// term-hub broker — central pub/sub hub for terminal sessions.
// Agents (see agent.js) run on each machine, spawn a local shell PTY,
// and publish its I/O here. Browsers subscribe via /ws/subscribe to mirror
// and control sessions. No local PTY, no tmux dependency on the broker.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const os = require('os');

const PORT = Number(process.env.PORT) || 7777;
const HOST = process.env.HOST || '0.0.0.0';
const HISTORY_BYTES = Number(process.env.TERM_HUB_HISTORY) || 256 * 1024;

// sessions: name -> Session
// Session shape:
//   { name, host, cols, rows, createdAt, publisher:WS, subscribers:Set<WS>,
//     history:Buffer[], historyBytes }
const sessions = new Map();

function pushHistory(s, buf) {
  s.history.push(buf);
  s.historyBytes += buf.length;
  while (s.historyBytes > HISTORY_BYTES && s.history.length > 1) {
    s.historyBytes -= s.history[0].length;
    s.history.shift();
  }
}
function broadcast(s, data) {
  for (const sub of s.subscribers) if (sub.readyState === 1) sub.send(data);
}
function publicSession(s) {
  return {
    name: s.name, host: s.host, cols: s.cols, rows: s.rows,
    subscribers: s.subscribers.size,
    uptimeSec: Math.round((Date.now() - s.createdAt) / 1000),
  };
}

// ---- HTTP ----
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', (_, res) => res.json({
  host: os.hostname().split('.')[0],
  platform: process.platform,
  role: 'broker',
  sessions: sessions.size,
}));

app.get('/api/sessions', (_, res) => {
  res.json([...sessions.values()].map(publicSession));
});

app.post('/api/sessions/:name/kill', (req, res) => {
  const s = sessions.get(req.params.name);
  if (!s) return res.status(404).json({ error: 'no such session' });
  try { s.publisher.send(JSON.stringify({ type: 'kill' })); } catch {}
  try { s.publisher.close(4000, 'killed'); } catch {}
  res.json({ ok: true });
});

// ---- WebSocket: /ws/publish  &  /ws/subscribe ----
const server = http.createServer(app);
const pubWss = new WebSocketServer({ noServer: true });
const subWss = new WebSocketServer({ noServer: true });

// Heartbeat: every 30s ping each client; if no pong since previous tick, kill
// the socket. Keeps half-closed TCPs (sleeping laptops, NATs dropping idle
// connections) from lingering as zombie "attached" sessions.
function heartbeat(wss) {
  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  const tick = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {}; continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(tick));
}
heartbeat(pubWss);
heartbeat(subWss);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/publish') {
    pubWss.handleUpgrade(req, socket, head, ws => pubWss.emit('connection', ws, req));
  } else if (url.pathname === '/ws/subscribe') {
    subWss.handleUpgrade(req, socket, head, ws => subWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

pubWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const name = url.searchParams.get('session');
  const host = url.searchParams.get('host') || 'unknown';
  const cols = Number(url.searchParams.get('cols')) || 120;
  const rows = Number(url.searchParams.get('rows')) || 32;
  if (!name) { ws.close(4001, 'session required'); return; }
  if (sessions.has(name)) { ws.close(4002, 'session name in use'); return; }

  const s = {
    name, host, cols, rows,
    createdAt: Date.now(),
    publisher: ws, subscribers: new Set(),
    history: [], historyBytes: 0,
  };
  sessions.set(name, s);
  ws.send(JSON.stringify({ type: 'registered', session: name }));
  console.log(`[pub] + ${name}@${host} (${cols}x${rows})`);

  ws.on('message', (buf, isBinary) => {
    if (isBinary) {
      const b = Buffer.from(buf);
      pushHistory(s, b);
      broadcast(s, b);
      return;
    }
    const str = buf.toString();
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'exit') {
          broadcast(s, JSON.stringify({ type: 'exit', exitCode: msg.exitCode }));
          return;
        }
        if (msg.type === 'resize') {
          s.cols = msg.cols; s.rows = msg.rows;
          broadcast(s, str);
          return;
        }
      } catch {}
    }
    const b = Buffer.from(str);
    pushHistory(s, b);
    broadcast(s, str);
  });

  ws.on('close', () => {
    broadcast(s, JSON.stringify({ type: 'publisher-gone', session: name }));
    sessions.delete(name);
    console.log(`[pub] - ${name}@${host}`);
  });
});

subWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const name = url.searchParams.get('session');
  if (!name) { ws.close(4001, 'session required'); return; }
  const s = sessions.get(name);
  if (!s) { ws.close(4004, 'no such session'); return; }

  s.subscribers.add(ws);
  ws.send(JSON.stringify({ type: 'attached', session: name, host: s.host, cols: s.cols, rows: s.rows }));
  for (const chunk of s.history) if (ws.readyState === 1) ws.send(chunk);

  ws.on('message', (buf, isBinary) => {
    if (s.publisher.readyState !== 1) return;
    if (isBinary) { s.publisher.send(Buffer.from(buf)); return; }
    // The publishing agent is the size authority. Drop any resize coming
    // from a viewer so a small browser tab can't shrink the PTY and corrupt
    // the layout for every other viewer.
    const str = buf.toString();
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);
        if (msg && msg.type === 'resize') return;
      } catch {}
    }
    s.publisher.send(str);
  });
  ws.on('close', () => s.subscribers.delete(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`term-hub broker on http://${HOST}:${PORT}  (history=${HISTORY_BYTES}B)`);
});
