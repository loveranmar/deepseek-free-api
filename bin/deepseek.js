#!/usr/bin/env node
'use strict';
// DeepSeek Free API: a local OpenAI + Anthropic API on your chat.deepseek.com login,
// driven entirely from the terminal (log in, launch Claude Code, chat, inspect traffic).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../src/config');
const ds = require('../src/deepseek');
const server = require('../src/server');
const { login, PROFILE } = require('../src/login');
const { MODELS, fromOpenAI, resolveModel } = require('../src/convert');
const { run } = require('../src/engine');
const t = require('../src/tui');
const p = t.paint;
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const cfg = config.load();
ds.setReconnectHint(() => 'Log in again with: deepseek login');

const state = { port: 0, connected: false, checked: false, email: cfg.email || '', model: 'deepseek-chat', requests: [], showKey: false };
let childRunning = false;      // Claude Code owns the terminal: ignore Ctrl+C here
let currentAbort = null;       // Ctrl+C cancels the running reply / login instead of quitting
let logListener = null;

process.on('SIGINT', () => {
  if (childRunning) return;
  if (currentAbort) { currentAbort.abort(); return; }
  quit(130);
});

// ---- helpers ------------------------------------------------------------------
const MODEL_HINT = {
  'deepseek-chat': 'fast, everyday',
  'deepseek-reasoner': 'thinks before answering',
  'deepseek-chat-search': 'fast, with web search',
  'deepseek-reasoner-search': 'thinks, with web search',
};
// While something runs (a reply, a login), Ctrl+C or Esc cancels it; other keys are swallowed.
function cancelOnKeys(ac) {
  if (!t.isTTY) return () => {};
  return t.keys((k) => { if (k === '\x03' || k === '\x1b') ac.abort(); });
}
const maskKey = (k) => (k ? k.slice(0, 6) + '••••••••' + k.slice(-4) : 'none');
const base = () => `http://localhost:${state.port}`;

function quit(code = 0) {
  t.cursor.show();
  if (t.isTTY) { t.screen(null); if (code === 0) t.clear(); }
  process.exit(code);
}

