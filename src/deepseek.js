'use strict';
// Client for the chat.deepseek.com web API.
const config = require('./config');
const pow = require('./pow');

const BASE = process.env.DSB_UPSTREAM || 'https://chat.deepseek.com';
const COMPLETION = '/api/v0/chat/completion';

class DeepSeekError extends Error {
  constructor(message, status = 502, type = 'upstream_error') {
    super(message); this.status = status; this.type = type;
  }
}

let reconnectHint = () => 'Log in again with: deepseek login';
function setReconnectHint(fn) { reconnectHint = fn; }

function headers(extra = {}, token) {
  const c = config.get();
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'x-client-platform': 'web',
    'x-client-version': c.clientVersion,
    'x-app-version': c.clientVersion,
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    Authorization: `Bearer ${token ?? c.token}`,
    Origin: BASE,
    Referer: BASE + '/',
    'Content-Type': 'application/json',
    ...extra,
  };
  if (c.cookie) h.Cookie = c.cookie;
  if (c.hif_dliq) h['x-hif-dliq'] = c.hif_dliq;
  if (c.hif_leim) h['x-hif-leim'] = c.hif_leim;
  return h;
}

async function api(pathname, body, signal, token, method = 'POST') {
  if (!(token ?? config.get().token)) throw new DeepSeekError('Not logged in. Run: deepseek login', 401, 'auth_missing');
  const r = await fetch(BASE + pathname, method === 'GET' ? { headers: headers({}, token), signal } : { method, headers: headers({}, token), body: JSON.stringify(body ?? {}), signal });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (r.status === 401 || r.status === 403) throw new DeepSeekError('DeepSeek rejected the token (expired or blocked). Log in again with: deepseek login', 401, 'auth_expired');
  if (r.status === 429) throw new DeepSeekError('DeepSeek rate limit reached. Wait a moment.', 429, 'rate_limit');
  if (!r.ok || !json) throw new DeepSeekError(`DeepSeek HTTP ${r.status}: ${text.slice(0, 160)}`, 502);
  if (json.code !== 0 && json.code !== undefined) {
    const msg = json.msg || 'unknown error';
    if (json.code === 40003 || /invalid.?token|authorization failed/i.test(msg)) {
      throw new DeepSeekError(`DeepSeek rejected the token (logged out, expired, or revoked by DeepSeek). ${reconnectHint()}`, 401, 'auth_expired');
    }
    const auth = /token|login|auth/i.test(msg);
    throw new DeepSeekError(`DeepSeek: ${msg}`, auth ? 401 : 502, auth ? 'auth_expired' : 'upstream_error');
  }
  const bc = json.data && json.data.biz_code;
  if (bc) {
    const msg = json.data.biz_msg || `biz_code ${bc}`;
    throw new DeepSeekError(`DeepSeek: ${msg}`, /many|limit|frequent/i.test(msg) ? 429 : 502, /many|limit|frequent/i.test(msg) ? 'rate_limit' : 'upstream_error');
  }
  return json;
}

async function powHeader(signal) {
  const j = await api('/api/v0/chat/create_pow_challenge', { target_path: COMPLETION }, signal);
  const ch = j.data && j.data.biz_data && j.data.biz_data.challenge;
  if (!ch) throw new DeepSeekError('DeepSeek returned no PoW challenge (captcha or API change).', 502);
  const answer = await pow.solve(ch, config.get().wasmUrl);
  return Buffer.from(JSON.stringify({
    algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt,
    answer, signature: ch.signature, target_path: ch.target_path || COMPLETION,
  })).toString('base64');
}

