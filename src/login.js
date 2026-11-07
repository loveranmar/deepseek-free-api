'use strict';
// Browser-assisted DeepSeek login for the terminal app.
//
// DeepSeek's sign-in runs risk checks in the page itself, so we never call the login API directly.
// Instead we open DeepSeek's real sign-in page in a normal browser window (with its own profile under
// data/browser, so the session is remembered), optionally fill in the email and password the user typed,
// and read the resulting userToken from the page over the Chrome DevTools Protocol. Nothing is stored
// except the token; the password only ever travels into that page's form.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const SIGN_IN = process.env.DSB_SIGNIN_URL || 'https://chat.deepseek.com/sign_in';
const ORIGIN = new URL(SIGN_IN).origin;
// Own profile (separate from the user's everyday browser) so the DeepSeek session is remembered between logins.
const PROFILE = path.join(config.DATA_DIR, 'chrome');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- browser discovery --------------------------------------------------------
function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}

// Google Chrome first. Brave is deliberately left out: its Shields break DeepSeek's captcha.
// (DSB_BROWSER still lets you point at any Chromium-based browser.)
function findBrowser() {
  if (process.env.DSB_BROWSER) return process.env.DSB_BROWSER;
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome', 'Chromium', 'Microsoft Edge'];
    for (const a of apps) { const p = `/Applications/${a}.app/Contents/MacOS/${a}`; if (fs.existsSync(p)) return p; }
    return null;
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];
    for (const r of roots) for (const x of rel) { const p = path.join(r, x); if (fs.existsSync(p)) return p; }
    return null;
  }
  for (const n of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable']) {
    const p = onPath(n); if (p) return p;
  }
  return null;
}

// ---- minimal DevTools Protocol client (Node 22+ has a global WebSocket) -------
class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = () => reject(new Error('Could not connect to the browser'));
    });
  }
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false;
    ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      const p = d.id && this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
    };
    ws.onclose = () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('Browser closed')); this.pending.clear(); };
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Browser closed'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---- in-page helpers (run inside DeepSeek's sign-in page) --------------------
const READ_TOKEN = `(() => { try { const t = localStorage.getItem('userToken'); if (!t) return null;
  try { return JSON.parse(t).value || null; } catch { return t; } } catch { return null; } })()`;
const CLEAR_TOKEN = `(() => { try { localStorage.removeItem('userToken'); } catch {} location.href = ${JSON.stringify(SIGN_IN)}; return true; })()`;

// Shared DOM helpers: visible elements, and "the clickable thing whose own text matches".
const DOM = `
  const vis = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const byText = (re) => {
    const leaves = [...document.querySelectorAll('body *')].filter(e => vis(e) && re.test((e.textContent || '').trim())
      && ![...e.children].some(ch => re.test((ch.textContent || '').trim())));
    const el = leaves[0]; if (!el) return null;
    return el.closest('button,[role=button],a,[class*=button],[class*=btn]') || el;
  };`;

// Fills the email/password form and presses "Log in". Returns a short state string.
function fillScript(email, password) {
  return `(() => {${DOM}
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pw = [...document.querySelectorAll('input[type=password]')].find(vis);
    if (!pw) {
      // Some layouts open on a one-time-code tab: switch to password login.
      const tab = byText(/^(password|password login|log in with password|密码登录)$/i);
      if (tab) tab.click();
      return 'no-form';
    }
    const id = [...document.querySelectorAll('input')].find(i => vis(i) && i !== pw && /^(text|email|tel|)$/.test(i.type));
    if (!id) return 'no-form';
    setVal(id, ${JSON.stringify(email)});
    setVal(pw, ${JSON.stringify(password)});
    const agree = [...document.querySelectorAll('input[type=checkbox]')].find(b => !b.checked);
    if (agree) agree.click();
    const btn = byText(/^(log in|login|sign in|登录)$/i);
    if (!btn) return 'no-button';
    setTimeout(() => btn.click(), 200);
    return 'submitted';
  })()`;
}
const CLICK_GOOGLE = `(() => {${DOM} const b = byText(/google/i); if (!b) return false; b.click(); return true; })()`;
// Short visible error text near the form (wrong password etc.), if any.
const READ_ERROR = `(() => {${DOM}
  const el = [...document.querySelectorAll('[class*=error],[class*=Error],[role=alert],[class*=toast],[class*=message]')]
    .find(e => vis(e) && (e.textContent || '').trim().length > 3 && (e.textContent || '').trim().length < 160);
  return el ? el.textContent.trim() : null; })()`;