function copyText(text) {
  const tools = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
    : [...(process.env.WAYLAND_DISPLAY ? [['wl-copy', []]] : []), ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b', '-i']]];
  for (const [bin, args] of tools) {
    const r = spawnSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
    if (r.status === 0) return true;
  }
  // Fall back to the terminal clipboard escape (OSC 52), which most modern terminals support.
  t.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  return true;
}

function claudeEnv() {
  return {
    ...process.env,
    FORCE_COLOR: '1',
    ANTHROPIC_BASE_URL: base(),
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
    ANTHROPIC_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-reasoner',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-reasoner',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-chat',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

// ---- server ---------------------------------------------------------------------
function onRequest(e) {
  state.requests.unshift(e);
  state.requests.length = Math.min(state.requests.length, 200);
  if (e.status === 401 && /token/i.test(e.error || '')) state.connected = false;
  if (logListener) logListener();
}

async function startServer({ quiet = true } = {}) {
  const want = Number(val('--port')) || Number(process.env.DSB_CLI_PORT) || 8788;
  for (let port = want; port < want + 20; port++) {
    const srv = server.create({ onLog: quiet ? onRequest : undefined });
    const ok = await new Promise((res) => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); });
    if (ok) { state.port = port; return port; }
  }
  throw new Error('No free port between ' + want + ' and ' + (want + 19));
}

async function checkSession() {
  const a = await ds.checkAuth();
  state.connected = a.ok; state.checked = true;
  if (a.ok) {
    const acc = await ds.account();
    if (acc && acc.email && acc.email !== state.email) { state.email = acc.email; config.update({ email: acc.email }); }
  }
  return a;
}

// ---- layout ----------------------------------------------------------------------
// Every screen: the banner on top with the signature under it, then a block `w` columns wide,
// all centred in the window. `after` is how many lines a menu or input adds below the block.
const LOVE = 'made by 𝒍𝒐𝒗𝒆';
const W = 58;          // width of the content block on most screens
const CHAT_W = 96;     // chat transcript width

function bannerArt(roomRows, drip = 0) {
  const art = t.banner({ max: t.cols() - 4, drip });
  if (art && art.length + 2 <= roomRows) return art;
  if (t.cols() >= 42 && roomRows >= 5) return t.wordmark();
  return [];
}

function frame(body = [], { w = W, after = 0, drip = 0 } = {}) {
  const cols = t.cols(), rows = t.rows();
  w = Math.min(w, cols - 4);
  const art = bannerArt(rows - body.length - after - 1, drip);
  const aw = art.length ? Math.max(...art.map(t.width)) : 0;
  const artLeft = Math.max(0, Math.floor((cols - aw) / 2));
  const head = art.length ? [...art.map(l => ' '.repeat(artLeft) + l), ' '.repeat(Math.max(0, artLeft + aw - t.width(LOVE))) + p.dim(LOVE), ''] : [];
  const top = Math.max(0, Math.floor((rows - head.length - body.length - after) / 2));
  const left = Math.max(2, Math.floor((cols - w) / 2));
  t.setLeft(left);
  const lines = [...Array(top).fill(''), ...head, ...body.map(l => ' '.repeat(left) + l)];
  t.write('\x1b[H' + lines.map(l => '\x1b[2K' + t.fit(l)).join('\n') + '\n\x1b[J');
}

// Wrapped sentence, one styled line each; `lead` (like a tag) goes in front of the first line.
const say = (text, style = p.dim, lead = '', w = W) =>
  t.wrap(text, 0, Math.min(t.cols() - 4, w) - t.width(lead)).split('\n').map((l, i) => (i ? ' '.repeat(t.width(lead)) : lead) + style(l));
const centerIn = (s, w) => ' '.repeat(Math.max(0, Math.floor((Math.min(w, t.cols() - 4) - t.width(s)) / 2))) + s;
const box = (rows, title) => t.panel(rows, { w: Math.min(W, t.cols() - 4) - 3, title });

function sessionRow() {
  if (!state.checked) return t.tag('*') + ' ' + p.dim('checking');
  if (state.connected) return t.TAG.ok() + ' ' + p.text('logged in') + (state.email ? '   ' + p.dim(state.email) : '');
  if (cfg.token) return t.TAG.bad() + ' ' + p.red('session expired');
  return t.TAG.warn() + ' ' + p.amber('not logged in');
}
function statusRows() {
  return [sessionRow(), t.TAG.info() + ' ' + p.dim('api  ') + p.text(base()), t.TAG.info() + ' ' + p.dim('key  ') + p.text(maskKey(cfg.apiKey))];
}

// ---- splash -------------------------------------------------------------------------
async function splash() {
  let blink = true, drip = 0;
  const go = () => blink ? p.blue('>> ') + p.text('press ') + p.blue(p.bold('enter')) + p.blue(' <<') : p.navy('>> ') + p.faint('press ') + p.navy(p.bold('enter')) + p.navy(' <<');
  const draw = () => { const g = go(); frame(['', g], { w: t.width(g), drip }); };
  t.cursor.hide();
  t.screen(draw);
  if (t.isTTY && !t.plain) for (let k = 1; k <= 12; k++) { drip = k / 12; draw(); await sleep(45); }
  drip = 1; draw();
  const timer = setInterval(() => { blink = !blink; draw(); }, 600);
  try {
    for (;;) {
      const k = await t.key();
      if (k === '\r' || k === '\n' || k === ' ') return true;
      if (k === '\x1b' || k === 'q') return false;
    }
  } finally { clearInterval(timer); t.screen(null); t.cursor.show(); }
}

// ---- home -------------------------------------------------------------------------
async function home() {
  let last = 0;
  for (;;) {
    const items = [
      { label: 'launch claude code', value: 'claude' },
      { label: 'chat', value: 'chat' },
      { label: state.connected ? 'switch account' : 'log in', value: 'login' },
      { label: 'connection details', value: 'details' },
      { label: 'request log', value: 'log' },
      ...(cfg.token ? [{ label: 'log out', value: 'logout' }] : []),
      { label: 'quit', value: 'quit' },
    ];
    t.screen(() => frame([...box(statusRows(), 'status'), ''], { after: items.length + 2 }));
    const initial = state.connected ? Math.min(last, items.length - 1) : items.findIndex(i => i.value === 'login');
    const v = await t.select(items, { initial, esc: 'quit', minWidth: Math.min(W, t.cols() - 4) });
    if (v === null || v === 'quit') return quit(0);
    last = items.findIndex(i => i.value === v);
    await ({ claude: launchClaude, chat, login: loginScreen, details, log: requestLog, logout })[v]();
  }
}

async function needLogin() {
  if (state.connected) return true;
  return loginScreen({ reason: cfg.token ? 'session expired, log in again' : 'log in first' });
}

// ---- login ------------------------------------------------------------------------
const DEEPSEEK = 'https://chat.deepseek.com';
// Pasted into the browser console: copies the session token to the clipboard.
const SNIPPET = 'copy(JSON.parse(localStorage.userToken).value)';
const looksLikeToken = (s) => /^[A-Za-z0-9+/_.=-]{24,4096}$/.test(s);

function openUrl(url) {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(bin, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); return true; } catch { return false; }
}

