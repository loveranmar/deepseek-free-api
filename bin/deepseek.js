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
  if (code === 0 && t.isTTY) { t.screen(null); t.write('\n  ' + t.TAG.info() + ' ' + p.ash('bridge down. later.') + '\n\n'); }
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
// Compact header for every screen after the splash:  ░▒▓█ DEEPSEEK API █▓▒░ v1.0.0 / rule / prompt
function headerLines(crumb = '') {
  const w = Math.min(t.cols() - 4, 76);
  const tagline = p.gore('░▒▓█ ') + p.blood(p.bold('DEEPSEEK')) + ' ' + p.bone(p.bold('API')) + p.gore(' █▓▒░') + '  ' + p.ash('v' + pkg.version);
  const prompt = p.blood('root') + p.gore('@') + p.bone('deepseek') + p.gore(':') + p.pink('~') + p.blood('# ') + (crumb ? p.ash('./' + crumb.replace(/ /g, '_')) : '');
  return ['', '  ' + t.fit(tagline, w), '  ' + p.gore('═'.repeat(w)), '  ' + t.fit(prompt, w), ''];
}
const put = (lines) => t.write(lines.map(l => t.fit(l)).join('\n') + '\n');
// A wrapped sentence, indented, one styled string per line.
const say = (text, style = p.ash, lead = '') => t.wrap(text, 0, Math.min(t.cols() - 4 - t.width(lead), 76)).split('\n').map((l, i) => '  ' + (i ? ' '.repeat(t.width(lead)) : lead) + style(l));
function header(crumb) { put(headerLines(crumb)); }

function sessionRow() {
  if (!state.checked) return t.tag('*') + ' ' + p.ash('session ') + '  ' + p.ash('checking...');
  if (state.connected) return t.TAG.ok() + ' ' + p.ash('session ') + '  ' + p.bone(p.bold('ALIVE')) + (state.email ? p.gore(' :: ') + p.bone(state.email) : '');
  if (cfg.token) return t.TAG.bad() + ' ' + p.ash('session ') + '  ' + p.blood(p.bold('DEAD')) + p.gore(' :: ') + p.ash('token expired, log in again');
  return t.TAG.warn() + ' ' + p.ash('session ') + '  ' + p.ember(p.bold('NONE')) + p.gore(' :: ') + p.ash('not logged in');
}
function statusRows() {
  return [
    sessionRow(),
    t.TAG.info() + ' ' + p.ash('api     ') + '  ' + p.bone(base()),
    t.TAG.info() + ' ' + p.ash('key     ') + '  ' + p.bone(maskKey(cfg.apiKey)),
  ];
}
const boxW = () => Math.min(t.cols() - 6, 64);

// ---- splash: the big banner, centred, "press enter to continue" ---------------------------
async function splash(checking) {
  let blink = true, drip = 0, reveal = 0, animating = t.isTTY && !t.plain;
  const center = (s, w) => ' '.repeat(Math.max(0, Math.floor((t.cols() - w) / 2))) + s;
  const build = () => {
    const art = t.banner({ max: t.cols() - 2, drip }) ||
      (t.cols() >= 42 ? t.wordmark() : [p.blood(p.bold('DEEPSEEK')) + ' ' + p.bone(p.bold('API'))]);
    const aw = Math.max(...art.map(t.width));
    const tag1 = p.gore('[ ') + p.ash('openai + anthropic api from your deepseek session') + p.gore(' ]');
    const tag2 = p.gore('v' + pkg.version + '  ::  github.com/loveranmar/deepseek-bridge');
    const go = blink ? p.blood('>> ') + p.bone('press ') + p.blood(p.bold('[ENTER]')) + p.bone(' to continue') + p.blood(' <<')
      : p.gore('>> ') + p.gore('press ') + p.crimson(p.bold('[ENTER]')) + p.gore(' to continue') + p.gore(' <<');
    const shown = art.map((l, i) => (i < reveal || !animating ? l : ''));
    const body = [...shown.map(l => center(l, aw)), '', center(t.fit(tag1, t.cols() - 2), Math.min(t.width(tag1), t.cols() - 2)),
      center(t.fit(tag2, t.cols() - 2), Math.min(t.width(tag2), t.cols() - 2)), '', '', center(sessionRow(), t.width(sessionRow())), '', center(go, t.width(go))];
    const top = Math.max(0, Math.floor((t.rows() - body.length) / 2));
    return '\x1b[H' + '\n'.repeat(top) + body.map(l => '\x1b[2K' + t.fit(l)).join('\n') + '\x1b[J';
  };
  const paint = () => t.write(build());
  t.cursor.hide();
  t.screen(paint);
  if (animating) {
    for (reveal = 0; reveal <= 11; reveal++) { paint(); await sleep(28); }
    for (let k = 1; k <= 10; k++) { drip = k / 10; paint(); await sleep(55); }
    animating = false; drip = 1;
  } else drip = 1;
  paint();
  checking.then(() => paint(), () => paint());
  const timer = setInterval(() => { blink = !blink; paint(); }, 550);
  try {
    for (;;) {
      const k = await t.key();
      if (k === '\r' || k === '\n' || k === ' ') return true;
      if (k === '\x1b' || k === 'q') return false;
    }
  } finally { clearInterval(timer); t.screen(null); t.cursor.show(); }
}

