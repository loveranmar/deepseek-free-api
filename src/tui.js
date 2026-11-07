'use strict';
// Tiny dependency-free terminal UI kit: colour, the banner, menus, inputs, spinners.
const out = process.stdout;
const isTTY = !!out.isTTY;
const env = process.env;
const truecolor = /truecolor|24bit/i.test(env.COLORTERM || '') || /kitty|wezterm|ghostty|alacritty|foot/i.test(env.TERM || '') || !!env.WT_SESSION;
const plain = !isTTY || 'NO_COLOR' in env;

// ---- colour ---------------------------------------------------------------------
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const to256 = ([r, g, b]) => {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : 232 + Math.round((r - 8) / 247 * 24);
  const q = (v) => Math.round(v / 255 * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
};
const fgCode = (rgb) => truecolor ? `38;2;${rgb.join(';')}` : `38;5;${to256(rgb)}`;
const bgCode = (rgb) => truecolor ? `48;2;${rgb.join(';')}` : `48;5;${to256(rgb)}`;
const sgr = (code, s) => plain ? s : `\x1b[${code}m${s}\x1b[0m`;
const fg = (h) => (s) => sgr(fgCode(hex(h)), s);

// DeepSeek blue, with red kept for errors and the drips.
const C = {
  blue: '#4D6BFE', sky: '#8FA2FF', navy: '#26346E', deep: '#121935',
  text: '#E6E8F0', dim: '#7D8399', faint: '#3A4058', red: '#FF3B57', amber: '#FFB547',
};
const paint = {
  blue: fg(C.blue), sky: fg(C.sky), navy: fg(C.navy), text: fg(C.text), red: fg(C.red), amber: fg(C.amber), faint: fg(C.faint),
  ok: fg(C.sky), bad: fg(C.red), warn: fg(C.amber),
  bold: (s) => sgr('1', s), dim: fg(C.dim), italic: (s) => sgr('3', s), under: (s) => sgr('4', s),
  sel: (s) => plain ? s : `\x1b[${bgCode(hex(C.deep))}m${String(s).replace(/\x1b\[0m/g, `\x1b[0m\x1b[${bgCode(hex(C.deep))}m`)}\x1b[0m`,
};
// [+] [x] [!] [*] [?] tags
const tag = (ch, tone = paint.blue) => paint.navy('[') + tone(paint.bold(ch)) + paint.navy(']');
const TAG = {
  ok: () => tag('+', paint.sky), bad: () => tag('x', paint.red), warn: () => tag('!', paint.amber),
  info: () => tag('*', paint.blue), ask: () => tag('?', paint.blue),
};

function lerp(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function gradient(text, stops = [C.sky, C.blue]) {
  if (plain) return text;
  const chars = [...text], cs = stops.map(hex), n = Math.max(1, chars.length - 1);
  return chars.map((ch, i) => {
    if (ch === ' ') return ch;
    const t = i / n * (cs.length - 1), k = Math.min(cs.length - 2, Math.floor(t));
    return `\x1b[${fgCode(lerp(cs[k], cs[k + 1], t - k))}m${ch}`;
  }).join('') + '\x1b[0m';
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
const width = (s) => [...strip(s)].length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const cols = () => Math.max(40, out.columns || 80);
const rows = () => Math.max(12, out.rows || 24);

// ---- banner ---------------------------------------------------------------------------
const BANNER = [
  "      $$\\                                                             $$\\                                 $$\\",
  "      $$ |                                                            $$ |                                \\__|",
  " $$$$$$$ | $$$$$$\\   $$$$$$\\   $$$$$$\\   $$$$$$$\\  $$$$$$\\   $$$$$$\\  $$ |  $$\\        $$$$$$\\   $$$$$$\\  $$\\",
  "$$  __$$ |$$  __$$\\ $$  __$$\\ $$  __$$\\ $$  _____|$$  __$$\\ $$  __$$\\ $$ | $$  |       \\____$$\\ $$  __$$\\ $$ |",
  "$$ /  $$ |$$$$$$$$ |$$$$$$$$ |$$ /  $$ |\\$$$$$$\\  $$$$$$$$ |$$$$$$$$ |$$$$$$  /        $$$$$$$ |$$ /  $$ |$$ |",
  "$$ |  $$ |$$   ____|$$   ____|$$ |  $$ | \\____$$\\ $$   ____|$$   ____|$$  _$$<        $$  __$$ |$$ |  $$ |$$ |",
  "\\$$$$$$$ |\\$$$$$$$\\ \\$$$$$$$\\ $$$$$$$  |$$$$$$$  |\\$$$$$$$\\ \\$$$$$$$\\ $$ | \\$$\\       \\$$$$$$$ |$$$$$$$  |$$ |",
  " \\_______| \\_______| \\_______|$$  ____/ \\_______/  \\_______| \\_______|\\__|  \\__|       \\_______|$$  ____/ \\__|",
  "                              $$ |                                                              $$ |",
  "                              $$ |                                                              $$ |",
  "                              \\__|                                                              \\__|",
];
const SPLIT = 80; // "deepseek" is columns 0-79, "api" starts at 86

// A few drips hang off the bottom edge (row 7) of the letters: [column, length].
const DRIPS = [[12, 3], [24, 2], [47, 3], [61, 1], [90, 2]];

/**
 * The big "deepseek api" banner: DeepSeek blue with dark shadows, optionally dripping.
 * Returns coloured lines, or null when the terminal is too narrow.
 * `drip` (0..1) is how far the drips have run (for the splash animation).
 */
function banner({ max = cols() - 2, drip = 0 } = {}) {
  const full = max >= 110, wide = full || max >= SPLIT;
  if (!wide) return null;
  const w = full ? 110 : SPLIT;
  const grid = BANNER.map(l => [...l.padEnd(110).slice(0, w)]);
  const marks = grid.map(r => r.map(() => null));
  // drips below the letters
  for (const [c, len] of DRIPS) {
    if (c >= w) continue;
    const n = Math.round(len * drip);
    for (let k = 0; k < n; k++) {
      const r = 8 + k;
      while (grid.length <= r) { grid.push([...' '.repeat(w)]); marks.push(grid[0].map(() => null)); }
      if (grid[r][c] !== ' ') break;
      grid[r][c] = k === n - 1 && n === len ? '▼' : '┃';
      marks[r][c] = k === n - 1 && n === len ? 'tip' : 'drip';
    }
  }
  const top = hex('#A9B8FF'), mid = hex(C.blue), bot = hex('#2D45C8');
  const apiTop = hex('#F2F4FA'), apiBot = hex('#8D93A8');
  const blue = (t) => (t < 0.5 ? lerp(top, mid, t * 2) : lerp(mid, bot, (t - 0.5) * 2));
  return grid.map((row, r) => {
    if (plain) return row.join('').replace(/\s+$/, '');
    const t = Math.min(1, r / 9);
    let s = '';
    row.forEach((ch, c) => {
      if (ch === ' ') { s += ' '; return; }
      const api = c >= SPLIT;
      let code;
      if (marks[r][c] === 'tip') code = fgCode(hex(C.red));
      else if (marks[r][c] === 'drip') code = fgCode(hex('#B0172F'));
      else if (ch === '$') code = fgCode(api ? lerp(apiTop, apiBot, t) : blue(t));
      else code = fgCode(hex(api ? '#3C4152' : '#22306A'));
      s += `\x1b[${code}m${ch}`;
    });
    return s.replace(/\s+$/, '') + '\x1b[0m';
  });
}

// Small fallback wordmark for narrow terminals: 5px pixel font in half blocks.
const FONT = {
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '####'],
  P: ['###.', '#..#', '###.', '#...', '#...'],
  S: ['.###', '#...', '.##.', '...#', '###.'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
};
function wordmark(word = 'DEEPSEEK') {
  const rws = ['', '', '', '', ''];
  for (const [i, ch] of [...word].entries()) for (let r = 0; r < 5; r++) rws[r] += (i ? '.' : '') + FONT[ch][r];
  rws.push('.'.repeat(rws[0].length));
  const lines = [];
  for (let r = 0; r < 6; r += 2) {
    let s = '';
    for (let x = 0; x < rws[0].length; x++) {
      const a = rws[r][x] === '#', b = rws[r + 1][x] === '#';
      s += a && b ? '█' : a ? '▀' : b ? '▄' : ' ';
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  const w = Math.max(...lines.map(l => l.length));
  return lines.map((l, i) => gradient(pad(l, w), [['#A9B8FF', C.blue, '#2D45C8'][i], C.blue]));
}

// Cut a coloured string to `n` visible columns (so it never wraps and breaks in-place redraws).
function fit(s, n = cols() - 1) {
  s = String(s);
  if (width(s) <= n) return s;
  let o = '', w = 0;
  for (const m of s.matchAll(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\s\S]/gu)) {
    if (m[0].startsWith('\x1b')) { o += m[0]; continue; }
    if (w >= n - 1) break;
    o += m[0]; w++;
  }
  return o + (plain ? '…' : '\x1b[0m' + paint.faint('…'));
}

// ---- screen -------------------------------------------------------------------
const write = (s) => out.write(s);
const clear = () => { if (isTTY) write('\x1b[2J\x1b[3J\x1b[H'); };

// Resizing: the current screen's painter redraws everything, then the active widget (menu, input, live view)
// draws itself again underneath. Screens that can't be rebuilt (a chat transcript) set no painter.
let painter = null, widget = null, resizeTimer = null;
// Left margin for widgets, so screens can sit in the middle of the window.
let LEFT = 2;
const ind = () => ' '.repeat(LEFT);
function setLeft(n) { LEFT = Math.max(2, n); }
function screen(fn) { painter = fn; widget = null; if (fn) { clear(); fn(); } }
function setWidget(fn) { widget = fn; }
out.on && out.on('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!painter) return; clear(); painter(); if (widget) widget(); }, 40);
});
const cursor = { hide: () => isTTY && write('\x1b[?25l'), show: () => isTTY && write('\x1b[?25h') };
process.on('exit', () => { cursor.show(); try { process.stdin.setRawMode && process.stdin.setRawMode(false); } catch {} });

// Re-renders a block of lines in place.
function live() {
  let prev = 0;
  return {
    render(lines) {
      let s = prev ? `\x1b[${prev}A\r` : '\r';
      for (const l of lines) s += '\x1b[2K' + fit(l) + '\n';
      for (let i = lines.length; i < prev; i++) s += '\x1b[2K\n';
      if (prev > lines.length) s += `\x1b[${prev - lines.length}A`;
      write(s); prev = lines.length;
    },
    reset() { prev = 0; },
  };
}

// Square box with an optional [ title ]. `rows` are pre-coloured strings.
function panel(rws, { w, title } = {}) {
  const inner = Math.min(cols() - 6, w || Math.max(...rws.map(width), title ? width(title) + 6 : 0) + 2);
  const b = paint.navy;
  const top = title
    ? b('┌─[ ') + paint.blue(paint.bold(fit(title, inner - 4))) + b(' ]' + '─'.repeat(Math.max(0, inner - width(title) - 4)) + '┐')
    : b('┌' + '─'.repeat(inner + 1) + '┐');
  return [top, ...rws.map(r => b('│') + ' ' + pad(fit(r, inner - 1), inner - 1) + ' ' + b('│')), b('└' + '─'.repeat(inner + 1) + '┘')];
}

// [##########..........] 2/4
function progress(n, total, w = 24, count = true) {
  const fill = Math.round(w * n / total);
  return paint.blue('■'.repeat(fill)) + paint.faint('■'.repeat(w - fill)) + (count ? '  ' + paint.dim(`${n}/${total}`) : '');
}

// Key hints: [enter] next  [esc] abort
const hints = (...pairs) => pairs.map(([k, v]) => paint.navy('[') + paint.blue(k) + paint.navy(']') + ' ' + paint.dim(v)).join('   ');

// ---- keys -----------------------------------------------------------------------
function keys(handler) {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  const on = (data) => {
    // Split escape sequences from pasted text.
    const parts = data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|\x1b|[\s\S]/g) || [];
    if (parts.length > 1 && !data.startsWith('\x1b') && !/[\r\n\x03\x7f\x08]/.test(data)) return handler(data, true);
    for (const k of parts) handler(k, false);
  };
  stdin.on('data', on);
  return () => { stdin.off('data', on); if (stdin.isTTY) stdin.setRawMode(!!wasRaw); stdin.pause(); };
}

const KEY = { up: ['\x1b[A', '\x1bOA', 'k'], down: ['\x1b[B', '\x1bOB', 'j'], enter: ['\r', '\n'], esc: ['\x1b'], ctrlc: ['\x03'] };

/**
 * Arrow-key menu. items: [{ label, hint, value, tone }]. Resolves to the value, or null on Esc / q.
 */
function select(items, { initial = 0, footer = true, esc = 'back', minWidth = 0 } = {}) {
  return new Promise((resolve) => {
    let i = Math.max(0, Math.min(items.length - 1, initial));
    const view = live();
    const lw = Math.max(...items.map(it => width(it.label)));
    const rowW = Math.max(minWidth, Math.max(...items.map(it => 9 + lw + (it.hint ? width(it.hint) + 3 : 0))) + 2);
    const draw = () => {
      const lines = items.map((it, k) => {
        const on = k === i;
        const num = String(k + 1);
        const hint = it.hint ? '   ' + paint.dim(it.hint) : '';
        const rw = Math.min(rowW, cols() - LEFT - 2);
        if (!on) return ind() + fit(`   ${paint.navy('[' + num + ']')} ${pad(it.tone ? it.tone(it.label) : paint.text(it.label), lw)}${hint}`, rw);
        const label = paint.bold(it.tone ? it.tone(it.label) : paint.text(it.label));
        return ind() + paint.sel(pad(fit(` ${paint.blue('>')} ${paint.blue('[' + num + ']')} ${pad(label, lw)}${hint}`, rw), rw));
      });
      if (footer) lines.push('', ind() + hints(['↑↓', 'move'], ['enter', 'select'], ['esc', esc]));
      view.render(lines);
    };
    cursor.hide(); draw();
    setWidget(() => { view.reset(); cursor.hide(); draw(); });
    const done = keys((k) => {
      if (KEY.up.includes(k)) { i = (i - 1 + items.length) % items.length; draw(); }
      else if (KEY.down.includes(k)) { i = (i + 1) % items.length; draw(); }
      else if (/^[1-9]$/.test(k) && +k <= items.length) { i = +k - 1; draw(); finish(items[i].value); }
      else if (KEY.enter.includes(k)) finish(items[i].value);
      else if (KEY.esc.includes(k) || k === 'q') finish(null);
      else if (KEY.ctrlc.includes(k)) { done(); cursor.show(); write('\n'); process.exit(130); }
    });
    function finish(v) {
      done(); setWidget(null);
      // Fold the menu into one line showing the choice (or nothing when backing out).
      const it = items.find(x => x.value === v);
      view.render(v === null || !it ? [] : [`${ind()}${paint.blue('>')} ${it.label}`]);
      cursor.show(); resolve(v);
    }
  });
}

// Single-line input. Resolves to the text on Enter, null on Esc / Ctrl+C,
// or undefined when `signal` aborts it from outside.
function input({ label, mask = false, value = '', placeholder = '', prefix: custom, signal } = {}) {
  return new Promise((resolve) => {
    let v = value;
    const draw = () => {
      const prefix = custom ?? `${ind()}${paint.dim(label)} ${paint.blue('>')} `;
      const shown = mask ? '*'.repeat([...v].length) : v;
      const room = Math.max(4, cols() - width(prefix) - 2);
      const vis = [...shown].length > room ? '…' + [...shown].slice(-(room - 1)).join('') : shown;
      write('\r\x1b[2K' + prefix + (vis ? paint.text(vis) : paint.faint(fit(placeholder, room))) + (vis ? '' : `\r\x1b[${width(prefix)}C`));
    };
    cursor.show(); draw();
    setWidget(() => { cursor.show(); draw(); });
    const done = keys((k, pasted) => {
      if (pasted) { v += k.replace(/[\r\n]+/g, ''); return draw(); }
      if (KEY.enter.includes(k)) { done(); setWidget(null); write('\n'); resolve(v); }
      else if (KEY.esc.includes(k) || KEY.ctrlc.includes(k)) { done(); setWidget(null); write('\n'); resolve(null); }
      else if (k === '\x7f' || k === '\x08') { v = [...v].slice(0, -1).join(''); draw(); }
      else if (k === '\x15') { v = ''; draw(); }
      else if (k.length === 1 && k >= ' ') { v += k; draw(); }
    });
    if (signal) signal.addEventListener('abort', () => { done(); setWidget(null); write('\r\x1b[2K'); resolve(undefined); }, { once: true });
  });
}

// Waits for one key. Resolves to the key, or undefined if `signal` aborts first. Ctrl+C exits.
function key({ signal } = {}) {
  return new Promise((resolve) => {
    cursor.hide();
    const done = keys((k) => {
      if (KEY.ctrlc.includes(k)) { done(); cursor.show(); write('\n'); process.exit(130); }
      done(); resolve(k);
    });
    if (signal) signal.addEventListener('abort', () => { done(); resolve(undefined); }, { once: true });
  });
}

// Waits for one key with a prompt line. Resolves to the key string.
async function anyKey(prompt = 'press any key to go back') {
  if (prompt) write('\n' + ind() + paint.dim(prompt));
  const k = await key();
  cursor.show(); write('\n');
  return k;
}

// ---- spinner --------------------------------------------------------------------
const FRAMES = ['|', '/', '-', '\\'];
function spinner(text) {
  if (!isTTY) {
    const end = (sym, s) => write('  ' + sym + ' ' + strip(s ?? text) + '\n');
    return { update() {}, ok: (s) => end('[+]', s), fail: (s) => end('[x]', s), stop() {} };
  }
  let i = 0, msg = text;
  const t0 = Date.now();
  cursor.hide();
  const tick = () => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    write('\r\x1b[2K' + ind() + tag(FRAMES[i++ % FRAMES.length]) + ' ' + msg + (secs >= 3 ? paint.faint(`  ${secs}s`) : ''));
  };
  tick();
  const timer = setInterval(tick, 90);
  const end = (sym, s) => { clearInterval(timer); write('\r\x1b[2K' + ind() + sym + ' ' + (s ?? msg) + '\n'); cursor.show(); };
  return {
    update(s) { msg = s; tick(); },
    ok(s) { end(TAG.ok(), s); },
    fail(s) { end(TAG.bad(), s); },
    stop() { clearInterval(timer); write('\r\x1b[2K'); cursor.show(); },
  };
}

// Word-wrap plain text to the terminal, with an indent on every line.
function wrap(text, indent = 2, max = cols() - 4) {
  const w = Math.max(20, Math.min(max, cols() - indent - 2));
  const outLines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (width(line + word) > w && line.trim()) { outLines.push(line.replace(/\s+$/, '')); line = word.replace(/^\s+/, ''); }
      else line += word;
    }
    outLines.push(line);
  }
  return outLines.map(l => ' '.repeat(indent) + l).join('\n');
}

module.exports = {
  paint, gradient, banner, wordmark, panel, progress, hints, tag, TAG, select, input, key, anyKey, spinner, live,
  clear, cursor, write, wrap, width, pad, strip, fit, cols, rows, keys, isTTY, plain, C, screen, setWidget, setLeft, ind,
};
