#!/usr/bin/env node
'use strict';
const config = require('../src/config');
const ui = require('../src/ui');
const { create, authStatus } = require('../src/server');
const { exec } = require('child_process');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);

if (flag('--help') || flag('-h')) {
  console.log(`deepseek-bridge [options]
  --port <n>     listen port (default 8787)
  --host <addr>  bind address (default 127.0.0.1; use 0.0.0.0 to expose on LAN)
  --token <t>    DeepSeek userToken (also: env DEEPSEEK_TOKEN, or connect in the dashboard)
  --no-open      don't open the dashboard in a browser
  --no-banner    skip the startup art`);
  process.exit(0);
}

const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const cfg = config.load();
if (val('--port')) cfg.port = Number(val('--port'));
if (val('--host')) cfg.host = val('--host');
if (val('--token')) config.update({ token: config.normalizeToken(val('--token')) });

if (!flag('--no-banner')) ui.banner();

const server = create();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(ui.red(`\n  Port ${cfg.port} is already in use. Try: deepseek-bridge --port ${cfg.port + 1}\n`));
  else console.error(e);
  process.exit(1);
});
server.listen(cfg.port, cfg.host, async () => {
  const auth = await authStatus(true);
  ui.ready({ host: cfg.host, port: cfg.port, apiKey: cfg.apiKey, connected: auth.ok });
  if (!auth.ok && cfg.token) console.log('  ' + ui.yellow('Token problem: ') + auth.reason + '\n');
  const url = `http://localhost:${cfg.port}`;
  const shouldOpen = !flag('--no-open') && !auth.ok;
  if (shouldOpen && process.platform === 'win32') exec(`start "" "${url}"`);
  else if (shouldOpen && process.platform === 'darwin') exec(`open "${url}"`);
  else if (shouldOpen) exec(`xdg-open "${url}"`);
});

process.on('SIGINT', () => { console.log(ui.dim('\n  bye\n')); process.exit(0); });