async function home() {
  let last = 0;
  for (;;) {
    const items = [
      { label: 'launch claude code', hint: 'claude, running on deepseek', value: 'claude' },
      { label: 'chat', hint: 'talk to deepseek right here', value: 'chat' },
      { label: state.connected ? 'switch account' : 'log in', hint: 'step by step, about a minute', value: 'login' },
      { label: 'connection details', hint: 'base urls + api key', value: 'details' },
      { label: 'request log', hint: state.requests.length ? `${state.requests.length} this session` : 'live traffic through the bridge', value: 'log' },
      ...(cfg.token ? [{ label: 'log out', hint: 'forget this account on this pc', value: 'logout' }] : []),
      { label: 'quit', hint: 'kill the bridge', value: 'quit' },
    ];
    t.screen(() => { header(); put(t.panel(statusRows(), { w: boxW(), title: 'status' }).map(l => '  ' + l)); t.write('\n'); });
    const initial = state.connected ? Math.min(last, items.length - 1) : items.findIndex(i => i.value === 'login');
    const v = await t.select(items, { initial, esc: 'quit' });
    if (v === null || v === 'quit') return quit(0);
    last = items.findIndex(i => i.value === v);
    await ({ claude: launchClaude, chat, login: loginScreen, details, log: requestLog, logout })[v]();
  }
}

