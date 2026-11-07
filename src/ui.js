'use strict';
// Terminal presentation: banner + tidy coloured status output.
const fs = require('fs');
const path = require('path');

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s), bold = (s) => c('1', s);
const blue = (s) => c('38;5;69', s), pink = (s) => c('38;5;170', s);
const green = (s) => c('38;5;78', s), red = (s) => c('38;5;203', s), yellow = (s) => c('38;5;221', s);

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function banner() {
  let art = '';
  try { art = fs.readFileSync(path.join(__dirname, '..', 'assets', 'banner.ans'), 'utf8'); } catch {}
  const lines = art.split('\n').filter(l => l.length);
  const width = Math.max(0, ...lines.map(l => [...stripAnsi(l)].length));
  const cols = process.stdout.columns || 0;
  if (tty && lines.length && cols >= width) {
    process.stdout.write('\n' + art);
  } else {
    // Terminal too narrow for the art: compact fallback in the same palette.
    console.log('\n  ' + blue('▄▀▀▄ ') + bold(blue('DeepSeek')) + pink(' Bridge'));
  }
}

function ready({ host, port, apiKey, connected }) {
  const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  const row = (k, v) => console.log('  ' + dim(k.padEnd(12)) + v);
  console.log('\n  ' + bold(blue('DeepSeek')) + bold(pink(' Bridge')) + dim('  ·  local OpenAI + Anthropic API for chat.deepseek.com') + '\n');
  row('Dashboard', blue(base));
  row('OpenAI', `${base}/v1`);
  row('Anthropic', `${base}  ${dim('(/v1/messages)')}`);
  row('API key', pink(apiKey));
  row('Account', connected ? green('● connected') : yellow('○ not connected — open the dashboard to connect'));
  console.log('\n  ' + dim('Claude Code:  ') + `set ANTHROPIC_BASE_URL=${base}  ANTHROPIC_AUTH_TOKEN=<key>`);
  console.log('  ' + dim('Ctrl+C to stop\n'));
}

function requestLine(e) {
  const t = new Date(e.time).toLocaleTimeString([], { hour12: false });
  const st = e.status >= 400 ? red(String(e.status)) : green(String(e.status));
  const extra = e.error ? '  ' + red(e.error) : e.tokens ? dim(`  ~${e.tokens} tok`) : '';
  console.log(`  ${dim(t)} ${st} ${e.path.padEnd(22)} ${pink(String(e.model).padEnd(18))} ${dim(e.ms + 'ms')}${extra}`);
}

module.exports = { banner, ready, requestLine, blue, pink, green, red, yellow, dim, bold };
