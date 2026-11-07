'use strict';
// Persistent config: data/config.json (next to the project). Never logged in full.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DSB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

const DEFAULTS = {
  port: 8788,
  host: '127.0.0.1',
  apiKey: '',          // key clients must send; generated on first run
  token: '',           // DeepSeek web userToken
  cookie: '',          // optional
  hif_dliq: '',        // optional
  hif_leim: '',        // optional
  wasmUrl: DEFAULT_WASM,
  clientVersion: '2.0.0',
  modelType: 'default',
  deleteChats: true,   // delete the web chat after each request
  email: '',           // last account used by the terminal login (never the password)
};

let state = null;

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  state = { ...DEFAULTS, ...saved };
  if (process.env.PORT) state.port = Number(process.env.PORT);
  if (process.env.HOST) state.host = process.env.HOST;
  if (process.env.DEEPSEEK_TOKEN) state.token = process.env.DEEPSEEK_TOKEN;
  if (!state.apiKey) { state.apiKey = 'sk-ds-' + crypto.randomBytes(18).toString('hex'); save(); }
  return state;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function get() { return state || load(); }

function update(patch) {
  const s = get();
  for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) s[k] = patch[k];
  save();
  return s;
}

// Accepts a raw token, the JSON stored in localStorage ({"value":"..","__version":".."}),
// or a whole "Bearer xxx" string.
function normalizeToken(input) {
  let t = String(input || '').trim();
  if (!t) return '';
  if (t.startsWith('{')) { try { t = JSON.parse(t).value || ''; } catch {} }
  t = t.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
  return t;
}

function mask(s) { return !s ? '' : s.length <= 10 ? '••••' : s.slice(0, 4) + '••••' + s.slice(-4); }

module.exports = { load, get, save, update, normalizeToken, mask, DATA_DIR, DEFAULT_WASM };