async function needLogin() {
  if (state.connected) return true;
  return loginScreen({ reason: cfg.token ? 'your deepseek session expired.' : 'log in to deepseek first.' });
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

// Word-wrapped paragraph for a box of width `w`, each line styled.
const para = (text, w, style = (x) => x) => t.wrap(text, 0, w).split('\n').map(style);

/**
 * The guided way in, one step per screen:
 *   1 log in on chat.deepseek.com (in the user's own browser)  2 open the console
 *   3 paste the payload (copies the token)  4 we pick it up from the clipboard and verify it.
 * The clipboard is watched the whole time, so copying the token early skips straight to step 4.
 */
async function tokenGuide({ reason } = {}) {
  const TOTAL = 4;
  const devtools = process.platform === 'darwin' ? 'Cmd+Option+J' : 'F12';
  const tried = new Set([SNIPPET]);
  const before = config.normalizeToken(await readClipboard());
  if (before) tried.add(before); // whatever was on the clipboard already isn't the new token

  let step = 1, note = reason ? t.TAG.warn() + ' ' + p.ember(reason) : '', opened = null;
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

  // One step screen: header, progress, the step's box, an optional note, then key hints.
  const stepScreen = (n, title, body, foot, extra = []) => {
    const w = boxW();
    header('login');
    put(['  ' + p.blood(p.bold(`STEP ${n}/${TOTAL}`)) + '  ' + t.progress(n, TOTAL, Math.max(8, Math.min(24, t.cols() - 16)), false), '']);
    put(t.panel(body(w - 2), { w, title }).map(l => '  ' + l));
    put(['', ...(note ? [].concat(note).map(l => '  ' + l).concat(['']) : []), ...extra]);
    if (foot) put(['  ' + foot]);
  };

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
        t.screen(() => stepScreen(1, 'log in on deepseek', (w) => [
          opened ? t.TAG.ok() + ' ' + p.bone('chat.deepseek.com just opened in your browser.') : t.TAG.warn() + ' ' + p.bone('open ' + DEEPSEEK + ' in your browser.'),
          '',
          ...para('log in there like you normally do. the captcha is fine, that part is you, not a bot.', w, p.bone),
          '',
          ...para('come back here once you can see the deepseek chat.', w, p.ash),
        ], t.hints(['enter', 'done, next'], ['o', 'open it again'], ['esc', 'abort'])));
        const k = await t.key({ signal: stepAbort.signal });
        note = '';
        if (k === undefined) continue;
        if (k === '\r' || k === '\n') step = 2;
        else if (k === 'o' || k === 'O') opened = openUrl(DEEPSEEK);
        else if (k === '\x1b') return false;
        continue;
      }

      if (step === 2) {
        t.screen(() => stepScreen(2, 'open the console', (w) => [
          p.bone('on the deepseek tab press ') + p.blood(p.bold(devtools)),
          '',
          ...para('a panel pops up. click the Console tab at the top of it.', w, p.bone),
          '',
          ...para(process.platform === 'darwin' ? 'safari: turn on Develop menu first (settings, advanced).' : 'nothing happened? try Ctrl+Shift+J (chrome) or Ctrl+Shift+K (firefox).', w, p.ash),
        ], t.hints(['enter', 'next'], ['esc', 'back'])));
        const k = await t.key({ signal: stepAbort.signal });
        note = '';
        if (k === undefined) continue;
        if (k === '\r' || k === '\n') step = 3;
        else if (k === '\x1b' || k === 'b') step = 1;
        continue;
      }

      // step 3: payload on the clipboard, watch for the token, or take a pasted one
      copyText(SNIPPET);
      let frame = 0;
      const watchLine = () => '  ' + t.tag(['|', '/', '-', '\\'][frame % 4]) + ' ' + p.ash('watching the clipboard for your token...');
      t.screen(() => stepScreen(3, 'grab the token', (w) => [
        t.TAG.ok() + ' ' + p.bone('payload copied to your clipboard:'),
        '',
        '    ' + p.pink(SNIPPET),
        '',
        ...para('paste it into the console and press enter. that copies your token and this window grabs it by itself.', w, p.bone),
        '',
        ...para('paste blocked? type "allow pasting", press enter, then paste again.', w, p.ash),
      ], null, [watchLine(), '', '', '  ' + t.hints(['enter', 'on empty: copy payload again'], ['esc', 'back'])]) || t.write('\x1b[3A')); // then back up to the input line
      const ticker = setInterval(() => { frame++; t.write('\x1b7\x1b[1A\r\x1b[2K' + t.fit(watchLine()) + '\x1b8'); }, 120);
      let typed;
      try { typed = await t.input({ label: 'or paste it', mask: true, placeholder: 'token here, or just wait', signal: stepAbort.signal }); }
      finally { clearInterval(ticker); }
      note = '';
      if (typed === undefined) continue;          // the watcher found something
      if (typed === null) { step = 2; continue; } // esc
      const tok = config.normalizeToken(typed);
      if (!tok) { note = t.TAG.ok() + ' ' + p.bone('payload copied again.'); continue; }
      tried.add(tok);
      if (await verifyStep(tok)) return true;
    }
  } finally {
    watch.abort();
    await watcher;
    stepAbort = null;
  }

  // step 4: check the token with DeepSeek, save it
  async function verifyStep(tok) {
    t.screen(() => stepScreen(4, 'verify', (w) => [
      ...para('checking the token with deepseek...', w, p.bone),
    ], null));
    const sp = t.spinner(p.ash('talking to chat.deepseek.com'));
    const a = await ds.checkAuth(tok);
    if (!a.ok) {
      sp.stop();
      note = [t.TAG.bad() + ' ' + p.blood('deepseek rejected that token.'), '    ' + p.ash('run the payload on the deepseek tab where you are logged in.')];
      return false;
    }
    config.update({ token: tok });
    if ((await readClipboard()) === tok) clearClipboard(); // don't leave the token lying on the clipboard
    await checkSession();
    sp.stop();
    t.screen(() => {
      header('login');
      put(['  ' + p.blood(p.bold(`STEP ${TOTAL}/${TOTAL}`)) + '  ' + t.progress(TOTAL, TOTAL, Math.max(8, Math.min(24, t.cols() - 16)), false), '']);
      const w = boxW();
      put(t.panel([
        t.TAG.ok() + ' ' + p.bone(p.bold('ACCESS GRANTED')),
        t.TAG.ok() + ' ' + p.ash('logged in') + (state.email ? p.ash(' as ') + p.bone(state.email) : ''),
        t.TAG.ok() + ' ' + p.ash('token saved, wiped from the clipboard'),
        '',
        ...para('you can close the browser tab. do not hit log out on the website, that kills this session too.', w - 2, p.ash),
      ], { w, title: 'pwned' }).map(l => '  ' + l));
      put(['', '  ' + t.hints(['enter', 'continue'])]);
    });
    t.cursor.hide();
    for (;;) { const k = await t.key(); if (k === '\r' || k === '\n' || k === '\x1b' || k === ' ') break; }
    t.screen(null);
    return true;
  }
}

