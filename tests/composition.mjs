import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("../composition-plan.js", import.meta.url), "utf8"), context);
vm.runInContext(fs.readFileSync(new URL("../melody-guide.js", import.meta.url), "utf8"), context);
const guideApi = context.window.FocusBeatMelodyGuide;

const first = guideApi.create({ style: "pop", seed: 1 });
const second = guideApi.create({ style: "pop", seed: 2 });
assert.equal(first.compositionPlan.schemaVersion, 2);
assert.notEqual(first.compositionPlan.planId, second.compositionPlan.planId);
assert.equal(JSON.stringify(first.slots), JSON.stringify({ verse: [7, 8, 7, 8, 7, 8], chorus: [9, 9, 8, 8], bridge: [7, 7, 7], outro: [9, 9, 8, 8] }));

const sevenSyllables = "清晨光落在书页";
const report = guideApi.analyze(`[主歌 A]\n${sevenSyllables}`, first);
assert.equal(report.lines[0].target, 7);
assert.equal(report.lines[0].length, 7);
assert.equal(report.issues, 0);

const repeatedVerse = guideApi.analyze(`[主歌 A]\n清晨光落在书页\n[主歌 B]\n分数题变得简单`, first);
assert.equal(repeatedVerse.lines[1].target, 7, "主歌 B 应从主歌曲调的第一个音节位重新开始");

const melismaPhrase = first.compositionPlan.sections.verse[1];
assert.ok(melismaPhrase.syllableSlots.some(slot => slot.melisma), "曲调应包含至少一个拖音位");
console.log("PASS composition plan contracts");
