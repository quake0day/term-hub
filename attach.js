#!/usr/bin/env node
// term-hub attach client — proxies the current terminal to a hub session.
// Usage: node attach.js [hubURL] [session]
//        Env:  TERM_HUB_URL, TERM_HUB_SESSION, TERM_HUB_PREFIX
//
// Windows Terminal profile example (set as default):
//   "commandline": "node.exe C:\\term-hub\\attach.js http://<hub-host>:7777"
// Each new tab/window auto-picks the next "<hostname>-N" session on the hub.

const WebSocket = require('ws');
const os = require('os');
const http = require('http');
const https = require('https');

const argv = process.argv.slice(2);
const HUB_URL = (argv[0] || process.env.TERM_HUB_URL || 'http://localhost:7777').replace(/\/$/, '');
const EXPLICIT_SESSION = argv[1] || process.env.TERM_HUB_SESSION || null;
const PREFIX = process.env.TERM_HUB_PREFIX || os.hostname().split('.')[0].toLowerCase();

function jget(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    mod.get(url, { timeout: 4000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function pickSession() {
  if (EXPLICIT_SESSION) return EXPLICIT_SESSION;
  try {
    const list = await jget(HUB_URL + '/api/sessions');
    const taken = new Set(list.map(s => s.name));
    let n = 1;
    while (taken.has(`${PREFIX}-${n}`)) n++;
    return `${PREFIX}-${n}`;
  } catch {
    return `${PREFIX}-${Date.now().toString(36).slice(-4)}`;
  }
}

(async () => {
  const session = await pickSession();
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const wsUrl = HUB_URL.replace(/^http/, 'ws') + `/ws?session=${encodeURIComponent(session)}&cols=${cols}&rows=${rows}`;

  const stderr = process.stderr;
  stderr.write(`[term-hub] ${HUB_URL} :: ${session}  (${cols}x${rows})  — prefix Ctrl-] then q to quit\n`);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  const send = (data) => { if (ws.readyState === 1) ws.send(data); };
  const stdin = process.stdin;
  const stdout = process.stdout;

  // detach sequence: Ctrl-] q
  let escapePending = false;
  const ESCAPE_CHAR = 0x1d; // Ctrl-]
  const QUIT_CHAR = 0x71;   // 'q'

  function setRaw(on) {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(on);
  }

  ws.on('open', () => {
    setRaw(true);
    stdin.resume();
  });

  ws.on('message', (data, isBin) => {
    if (!isBin && typeof data !== 'string') {
      // buffer arriving as Buffer when isBin true depending on ws version
      const s = data.toString();
      if (s.startsWith('{')) {
        try {
          const msg = JSON.parse(s);
          if (msg.type === 'ready') return;
          if (msg.type === 'exit') { stderr.write(`\n[term-hub] session exited (${msg.exitCode})\n`); cleanup(0); return; }
        } catch {}
      }
      stdout.write(s);
      return;
    }
    // binary buffer
    stdout.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });

  ws.on('close', () => { stderr.write('\n[term-hub] connection closed\n'); cleanup(0); });
  ws.on('error', (e) => { stderr.write(`\n[term-hub] ws error: ${e.message}\n`); cleanup(1); });

  stdin.on('data', (buf) => {
    // scan for detach sequence
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (escapePending) {
        if (b === QUIT_CHAR) { stderr.write('\n[term-hub] detach\n'); cleanup(0); return; }
        escapePending = false;
        // send the held Ctrl-] then current byte
        send(Buffer.from([ESCAPE_CHAR, b]));
        continue;
      }
      if (b === ESCAPE_CHAR) { escapePending = true; continue; }
      // fast path: single byte
      send(Buffer.from([b]));
    }
  });

  stdout.on('resize', () => {
    const c = stdout.columns || 120, r = stdout.rows || 32;
    send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
  });

  function cleanup(code) {
    try { setRaw(false); } catch {}
    try { ws.close(); } catch {}
    process.exit(code);
  }

  process.on('SIGINT', () => { /* forward ^C to remote instead of exiting */ send(Buffer.from([0x03])); });
  process.on('SIGTERM', () => cleanup(0));
})();