// Current clipboard text, or '' (never throws). Async so the screen stays responsive.
function readClipboard() {
  const tools = process.platform === 'darwin' ? [['pbpaste', []]]
    : process.platform === 'win32' ? []
    : [...(process.env.WAYLAND_DISPLAY ? [['wl-paste', ['--no-newline', '--type', 'text/plain']]] : []),
       ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b', '-o']]];
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= tools.length) return resolve('');
      require('child_process').execFile(tools[i][0], tools[i][1], { timeout: 1500, maxBuffer: 64 * 1024 },
        (err, out) => (err ? next(i + 1) : resolve(String(out).trim())));
    };
    next(0);
  });
}

function clearClipboard() {
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY && spawnSync('wl-copy', ['--clear'], { stdio: 'ignore', timeout: 3000 }).status === 0) return;
  copyText(' ');
}

/**
 * The guided login, one step per screen:
 *   1 log in on chat.deepseek.com in your own browser   2 open the console
 *   3 run one line that copies the token                 4 we pick it up from the clipboard and check it.
 * The clipboard is watched the whole time, so copying the token early skips straight to step 4.
 */
async function tokenGuide({ reason } = {}) {
  const TOTAL = 4;
  const mac = process.platform === 'darwin';
  const tried = new Set([SNIPPET]);
  const before = config.normalizeToken(await readClipboard());
  if (before) tried.add(before); // whatever was on the clipboard already isn't the new token

  let step = 1, note = reason ? t.TAG.warn() + ' ' + p.amber(reason) : '', opened = null;
  let found = null, stepAbort = null;
  const watch = new AbortController();
  const watcher = (async () => {
    while (!watch.signal.aborted) {
      await sleep(800);
      if (watch.signal.aborted || found) continue;
      const clip = config.normalizeToken(await readClipboard());
      if (clip && !tried.has(clip) && looksLikeToken(clip)) { found = clip; tried.add(clip); if (stepAbort) stepAbort.abort(); }
    }
  })();

  // step n of 4: progress, the step's box, a note if any, then `tail` lines (hints, or the input area)
  const stepFrame = (n, title, rows, tail, after = 0) => frame([
    p.dim(`step ${n}/${TOTAL}  `) + t.progress(n, TOTAL, 8, false), '',
    ...box(rows, title), '',
    ...(note ? [note, ''] : []),
    ...tail,
  ], { after });

  try {
    for (;;) {
      if (found) {
        const tok = found; found = null;
        if (await verifyStep(tok)) return true;
        step = 3; continue;
      }
      stepAbort = new AbortController();

      if (step === 1) {
        if (opened === null) opened = openUrl(DEEPSEEK);
        t.screen(() => stepFrame(1, 'log in', [
          p.text(opened ? 'chat.deepseek.com is open in your browser.' : 'open chat.deepseek.com in your browser.'),
          p.text('log in, then come back here.'),
        ], [t.hints(['enter', 'next'], ['o', 'reopen'], ['esc', 'cancel'])]));
        const k = await t.key({ signal: stepAbort.signal });
        note = '';
        if (k === undefined) continue;
        if (k === '\r' || k === '\n') step = 2;
        else if (k === 'o' || k === 'O') opened = openUrl(DEEPSEEK);
        else if (k === '\x1b') return false;
        continue;
      }

      if (step === 2) {
        t.screen(() => stepFrame(2, 'open the console', [
          p.text('press ') + p.blue(p.bold(mac ? 'cmd+option+i' : 'ctrl+shift+i')) + p.dim(mac ? '' : '  (or f12)'),
          p.text('click the ') + p.blue('Console') + p.text(' tab.'),
        ], [t.hints(['enter', 'next'], ['esc', 'back'])]));
        const k = await t.key({ signal: stepAbort.signal });
        note = '';
        if (k === undefined) continue;
        if (k === '\r' || k === '\n') step = 3;
        else if (k === '\x1b') step = 1;
        continue;
      }

      // step 3: the line goes on the clipboard; wait for the token (or a pasted one)
      copyText(SNIPPET);
      let frameNo = 0;
      const waitLine = () => t.tag(['|', '/', '-', '\\'][frameNo % 4]) + ' ' + p.dim('waiting for the token');
      t.screen(() => {
        stepFrame(3, 'copy the token', [
          p.blue('1') + '  ' + p.text('type ') + p.sky('allow pasting') + p.text(' and press enter'),
          p.blue('2') + '  ' + p.text('paste this and press enter') + p.dim('  (copied)'),
          '',
          '   ' + p.sky(SNIPPET),
        ], [waitLine(), '', '', t.hints(['enter', 'copy again'], ['esc', 'back'])]);
        t.write('\x1b[3A'); // up to the input line
      });
      const ticker = setInterval(() => { frameNo++; t.write('\x1b7\x1b[1A\r\x1b[2K' + t.ind() + waitLine() + '\x1b8'); }, 120);
      let typed;
      try { typed = await t.input({ label: 'or paste it', mask: true, signal: stepAbort.signal }); }
      finally { clearInterval(ticker); }
      note = '';
      if (typed === undefined) continue;          // the watcher found something
      if (typed === null) { step = 2; continue; } // esc
      const tok = config.normalizeToken(typed);
      if (!tok) { note = t.TAG.ok() + ' ' + p.text('copied again'); continue; }
      tried.add(tok);
      if (await verifyStep(tok)) return true;
    }
  } finally {
    watch.abort();
    await watcher;
    stepAbort = null;
  }

  // step 4: check the token with DeepSeek and save it
  async function verifyStep(tok) {
    t.screen(() => frame([p.dim(`step 4/${TOTAL}  `) + t.progress(4, TOTAL, 8, false), ''], { after: 1 }));
    const sp = t.spinner(p.dim('checking the token'));
    const a = await ds.checkAuth(tok);
    if (!a.ok) {
      sp.stop();
      note = t.TAG.bad() + ' ' + p.red('deepseek rejected that token');
      return false;
    }
    config.update({ token: tok });
    if ((await readClipboard()) === tok) clearClipboard(); // don't leave the token on the clipboard
    await checkSession();
    sp.stop();
    t.screen(() => frame([
      p.dim(`step 4/${TOTAL}  `) + t.progress(4, TOTAL, 8, false), '',
      ...box([t.TAG.ok() + ' ' + p.text('logged in') + (state.email ? '   ' + p.dim(state.email) : '')], 'done'), '',
      ...say('you can close the tab. don\'t log out there, that ends this session too.'), '',
      t.hints(['enter', 'continue']),
    ]));
    t.cursor.hide();
    for (;;) { const k = await t.key(); if (k === '\r' || k === '\n' || k === '\x1b' || k === ' ') break; }
    t.screen(null);
    return true;
  }
}

