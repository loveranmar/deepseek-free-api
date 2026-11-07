#!/usr/bin/env node
'use strict';
// DeepSeek Bridge, terminal edition: the same local API as the dashboard version,
// driven entirely from the command line (log in, launch Claude Code, chat, inspect traffic).
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
const indent = (lines) => lines.map(l => '  ' + l).join('\n') + '\n';

function quit(code = 0) {
  t.cursor.show();
  if (code === 0 && t.isTTY) t.write('\n  ' + p.dim('Bridge stopped. See you.') + '\n\n');
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
    const srv = server.create({ dashboard: false, onLog: quiet ? onRequest : undefined });
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

// ---- screens ----------------------------------------------------------------------
function header(sub) {
  t.clear();
  t.write('\n' + indent(t.wordmark()));
  t.write('  ' + p.dim('bridge  ·  v' + pkg.version) + (sub ? p.dim('  ·  ') + sub : '') + '\n\n');
}

function statusRows() {
  const st = !state.checked ? p.dim('○ Checking') :
    state.connected ? p.ok('●') + ' ' + p.bold('Connected') + (state.email ? p.dim('  ' + state.email) : '') :
    cfg.token ? p.bad('●') + ' ' + p.bold('Session expired') + p.dim('  log in again to continue') :
    p.warn('●') + ' ' + p.bold('Not logged in');
  return [st, p.dim('API  ') + base() + p.dim('    key  ') + maskKey(cfg.apiKey)];
}

async function home() {
  let last = 0;
  for (;;) {
    header();
    t.write(indent(t.panel(statusRows(), { w: 60 })) + '\n');
    const items = [
      { label: 'Launch Claude Code', hint: 'claude, running on DeepSeek', value: 'claude' },
      { label: 'Chat', hint: 'talk to DeepSeek right here', value: 'chat' },
      { label: state.connected ? 'Switch account' : 'Log in', hint: 'guided, about a minute', value: 'login' },
      { label: 'Connection details', hint: 'base URLs and API key', value: 'details' },
      { label: 'Request log', hint: state.requests.length ? `${state.requests.length} this session` : 'live traffic through the bridge', value: 'log' },
      ...(cfg.token ? [{ label: 'Log out', hint: 'forget this account on this PC', value: 'logout' }] : []),
      { label: 'Quit', value: 'quit' },
    ];
    const initial = state.connected ? Math.min(last, items.length - 1) : items.findIndex(i => i.value === 'login');
    const v = await t.select(items, { initial, esc: 'quit' });
    if (v === null || v === 'quit') return quit(0);
    last = items.findIndex(i => i.value === v);
    await ({ claude: launchClaude, chat, login: loginScreen, details, log: requestLog, logout })[v]();
  }
}

async function needLogin() {
  if (state.connected) return true;
  return loginScreen({ reason: cfg.token ? 'Your DeepSeek session has expired.' : 'Log in to DeepSeek first.' });
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

// The guided way in: log in on chat.deepseek.com in your own browser, run one line in its console,
// and this screen picks the token up from the clipboard (or you paste it).
async function tokenGuide({ reason } = {}) {
  header(p.bold('Log in'));
  if (reason) t.write('  ' + p.warn(reason) + '\n\n');

  const opened = openUrl(DEEPSEEK);
  copyText(SNIPPET);
  const devtools = process.platform === 'darwin' ? 'Cmd+Option+J' : 'F12';
  const n = (i) => p.brand(p.bold(String(i)));
  t.write(indent(t.panel([
    n(1) + '  ' + p.bold('Log in on chat.deepseek.com'),
    '   ' + p.dim(opened ? 'It just opened in your browser. Captcha and all, as usual.' : 'Open ' + DEEPSEEK + ' in your browser.'),
    '',
    n(2) + '  ' + p.bold(`Press ${devtools}`) + ' and click the ' + p.bold('Console') + ' tab',
    '   ' + p.dim('Do this on the DeepSeek tab, once you can see the chat.'),
    '',
    n(3) + '  ' + p.bold('Paste and press Enter') + p.dim('   (already on your clipboard)'),
    '   ' + p.sky(SNIPPET),
    '   ' + p.dim('Blocked? Type ') + 'allow pasting' + p.dim(', press Enter, then paste again.'),
    '',
    n(4) + '  ' + p.bold('Done.') + ' This window notices the token by itself.',
  ], { w: 64, title: p.dim('4 steps · about a minute') })));
  t.write('\n  ' + p.dim('Or paste the token below yourself.  esc goes back') + '\n\n');

  const tried = new Set([SNIPPET]);
  const initial = await readClipboard();
  if (initial) tried.add(initial); // whatever was there before isn't the new token

  let msg = '';
  for (;;) {
    t.write('\r\x1b[2K  ' + (msg || p.dim('◌ Watching the clipboard for your token')) + '\n');
    msg = '';
    const ac = new AbortController();
    let found = null;
    const watcher = (async () => {
      while (!ac.signal.aborted) {
        await sleep(800);
        if (ac.signal.aborted) return;
        const clip = config.normalizeToken(await readClipboard());
        if (clip && !tried.has(clip) && looksLikeToken(clip)) { found = clip; ac.abort(); return; }
      }
    })();
    const typed = await t.input({ label: 'Token', mask: true, placeholder: 'paste here, or just wait', signal: ac.signal });
    ac.abort(); await watcher;
    if (typed === null) return false;
    const tok = found || config.normalizeToken(typed);
    if (!tok) { t.write('\x1b[2A'); continue; }
    tried.add(tok);

    t.write((found ? '\x1b[1A' : '\x1b[2A\r\x1b[2K\x1b[1B\r\x1b[2K\x1b[1A') + '\r\x1b[2K');
    const sp = t.spinner(found ? 'Found a token on the clipboard, checking it with DeepSeek' : 'Checking the token with DeepSeek');
    const a = await ds.checkAuth(tok);
    if (!a.ok) {
      sp.stop();
      msg = p.bad('✗') + ' ' + (found ? 'That clipboard text isn\'t a working token.' : 'DeepSeek didn\'t accept that token.') + p.dim(' Still watching, try step 3 again.');
      continue;
    }
    config.update({ token: tok });
    if (found && (await readClipboard()) === tok) clearClipboard(); // don't leave the token lying on the clipboard
    await checkSession();
    sp.ok('Logged in' + (state.email ? ' as ' + p.bold(state.email) : ''));
    t.write('\n  ' + p.dim('You can close the browser tab. Logging out on the website ends this session too.') + '\n');
    await sleep(1800);
    return true;
  }
}

async function loginScreen({ reason, method } = {}) {
  if (!method || method === 'guide') return tokenGuide({ reason });
  header(p.bold('Log in'));
  if (reason) t.write('  ' + p.warn(reason) + '\n\n');
  if (method === 'auto') {
    t.write('  ' + p.dim('Your password goes straight into DeepSeek\'s own sign-in page. It is never saved.') + '\n\n');
    method = await t.select([
      { label: 'Email and password', hint: 'type them here, the rest is automatic', value: 'password' },
      { label: 'Continue with Google', hint: 'sign in once in a browser window', value: 'google' },
      { label: 'Paste a token', hint: 'from a logged-in chat.deepseek.com tab', value: 'token' },
      { label: 'Back', value: null },
    ]);
    if (!method) return false;
    t.write('\n');
  }

  if (method === 'token') {
    const raw = await t.input({ label: 'Token', mask: true, placeholder: 'paste here' });
    if (!raw) return false;
    const sp = t.spinner('Checking the token with DeepSeek');
    const tok = config.normalizeToken(raw);
    const a = await ds.checkAuth(tok);
    if (!a.ok) { sp.fail('DeepSeek rejected that token. ' + p.dim(a.reason || '')); await t.anyKey(); return false; }
    config.update({ token: tok });
    await checkSession();
    sp.ok('Logged in' + (state.email ? ' as ' + p.bold(state.email) : ''));
    await sleep(900);
    return true;
  }

  let email = '', password = '';
  if (method === 'password') {
    email = (await t.input({ label: 'Email', value: cfg.email || '', placeholder: 'you@example.com' }) || '').trim();
    if (!email) return false;
    password = await t.input({ label: 'Password', mask: true });
    if (!password) return false;
    t.write('\n');
  }

  const sp = t.spinner(method === 'google' ? 'Opening Google sign-in' : 'Opening DeepSeek sign-in');
  const ac = new AbortController();
  currentAbort = ac;
  const release = cancelOnKeys(ac);
  try {
    const token = await login({
      method, email, password, signal: ac.signal,
      onStatus: (s) => sp.update(s + p.dim('   esc cancels')),
      verify: async (tk) => (await ds.checkAuth(tk)).ok,
    });
    password = '';
    config.update({ token, ...(email ? { email } : {}) });
    if (email) state.email = email;
    await checkSession();
    sp.ok('Logged in' + (state.email ? ' as ' + p.bold(state.email) : ''));
    await sleep(900);
    return true;
  } catch (e) {
    sp.fail(e.message === 'Cancelled' ? 'Cancelled' : e.message);
    release();
    await t.anyKey();
    return false;
  } finally {
    release();
    currentAbort = null;
  }
}

async function logout() {
  header(p.bold('Log out'));
  t.write('  Forget the DeepSeek session on this PC? The browser profile used for sign-in is cleared too.\n\n');
  const v = await t.select([{ label: 'Log out', value: true, tone: p.bad }, { label: 'Cancel', value: false }], { initial: 1 });
  if (!v) return;
  config.update({ token: '', cookie: '' });
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  state.connected = false; state.email = '';
  config.update({ email: '' });
}

// ---- Claude Code --------------------------------------------------------------------
async function launchClaude(extra = []) {
  if (!(await needLogin())) return 1;
  t.clear();
  t.write('\n  ' + p.brand('◆') + ' ' + p.bold('Claude Code') + p.dim(` on DeepSeek  ·  bridge on :${state.port}  ·  /model to switch models`) + '\n\n');
  childRunning = true;
  const code = await new Promise((resolve) => {
    const child = spawn('claude', ['--allow-dangerously-skip-permissions', '--settings', path.join(ROOT, 'assets', 'claude-settings.json'), ...extra],
      { stdio: 'inherit', env: claudeEnv(), shell: process.platform === 'win32' });
    child.on('error', (e) => resolve(e.code === 'ENOENT' ? 'missing' : 1));
    child.on('exit', (c) => resolve(c ?? 0));
  });
  childRunning = false;
  if (code === 'missing') {
    t.write('  ' + p.bad('✗') + ' Claude Code is not installed. Get it from ' + p.under('https://claude.com/claude-code') + '\n');
    await t.anyKey();
    return 1;
  }
  return code;
}

// ---- chat -----------------------------------------------------------------------------
function chatHeader() {
  header(p.bold('Chat'));
  t.write('  ' + p.dim('model ') + p.brand(state.model) + p.dim('   /model switch   /new fresh chat   /exit back   esc stops a reply') + '\n\n');
}

// Streams text with a left margin and word wrap.
function streamWriter(style = (s) => s, gutter = '  ') {
  const max = Math.max(30, Math.min(100, t.cols() - 6));
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
  t.write('\n  ' + gradient('deepseek') + p.dim('  ' + state.model) + '\n');
  const sp = t.spinner(p.dim('thinking'));
  let started = false, mode = null, answer = '';
  const think = streamWriter((s) => p.dim(p.italic(s)), '  ' + p.dim('│ '));
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
    if (ac.signal.aborted) { t.write('\n  ' + p.dim('stopped') + '\n\n'); return answer || null; }
    if (e.status === 401) state.connected = false;
    t.write('\n  ' + p.bad('✗ ') + e.message + '\n\n');
    return null;
  } finally {
    release();
    currentAbort = null;
  }
}
const gradient = (s) => t.gradient(s);

async function chat() {
  if (!(await needLogin())) return;
  chatHeader();
  const history = [];
  for (;;) {
    const raw = await t.input({ prefix: '  ' + p.brand('›') + ' ', placeholder: 'Message DeepSeek' });
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
      t.write('\n  ' + p.dim('model ') + p.brand(state.model) + '\n\n');
      continue;
    }
    history.push({ role: 'user', content: s });
    const answer = await reply(history);
    if (answer === null) history.pop();
    else history.push({ role: 'assistant', content: answer });
    if (!state.connected) {
      t.write('  ' + p.warn('Your DeepSeek session has expired.') + p.dim(' Press any key to log in again.') + '\n');
      await t.anyKey(null);
      if (!(await loginScreen())) return;
      chatHeader();
    }
  }
}

