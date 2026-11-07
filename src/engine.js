'use strict';
// Protocol-agnostic runner: DeepSeek deltas in, normalised events out.
//   {type:'think',text} {type:'text',text} {type:'tool',call} {type:'end',finish,usage}
const ds = require('./deepseek');
const { buildPrompt, parseToolCalls, findToolStart, estimateTokens } = require('./convert');

// After search mode fails on a prompt, skip search for prompts at least that long for a while,
// instead of paying for a failed request every turn (agent prompts only grow).
const SEARCH_BACKOFF_MS = 15 * 60 * 1000;
const searchFail = { at: 0, len: Infinity };
const searchLooksBroken = (len) => Date.now() - searchFail.at < SEARCH_BACKOFF_MS && len >= searchFail.len;

async function* run({ normalized, model, signal }) {
  const { tools } = normalized;
  const prompt = buildPrompt(normalized);
  if (process.env.DSB_DEBUG_SSE) try { require('fs').writeFileSync(require('path').join(require('./config').DATA_DIR, 'last-prompt.txt'), prompt); } catch {}
  let full = '', emitted = 0, thinkLen = 0, finish = 'stop', sawTool = false;
  const hold = 12; // keep a tail back so a half-streamed "<｜DSML" / "<tool_call>" marker isn't emitted as text

  // DeepSeek sometimes fails a reply outright ("Server is temporarily unavailable"), most often
  // in search mode on long agent prompts. If nothing has been answered yet, try once more, without search.
  let search = model.search && !searchLooksBroken(prompt.length);
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const ev of ds.complete({ prompt, thinking: model.thinking, search, signal })) {
        if (ev.done) { finish = ev.finish; break; }
        if (ev.think) { thinkLen += ev.think.length; yield { type: 'think', text: ev.think }; }
        if (!ev.text) continue;
        full += ev.text;
        if (!tools.length) { yield { type: 'text', text: ev.text }; emitted = full.length; continue; }
        // Tools active: stream plain text, but stop at the first <tool_call>.
        if (sawTool) continue;
        const idx = findToolStart(full);
        if (idx >= 0) { sawTool = true; if (idx > emitted) yield { type: 'text', text: full.slice(emitted, idx) }; emitted = idx; continue; }
        const safe = full.length - hold;
        if (safe > emitted) { yield { type: 'text', text: full.slice(emitted, safe) }; emitted = safe; }
      }
      break;
    } catch (e) {
      if (!e.retryable || full || attempt >= 1 || (signal && signal.aborted)) throw e;
      if (search) {
        const active = Date.now() - searchFail.at < SEARCH_BACKOFF_MS;
        searchFail.len = active ? Math.min(searchFail.len, prompt.length) : prompt.length;
        searchFail.at = Date.now();
      }
      search = false;
      if (thinkLen) yield { type: 'think', text: '\n\n' };
    }
  }

  let calls = [];
  if (tools.length) {
    const parsed = parseToolCalls(full, tools);
    calls = parsed.calls;
    // Keep the raw reply of the latest tool-enabled request for debugging (data/last-raw.txt).
    try {
      const dir = require('./config').DATA_DIR;
      require('fs').writeFileSync(require('path').join(dir, 'last-raw.txt'),
        `parsed_calls=${calls.length}\n----- RAW -----\n${full}\n`);
    } catch {}
    if (!sawTool && emitted < full.length) yield { type: 'text', text: full.slice(emitted) };
    // Tool-call text that failed to parse: surface it rather than swallow it.
    if (sawTool && !calls.length) yield { type: 'text', text: full.slice(emitted) };
    for (const c of calls) yield { type: 'tool', call: c };
  }
  yield {
    type: 'end',
    finish: calls.length ? 'tool_calls' : finish,
    usage: { input: estimateTokens(prompt), output: estimateTokens(full) + Math.ceil(thinkLen / 3.6) },
  };
}

module.exports = { run, _searchFail: searchFail };