async function loginScreen({ reason, method } = {}) {
  if (!method || method === 'guide') return tokenGuide({ reason });
  t.screen(() => { header('login'); if (reason) put(['  ' + t.TAG.warn() + ' ' + p.ember(reason), '']); });
  if (method === 'auto') {
    put(['  ' + p.ash('your password goes straight into deepseek\'s own sign-in page. it is never saved.'), '']);
    method = await t.select([
      { label: 'email + password', hint: 'type them here, the rest is automatic', value: 'password' },
      { label: 'continue with google', hint: 'sign in once in a browser window', value: 'google' },
      { label: 'paste a token', hint: 'from a logged-in chat.deepseek.com tab', value: 'token' },
      { label: 'back', value: null },
    ]);
    if (!method) return false;
    t.write('\n');
  }

  if (method === 'token') {
    const raw = await t.input({ label: 'token', mask: true, placeholder: 'paste here' });
    if (!raw) return false;
    const sp = t.spinner('checking the token with deepseek');
    const tok = config.normalizeToken(raw);
    const a = await ds.checkAuth(tok);
    if (!a.ok) { sp.fail('deepseek rejected that token. ' + p.ash(a.reason || '')); await t.anyKey(); return false; }
    config.update({ token: tok });
    await checkSession();
    sp.ok('logged in' + (state.email ? ' as ' + p.bold(state.email) : ''));
    await sleep(900);
    return true;
  }

  let email = '', password = '';
  if (method === 'password') {
    email = (await t.input({ label: 'email', value: cfg.email || '', placeholder: 'you@example.com' }) || '').trim();
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
      onStatus: (s) => sp.update(s + p.ash('   esc cancels')),
      verify: async (tk) => (await ds.checkAuth(tk)).ok,
    });
    password = '';
    config.update({ token, ...(email ? { email } : {}) });
    if (email) state.email = email;
    await checkSession();
    sp.ok('logged in' + (state.email ? ' as ' + p.bold(state.email) : ''));
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
  t.screen(() => { header('logout'); put([...say('forget the deepseek session on this pc?', p.bone, t.TAG.warn() + ' '), ...say('the browser profile used for automatic sign-in is wiped too.', p.ash, '    '), '']); });
  const v = await t.select([{ label: 'log out', value: true, tone: p.blood }, { label: 'cancel', value: false }], { initial: 1 });
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
  t.write('\n  ' + t.TAG.info() + ' ' + p.bone(p.bold('claude code')) + p.ash(' on deepseek') + p.gore('  ::  ') + p.ash(`bridge on :${state.port}`) + p.gore('  ::  ') + p.ash('/model to switch') + '\n\n');
  childRunning = true;
  const code = await new Promise((resolve) => {
    const child = spawn('claude', ['--allow-dangerously-skip-permissions', '--settings', path.join(ROOT, 'assets', 'claude-settings.json'), ...extra],
      { stdio: 'inherit', env: claudeEnv(), shell: process.platform === 'win32' });
    child.on('error', (e) => resolve(e.code === 'ENOENT' ? 'missing' : 1));
    child.on('exit', (c) => resolve(c ?? 0));
  });
  childRunning = false;
  if (code === 'missing') {
    t.write('  ' + t.TAG.bad() + ' claude code is not installed. get it from ' + p.under('https://claude.com/claude-code') + '\n');
    await t.anyKey();
    return 1;
  }
  return code;
}

