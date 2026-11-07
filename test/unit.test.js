'use strict';
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/convert');

test('openai -> normalized -> prompt with tools', () => {
  const n = c.fromOpenAI({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '20C' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }] });
  const p = c.buildPrompt(n);
  assert.match(p, /\[Tools\]/); assert.match(p, /<tool_call>\{"name":"get_weather"/); assert.match(p, /\[Tool result c1\]\n20C/); assert.ok(p.endsWith('[Assistant]'));
});

test('anthropic tool_result becomes tool message', () => {
  const n = c.fromAnthropic({ system: [{ type: 'text', text: 'sys' }], messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] }] });
  assert.equal(n.system, 'sys'); assert.equal(n.messages[2].role, 'tool'); assert.equal(n.messages[2].text, 'ok');
});

test('plain single message passes through untouched', () => {
  assert.equal(c.buildPrompt(c.fromOpenAI({ messages: [{ role: 'user', content: 'hello' }] })), 'hello');
});

test('parseToolCalls extracts and strips', () => {
  const r = c.parseToolCalls('Sure.\n<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>', [{ name: 'a' }]);
  assert.deepEqual(r.calls, [{ name: 'a', arguments: { x: 1 } }]); assert.equal(r.text, 'Sure.');
  assert.equal(c.parseToolCalls('<tool_call>{"name":"zzz"}</tool_call>', [{ name: 'a' }]).calls.length, 0);
});

test('model resolution', () => {
  assert.equal(c.resolveModel('claude-opus-4').id, 'deepseek-chat');
  assert.equal(c.resolveModel('deepseek-reasoner').thinking, true);
  assert.equal(c.resolveModel('claude-x', { thinkingHint: true }).thinking, true);
});

test('parses DeepSeek native DSML tool calls', () => {
  const text = '\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="Read">\n<｜｜DSML｜｜ parameter name="file_path" string="true">C:\tmp\note.txt</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="limit" string="false">20</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  const r = c.parseToolCalls(text, [{ name: 'Read' }]);
  assert.deepEqual(r.calls, [{ name: 'Read', arguments: { file_path: 'C:\tmp\note.txt', limit: 20 } }]);
  assert.equal(r.text, '');
  assert.ok(c.findToolStart('hi <｜DSML｜tool_calls>') === 3);
});

test('parses <tool_call> JSON closed with stray DSML tags (AskUserQuestion case)', () => {
  const text = '<tool_call>{"name":"AskUserQuestion","arguments":{"questions":[{"question":"Which tool?","options":[{"label":"A {x}","description":"has } brace and \\"quote\\""}]}]}}</｜｜DSML｜｜ parameter>   \n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>  ';
  const r = c.parseToolCalls(text, [{ name: 'AskUserQuestion' }]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.questions[0].options[0].description, 'has } brace and "quote"');
  assert.equal(r.text, '');
});

test('multiple tool calls plus leading prose', () => {
  const r = c.parseToolCalls('ok <tool_call>{"name":"a","arguments":{}}</tool_call>\n<tool_call>{"name":"b","arguments":{"n":1}}</tool_call>', [{ name: 'a' }, { name: 'b' }]);
  assert.deepEqual(r.calls.map(x => x.name), ['a', 'b']); assert.equal(r.text, 'ok');
});

test('repairs tool_call JSON with unescaped inner quotes (Thorium case)', () => {
  const text = `I'll find Thorium.\n<tool_call>{"name":"Bash","arguments":{"command":"powershell -NoProfile -Command "Get-Process thorium -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"","description":"Get Thorium path from running             process"}}</tool_call>`;
  const r = c.parseToolCalls(text, [{ name: 'Bash' }]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].arguments.command, 'powershell -NoProfile -Command "Get-Process thorium -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"');
  assert.match(r.calls[0].arguments.description, /^Get Thorium path/);
  assert.equal(r.text, "I'll find Thorium.");
});

test('repairs raw newlines and bad backslashes in strings', () => {
  const r = c.parseToolCalls('<tool_call>{"name":"Write","arguments":{"file_path":"C:\\Users\\x\\a.txt","content":"line1\nline2 say "hi" ok"}}</tool_call>', [{ name: 'Write' }]);
  assert.equal(r.calls[0].arguments.file_path, 'C:\\Users\\x\\a.txt');
  assert.equal(r.calls[0].arguments.content, 'line1\nline2 say "hi" ok');
});
