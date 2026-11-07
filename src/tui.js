'use strict';
// Tiny dependency-free terminal UI kit: colour, gradient wordmark, menus, inputs, spinners.
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
const sgr = (code, s) => plain ? s : `\x1b[${code}m${s}\x1b[0m`;
const fg = (h) => (s) => sgr(fgCode(hex(h)), s);

const C = {
  brand: '#4D6BFE', violet: '#9B8CFF', sky: '#7FB2FF',
  ok: '#5FD3A0', bad: '#F2777A', warn: '#F0C674',
};
const paint = {
  brand: fg(C.brand), violet: fg(C.violet), sky: fg(C.sky),
  ok: fg(C.ok), bad: fg(C.bad), warn: fg(C.warn),
  bold: (s) => sgr('1', s), dim: (s) => sgr('2', s), italic: (s) => sgr('3', s),
  under: (s) => sgr('4', s),
};

function lerp(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function gradient(text, stops = [C.brand, C.violet]) {
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

// ---- wordmark: 5px pixel font rendered with half blocks (3 rows tall) -------------
const FONT = {
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '####'],
  P: ['###.', '#..#', '###.', '#...', '#...'],
  S: ['.###', '#...', '.##.', '...#', '###.'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
};
function wordmark(word = 'DEEPSEEK') {
  const rows = ['', '', '', '', ''];
  for (const [i, ch] of [...word].entries()) for (let r = 0; r < 5; r++) rows[r] += (i ? '.' : '') + FONT[ch][r];
  rows.push('.'.repeat(rows[0].length));
  const lines = [];
  for (let r = 0; r < 6; r += 2) {
    let s = '';
    for (let x = 0; x < rows[0].length; x++) {
      const a = rows[r][x] === '#', b = rows[r + 1][x] === '#';
      s += a && b ? '█' : a ? '▀' : b ? '▄' : ' ';
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  const w = Math.max(...lines.map(l => l.length));
  return lines.map(l => gradient(pad(l, w), [C.brand, C.sky, C.violet]));
}

// ---- screen -------------------------------------------------------------------
const write = (s) => out.write(s);
const clear = () => { if (isTTY) write('\x1b[2J\x1b[3J\x1b[H'); };
const cursor = { hide: () => isTTY && write('\x1b[?25l'), show: () => isTTY && write('\x1b[?25h') };
process.on('exit', () => { cursor.show(); try { process.stdin.setRawMode && process.stdin.setRawMode(false); } catch {} });

// Re-renders a block of lines in place.
function live() {
  let prev = 0;
  return {
    render(lines) {
      let s = prev ? `\x1b[${prev}A\r` : '\r';
      for (const l of lines) s += '\x1b[2K' + l + '\n';
      for (let i = lines.length; i < prev; i++) s += '\x1b[2K\n';
      if (prev > lines.length) s += `\x1b[${prev - lines.length}A`;
      write(s); prev = lines.length;
    },
    reset() { prev = 0; },
  };
}

// Rounded panel. `rows` are pre-coloured strings.
function panel(rows, { w, title } = {}) {
  const inner = Math.min(cols() - 6, w || Math.max(...rows.map(width), title ? width(title) + 2 : 0) + 2);
  const b = paint.dim;
  const top = title ? b('╭─ ') + title + b(' ' + '─'.repeat(Math.max(0, inner - width(title) - 2)) + '╮') : b('╭' + '─'.repeat(inner + 1) + '╮');
  return [top, ...rows.map(r => b('│') + ' ' + pad(r, inner - 1) + ' ' + b('│')), b('╰' + '─'.repeat(inner + 1) + '╯')];
}

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
function select(items, { initial = 0, footer = true, esc = 'back' } = {}) {
  return new Promise((resolve) => {
    let i = Math.max(0, Math.min(items.length - 1, initial));
    const view = live();
    const lw = Math.max(...items.map(it => width(it.label)));
    const draw = () => {
      const lines = items.map((it, k) => {
        const on = k === i;
        const mark = on ? paint.brand('▍') : ' ';
        const label = on ? paint.bold(it.tone ? it.tone(it.label) : paint.brand(it.label)) : (it.tone ? it.tone(it.label) : it.label);
        const hint = it.hint ? '   ' + paint.dim(it.hint) : '';
        return `  ${mark} ${pad(label, lw)}${hint}`;
      });
      if (footer) lines.push('', '  ' + paint.dim(`↑↓ move   ⏎ select   ${items.length < 10 ? '1-' + items.length + ' jump   ' : ''}esc ${esc}`));
      view.render(lines);
    };
    cursor.hide(); draw();
    const done = keys((k) => {
      if (KEY.up.includes(k)) { i = (i - 1 + items.length) % items.length; draw(); }
      else if (KEY.down.includes(k)) { i = (i + 1) % items.length; draw(); }
      else if (/^[1-9]$/.test(k) && +k <= items.length) { i = +k - 1; draw(); finish(items[i].value); }
      else if (KEY.enter.includes(k)) finish(items[i].value);
      else if (KEY.esc.includes(k) || k === 'q') finish(null);
      else if (KEY.ctrlc.includes(k)) { done(); cursor.show(); write('\n'); process.exit(130); }
    });
    function finish(v) {
      done();
      // Fold the menu into one line showing the choice (or nothing when backing out).
      const it = items.find(x => x.value === v);
      view.render(v === null || !it ? [] : [`  ${paint.brand('›')} ${it.label}`]);
      cursor.show(); resolve(v);
    }
  });
}

/**
 * Single-line input. Resolves to the string, or null on Esc / Ctrl+C.
 */
// Resolves to the text on Enter, null on Esc / Ctrl+C, or undefined when `signal` aborts it from outside.
function input({ label, mask = false, value = '', placeholder = '', prefix: custom, signal } = {}) {
  return new Promise((resolve) => {
    let v = value;
    const prefix = custom ?? `  ${paint.dim(pad(label, 10))} ${paint.brand('›')} `;
    const draw = () => {
      const shown = mask ? '•'.repeat([...v].length) : v;
      write('\r\x1b[2K' + prefix + (shown || paint.dim(placeholder)) + (shown ? '' : `\r\x1b[${width(prefix)}C`));
    };
    cursor.show(); draw();
    if (signal) signal.addEventListener('abort', () => { done(); write('\r\x1b[2K'); resolve(undefined); }, { once: true });
    const done = keys((k, pasted) => {
      if (pasted) { v += k.replace(/[\r\n]+/g, ''); return draw(); }
      if (KEY.enter.includes(k)) { done(); write('\n'); resolve(v); }
      else if (KEY.esc.includes(k) || KEY.ctrlc.includes(k)) { done(); write('\n'); resolve(null); }
      else if (k === '\x7f' || k === '\x08') { v = [...v].slice(0, -1).join(''); draw(); }
      else if (k === '\x15') { v = ''; draw(); }
      else if (k.length === 1 && k >= ' ') { v += k; draw(); }
    });
  });
}

// Waits for one key. Resolves to the key string.
function anyKey(prompt = 'press any key to go back') {
  return new Promise((resolve) => {
    if (prompt) write('\n  ' + paint.dim(prompt));
    cursor.hide();
    const done = keys((k) => { if (KEY.ctrlc.includes(k)) { done(); cursor.show(); write('\n'); process.exit(130); } done(); cursor.show(); write('\n'); resolve(k); });
  });
}

// ---- spinner --------------------------------------------------------------------
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function spinner(text) {
  if (!isTTY) {
    const end = (sym, s) => write('  ' + sym + ' ' + strip(s ?? text) + '\n');
    return { update() {}, ok: (s) => end('✓', s), fail: (s) => end('✗', s), stop() {} };
  }
  let i = 0, msg = text;
  const t0 = Date.now();
  cursor.hide();
  const tick = () => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    write('\r\x1b[2K  ' + paint.brand(FRAMES[i++ % FRAMES.length]) + ' ' + msg + (secs >= 3 ? paint.dim(`  ${secs}s`) : ''));
  };
  tick();
  const timer = setInterval(tick, 80);
  const end = (sym, s) => { clearInterval(timer); write('\r\x1b[2K  ' + sym + ' ' + (s ?? msg) + '\n'); cursor.show(); };
  return {
    update(s) { msg = s; tick(); },
    ok(s) { end(paint.ok('✓'), s); },
    fail(s) { end(paint.bad('✗'), s); },
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

module.exports = { paint, gradient, wordmark, panel, select, input, anyKey, spinner, live, clear, cursor, write, wrap, width, pad, strip, cols, keys, isTTY, C };