async function loginScreen({ reason, method } = {}) {
  if (!method || method === 'guide') return tokenGuide({ reason });
  const top = reason ? [t.TAG.warn() + ' ' + p.amber(reason), ''] : [];

  if (method === 'auto') {
    const items = [
      { label: 'email + password', value: 'password' },
      { label: 'google', value: 'google' },
      { label: 'paste a token', value: 'token' },
      { label: 'back', value: null },
    ];
    t.screen(() => frame([...top, ...say('your password goes into deepseek\'s own sign-in page and is never saved.'), ''], { after: items.length + 2 }));
    method = await t.select(items, { minWidth: Math.min(W, t.cols() - 4) });
    if (!method) return false;
  } else t.screen(() => frame(top, { after: 4 }));
  t.screen(null);
  t.write('\n');

  if (method === 'token') {
    const raw = await t.input({ label: 'token', mask: true });
    if (!raw) return false;
    const sp = t.spinner('checking the token');
    const tok = config.normalizeToken(raw);
    const a = await ds.checkAuth(tok);
    if (!a.ok) { sp.fail('deepseek rejected that token'); await t.anyKey(); return false; }
    config.update({ token: tok });
    await checkSession();
    sp.ok('logged in' + (state.email ? '   ' + p.dim(state.email) : ''));
    await sleep(900);
    return true;
  }

  let email = '', password = '';
  if (method === 'password') {
    email = (await t.input({ label: 'email', value: cfg.email || '' }) || '').trim();
    if (!email) return false;
    password = await t.input({ label: 'password', mask: true });
    if (!password) return false;
    t.write('\n');
  }

  const sp = t.spinner(method === 'google' ? 'opening google sign-in' : 'opening deepseek sign-in');
  const ac = new AbortController();
  currentAbort = ac;
  const release = cancelOnKeys(ac);
  try {
    const token = await login({
      method, email, password, signal: ac.signal,
      onStatus: (s) => sp.update(s.toLowerCase() + p.dim('   esc cancels')),
      verify: async (tk) => (await ds.checkAuth(tk)).ok,
    });
    password = '';
    config.update({ token, ...(email ? { email } : {}) });
    if (email) state.email = email;
    await checkSession();
    sp.ok('logged in' + (state.email ? '   ' + p.dim(state.email) : ''));
    await sleep(900);
    return true;
  } catch (e) {
    sp.fail(e.message === 'Cancelled' ? 'cancelled' : e.message);
    release();
    await t.anyKey();
    return false;
  } finally {
    release();
    currentAbort = null;
  }
}