// ---- chat -----------------------------------------------------------------------------
function chatHeader() {
  t.screen(null); t.clear(); // a transcript can't be redrawn on resize, so no painter here
  header('chat');
  put(['  ' + p.ash('model ') + p.blood(state.model), '  ' + t.hints(['/model', 'switch'], ['/new', 'fresh chat'], ['/exit', 'back'], ['esc', 'stop a reply']), '']);
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
  t.write('\n  ' + p.blood(p.bold('deepseek')) + p.gore(' >> ') + p.ash(state.model) + '\n');
  const sp = t.spinner(p.ash('thinking'));
  let started = false, mode = null, answer = '';
  const think = streamWriter((s) => p.ash(p.italic(s)), '  ' + p.gore('┃ '));
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
    if (ac.signal.aborted) { t.write('\n  ' + t.TAG.warn() + ' ' + p.ash('stopped') + '\n\n'); return answer || null; }
    if (e.status === 401) state.connected = false;
    t.write('\n' + say(e.message, p.bone, t.TAG.bad() + ' ').join('\n') + '\n\n');
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
    const raw = await t.input({ prefix: '  ' + p.bone(p.bold('you')) + p.gore(' >> '), placeholder: 'message deepseek' });
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
      t.write('\n  ' + p.ash('model ') + p.blood(state.model) + '\n\n');
      continue;
    }
    history.push({ role: 'user', content: s });
    const answer = await reply(history);
    if (answer === null) history.pop();
    else history.push({ role: 'assistant', content: answer });
    if (!state.connected) {
      t.write(say('your deepseek session expired. press any key to log in again.', p.ember, t.TAG.warn() + ' ').join('\n') + '\n');
      await t.anyKey(null);
      if (!(await loginScreen())) return;
      chatHeader();
    }
  }
}

// ---- details & log --------------------------------------------------------------------
async function details() {
  for (;;) {
    const key = state.showKey ? cfg.apiKey : maskKey(cfg.apiKey);
    t.screen(() => {
      header('details');
      put(t.panel([
        t.TAG.info() + ' ' + p.ash('openai    ') + p.bone(base() + '/v1'),
        t.TAG.info() + ' ' + p.ash('anthropic ') + p.bone(base()),
        t.TAG.info() + ' ' + p.ash('api key   ') + p.bone(key),
      ], { w: boxW(), title: 'endpoints' }).map(l => '  ' + l));
      put(['', ...say('point any openai or anthropic client here. works while this app is open.'), '']);
    });
    const v = await t.select([
      { label: 'copy api key', value: 'key' },
      { label: 'copy claude code setup', hint: 'export lines for another terminal', value: 'env' },
      { label: state.showKey ? 'hide api key' : 'show api key', value: 'show' },
      { label: 'new api key', hint: 'the old one stops working', value: 'regen' },
      { label: 'back', value: null },
    ]);
    if (!v) return;
    if (v === 'show') { state.showKey = !state.showKey; continue; }
    if (v === 'regen') { config.update({ apiKey: 'sk-ds-' + require('crypto').randomBytes(18).toString('hex') }); continue; }
    const text = v === 'key' ? cfg.apiKey
      : `export ANTHROPIC_BASE_URL=${base()}\nexport ANTHROPIC_AUTH_TOKEN=${cfg.apiKey}\nexport ANTHROPIC_MODEL=deepseek-chat\n`;
    copyText(text);
    t.write('\n  ' + t.TAG.ok() + ' ' + p.bone('copied') + '\n');
    await sleep(700);
  }
}

