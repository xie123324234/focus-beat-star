(() => {
  "use strict";

  /*
   * CompositionPlan is the single source of truth for the song studio.
   * A note is not automatically a Chinese character: one syllable may own
   * several tied notes (melisma), and a phrase may contain rests.  The UI and
   * lyric generator therefore use syllableSlots, never raw note counts.
   */
  const STYLE_NAMES = { pop: "元气流行", rock: "热血摇滚", rap: "节奏说唱", folk: "清新民谣", classic: "梦幻古典" };
  const SECTIONS = ["verse", "chorus", "bridge", "outro"];
  const SECTION_LABELS = { verse: "主歌", chorus: "副歌", bridge: "桥段", outro: "终章副歌" };
  const BANK = {
    pop: [
      { name: "明亮上行", bpm: 108, key: "C Major", counts: { verse: [8, 8, 8, 8], chorus: [9, 9, 9, 9], bridge: [7, 7], outro: [9, 9, 9, 9] }, motif: [0, 1, 2, 1, 3, 2, 1, 0] },
      { name: "清晨跳拍", bpm: 114, key: "D Major", counts: { verse: [7, 8, 7, 8], chorus: [9, 9, 8, 8], bridge: [7, 7], outro: [9, 9, 8, 8] }, motif: [0, 0, 2, 1, 3, 3, 2, 1] },
      { name: "温暖回旋", bpm: 102, key: "G Major", counts: { verse: [8, 8, 7, 7], chorus: [8, 8, 9, 9], bridge: [7, 7], outro: [8, 8, 9, 9] }, motif: [0, 2, 1, 3, 2, 1, 0, 1] },
    ],
    rock: [
      { name: "推进上扬", bpm: 122, key: "A Major", counts: { verse: [8, 8, 8, 8], chorus: [9, 9, 9, 9], bridge: [8, 8], outro: [9, 9, 9, 9] }, motif: [0, 0, 1, 2, 2, 3, 2, 1] },
      { name: "高歌切分", bpm: 128, key: "E Major", counts: { verse: [7, 8, 7, 8], chorus: [10, 9, 10, 9], bridge: [8, 8], outro: [10, 9, 10, 9] }, motif: [0, 1, 0, 2, 3, 2, 1, 3] },
      { name: "坚定落点", bpm: 116, key: "D Major", counts: { verse: [8, 8, 8, 8], chorus: [9, 9, 8, 8], bridge: [7, 8], outro: [9, 9, 8, 8] }, motif: [0, 2, 2, 1, 3, 1, 0, 0] },
    ],
    rap: [
      { name: "切分律动", bpm: 94, key: "F Minor", counts: { verse: [11, 11, 10, 10], chorus: [8, 8, 8, 8], bridge: [8, 8], outro: [8, 8, 8, 8] }, motif: [0, 1, 1, 2, 0, 2, 3, 1] },
      { name: "轻快十拍", bpm: 102, key: "A Minor", counts: { verse: [10, 10, 10, 10], chorus: [8, 8, 9, 9], bridge: [8, 8], outro: [8, 8, 9, 9] }, motif: [0, 0, 1, 3, 2, 2, 1, 0] },
      { name: "说唱转歌", bpm: 98, key: "C Minor", counts: { verse: [10, 11, 10, 11], chorus: [9, 9, 9, 9], bridge: [8, 8], outro: [9, 9, 9, 9] }, motif: [0, 2, 0, 1, 3, 1, 2, 0] },
    ],
    folk: [
      { name: "叙事舒展", bpm: 86, key: "D Major", counts: { verse: [8, 8, 8, 8], chorus: [9, 9, 9, 9], bridge: [7, 7], outro: [9, 9, 9, 9] }, motif: [0, 1, 2, 2, 1, 0, 1, 0] },
      { name: "晚风回响", bpm: 80, key: "G Major", counts: { verse: [8, 8, 9, 9], chorus: [8, 8, 9, 9], bridge: [7, 7], outro: [8, 8, 9, 9] }, motif: [0, 2, 3, 2, 1, 1, 0, 1] },
      { name: "校园小调", bpm: 92, key: "C Major", counts: { verse: [7, 8, 7, 8], chorus: [8, 8, 8, 8], bridge: [7, 7], outro: [8, 8, 8, 8] }, motif: [0, 1, 3, 2, 1, 0, 2, 1] },
    ],
    classic: [
      { name: "钢琴流光", bpm: 76, key: "C Major", counts: { verse: [7, 8, 7, 8], chorus: [8, 8, 8, 8], bridge: [7, 7], outro: [8, 8, 8, 8] }, motif: [0, 2, 1, 3, 2, 1, 0, 1] },
      { name: "梦境回旋", bpm: 72, key: "D Major", counts: { verse: [8, 8, 8, 8], chorus: [9, 8, 9, 8], bridge: [7, 7], outro: [9, 8, 9, 8] }, motif: [0, 1, 3, 2, 1, 2, 0, 1] },
      { name: "星光叙事", bpm: 82, key: "G Major", counts: { verse: [7, 7, 8, 8], chorus: [8, 8, 9, 9], bridge: [7, 7], outro: [8, 8, 9, 9] }, motif: [0, 2, 2, 3, 1, 0, 1, 0] },
    ],
  };
  const SCALE = [0, 2, 4, 5, 7, 9, 11];

  function hash(value) { let result = 2166136261; for (const char of String(value)) { result ^= char.codePointAt(0); result = Math.imul(result, 16777619); } return result >>> 0; }
  function safeStyle(style) { return Object.hasOwn(BANK, style) ? style : "pop"; }
  function rootMidi(key) { const match = String(key).match(/^(C|D|E|F|G|A|B)/i); return ({ C: 60, D: 62, E: 64, F: 65, G: 67, A: 69, B: 71 }[(match?.[1] || "C").toUpperCase()] || 60); }
  function slotCount(line) { return Array.from(String(line || "").replace(/[\s，。！？、；：,.!?~～—-]/g, "")).length; }

  function makePhrase({ section, index, count, motif, root, bpm }) {
    const notes = []; const syllableSlots = []; let cursor = 0;
    const phraseBeats = Math.max(6, Math.ceil(count / 2) * 2);
    for (let i = 0; i < count; i += 1) {
      const remaining = count - i;
      const duration = i === count - 1 ? 1.5 : (remaining === 2 ? 1.5 : 1);
      const noteIndexes = [];
      const noteCount = i === count - 1 && (index + count) % 3 === 0 ? 2 : 1;
      for (let n = 0; n < noteCount; n += 1) {
        const degree = motif[(i + n + index) % motif.length] + (section === "chorus" || section === "outro" ? 1 : 0);
        noteIndexes.push(notes.length);
        notes.push({ pitch: root + SCALE[degree % SCALE.length] + (degree >= 7 ? 12 : 0), startBeat: cursor, durationBeats: duration / noteCount });
        cursor += duration / noteCount;
      }
      syllableSlots.push({ id: `${section}.${index + 1}.s${i + 1}`, noteIndexes, startBeat: notes[noteIndexes[0]].startBeat, durationBeats: duration, melisma: noteCount > 1 });
    }
    while (cursor < phraseBeats) { notes.push({ pitch: root, startBeat: cursor, durationBeats: Math.min(1, phraseBeats - cursor), rest: true }); cursor += Math.min(1, phraseBeats - cursor); }
    return { id: `${section}.${index + 1}`, section, index, bpm, durationBeats: phraseBeats, notes, syllableSlots, syllableCount: syllableSlots.length };
  }

  function create({ style = "pop", seed = Date.now() } = {}) {
    const safe = safeStyle(style); const choices = BANK[safe]; const numericSeed = Number(seed) || Date.now(); const template = choices[hash(`${safe}|${numericSeed}`) % choices.length]; const root = rootMidi(template.key);
    const sections = {}; const phrases = [];
    for (const section of SECTIONS) {
      const baseCounts = template.counts[section];
      // New songs use a fuller two-minute structure while old saved plans keep
      // their original phrase map. Both verse sections reuse these six slots.
      const counts = section === "verse" ? [...baseCounts, ...baseCounts.slice(0, 2)] : section === "bridge" ? [...baseCounts, baseCounts[0]] : baseCounts;
      sections[section] = counts.map((count, index) => { const phrase = makePhrase({ section, index, count, motif: template.motif, root, bpm: template.bpm }); phrases.push(phrase); return phrase; });
    }
    const plan = { schemaVersion: 2, planId: `plan_${safe}_${hash(`${safe}|${numericSeed}`).toString(36)}`, style: safe, styleName: STYLE_NAMES[safe], seed: numericSeed, name: template.name, bpm: template.bpm, key: template.key, timeSignature: "4/4", sections, phrases, slotCounts: Object.fromEntries(SECTIONS.map(section => [section, sections[section].map(phrase => phrase.syllableCount)])), createdAt: new Date().toISOString() };
    return plan;
  }

  function normalize(plan, fallback = {}) {
    if (plan && typeof plan === "object" && plan.schemaVersion === 2 && plan.sections) return plan;
    return create({ style: plan?.style || fallback.style || "pop", seed: plan?.seed || fallback.seed || Date.now() });
  }

  function compactPlan(plan) {
    const value = normalize(plan); const sections = {};
    for (const section of SECTIONS) {
      sections[section] = (value.sections[section] || []).map(phrase => ({ id: phrase.id, durationBeats: phrase.durationBeats, notes: (phrase.notes || []).map(note => ({ pitch: note.pitch, startBeat: note.startBeat, durationBeats: note.durationBeats, ...(note.rest ? { rest: true } : {}) })), syllableSlots: (phrase.syllableSlots || []).map(slot => ({ id: slot.id, startBeat: slot.startBeat, durationBeats: slot.durationBeats, ...(slot.melisma ? { melisma: true } : {}) })) }));
    }
    return { schemaVersion: 2, planId: value.planId, style: value.style, seed: value.seed, name: value.name, bpm: value.bpm, key: value.key, sections };
  }
  function flatten(plan) { const value = normalize(plan); return value.phrases?.length ? value.phrases : SECTIONS.flatMap(section => (value.sections[section] || []).map(phrase => ({ ...phrase, section }))); }
  function toGuide(plan) {
    const value = normalize(plan); const compact = compactPlan(value); return { schemaVersion: 2, planId: compact.planId, style: compact.style, seed: compact.seed, name: compact.name, bpm: compact.bpm, key: compact.key, slots: value.slotCounts || slotCountsFor(value), compositionPlan: compact };
  }

  function phraseForLine(plan, section, index) { const value = normalize(plan); const list = value.sections[section] || value.sections.verse; return list[Math.min(index, list.length - 1)]; }
  function analyzeLyrics(lyrics, plan) {
    const value = normalize(plan); const positions = { verse: 0, chorus: 0, bridge: 0, outro: 0 }; let section = "verse"; const lines = [];
    String(lyrics || "").split(/\r?\n/).forEach((raw, index) => {
      const text = raw.trim(); if (!text) return;
      if (/^\s*[\[【].+[\]】]\s*$/.test(text)) { if (/副歌|chorus/i.test(text)) section = /终章|尾|final/i.test(text) ? "outro" : "chorus"; else if (/桥|bridge/i.test(text)) section = "bridge"; else section = "verse"; positions[section] = 0; return; }
      const phrase = phraseForLine(value, section, positions[section]); positions[section] += 1; const target = Number(phrase?.syllableCount) || phrase?.syllableSlots?.length || 0; const length = slotCount(text); const delta = length - target; const status = !target ? "unknown" : delta === 0 ? "fit" : delta > 0 ? "long" : "short";
      lines.push({ lineNumber: index + 1, text, section, phraseId: phrase?.id || `${section}.${positions[section]}`, target, length, delta, status, severe: Math.abs(delta) >= 4, melisma: phrase?.syllableSlots?.filter(slot => slot.melisma).length || 0 });
    });
    const fit = lines.filter(line => line.status === "fit").length; return { plan: value, lines, total: lines.length, fit, issues: lines.filter(line => line.status !== "fit").length, severe: lines.filter(line => line.severe).length, score: lines.length ? Math.round(fit / lines.length * 100) : 0 };
  }

  function slotCountsFor(plan) { const value = normalize(plan); return value.slotCounts || Object.fromEntries(SECTIONS.map(section => [section, (value.sections[section] || []).map(phrase => (phrase.syllableSlots || []).length)])); }
  function description(plan) { const value = normalize(plan); const slots = slotCountsFor(value); return `${value.name} · ${value.bpm} BPM · ${value.key} · 主歌 ${slots.verse.join("/")} 音节位 · 副歌 ${slots.chorus.join("/")} 音节位`; }
  function prompt(plan) { const value = normalize(plan); const slots = slotCountsFor(value); return `固定曲调规格：${value.name}，${value.bpm} BPM，${value.key}。这是结构化曲调，不要重新创作旋律。主歌音节位 ${slots.verse.join("/")}；副歌 ${slots.chorus.join("/")}；桥段 ${slots.bridge.join("/")}；终章副歌 ${slots.outro.join("/")}。一个汉字对应一个音节位，拖音位已在乐谱中标记。`; }

  window.FocusBeatComposition = { create, normalize, toGuide, compactPlan, flatten, analyzeLyrics, description, prompt, slotCount, phraseForLine, styleNames: STYLE_NAMES };
})();