async function logout() {
  const items = [{ label: 'log out', value: true, tone: p.red }, { label: 'cancel', value: false }];
  t.screen(() => frame([t.TAG.warn() + ' ' + p.text('log out of deepseek on this pc?'), ''], { after: items.length + 2 }));
  const v = await t.select(items, { initial: 1, minWidth: Math.min(W, t.cols() - 4) });
  if (!v) return;
  config.update({ token: '', cookie: '' });
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  state.connected = false; state.email = '';
  config.update({ email: '' });
}

// ---- Claude Code --------------------------------------------------------------------
async function launchClaude(extra = []) {
  if (!(await needLogin())) return 1;
  t.screen(null); t.clear();
  childRunning = true;
  const code = await new Promise((resolve) => {
    const child = spawn('claude', ['--allow-dangerously-skip-permissions', '--settings', path.join(ROOT, 'assets', 'claude-settings.json'), ...extra],
      { stdio: 'inherit', env: claudeEnv(), shell: process.platform === 'win32' });
    child.on('error', (e) => resolve(e.code === 'ENOENT' ? 'missing' : 1));
    child.on('exit', (c) => resolve(c ?? 0));
  });
  childRunning = false;
  if (code === 'missing') {
    t.screen(() => frame([t.TAG.bad() + ' ' + p.text('claude code is not installed'), p.dim('https://claude.com/claude-code')], { after: 2 }));
    await t.anyKey('any key');
    return 1;
  }
  return code;
}

