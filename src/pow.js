'use strict';
// DeepSeek web proof-of-work solver (WASM, DeepSeekHashV1).
// Approach adapted from ForgetMeAI/FreeDeepseekAPI (MIT).
// The compiled module is cached; every solve gets a fresh instance.
const cache = new Map();

async function loadModule(url) {
  if (!url) throw new Error('PoW: missing wasm url');
  if (!cache.has(url)) {
    const p = (async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`PoW: wasm download failed (HTTP ${r.status})`);
      return WebAssembly.compile(await r.arrayBuffer());
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return cache.get(url);
}

async function solve(ch, wasmUrl) {
  const mod = await loadModule(wasmUrl);
  const inst = await WebAssembly.instantiate(mod, { wbg: {} });
  const e = inst.exports;
  const enc = new TextEncoder();
  const c = enc.encode(ch.challenge);
  const p = enc.encode(`${ch.salt}_${ch.expire_at}_`);
  const cp = e.__wbindgen_export_0(c.length, 1) >>> 0;
  const pp = e.__wbindgen_export_0(p.length, 1) >>> 0;
  new Uint8Array(e.memory.buffer, cp, c.length).set(c);
  new Uint8Array(e.memory.buffer, pp, p.length).set(p);
  const sp = e.__wbindgen_add_to_stack_pointer(-16);
  e.wasm_solve(sp, cp, c.length, pp, p.length, ch.difficulty);
  const dv = new DataView(e.memory.buffer);
  const code = dv.getInt32(sp, true);
  const ans = dv.getFloat64(sp + 8, true);
  e.__wbindgen_add_to_stack_pointer(16);
  if (code === 0 || !Number.isFinite(ans) || ans < 0) throw new Error('PoW: no solution found');
  return Math.floor(ans);
}

module.exports = { solve };
