const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { execSync } = require('child_process');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_WIN = process.platform === 'win32';
const SHELL = process.env.SHELL || (IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : '/bin/bash');
const HISTORY_BYTES = Number(process.env.TERM_HUB_HISTORY) || 256 * 1024;
const HOSTS_FILE = process.env.TERM_HUB_HOSTS || path.join(__dirname, 'hosts.json');

function resolveTmux() {
  if (IS_WIN) return null;
  if (process.env.TMUX_BIN) return process.env.TMUX_BIN;
  const candidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
  for (const p of candidates) {
    try { execSync(`${p} -V`, { stdio: 'ignore' }); return p; } catch {}
  }
  try { return execSync('command -v tmux', { shell: '/bin/sh', encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}
const TMUX = resolveTmux();
const FANOUT = !TMUX || process.env.TERM_HUB_NO_TMUX === '1';

// ---- fan-out session registry (used when no tmux) --------------------------
const sessions = new Map(); // name -> Session

function defaultShellArgs() {
  if (IS_WIN) return { cmd: 'powershell.exe', args: [] };
  return { cmd: SHELL, args: ['-l'] };
}

function makeSession(name, cols, rows) {
  const { cmd, args } = defaultShellArgs();
  const p = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.env.HOME || process.env.USERPROFILE || '/',
    env: process.env,
  });
  const s = {
    name, pty: p, subs: new Set(),
    history: [], historyBytes: 0,
    cols, rows,
    createdAt: Date.now(),
    exited: false, exitCode: null,
  };
  p.onData(chunk => {
    const buf = Buffer.from(chunk);
    s.history.push(buf); s.historyBytes += buf.length;
    while (s.historyBytes > HISTORY_BYTES && s.history.length > 1) {
      s.historyBytes -= s.history[0].length;
      s.history.shift();
    }
    for (const ws of s.subs) if (ws.readyState === 1) ws.send(chunk);
  });
  p.onExit(({ exitCode }) => {
    s.exited = true; s.exitCode = exitCode;
    for (const ws of s.subs) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    sessions.delete(name);
  });
  sessions.set(name, s);
  return s;
}

function listFanoutSessions() {
  return [...sessions.values()].map(s => ({
    name: s.name, windows: 1, attached: s.subs.size > 0, subs: s.subs.size,
    uptimeSec: Math.round((Date.now() - s.createdAt) / 1000),
  }));
}

// ---- tmux helpers ----------------------------------------------------------
function listTmuxSessions() {
  if (!TMUX) return [];
  try {
    const out = execSync(`${TMUX} list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}'`, { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, attached] = line.split('\t');
      return { name, windows: Number(windows), attached: attached !== '0' };
    });
  } catch { return []; }
}

// ---- host list -------------------------------------------------------------
function readHosts() {
  try {
    const raw = fs.readFileSync(HOSTS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch {}
  // Default: only self (relative URL — browser uses same origin)
  return [{ name: os.hostname().split('.')[0], url: '' }];
}

// ---- HTTP ------------------------------------------------------------------
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

app.get('/api/info', (_req, res) => {
  res.json({
    host: os.hostname().split('.')[0],
    fqdn: os.hostname(),
    platform: process.platform,
    hasTmux: !!TMUX && !FANOUT,
    mode: FANOUT ? 'fanout' : 'tmux',
    shell: SHELL,
  });
});

app.get('/api/hosts', (_req, res) => res.json(readHosts()));

app.get('/api/sessions', (_req, res) => {
  res.json(FANOUT ? listFanoutSessions() : listTmuxSessions());
});

app.post('/api/sessions/:name/kill', (req, res) => {
  const name = req.params.name;
  if (FANOUT) {
    const s = sessions.get(name);
    if (!s) return res.status(404).json({ error: 'no such session' });
    try { s.pty.kill(); } catch {}
    sessions.delete(name);
    return res.json({ ok: true });
  }
  try { execSync(`${TMUX} kill-session -t ${JSON.stringify(name)}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- WebSocket -------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const sessionName = url.searchParams.get('session') || `sess-${Date.now()}`;
  const cols = Number(url.searchParams.get('cols')) || 120;
  const rows = Number(url.searchParams.get('rows')) || 32;
  const hostName = os.hostname().split('.')[0];

  if (FANOUT) {
    const s = sessions.get(sessionName) || makeSession(sessionName, cols, rows);
    s.subs.add(ws);
    try { s.pty.resize(cols, rows); s.cols = cols; s.rows = rows; } catch {}
    ws.send(JSON.stringify({ type: 'ready', session: sessionName, host: hostName, pid: s.pty.pid, mode: 'fanout', subs: s.subs.size }));
    // Replay history so new client sees recent output
    for (const chunk of s.history) if (ws.readyState === 1) ws.send(chunk);

    ws.on('message', (buf, isBinary) => {
      if (isBinary) { try { s.pty.write(buf); } catch {} return; }
      const str = buf.toString();
      if (str.startsWith('{')) {
        try {
          const msg = JSON.parse(str);
          if (msg.type === 'resize') { try { s.pty.resize(msg.cols, msg.rows); s.cols = msg.cols; s.rows = msg.rows; } catch {} return; }
          if (msg.type === 'input') { try { s.pty.write(msg.data); } catch {} return; }
        } catch {}
      }
      try { s.pty.write(str); } catch {}
    });
    ws.on('close', () => { s.subs.delete(ws); });
    return;
  }

  // tmux-backed session: spawn a fresh tmux client per WS
  const term = pty.spawn(TMUX, ['new-session', '-A', '-s', sessionName], {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.env.HOME,
    env: process.env,
  });

  ws.send(JSON.stringify({ type: 'ready', session: sessionName, host: hostName, pid: term.pid, mode: 'tmux' }));
  term.onData(d => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(({ exitCode }) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    ws.close();
  });

  ws.on('message', (buf, isBinary) => {
    if (isBinary) { term.write(buf); return; }
    const str = buf.toString();
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'resize') { term.resize(msg.cols, msg.rows); return; }
        if (msg.type === 'input') { term.write(msg.data); return; }
      } catch {}
    }
    term.write(str);
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
});

server.listen(PORT, HOST, () => {
  console.log(`term-hub listening on http://${HOST}:${PORT}  [mode=${FANOUT ? 'fanout' : 'tmux'}${TMUX ? ' ('+TMUX+')' : ''}]`);
});
