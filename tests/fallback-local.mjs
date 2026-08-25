import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const engine = fs.readFileSync(new URL("../music-engine.js", import.meta.url), "utf8");

assert.match(app, /function createLocalFallbackPreview/);
assert.match(app, /mode: "local-fallback"/);
assert.match(app, /provider: "browser-synth"/);
assert.match(app, /localFallback: fallback/);
assert.match(app, /function startLocalGlobalPlayer/);
assert.match(app, /isLocalFallback\(item\)/);
assert.match(engine, /vocalCues/);
assert.match(engine, /speechSynthesis/);
console.log("PASS local electronic fallback and browser vocal contracts");
