'use strict';
const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const ds = require('./deepseek');
const { MODELS, fromAnthropic, estimateTokens, buildPrompt } = require('./convert');
const { openaiChat, anthropicMessages } = require('./protocols');

const stats = { started: Date.now(), requests: 0, errors: 0, tokensIn: 0, tokensOut: 0 };
let logHook = () => {};

function send(res, status, obj, extra = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...extra });
  res.end(body);
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function errorBody(protocol, e) {
  const status = e.status || 500, type = e.type || 'api_error';
  if (protocol === 'anthropic') {
    const t = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error';
    return { type: 'error', error: { type: t, message: e.message } };
  }
  return { error: { message: e.message, type, code: type } };
}

function checkKey(req) {
  const key = config.get().apiKey;
  if (!key) return true;
  const h = req.headers;
  const given = (h.authorization || '').replace(/^Bearer\s+/i, '') || h['x-api-key'] || '';
  const a = Buffer.from(given), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleApi(req, res, url) {
  const t0 = Date.now();
  const anth = url.pathname.startsWith('/v1/messages');
  const protocol = anth ? 'anthropic' : 'openai';
  const entry = { time: new Date().toISOString(), path: url.pathname, protocol, model: '-', status: 0, ms: 0, tokens: 0 };
  const meta = {};
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    if (!checkKey(req)) throw Object.assign(new Error('Invalid API key'), { status: 401, type: 'invalid_api_key' });
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      entry.status = 200;
      const data = Object.keys(MODELS).map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek', type: 'model', display_name: id }));
      return send(res, 200, { object: 'list', data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
    }
    if (req.method !== 'POST') throw Object.assign(new Error('Not found'), { status: 404, type: 'not_found' });
    const body = await readBody(req);

    if (url.pathname === '/v1/messages/count_tokens') {
      const n = fromAnthropic(body);
      entry.status = 200;
      return send(res, 200, { input_tokens: estimateTokens(buildPrompt(n)) });
    }
    if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages') {
      stats.requests++;
      const out = await (anth ? anthropicMessages : openaiChat)(body, res, ac.signal, meta);
      if (out) send(res, 200, out);
      entry.status = 200;
      return;
    }
    throw Object.assign(new Error(`Unknown endpoint ${url.pathname}`), { status: 404, type: 'not_found' });
  } catch (e) {
    entry.status = e.status || 500;
    if (entry.status !== 404) stats.errors++;
    entry.error = e.message;
    if (res.headersSent) { // mid-stream failure: signal in-band
      try {
        if (anth) res.write(`event: error\ndata: ${JSON.stringify(errorBody('anthropic', e))}\n\n`);
        else res.write(`data: ${JSON.stringify(errorBody('openai', e))}\n\n`);
        res.end();
      } catch {}
    } else if (!ac.signal.aborted) send(res, entry.status, errorBody(protocol, e));
  } finally {
    entry.ms = Date.now() - t0;
    entry.model = meta.model || entry.model;
    if (meta.usage) { entry.tokens = meta.usage.input + meta.usage.output; stats.tokensIn += meta.usage.input; stats.tokensOut += meta.usage.output; }
    if (url.pathname !== '/v1/models') logHook(entry);
  }
}

function create({ onLog } = {}) {
  if (onLog) logHook = onLog;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      if (url.pathname.startsWith('/v1/')) return await handleApi(req, res, url);
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      send(res, 404, 'DeepSeek Free API: the API lives under /v1');
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    }
  });
}

module.exports = { create, stats };
