import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const storage = new Map();
const localStorage = { getItem:key => storage.get(key) ?? null, setItem:(key,value) => storage.set(key,String(value)) };
const sandbox = { window:{}, localStorage, crypto:globalThis.crypto, Uint32Array, Math };
vm.runInNewContext(fs.readFileSync(fileURLToPath(new URL("../theme-content.js",import.meta.url)),"utf8"),sandbox);
const library = sandbox.window.FocusBeatThemeContent;
const counts = library.counts();
assert.deepEqual(Object.keys(counts),["sunny","candy","cosmos","pixel","journal","forest"]);
for (const [theme,count] of Object.entries(counts)) {
  assert.equal(count,50,`${theme} should contain exactly 50 entries`);
  const items=library.all(theme); assert.equal(new Set(items.map(item=>item.id)).size,50,`${theme} IDs should be unique`);
  assert(items.every(item=>item.title && item.text && item.typeName),`${theme} contains an incomplete entry`);
  storage.clear(); const cycle=Array.from({length:50},()=>library.next(theme));
  assert.equal(new Set(cycle.map(item=>item.id)).size,50,`${theme} repeated before exhausting its deck`);
  assert.equal(cycle.at(-1).remaining,0,`${theme} progress did not reach zero`);
}
console.log("PASS six local theme libraries contain 300 complete non-repeating entries");
