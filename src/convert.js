'use strict';
// Normalises OpenAI / Anthropic requests into one shape, builds the single
// prompt string DeepSeek's web chat expects, and parses emulated tool calls.

const MODELS = {
  'deepseek-chat':            { thinking: false, search: false },
  'deepseek-reasoner':        { thinking: true,  search: false },
  'deepseek-chat-search':     { thinking: false, search: true },
  'deepseek-reasoner-search': { thinking: true,  search: true },
};

function resolveModel(name, { thinkingHint = false } = {}) {
  const n = String(name || '').toLowerCase();
  if (MODELS[n]) return { id: n, ...MODELS[n] };
  // Unknown names (gpt-*, claude-*, ...) fall back to chat; "think/reason/r1" opt in.
  const thinking = /reason|think|r1/.test(n) || thinkingHint;
  const search = /search/.test(n);
  return { id: thinking ? 'deepseek-reasoner' : 'deepseek-chat', thinking, search };
}

const textOf = (c) => {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => {
    if (typeof p === 'string') return p;
    if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') return p.text || '';
    if (p.type === 'image_url' || p.type === 'image') return '[image omitted: not supported]';
    if (p.type === 'tool_result') return textOf(p.content);
    return '';
  }).filter(Boolean).join('\n');
  return String(c);
};

// ---- OpenAI ------------------------------------------------------------------
function fromOpenAI(body) {
  const system = [], messages = [];
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') system.push(textOf(m.content));
    else if (m.role === 'tool') messages.push({ role: 'tool', id: m.tool_call_id, text: textOf(m.content) });
    else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant', text: textOf(m.content),
        calls: (m.tool_calls || []).map(t => ({ id: t.id, name: t.function.name, arguments: safeJSON(t.function.arguments) })),
      });
    } else messages.push({ role: 'user', text: textOf(m.content) });
  }
  const tools = (body.tools || []).filter(t => t.type === 'function' && t.function).map(t => ({
    name: t.function.name, description: t.function.description || '', schema: t.function.parameters || {},
  }));
  return { system: system.join('\n\n'), messages, tools: body.tool_choice === 'none' ? [] : tools };
}

// ---- Anthropic ---------------------------------------------------------------
function fromAnthropic(body) {
  const system = textOf(body.system);
  const messages = [];
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, text: m.content }); continue; }
    let text = [], calls = [];
    for (const b of m.content || []) {
      if (b.type === 'text') text.push(b.text || '');
      else if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, arguments: b.input || {} });
      else if (b.type === 'tool_result') messages.push({ role: 'tool', id: b.tool_use_id, text: textOf(b.content) });
      else if (b.type === 'image') text.push('[image omitted: not supported]');
    }
    if (text.length || calls.length) messages.push({ role: m.role, text: text.join('\n'), calls });
  }
  const tools = (body.tools || []).map(t => ({ name: t.name, description: t.description || '', schema: t.input_schema || {} }));
  return { system, messages, tools };
}

function safeJSON(s) { if (typeof s !== 'string') return s || {}; try { return JSON.parse(s); } catch { return {}; } }

// ---- Prompt ------------------------------------------------------------------
const TOOL_OPEN = '<tool_call>', TOOL_CLOSE = '</tool_call>';

function toolBlock(tools) {
  const list = tools.map(t => `- ${t.name}: ${(t.description || '').replace(/\s+/g, ' ').slice(0, 600)}\n  parameters (JSON schema): ${JSON.stringify(t.schema)}`).join('\n');
  return [
    'You can call tools. To call one, output exactly this on its own (valid JSON, no code fences):',
    `${TOOL_OPEN}{"name":"<tool name>","arguments":{...}}${TOOL_CLOSE}`,
    'The JSON must be strictly valid: escape every double quote inside a string value as \\" and every newline as \\n, and double each backslash in paths.',
    'You may output several tool calls in one reply. After the tool call(s), stop and wait; the results will arrive in the next message. If no tool is needed, just answer normally.',
    'Available tools:', list,
  ].join('\n');
}

function buildPrompt({ system, messages, tools }) {
  const parts = [];
  if (system) parts.push(`[System]\n${system}`);
  if (tools.length) parts.push(`[Tools]\n${toolBlock(tools)}`);
  const lines = messages.map(m => {
    if (m.role === 'tool') return `[Tool result${m.id ? ' ' + m.id : ''}]\n${m.text}`;
    if (m.role === 'assistant') {
      const calls = (m.calls || []).map(c => `${TOOL_OPEN}${JSON.stringify({ name: c.name, arguments: c.arguments })}${TOOL_CLOSE}`).join('\n');
      return `[Assistant]\n${[m.text, calls].filter(Boolean).join('\n')}`;
    }
    return `[User]\n${m.text}`;
  });
  if (messages.length === 1 && messages[0].role === 'user' && !system && !tools.length) return messages[0].text;
  // A last nudge right before the reply: on long agent prompts DeepSeek tends to announce
  // what it will do ("I'll check the files.") and stop without the call.
  if (tools.length) lines.push('[Reminder]\nIf you need a tool, put the tool call in this reply. Do not just say what you are about to do and stop.');
  parts.push(...lines, '[Assistant]');
  return 'Below is a conversation. Write only the next [Assistant] message.\n\n' + parts.join('\n\n');
}

