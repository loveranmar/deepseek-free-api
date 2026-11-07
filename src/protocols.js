'use strict';
// OpenAI Chat Completions and Anthropic Messages front-ends over engine.run().
const crypto = require('crypto');
const { run } = require('./engine');
const { resolveModel, fromOpenAI, fromAnthropic } = require('./convert');

const rid = (p) => p + crypto.randomBytes(12).toString('hex');
const sse = (res, obj, event) => res.write((event ? `event: ${event}\n` : '') + `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
const startSSE = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });

// ---- OpenAI ------------------------------------------------------------------
async function openaiChat(body, res, signal, meta) {
  const model = resolveModel(body.model);
  const normalized = fromOpenAI(body);
  meta.model = model.id;
  const id = rid('chatcmpl-'), created = Math.floor(Date.now() / 1000), name = body.model || model.id;
  const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model: name, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

  if (body.stream) {
    startSSE(res);
    sse(res, chunk({ role: 'assistant', content: '' }));
    let toolIdx = 0;
    for await (const ev of run({ normalized, model, signal })) {
      if (ev.type === 'think') sse(res, chunk({ reasoning_content: ev.text }));
      else if (ev.type === 'text') sse(res, chunk({ content: ev.text }));
      else if (ev.type === 'tool') {
        sse(res, chunk({ tool_calls: [{ index: toolIdx++, id: rid('call_'), type: 'function', function: { name: ev.call.name, arguments: JSON.stringify(ev.call.arguments) } }] }));
      } else if (ev.type === 'end') {
        meta.usage = ev.usage;
        const extra = body.stream_options && body.stream_options.include_usage ? {} : {};
        sse(res, chunk({}, ev.finish, extra));
        if (body.stream_options && body.stream_options.include_usage) {
          sse(res, { id, object: 'chat.completion.chunk', created, model: name, choices: [], usage: { prompt_tokens: ev.usage.input, completion_tokens: ev.usage.output, total_tokens: ev.usage.input + ev.usage.output } });
        }
      }
    }
    sse(res, '[DONE]'); res.end();
    return;
  }

  let content = '', reasoning = '', calls = [], finish = 'stop', usage = { input: 0, output: 0 };
  for await (const ev of run({ normalized, model, signal })) {
    if (ev.type === 'think') reasoning += ev.text;
    else if (ev.type === 'text') content += ev.text;
    else if (ev.type === 'tool') calls.push({ id: rid('call_'), type: 'function', function: { name: ev.call.name, arguments: JSON.stringify(ev.call.arguments) } });
    else if (ev.type === 'end') { finish = ev.finish; usage = ev.usage; }
  }
  meta.usage = usage;
  const message = { role: 'assistant', content: content || (calls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;
  return {
    id, object: 'chat.completion', created, model: name,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  };
}

// ---- Anthropic ---------------------------------------------------------------
async function anthropicMessages(body, res, signal, meta) {
  const thinkingHint = !!(body.thinking && body.thinking.type === 'enabled');
  const model = resolveModel(body.model, { thinkingHint });
  const normalized = fromAnthropic(body);
  meta.model = model.id;
  const id = rid('msg_'), name = body.model || model.id;
  const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };

  if (body.stream) {
    startSSE(res);
    let usageIn = 0;
    // We don't know input tokens until the end; report an estimate up front.
    usageIn = Math.ceil(JSON.stringify(normalized).length / 3.6);
    sse(res, { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: name, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usageIn, output_tokens: 1 } } }, 'message_start');
    let idx = -1, open = null; // open: 'thinking' | 'text'
    const close = () => { if (open) { sse(res, { type: 'content_block_stop', index: idx }, 'content_block_stop'); open = null; } };
    const begin = (kind, block) => { close(); idx++; open = kind; sse(res, { type: 'content_block_start', index: idx, content_block: block }, 'content_block_start'); };
    let finish = 'stop', usage = { output: 0 };
    for await (const ev of run({ normalized, model, signal })) {
      if (ev.type === 'think') {
        if (open !== 'thinking') begin('thinking', { type: 'thinking', thinking: '', signature: '' });
        sse(res, { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: ev.text } }, 'content_block_delta');
      } else if (ev.type === 'text') {
        if (open !== 'text') begin('text', { type: 'text', text: '' });
        sse(res, { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: ev.text } }, 'content_block_delta');
      } else if (ev.type === 'tool') {
        begin('tool', { type: 'tool_use', id: rid('toolu_'), name: ev.call.name, input: {} });
        sse(res, { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(ev.call.arguments) } }, 'content_block_delta');
        close();
      } else if (ev.type === 'end') { finish = ev.finish; usage = ev.usage; }
    }
    close();
    meta.usage = usage;
    sse(res, { type: 'message_delta', delta: { stop_reason: stopMap[finish] || 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } }, 'message_delta');
    sse(res, { type: 'message_stop' }, 'message_stop');
    res.end();
    return;
  }

  const blocks = []; let think = '', text = '', finish = 'stop', usage = { input: 0, output: 0 };
  const calls = [];
  for await (const ev of run({ normalized, model, signal })) {
    if (ev.type === 'think') think += ev.text;
    else if (ev.type === 'text') text += ev.text;
    else if (ev.type === 'tool') calls.push({ type: 'tool_use', id: rid('toolu_'), name: ev.call.name, input: ev.call.arguments });
    else if (ev.type === 'end') { finish = ev.finish; usage = ev.usage; }
  }
  if (think) blocks.push({ type: 'thinking', thinking: think, signature: '' });
  if (text || !calls.length) blocks.push({ type: 'text', text });
  blocks.push(...calls);
  meta.usage = usage;
  return { id, type: 'message', role: 'assistant', model: name, content: blocks, stop_reason: stopMap[finish] || 'end_turn', stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output } };
}

module.exports = { openaiChat, anthropicMessages };