// ---- SSE state machine -------------------------------------------------------
// DeepSeek streams JSON patches. We keep the fragment list and expose
// accumulated {think, text}; callers diff against what they already emitted.
class StreamState {
  constructor() { this.fragments = []; this.path = null; this.legacy = ''; this.finish = null; this.status = null; this.error = null; }
  get think() { return this.fragments.filter(f => (f.type === 'THINK' || f.type === 'REASONING') && typeof f.content === 'string').map(f => f.content).join(''); }
  get text() {
    const t = this.fragments.filter(f => (f.type === 'RESPONSE') && typeof f.content === 'string').map(f => f.content).join('');
    return t + this.legacy;
  }
  push(v) { for (const f of (Array.isArray(v) ? v : [v])) if (f && typeof f === 'object') this.fragments.push({ ...f }); }
  feed(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'error' || d.type === 'hint') {
      if (d.finish_reason === 'rate_limit_reached' || /too many|rate/i.test(d.content || '')) this.error = new DeepSeekError('DeepSeek rate limit reached.', 429, 'rate_limit');
    }
    if (d.finish_reason) this.finish = d.finish_reason;
    if (d.p !== undefined) this.path = d.p;
    if (d.v && typeof d.v === 'object' && !Array.isArray(d.v) && d.v.response) {
      const r = d.v.response;
      if (Array.isArray(r.fragments)) { this.fragments = []; this.push(r.fragments); }
      if (typeof r.content === 'string') this.legacy = r.content;
      if (typeof r.status === 'string') this.status = r.status;
      return;
    }
    const p = this.path;
    if (p === 'response/fragments' && d.v !== undefined) this.push(d.v);
    else if (p === 'response' && Array.isArray(d.v)) {
      for (const op of d.v) if (op && op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) this.push(op.v);
    } else if (p === 'response/fragments/-1/content' && typeof d.v === 'string') {
      const last = this.fragments[this.fragments.length - 1];
      if (last) last.content = (last.content || '') + d.v;
    } else if (p === 'response/content' && typeof d.v === 'string') this.legacy += d.v;
    else if (p === 'response/status' && typeof d.v === 'string') this.status = d.v;
    else if (p === 'response/finish_reason' && typeof d.v === 'string') this.finish = d.v;
  }
}

/**
 * Runs one completion in a throwaway chat.
 * Yields { think, text } deltas, then returns via final {done:true, finish}.
 */
async function* complete({ prompt, thinking = false, search = false, signal }) {
  const c = config.get();
  const created = await api('/api/v0/chat_session/create', {}, signal);
  const bd = created.data && created.data.biz_data;
  const sessionId = bd && ((bd.chat_session && bd.chat_session.id) || bd.id);
  if (!sessionId) throw new DeepSeekError('Could not create a DeepSeek chat session.', 502);
  try {
    const powB64 = await powHeader(signal);
    const body = {
      chat_session_id: sessionId, parent_message_id: null, prompt, ref_file_ids: [],
      thinking_enabled: !!thinking, search_enabled: !!search, action: null, preempt: false,
    };
    if (c.modelType) body.model_type = c.modelType;
    const r = await fetch(BASE + COMPLETION, { method: 'POST', headers: headers({ 'X-DS-PoW-Response': powB64 }), body: JSON.stringify(body), signal });
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 401 || r.status === 403) throw new DeepSeekError('DeepSeek rejected the token (expired or blocked).', 401, 'auth_expired');
      if (/too many|rate/i.test(t) || r.status === 429) throw new DeepSeekError('DeepSeek rate limit reached.', 429, 'rate_limit');
      throw new DeepSeekError(`DeepSeek HTTP ${r.status}: ${t.slice(0, 160)}`, 502);
    }
    const st = new StreamState();
    const dec = new TextDecoder();
    let buf = '', sentThink = 0, sentText = 0;
    const flush = function* () {
      const th = st.think, tx = st.text;
      if (th.length > sentThink || tx.length > sentText) {
        const out = { think: th.slice(sentThink), text: tx.slice(sentText) };
        sentThink = th.length; sentText = tx.length;
        yield out;
      }
    };
    const line = (l) => {
      l = l.replace(/\r$/, '');
      if (!l.startsWith('data:')) return;
      const p = l.slice(5).trimStart();
      if (!p || p === '[DONE]') return;
      try { st.feed(JSON.parse(p)); } catch {}
    };
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) line(l);
      if (st.error) throw st.error;
      yield* flush();
    }
    buf += dec.decode(); if (buf) line(buf);
    if (st.error) throw st.error;
    yield* flush();
    const finish = /^INCOMPLETE$/i.test(st.status || '') ? 'length' : 'stop';
    yield { done: true, finish };
  } finally {
    if (c.deleteChats) api('/api/v0/chat_session/delete', { chat_session_id: sessionId }).catch(() => {});
  }
}

// Cheap token check.
async function checkAuth(token) {
  const t = token ?? config.get().token;
  if (!t) return { ok: false, reason: 'No token configured' };
  try {
    await api('/api/v0/chat/create_pow_challenge', { target_path: COMPLETION }, undefined, t);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Who the token belongs to (email or phone), best effort.
async function account(token) {
  try {
    const j = await api('/api/v0/users/current', null, AbortSignal.timeout(8000), token, 'GET');
    const u = (j.data && (j.data.biz_data || j.data.user)) || {};
    return { email: u.email || u.mobile_number || u.mobile || '', muted: !!(u.chat && u.chat.is_muted) };
  } catch { return null; }
}

module.exports = { complete, checkAuth, account, setReconnectHint, DeepSeekError };