// ---- Tool-call parsing ---------------------------------------------------------
// DeepSeek sometimes answers in its native "DSML" tool format instead of ours:
//   <｜DSML｜tool_calls><｜DSML｜invoke name="Read"><｜DSML｜parameter name="x" string="true">v</｜DSML｜parameter>…
// The pipe/space decoration varies, so match loosely.
const DSML_START = /<[｜|\s]*DSML/;
const DSML_BLOCK = /<[^<>\n]*?DSML[^<>\n]*?\binvoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[^<>\n]*?DSML[^<>\n]*?\binvoke\s*>/g;
const DSML_PARAM = /<[^<>\n]*?DSML[^<>\n]*?\bparameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/[^<>\n]*?DSML[^<>\n]*?\bparameter\s*>/g;
const DSML_WRAP = /<\/?[^<>\n]*?DSML[^<>\n]*?\b(?:function_)?calls?\s*>/g;

function parseDSML(text, names) {
  const calls = [];
  let rest = text.replace(DSML_BLOCK, (whole, name, inner) => {
    if (names.size && !names.has(name)) return whole;
    const args = {};
    for (const m of inner.matchAll(DSML_PARAM)) {
      const raw = m[3].replace(/^\n|\n$/g, '');
      const isStr = /string="true"/.test(m[2]);
      let v = raw;
      if (!isStr) { try { v = JSON.parse(raw); } catch {} }
      args[m[1]] = v;
    }
    calls.push({ name, arguments: args });
    return '';
  });
  if (calls.length) rest = rest.replace(DSML_WRAP, '');
  return { text: rest, calls };
}

// Index where a tool call begins in streamed text (either format), or -1.
function findToolStart(text) {
  const a = text.indexOf(TOOL_OPEN);
  const b = text.search(DSML_START);
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function parseToolCalls(text, tools) {
  const names = new Set(tools.map(t => t.name));
  const dsml = parseDSML(text, names);
  if (dsml.calls.length) text = dsml.text;
  const calls = [...dsml.calls];
  // <tool_call>{json}  — read the JSON object itself (balanced braces) so a missing or
  // wrong closing tag (e.g. DeepSeek closing with leftover DSML tags) doesn't lose the call.
  let rest = '', pos = 0;
  while (true) {
    const open = text.indexOf(TOOL_OPEN, pos);
    if (open < 0) { rest += text.slice(pos); break; }
    rest += text.slice(pos, open);
    const start = text.indexOf('{', open + TOOL_OPEN.length);
    const obj = start < 0 ? null : readObject(text, start);
    let consumed = false;
    if (obj) {
      try {
        const j = obj.value;
        const name = j.name || j.tool;
        if (name && (names.size === 0 || names.has(name))) {
          calls.push({ name, arguments: j.arguments ?? j.input ?? j.parameters ?? {} });
          consumed = true;
          pos = obj.end;
          // swallow whatever closing tags follow: </tool_call>, </｜DSML｜ parameter>, ...
          const tail = text.slice(pos).match(/^(?:\s*<\/[^<>\n]{0,40}>)+/);
          if (tail) pos += tail[0].length;
        }
      } catch {}
    }
    if (!consumed) { rest += TOOL_OPEN; pos = open + TOOL_OPEN.length; }
  }
  return { text: rest.trim(), calls };
}

// Parse the JSON object starting at text[start]. Strict first; if the model produced
// invalid JSON (unescaped quotes, raw newlines, bad backslashes) fall back to a repair scan.
function readObject(text, start) {
  const end = jsonObjectEnd(text, start);
  if (end > 0) { try { return { value: JSON.parse(text.slice(start, end)), end }; } catch {} }
  const fixed = repairObject(text, start);
  if (fixed) { try { return { value: JSON.parse(fixed.json), end: fixed.end }; } catch {} }
  return null;
}

// Scans a JSON-ish object and decides, per quote, whether it really closes a string
// (what follows must be structurally valid: ':' after a key, ',"key":' or '}' after a
// value) — otherwise the quote is treated as literal text and escaped.
function repairObject(text, start) {
  let out = '', inStr = false, isKey = false, expectKey = false;
  const stack = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (!inStr) {
      if (ch === '"') { inStr = true; isKey = stack[stack.length - 1] === '{' && expectKey; expectKey = false; out += ch; continue; }
      if (ch === '{') { stack.push('{'); expectKey = true; }
      else if (ch === '[') stack.push('[');
      else if (ch === '}' || ch === ']') { stack.pop(); if (!stack.length) return { json: out + ch, end: i + 1 }; }
      else if (ch === ',' && stack[stack.length - 1] === '{') expectKey = true;
      else if (ch === '<' && text[i + 1] === '/') return closeOpen(out, stack, i); // stray closing tag: the model forgot the last brace(s)
      out += ch; continue;
    }
    if (ch === '\\') {
      const n = text[i + 1];
      if (n !== undefined && '"\\/bfnrtu'.includes(n)) { out += ch + n; i++; } else out += '\\\\'; // e.g. C:\Users
      continue;
    }
    if (ch === '"') {
      const rest = text.slice(i + 1, i + 240);
      const top = stack[stack.length - 1];
      const closing = rest.trim() === '' ? true
        : isKey ? /^\s*:/.test(rest)
        : top === '{' ? /^\s*(,\s*"[^"\\\n]{1,80}"\s*:|\})/.test(rest)
        : /^\s*(,|\])/.test(rest);
      if (closing) { inStr = false; out += ch; } else out += '\\"';
      continue;
    }
    out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ch;
  }
  return inStr ? null : closeOpen(out, stack, text.length);
}

// Auto-close containers the model left open.
function closeOpen(out, stack, end) {
  if (!stack.length) return null;
  const json = out.replace(/[\s,]+$/, '') + stack.reverse().map(c => (c === '{' ? '}' : ']')).join('');
  return { json, end };
}

// Index just past the JSON object that starts at text[start] === '{', or -1.
function jsonObjectEnd(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

const estimateTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / 3.6));

module.exports = { MODELS, resolveModel, fromOpenAI, fromAnthropic, buildPrompt, parseToolCalls, findToolStart, estimateTokens, TOOL_OPEN };