// ---- chat -----------------------------------------------------------------------------
// The banner at the top, then the transcript (it scrolls, so no centring and no resize repaint).
function chatHeader() {
  t.screen(null); t.clear();
  const art = bannerArt(t.rows() - 8);
  const aw = art.length ? Math.max(...art.map(t.width)) : 0;
  const artLeft = Math.max(0, Math.floor((t.cols() - aw) / 2));
  const w = Math.min(CHAT_W, t.cols() - 4);
  t.setLeft(Math.floor((t.cols() - w) / 2));
  const lines = ['', ...art.map(l => ' '.repeat(artLeft) + l)];
  if (art.length) lines.push(' '.repeat(Math.max(0, artLeft + aw - t.width(LOVE))) + p.dim(LOVE));
  lines.push('', t.ind() + p.dim('model ') + p.blue(state.model) + '   ' + t.hints(['/model', 'switch'], ['/new', 'clear'], ['/exit', 'back']), '');
  t.write(lines.map(l => t.fit(l)).join('\n') + '\n');
}

// Streams text with a left margin and word wrap.
function streamWriter(style = (s) => s, gutter = t.ind()) {
  const max = Math.max(30, Math.min(CHAT_W, t.cols() - 6) - (t.width(gutter) - t.ind().length) - 2);
  let col = 0, word = '';
  const flushWord = () => {
    if (!word) return;
    if (col + word.length > max && col > 0) { t.write('\n' + gutter); col = 0; }
    t.write(style(word)); col += word.length; word = '';
  };
  return {
    start() { t.write(gutter); col = 0; },
    push(text) {
      for (const ch of text) {
        if (ch === '\n') { flushWord(); t.write('\n' + gutter); col = 0; }
        else if (ch === ' ' || ch === '\t') { flushWord(); if (col > 0 && col < max) { t.write(' '); col++; } }
        else word += ch;
      }
    },
    end() { flushWord(); },
  };
}

async function reply(history) {
  const ac = new AbortController();
  currentAbort = ac;
  const release = cancelOnKeys(ac);
  t.write('\n' + t.ind() + p.blue(p.bold('deepseek')) + p.dim('  ' + state.model) + '\n');
  const sp = t.spinner(p.dim('thinking'));
  let started = false, mode = null, answer = '';
  const think = streamWriter((s) => p.dim(p.italic(s)), t.ind() + p.navy('│ '));
  const text = streamWriter();
  const begin = () => { if (!started) { sp.stop(); started = true; } };
  try {
    const normalized = fromOpenAI({ model: state.model, messages: history });
    for await (const ev of run({ normalized, model: resolveModel(state.model), signal: ac.signal })) {
      if (ac.signal.aborted) throw new Error('stopped');
      if (ev.type === 'think' && ev.text) {
        begin();
        if (mode !== 'think') { mode = 'think'; think.start(); }
        think.push(ev.text);
      } else if (ev.type === 'text' && ev.text) {
        begin();
        if (mode === 'think') { think.end(); t.write('\n\n'); }
        if (mode !== 'text') { mode = 'text'; text.start(); }
        text.push(ev.text); answer += ev.text;
      }
    }
    begin(); think.end(); text.end();
    t.write('\n\n');
    return answer;
  } catch (e) {
    begin(); think.end(); text.end();
    if (ac.signal.aborted) { t.write('\n' + t.ind() + p.dim('stopped') + '\n\n'); return answer || null; }
    if (e.status === 401) state.connected = false;
    t.write('\n' + say(e.message, p.text, t.TAG.bad() + ' ', CHAT_W).join('\n') + '\n\n');
    return null;
  } finally {
    release();
    currentAbort = null;
  }
}

