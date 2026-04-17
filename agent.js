#!/usr/bin/env node
// term-hub agent — runs on each client machine (Mac / Linux / Windows).
// Spawns a local shell PTY and streams its I/O:
//   - to the local TTY (user sees and types normally)
//   - to a central term-hub broker via WebSocket (browser viewers mirror it)
// If the hub is unreachable at startup, the local shell still runs.
// The agent retries the WS connection every 3s until the broker comes back.
//
// Usage:   node agent.js [hubURL] [session]
//          env TERM_HUB_URL, TERM_HUB_SESSION, TERM_HUB_PREFIX
//
// Detach:  Ctrl-]  then  q     (session keeps living locally in tmux if used)

const WebSocket = require('ws');
const pty = require('node-pty');
const os = require('os');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const HUB = (process.argv[2] || process.env.TERM_HUB_URL || 'http://localhost:7777').replace(/\/$/, '');
const PREFIX = process.env.TERM_HUB_PREFIX || os.hostname().split('.')[0].toLowerCase();
const IS_WIN = process.platform === 'win32';
const SHELL = process.env.SHELL || (IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : '/bin/bash');
const BUFFER_LIMIT = Number(process.env.TERM_HUB_AGENT_BUFFER) || 256 * 1024;

function hasTmux() {
  if (IS_WIN || process.env.TERM_HUB_NO_TMUX === '1') return null;
  try {
    const out = execSync('command -v tmux', { shell: '/bin/sh', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch { return null; }
}
const TMUX = hasTmux();

function jget(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 3000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

async function pickSessionName() {
  const explicit = process.argv[3] || process.env.TERM_HUB_SESSION;
  if (explicit) return explicit;
  // First preference: local tmux — pick next free session there so
  // orphaned local tmux sessions get reused on next open.
  if (TMUX) {
    let n = 1;
    while (true) {
      try { execSync(`${TMUX} has-session -t ${JSON.stringify(`${PREFIX}-${n}`)} 2>/dev/null`); n++; }
      catch { return `${PREFIX}-${n}`; }
    }
  }
  // Else: ask hub (best-effort; if hub down, just timestamp)
  try {
    const list = await jget(HUB + '/api/sessions');
    const taken = new Set(list.map(s => s.name));
    let n = 1;
    while (taken.has(`${PREFIX}-${n}`)) n++;
    return `${PREFIX}-${n}`;
  } catch {
    return `${PREFIX}-${Date.now().toString(36).slice(-4)}`;
  }
}

async function main() {
  const session = await pickSessionName();
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;

  // 1) Spawn local shell PTY. Use tmux (if available) to persist the shell
  //    across agent restarts (closing the Terminal window leaves tmux alive).
  let cmd, args;
  if (TMUX) { cmd = TMUX; args = ['new-session', '-A', '-s', session]; }
  else if (IS_WIN) { cmd = 'powershell.exe'; args = []; }
  else { cmd = SHELL; args = ['-l']; }

  const term = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.env.HOME || process.env.USERPROFILE || '/',
    env: process.env,
  });

  // 2) Local TTY raw mode (so keystrokes aren't line-buffered).
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stderr.write(
    `\x1b[2m[term-hub] session=${session}  hub=${HUB}  ${TMUX ? 'tmux' : 'direct'}  — Ctrl-] q to detach\x1b[0m\r\n`
  );

  // 3) Detach sequence: Ctrl-] then 'q' — closes agent, PTY (and tmux if used).
  let escape = false;
  const ESC = 0x1d, Q = 0x71;
  process.stdin.on('data', buf => {
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (escape) {
        if (b === Q) { cleanup(0); return; }
        escape = false;
        try { term.write(Buffer.from([ESC, b])); } catch {}
      } else if (b === ESC) {
        escape = true;
      } else {
        try { term.write(Buffer.from([b])); } catch {}
      }
    }
  });

  // 4) PTY output → local stdout + hub WS (buffered if not connected).
  let ws = null;
  const preBuf = []; let preBytes = 0;
  function enqueue(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    preBuf.push(b); preBytes += b.length;
    while (preBytes > BUFFER_LIMIT && preBuf.length > 1) {
      preBytes -= preBuf[0].length;
      preBuf.shift();
    }
  }
  term.onData(data => {
    process.stdout.write(data);
    if (ws && ws.readyState === 1) {
      try { ws.send(data); } catch {}
    } else {
      enqueue(data);
    }
  });
  term.onExit(({ exitCode }) => {
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', exitCode })); } catch {}
    cleanup(exitCode || 0);
  });

  // 5) Local resize → PTY + hub.
  process.stdout.on('resize', () => {
    const c = process.stdout.columns || 120, r = process.stdout.rows || 32;
    try { term.resize(c, r); } catch {}
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r })); } catch {}
    }
  });

  // 6) Hub connection with retry loop.
  const wsUrl = HUB.replace(/^http/, 'ws') +
    `/ws/publish?session=${encodeURIComponent(session)}&host=${encodeURIComponent(PREFIX)}` +
    `&cols=${process.stdout.columns || cols}&rows=${process.stdout.rows || rows}`;

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => {
      process.stderr.write(`\x1b[2m[term-hub] connected\x1b[0m\r\n`);
      // Flush buffered output so viewers see recent state.
      for (const b of preBuf) { try { ws.send(b); } catch {} }
      preBuf.length = 0; preBytes = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { try { term.write(Buffer.from(data)); } catch {} return; }
      const str = data.toString();
      if (str.startsWith('{')) {
        try {
          const msg = JSON.parse(str);
          if (msg.type === 'resize') { try { term.resize(msg.cols, msg.rows); } catch {} return; }
          if (msg.type === 'kill')   { cleanup(0); return; }
          if (msg.type === 'registered') return;
        } catch {}
      }
      try { term.write(str); } catch {}
    });
    ws.on('close', (code) => {
      if (code === 4002) {
        process.stderr.write(`\x1b[31m[term-hub] session name '${session}' already in use on hub\x1b[0m\r\n`);
      }
      setTimeout(connect, 3000);
    });
    ws.on('error', () => { /* onclose handles reconnect */ });
  }
  connect();

  function cleanup(code) {
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    try { if (ws) ws.close(); } catch {}
    try { term.kill(); } catch {}
    process.stderr.write(`\r\n\x1b[2m[term-hub] detached (${code})\x1b[0m\r\n`);
    process.exit(code);
  }
  process.on('SIGINT', () => { try { term.write(Buffer.from([0x03])); } catch {} });
  process.on('SIGTERM', () => cleanup(0));
}

main().catch(e => { console.error(e); process.exit(1); });