function logLines() {
  const rows = Math.max(5, (process.stdout.rows || 30) - 12);
  if (!state.requests.length) return say('nothing yet. requests from claude code or any other client show up here live.', p.ash, t.TAG.info() + ' ');
  const lines = [];
  for (const e of state.requests) {
    if (lines.length >= rows) break;
    const time = new Date(e.time).toLocaleTimeString([], { hour12: false });
    const st = e.status < 400 ? t.TAG.ok() + ' ' + p.bone(String(e.status)) : t.TAG.bad() + ' ' + p.blood(String(e.status));
    lines.push(`  ${p.gore(time)}  ${st}  ${p.bone(t.pad(e.path, 22))} ${p.pink(t.pad(String(e.model), 18))} ${p.ash(String(e.ms).padStart(6) + ' ms')}${e.tokens ? p.ash('  ~' + e.tokens + ' tok') : ''}`);
    if (e.error) lines.push('  ' + ' '.repeat(14) + p.blood(e.error));
  }
  return lines;
}

async function requestLog() {
  const view = t.live();
  const draw = () => view.render([...logLines(), '', '  ' + t.hints(['any key', 'back'])]);
  t.screen(() => header('request_log'));
  logListener = draw; draw();
  t.setWidget(() => { view.reset(); draw(); });
  await t.key();
  logListener = null; t.setWidget(null);
}

// ---- subcommands -------------------------------------------------------------------------
function help() {
  const art = t.banner({ drip: 1 }) || t.wordmark();
  const c = (cmdS, d) => '    ' + p.blood(t.pad(cmdS, 25)) + p.ash(d);
  console.log(['', ...art.map(l => '  ' + l), '', '  ' + p.gore('v' + pkg.version + '  ::  openai + anthropic api from your deepseek session'), '',
    '  ' + p.bone(p.bold('usage')),
    c('deepseek', 'open the app'),
    c('deepseek claude [args]', 'launch claude code on deepseek'),
    c('deepseek chat', 'chat in the terminal'),
    c('deepseek login', 'step-by-step login (or --token <t>)'),
    c('deepseek logout', 'forget the session on this pc'),
    c('deepseek status', 'is the session alive?'),
    c('deepseek serve', 'api only, with a live request log'),
    '', '  ' + p.bone(p.bold('options')),
    c('--port <n>', 'api port (default 8788, next free one if taken)'), ''].map(l => t.isTTY ? t.fit(l) : l).join('\n'));
}

async function main() {
  if (flag('--help') || flag('-h') || cmd === 'help') return help();
  if (flag('--version') || flag('-v')) return console.log(pkg.version);

  if (cmd === 'status') {
    const sp = t.spinner('checking your deepseek session');
    const a = await checkSession();
    a.ok ? sp.ok('session alive' + (state.email ? ' :: ' + p.bold(state.email) : '')) : sp.fail(cfg.token ? 'session dead: ' + p.ash(a.reason) : 'not logged in');
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
    const a = await checkSession();
    header('serve');
    console.log(t.panel(statusRows(), { w: boxW(), title: 'status' }).map(l => '  ' + l).join('\n'));
    if (!a.ok) console.log('\n' + say('not connected. run "deepseek login" in another terminal, then restart this.', p.ember, t.TAG.warn() + ' ').join('\n'));
    console.log('\n  ' + t.hints(['ctrl+c', 'stop']) + '\n');
    return;
  }

  await startServer();
  const checking = checkSession().catch(() => {});
  if (!cmd) {
    if (!(await splash(checking))) return quit(0);
  } else {
    header();
  }
  if (!state.checked) {
    t.write('\n');
    const sp = t.spinner('checking your deepseek session');
    await checking;
    sp.stop();
  }

  if (cmd === 'claude') { const code = await launchClaude(argv.slice(1)); return quit(typeof code === 'number' ? code : 0); }
  if (cmd === 'chat') { await chat(); return quit(0); }
  if (cmd) { help(); return quit(1); }
  await home();
}

main().catch((e) => { t.cursor.show(); console.error('\n  ' + t.TAG.bad() + ' ' + (e.stack || e.message)); process.exit(1); });