async function chat() {
  if (!(await needLogin())) return;
  chatHeader();
  const history = [];
  for (;;) {
    const raw = await t.input({ prefix: t.ind() + p.text(p.bold('you')) + p.blue(' > ') });
    if (raw === null) return;
    const s = raw.trim();
    if (!s) continue;
    if (['/exit', '/quit', '/q', '/back'].includes(s)) return;
    if (s === '/new' || s === '/clear') { history.length = 0; chatHeader(); continue; }
    if (s === '/model') {
      t.write('\n');
      const ids = Object.keys(MODELS);
      const m = await t.select(ids.map(id => ({ label: id, hint: MODEL_HINT[id], value: id })), { initial: ids.indexOf(state.model) });
      if (m) state.model = m;
      t.write('\n' + t.ind() + p.dim('model ') + p.blue(state.model) + '\n\n');
      continue;
    }
    history.push({ role: 'user', content: s });
    const answer = await reply(history);
    if (answer === null) history.pop();
    else history.push({ role: 'assistant', content: answer });
    if (!state.connected) {
      t.write(t.ind() + t.TAG.warn() + ' ' + p.amber('session expired') + p.dim('   any key to log in again') + '\n');
      await t.anyKey(null);
      if (!(await loginScreen())) return;
      chatHeader();
    }
  }
}

// ---- details & log --------------------------------------------------------------------
async function details() {
  let note = '';
  for (;;) {
    const key = state.showKey ? cfg.apiKey : maskKey(cfg.apiKey);
    const items = [
      { label: 'copy api key', value: 'key' },
      { label: 'copy claude code env', value: 'env' },
      { label: state.showKey ? 'hide key' : 'show key', value: 'show' },
      { label: 'new key', value: 'regen' },
      { label: 'back', value: null },
    ];
    t.screen(() => frame([
      ...box([p.dim('openai     ') + p.text(base() + '/v1'), p.dim('anthropic  ') + p.text(base()), p.dim('key        ') + p.text(key)], 'api'), '',
      ...(note ? [note, ''] : []),
    ], { after: items.length + 2 }));
    note = '';
    const v = await t.select(items, { minWidth: Math.min(W, t.cols() - 4) });
    if (!v) return;
    if (v === 'show') { state.showKey = !state.showKey; continue; }
    if (v === 'regen') { config.update({ apiKey: 'sk-ds-' + require('crypto').randomBytes(18).toString('hex') }); note = t.TAG.ok() + ' ' + p.text('new key made, the old one is dead'); continue; }
    copyText(v === 'key' ? cfg.apiKey
      : `export ANTHROPIC_BASE_URL=${base()}\nexport ANTHROPIC_AUTH_TOKEN=${cfg.apiKey}\nexport ANTHROPIC_MODEL=deepseek-chat\n`);
    note = t.TAG.ok() + ' ' + p.text('copied');
  }
}

const LOG_W = 92;
function logLines() {
  const max = Math.max(3, t.rows() - 22);
  if (!state.requests.length) return [p.dim('no requests yet')];
  const lines = [];
  for (const e of state.requests) {
    if (lines.length >= max) break;
    const time = new Date(e.time).toLocaleTimeString([], { hour12: false });
    const st = e.status < 400 ? p.sky(String(e.status)) : p.red(String(e.status));
    lines.push(`${p.dim(time)}  ${st}  ${p.text(t.pad(e.path, 22))} ${p.blue(t.pad(String(e.model), 18))} ${p.dim(String(e.ms).padStart(6) + ' ms')}${e.tokens ? p.dim('  ~' + e.tokens + ' tok') : ''}`);
    if (e.error) lines.push(' '.repeat(10) + p.red(e.error));
  }
  return lines;
}

