(() => {
  "use strict";

  const composition = window.FocusBeatComposition;
  if (!composition) throw new Error("CompositionPlan 未加载");

  function create(options = {}) { return composition.toGuide(composition.create(options)); }
  function normalize(guide, fallback = {}) {
    if (guide?.compositionPlan) return composition.toGuide(composition.normalize(guide.compositionPlan, fallback));
    if (guide?.schemaVersion === 2 && guide.sections) return composition.toGuide(guide);
    // Legacy guides are retained for old songs, but new drafts always receive a real plan.
    if (guide?.slots) {
      const plan = composition.create({ style: guide.style || fallback.style || "pop", seed: guide.seed || fallback.seed || Date.now() });
      return { ...composition.toGuide(plan), legacySlots: guide.slots };
    }
    return create(fallback);
  }
  function sectionKind(header) { const value = String(header || ""); if (/副歌|chorus/i.test(value)) return /终章|尾|final/i.test(value) ? "outro" : "chorus"; if (/桥|bridge/i.test(value)) return "bridge"; if (/终章|尾奏|outro|final/i.test(value)) return "outro"; return "verse"; }
  function isHeader(line) { return /^\s*[\[【].+[\]】]\s*$/.test(String(line)); }
  function count(line) { return composition.slotCount(line); }
  function analyze(lyrics, rawGuide) {
    if (rawGuide && !rawGuide.compositionPlan && rawGuide.slots && rawGuide.schemaVersion !== 2) {
      const slots = rawGuide.slots; const positions = { verse: 0, chorus: 0, bridge: 0, outro: 0 }; let section = "verse"; const lines = [];
      String(lyrics || "").split(/\r?\n/).forEach((raw, index) => {
        const value = raw.trim(); if (!value) return; if (isHeader(value)) { section = sectionKind(value); return; }
        const targetList = Array.isArray(slots[section]) && slots[section].length ? slots[section] : [8]; const target = Number(targetList[Math.min(positions[section], targetList.length - 1)]) || 8; positions[section] += 1; const length = count(value); const delta = length - target; lines.push({ lineNumber: index + 1, text: value, section, target, length, delta, status: delta === 0 ? "fit" : delta > 0 ? "long" : "short", severe: Math.abs(delta) >= 4 });
      });
      const fit = lines.filter(line => line.status === "fit").length; return { guide: rawGuide, lines, total: lines.length, fit, issues: lines.length - fit, severe: lines.filter(line => line.severe).length, score: lines.length ? Math.round(fit / lines.length * 100) : 0 };
    }
    const guide = normalize(rawGuide); return composition.analyzeLyrics(lyrics, guide.compositionPlan || guide);
  }
  function description(rawGuide) { const guide = normalize(rawGuide); return composition.description(guide.compositionPlan || guide); }
  function prompt(rawGuide) { const guide = normalize(rawGuide); return composition.prompt(guide.compositionPlan || guide); }

  window.FocusBeatMelodyGuide = { create, normalize, analyze, description, prompt, count, sectionKind, isHeader };
})();