// ---- main flow ----------------------------------------------------------------
/**
 * login({ method: 'password'|'google'|'browser', email, password, onStatus, signal, verify })
 * Resolves to the DeepSeek userToken. `verify(token)` must resolve truthy for a token to be accepted
 * (stale tokens left in the browser profile are cleared and the sign-in page is shown again).
 */
async function login({ method = 'browser', email = '', password = '', onStatus = () => {}, signal, verify = async () => true, headless = false } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error('Google Chrome was not found. Install Chrome (or set DSB_BROWSER to a Chromium-based browser).');

  fs.mkdirSync(PROFILE, { recursive: true });
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  try { fs.unlinkSync(portFile); } catch {}

  const args = [
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--window-size=520,780', `--app=${SIGN_IN}`,
  ];
  if (headless) args.push('--headless=new');
  else if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland');

  onStatus('Opening a browser window');
  const proc = spawn(exe, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  proc.on('error', () => { exited = true; });

  let cdp = null;
  const shutdown = async () => {
    if (cdp && !cdp.closed) { try { await Promise.race([cdp.send('Browser.close'), sleep(1500)]); } catch {} cdp.close(); }
    if (!exited) { try { process.platform === 'win32' ? proc.kill() : process.kill(-proc.pid); } catch { try { proc.kill(); } catch {} } }
  };
  const aborted = () => signal && signal.aborted;

  try {
    // Wait for DevTools to come up.
    let wsPath = null;
    for (let i = 0; i < 100 && !wsPath; i++) {
      if (exited) throw new Error('The browser closed before it was ready.');
      if (aborted()) throw new Error('Cancelled');
      try { const [port, p] = fs.readFileSync(portFile, 'utf8').trim().split('\n'); if (port && p) wsPath = `ws://127.0.0.1:${port}${p}`; } catch {}
      if (!wsPath) await sleep(150);
    }
    if (!wsPath) throw new Error('The browser did not start in time.');
    cdp = await CDP.connect(wsPath);

    const sessions = new Map(); // targetId -> sessionId
    const pages = async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.filter(t => t.type === 'page' && t.url.startsWith(ORIGIN));
    };
    const evalIn = async (t, expression) => {
      let sid = sessions.get(t.targetId);
      if (!sid) { sid = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId; sessions.set(t.targetId, sid); }
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sid);
      return r.result ? r.result.value : undefined;
    };

    const rejected = new Set();
    let filled = false, googleClicked = false, startedAt = Date.now(), nudged = false, lastErr = null;
    onStatus(method === 'password' ? `Signing in as ${email}` : method === 'google' ? 'Waiting for you to sign in with Google' : 'Waiting for you to sign in');

    while (true) {
      if (aborted()) throw new Error('Cancelled');
      if (exited || cdp.closed) throw new Error('The browser window was closed before sign-in finished.');
      if (Date.now() - startedAt > 5 * 60 * 1000) throw new Error('Timed out waiting for sign-in.');

      let list = [];
      try { list = await pages(); } catch {}
      for (const t of list) {
        let token = null;
        try { token = await evalIn(t, READ_TOKEN); } catch { sessions.delete(t.targetId); continue; }
        if (token && !rejected.has(token)) {
          onStatus('Checking the new session');
          if (await verify(token)) { await shutdown(); return token; }
          // A stale token from an earlier session: drop it so DeepSeek shows the sign-in form again.
          rejected.add(token);
          try { await evalIn(t, CLEAR_TOKEN); } catch {}
          filled = false; googleClicked = false;
          onStatus(method === 'password' ? `Signing in as ${email}` : 'Previous session expired, sign in again');
          continue;
        }
        if (token) continue;
        try {
          if (method === 'password' && !filled) {
            const st = await evalIn(t, fillScript(email, password));
            if (st === 'submitted') { filled = true; startedAt = Date.now(); onStatus('Waiting for DeepSeek'); }
          } else if (method === 'google' && !googleClicked) {
            if (await evalIn(t, CLICK_GOOGLE)) googleClicked = true;
          } else if (method === 'password' && filled) {
            const err = await evalIn(t, READ_ERROR);
            if (err && err !== lastErr) { lastErr = err; onStatus(`DeepSeek says: ${err}`); }
            if (!nudged && Date.now() - startedAt > 20000) { nudged = true; onStatus('Finish signing in in the browser window (captcha or verification code?)'); }
          }
        } catch { sessions.delete(t.targetId); }
      }
      await sleep(600);
    }
  } finally {
    await shutdown();
  }
}

module.exports = { login, findBrowser, PROFILE, SIGN_IN };