// ---- details & log --------------------------------------------------------------------
async function details() {
  for (;;) {
    header(p.bold('Connection details'));
    const key = state.showKey ? cfg.apiKey : maskKey(cfg.apiKey);
    t.write(indent(t.panel([
      p.dim('OpenAI     ') + base() + '/v1',
      p.dim('Anthropic  ') + base(),
      p.dim('API key    ') + key,
    ], { w: 60 })));
    t.write('\n  ' + p.dim('Point any OpenAI or Anthropic client here. Works while this app is open.') + '\n\n');
    const v = await t.select([
      { label: 'Copy API key', value: 'key' },
      { label: 'Copy Claude Code setup', hint: 'export lines for another terminal', value: 'env' },
      { label: state.showKey ? 'Hide API key' : 'Show API key', value: 'show' },
      { label: 'New API key', hint: 'the old one stops working', value: 'regen' },
      { label: 'Back', value: null },
    ]);
    if (!v) return;
    if (v === 'show') { state.showKey = !state.showKey; continue; }
    if (v === 'regen') { config.update({ apiKey: 'sk-ds-' + require('crypto').randomBytes(18).toString('hex') }); continue; }
    const text = v === 'key' ? cfg.apiKey
      : `export ANTHROPIC_BASE_URL=${base()}\nexport ANTHROPIC_AUTH_TOKEN=${cfg.apiKey}\nexport ANTHROPIC_MODEL=deepseek-chat\n`;
    copyText(text);
    t.write('\n  ' + p.ok('✓') + ' Copied\n');
    await sleep(700);
  }
}

