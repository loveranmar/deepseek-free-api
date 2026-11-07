'use strict';
// End-to-end against a mock DeepSeek upstream (real PoW wasm from the reference repo).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WASM = path.join(__dirname, '..', 'refs', 'deepseek2api', 'sha3_wasm_bg.7b9ca65ddd.wasm');
const skip = !fs.existsSync(WASM) && 'wasm not present';
let completionBody = null, deleted = 0, replyMode = 'plain';

const sseLines = (arr) => arr.map(o => `data: ${JSON.stringify(o)}\n\n`).join('');
function reply() {
  if (replyMode === 'tool') {
    return sseLines([
      { v: { response: { message_id: 2, fragments: [{ type: 'RESPONSE', content: 'Checking. ' }] } } },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: '<tool_call>{"name":"get_weather",' },
      { p: 'response/fragments/-1/content', v: '"arguments":{"city":"Paris"}}</tool_call>' },
      { p: 'response/status', v: 'FINISHED' },
    ]);
  }
  return sseLines([
    { v: { response: { message_id: 2, fragments: [{ type: 'THINK', content: 'Hm' }] } } },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: 'm.' },
    { p: 'response', o: 'BATCH', v: [{ p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'Hel' }] }] },
    { p: 'response/fragments/-1/content', v: 'lo' },
    { p: 'response/fragments/-1/content', v: ' there' },
    { p: 'response/status', v: 'FINISHED' },
  ]);
}

let upstream, bridge, base, key;
test.before(async () => {
  process.env.DSB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-'));
  upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const ok = (biz) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: biz } })); };
      if (req.url === '/wasm') { res.setHeader('content-type', 'application/wasm'); return res.end(fs.readFileSync(WASM)); }
      if (req.headers.authorization !== 'Bearer good-token') { res.statusCode = 401; return res.end('{}'); }
      if (req.url === '/api/v0/chat/create_pow_challenge') return ok({ challenge: { algorithm: 'DeepSeekHashV1', challenge: 'a'.repeat(64), salt: 'salt1', expire_at: Date.now() + 60000, difficulty: 2000, signature: 'sig', target_path: '/api/v0/chat/completion' } });
      if (req.url === '/api/v0/chat_session/create') return ok({ chat_session: { id: 'sess-1' } });
      if (req.url === '/api/v0/chat_session/delete') { deleted++; return ok({}); }
      if (req.url === '/api/v0/chat/completion') {
        completionBody = JSON.parse(body);
        assert.ok(req.headers['x-ds-pow-response'], 'pow header sent');
        res.setHeader('content-type', 'text/event-stream'); return res.end(reply());
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${upstream.address().port}`;
  process.env.DSB_UPSTREAM = up;
  // The mock can't mint a mathematically valid challenge, so stub the solver.
  // (The real solver is the proven approach from the reference repos; see README.)
  require('../src/pow').solve = async () => 42;
  const config = require('../src/config'); config.load();
  config.update({ token: 'good-token', wasmUrl: up + '/wasm' });
  bridge = require('../src/server').create();
  await new Promise(r => bridge.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${bridge.address().port}`; key = config.get().apiKey;
});
test.after(() => { bridge.close(); upstream.close(); });

const post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, ...h }, body: JSON.stringify(b) });

test('openai non-stream with reasoning', { skip }, async () => {
  replyMode = 'plain';
  const j = await (await post('/v1/chat/completions', { model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(j.choices[0].message.content, 'Hello there');
  assert.equal(j.choices[0].message.reasoning_content, 'Hmm.');
  assert.equal(completionBody.thinking_enabled, true);
  assert.equal(completionBody.prompt, 'hi');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(deleted >= 1, 'chat deleted after use');
});

test('openai stream', { skip }, async () => {
  const txt = await (await post('/v1/chat/completions', { model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
  const chunks = txt.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).map(l => JSON.parse(l.slice(6)));
  assert.equal(chunks.map(c => c.choices[0].delta.content || '').join(''), 'Hello there');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.ok(txt.trim().endsWith('[DONE]'));
});

test('anthropic stream has thinking + text blocks', { skip }, async () => {
  const txt = await (await post('/v1/messages', { model: 'claude-x', max_tokens: 50, stream: true, thinking: { type: 'enabled', budget_tokens: 100 }, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': key, authorization: '' })).text();
  const events = [...txt.matchAll(/^event: (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(events.filter((e, i, a) => a.indexOf(e) === i), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.match(txt, /"thinking_delta"/);
  assert.match(txt, /"text_delta","text":"Hello there"/);
  assert.match(txt, /"stop_reason":"end_turn"/);
});

test('tool call emulation (openai + anthropic)', { skip }, async () => {
  replyMode = 'tool';
  const j = await (await post('/v1/chat/completions', {
    model: 'x', messages: [{ role: 'user', content: 'weather in Paris?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
  })).json();
  assert.equal(j.choices[0].finish_reason, 'tool_calls');
  assert.equal(j.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { city: 'Paris' });
  assert.equal(j.choices[0].message.content.trim(), 'Checking.');
  const a = await (await post('/v1/messages', { model: 'x', max_tokens: 50, messages: [{ role: 'user', content: 'w?' }], tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }] }, { 'x-api-key': key })).json();
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.content.find(b => b.type === 'tool_use').input, { city: 'Paris' });
});

test('bad client key rejected; expired upstream token maps to 401', { skip }, async () => {
  assert.equal((await post('/v1/chat/completions', {}, { authorization: 'Bearer nope' })).status, 401);
  require('../src/config').update({ token: 'expired' });
  const r = await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.type, 'auth_expired');
});