async function requestLog() {
  const draw = () => frame([...logLines(), '', t.hints(['any key', 'back'])], { w: LOG_W });
  t.screen(draw);
  logListener = draw;
  await t.key();
  logListener = null;
}

// ---- subcommands -------------------------------------------------------------------------
function help() {
  const art = t.banner() || t.wordmark();
  const c = (cmdS, d) => '    ' + p.blue(t.pad(cmdS, 25)) + p.dim(d);
  console.log(['', ...art.map(l => '  ' + l), '  ' + p.dim(LOVE + '  ·  v' + pkg.version), '',
    c('deepseek', 'open the app'),
    c('deepseek claude [args]', 'launch claude code on deepseek'),
    c('deepseek chat', 'chat in the terminal'),
    c('deepseek login', 'log in (or --token <t>)'),
    c('deepseek logout', 'forget the session'),
    c('deepseek status', 'is the session alive?'),
    c('deepseek serve', 'api only, with a request log'),
    c('--port <n>', 'api port (default 8788)'), ''].map(l => t.isTTY ? t.fit(l) : l).join('\n'));
}

async function main() {
  if (flag('--help') || flag('-h') || cmd === 'help') return help();
  if (flag('--version') || flag('-v')) return console.log(pkg.version);

  if (cmd === 'status') {
    const sp = t.spinner('checking the session');
    const a = await checkSession();
    a.ok ? sp.ok('logged in' + (state.email ? '   ' + p.dim(state.email) : '')) : sp.fail(cfg.token ? 'session expired' : 'not logged in');
    return process.exit(a.ok ? 0 : 1);
  }
  if (cmd === 'logout') { config.update({ token: '', cookie: '', email: '' }); fs.rmSync(PROFILE, { recursive: true, force: true }); console.log('  ' + t.TAG.ok() + ' logged out'); return; }
  if (!t.isTTY && cmd !== 'serve') { help(); return process.exit(1); }

  if (cmd === 'login') {
    if (val('--token')) {
      const tok = config.normalizeToken(val('--token'));
      const a = await ds.checkAuth(tok);
      if (!a.ok) { console.error('  ' + t.TAG.bad() + ' deepseek rejected that token'); return process.exit(1); }
      config.update({ token: tok }); console.log('  ' + t.TAG.ok() + ' logged in'); return process.exit(0);
    }
    const ok = await loginScreen({ method: flag('--google') ? 'google' : flag('--browser') ? 'auto' : 'guide' });
    return quit(ok ? 0 : 1);
  }

  if (cmd === 'serve') {
    await startServer({ quiet: false });
    await checkSession();
    console.log(['', ...statusRows().map(r => '  ' + r), '', '  ' + t.hints(['ctrl+c', 'stop']), ''].join('\n'));
    return;
  }

  await startServer();
  const checking = checkSession().catch(() => {});
  if (!cmd && !(await splash())) return quit(0);
  if (!state.checked) {
    t.screen(() => frame([], { after: 1 }));
    const sp = t.spinner(p.dim('checking the session'));
    await checking;
    sp.stop();
    t.screen(null);
  }

  if (cmd === 'claude') { const code = await launchClaude(argv.slice(1)); return quit(typeof code === 'number' ? code : 0); }
  if (cmd === 'chat') { await chat(); return quit(0); }
  if (cmd) { help(); return quit(1); }
  await home();
}

main().catch((e) => { t.cursor.show(); console.error('\n  ' + t.TAG.bad() + ' ' + (e.stack || e.message)); process.exit(1); });