function logLines() {
  const rows = Math.max(5, (process.stdout.rows || 30) - 12);
  if (!state.requests.length) return ['  ' + p.dim('Nothing yet. Requests from Claude Code or any other client show up here as they happen.')];
  const lines = [];
  for (const e of state.requests) {
    if (lines.length >= rows) break;
    const time = new Date(e.time).toLocaleTimeString([], { hour12: false });
    const st = e.status < 400 ? p.ok(String(e.status)) : p.bad(String(e.status));
    lines.push(`  ${p.dim(time)}  ${st}  ${t.pad(e.path, 22)} ${p.brand(t.pad(String(e.model), 18))} ${p.dim(String(e.ms).padStart(6) + ' ms')}${e.tokens ? p.dim('  ~' + e.tokens + ' tok') : ''}`);
    if (e.error) lines.push('  ' + ' '.repeat(10) + p.bad(e.error.length > t.cols() - 16 ? e.error.slice(0, t.cols() - 17) + '…' : e.error));
  }
  return lines;
}

async function requestLog() {
  header(p.bold('Request log') + p.dim('  ·  live'));
  const view = t.live();
  const draw = () => view.render([...logLines(), '', '  ' + p.dim('any key to go back')]);
  logListener = draw; draw();
  await t.anyKey(null);
  logListener = null;
}

// ---- subcommands -------------------------------------------------------------------------
function help() {
  console.log(`
${indent(t.wordmark())}  ${p.dim('bridge  ·  v' + pkg.version)}

  ${p.bold('Usage')}
    deepseek                 open the app
    deepseek claude [args]   launch Claude Code on DeepSeek
    deepseek chat            chat in the terminal
    deepseek login           step-by-step login (or --token <t>)
    deepseek logout          forget the session on this PC
    deepseek status          show whether the session works
    deepseek serve           run only the API, with a live request log

  ${p.bold('Options')}
    --port <n>               API port (default 8788, next free one if taken)
`);
}

async function main() {
  if (flag('--help') || flag('-h') || cmd === 'help') return help();
  if (flag('--version') || flag('-v')) return console.log(pkg.version);

  if (cmd === 'status') {
    const sp = t.spinner('Checking your DeepSeek session');
    const a = await checkSession();
    a.ok ? sp.ok('Connected' + (state.email ? ' as ' + p.bold(state.email) : '')) : sp.fail(cfg.token ? 'Session expired: ' + p.dim(a.reason) : 'Not logged in');
    return process.exit(a.ok ? 0 : 1);
  }
  if (cmd === 'logout') { config.update({ token: '', cookie: '', email: '' }); fs.rmSync(PROFILE, { recursive: true, force: true }); console.log('  ' + p.ok('✓') + ' Logged out'); return; }
  if (!t.isTTY && cmd !== 'serve') { help(); return process.exit(1); }

  if (cmd === 'login') {
    if (val('--token')) {
      const tok = config.normalizeToken(val('--token'));
      const a = await ds.checkAuth(tok);
      if (!a.ok) { console.error('  ' + p.bad('✗') + ' DeepSeek rejected that token'); return process.exit(1); }
      config.update({ token: tok }); console.log('  ' + p.ok('✓') + ' Logged in'); return process.exit(0);
    }
    const ok = await loginScreen({ method: flag('--google') ? 'google' : flag('--browser') ? 'auto' : 'guide' });
    return quit(ok ? 0 : 1);
  }

  if (cmd === 'serve') {
    await startServer({ quiet: false });
    const a = await checkSession();
    console.log('\n' + indent(t.wordmark()) + '  ' + p.dim('bridge  ·  API only') + '\n');
    console.log(indent(t.panel(statusRows(), { w: 60 })));
    if (!a.ok) console.log('  ' + p.warn('Not connected.') + ' Run ' + p.bold('deepseek login') + ' in another terminal, then restart this.\n');
    console.log('  ' + p.dim('Ctrl+C to stop') + '\n');
    return;
  }

  await startServer();
  header();
  const sp = t.spinner('Checking your DeepSeek session');
  await checkSession();
  sp.stop();

  if (cmd === 'claude') { const code = await launchClaude(argv.slice(1)); return quit(typeof code === 'number' ? code : 0); }
  if (cmd === 'chat') { await chat(); return quit(0); }
  if (cmd) { help(); return quit(1); }
  await home();
}

main().catch((e) => { t.cursor.show(); console.error('\n  ' + p.bad('✗') + ' ' + (e.stack || e.message)); process.exit(1); });
