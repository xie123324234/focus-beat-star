(() => {
  "use strict";

  // 本地拟唱：伴奏由 Web Audio 合成，歌词用浏览器中文语音按短句、音高和节拍调度。
  // 它不是云端真人演唱，但即使离线也能让歌词跟着旋律走。
  const profiles = {
    pop: { label: "元气流行", bpm: [102, 108, 114, 118], roots: [60, 62, 65, 67], scale: [0, 2, 4, 7, 9], progressions: [[0, 5, 3, 4], [0, 3, 4, 5], [0, 4, 5, 3], [0, 5, 4, 3]], wave: "triangle", lead: .052, swing: 0, speechRate: .94, drum: "pop" },
    rock: { label: "热血摇滚", bpm: [116, 122, 128, 134], roots: [55, 57, 59, 62], scale: [0, 3, 5, 7, 10], progressions: [[0, 5, 3, 6], [0, 3, 5, 4], [0, 6, 5, 3], [0, 4, 5, 6]], wave: "sawtooth", lead: .045, swing: 0, speechRate: 1.04, drum: "rock" },
    rap: { label: "节奏说唱", bpm: [88, 94, 98, 104], roots: [55, 58, 60, 62], scale: [0, 3, 5, 7, 10], progressions: [[0, 3, 5, 4], [0, 5, 3, 4], [0, 6, 4, 5], [0, 4, 3, 5]], wave: "square", lead: .032, swing: .075, speechRate: 1.13, drum: "rap" },
    folk: { label: "清新民谣", bpm: [78, 84, 88, 94], roots: [60, 62, 64, 67], scale: [0, 2, 4, 7, 9], progressions: [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 0], [0, 4, 0, 5]], wave: "triangle", lead: .044, swing: .028, speechRate: .86, drum: "folk" },
    classic: { label: "梦幻古典", bpm: [70, 76, 80, 86], roots: [57, 60, 62, 65], scale: [0, 2, 3, 7, 8], progressions: [[0, 5, 3, 4], [0, 3, 4, 0], [0, 4, 5, 3], [0, 5, 4, 3]], wave: "sine", lead: .048, swing: 0, speechRate: .8, drum: "classic" },
  };

  let audioContext = null;
  let active = null;
  let playbackCounter = 0;
  const diagnostics = { sourceCount: 0, fullDuration: 0, playDuration: 0, fraction: 0, style: "", lyricCues: 0, speechCues: 0, voiceEnabled: false };

  function hash(value) { return window.FocusBeatAI?.hashString(value) ?? [...String(value)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7); }
  function randomFrom(seed) {
    let value = seed >>> 0;
    return () => { value += 0x6d2b79f5; let next = value; next = Math.imul(next ^ next >>> 15, next | 1); next ^= next + Math.imul(next ^ next >>> 7, next | 61); return ((next ^ next >>> 14) >>> 0) / 4294967296; };
  }
  function lyricLines(lyrics) { return String(lyrics || "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[[【].+[\]】]$/.test(line) && !/^《.+》$/.test(line)).slice(0, 24); }
  function cleanChars(line) { return [...String(line || "").replace(/[，。！？、；：,.!?\s—-]/g, "")]; }
  function phraseParts(line) {
    const chars = cleanChars(line); if (!chars.length) return [String(line || "")];
    const parts = []; const size = chars.length <= 5 ? 2 : chars.length <= 10 ? 3 : 4;
    for (let index = 0; index < chars.length; index += size) parts.push(chars.slice(index, index + size).join(""));
    return parts.slice(0, 8);
  }
  function pick(list, random) { return list[Math.floor(random() * list.length)] ?? list[0]; }

  function createBlueprint({ title, style, lyrics, seed }) {
    const profile = profiles[style] || profiles.pop;
    const safeSeed = Number(seed) || Date.now(); const random = randomFrom(hash(`${title}|${style}|${lyrics}|${safeSeed}`));
    const bpm = pick(profile.bpm, random); const root = pick(profile.roots, random); const progression = pick(profile.progressions, random); const variant = Math.floor(random() * 4) + 1;
    const lines = lyricLines(lyrics); const usableLines = lines.length ? lines : [title || "今天我会发光"];
    const beatsPerLine = style === "rap" ? 6 : 8; const lead = []; const cues = []; const vocalCues = []; let cursor = 0;
    usableLines.forEach((line, lineIndex) => {
      const characters = cleanChars(line); const pieces = phraseParts(line); const phraseBeats = beatsPerLine - (style === "rap" ? .35 : .75); const charBeats = phraseBeats / Math.max(characters.length, 1); const chordDegree = progression[lineIndex % progression.length];
      let characterCursor = 0; const phraseNotes = [];
      pieces.forEach((piece, phraseIndex) => {
        const pieceChars = cleanChars(piece); const notes = [];
        pieceChars.forEach((character, index) => {
          const globalIndex = characterCursor + index; const contour = Math.sin((globalIndex / Math.max(characters.length - 1, 1)) * Math.PI);
          const degreeIndex = Math.max(0, Math.min(profile.scale.length - 1, Math.floor(random() * profile.scale.length + contour * 1.35)));
          let note = root + profile.scale[degreeIndex] + (random() > .86 ? 12 : 0);
          if (globalIndex === characters.length - 1) note = root + profile.scale[(chordDegree + 2) % profile.scale.length];
          const start = cursor + globalIndex * charBeats + (globalIndex % 2 ? profile.swing : 0); const duration = Math.max(.16, charBeats * (style === "rap" ? .56 : .78));
          lead.push({ start, duration, note, text: character, lineIndex }); notes.push(note);
        });
        const phraseStart = cursor + characterCursor * charBeats; const phraseDuration = Math.max(.26, pieceChars.length * charBeats * .94); const average = notes.reduce((sum, note) => sum + note, 0) / Math.max(1, notes.length);
        vocalCues.push({ text: piece, start: phraseStart, duration: phraseDuration, pitchMidi: average, isChorus: lineIndex % 4 === 2 || /唱|发光|加油|一起/.test(line), lineIndex, phraseIndex });
        phraseNotes.push(...notes); characterCursor += pieceChars.length;
      });
      cues.push({ line, start: cursor, duration: phraseBeats, pitch: phraseNotes.reduce((sum, note) => sum + note, 0) / Math.max(phraseNotes.length, 1) }); cursor += beatsPerLine;
    });
    const totalBeats = Math.max(cursor, 16); const chords = []; const bass = [];
    for (let beat = 0, chordIndex = 0; beat < totalBeats; beat += 4, chordIndex += 1) {
      const degree = progression[chordIndex % progression.length]; const chordRoot = root - 12 + profile.scale[degree % profile.scale.length];
      chords.push({ start: beat, duration: 3.8, notes: [chordRoot, chordRoot + (style === "classic" ? 3 : 4), chordRoot + 7] });
      bass.push({ start: beat, duration: 1.55, note: chordRoot - 12 }, { start: beat + 2, duration: 1.4, note: chordRoot - 5 });
    }
    return { version: 3, title: String(title || "未命名歌曲").slice(0, 32), style: Object.hasOwn(profiles, style) ? style : "pop", styleLabel: profile.label, seed: safeSeed, bpm, root, variant, totalBeats, duration: Number((totalBeats * 60 / bpm + 1.2).toFixed(3)), lead, chords, bass, cues, vocalCues, fingerprint: hash(`${style}|${lyrics}|${safeSeed}|${variant}|${bpm}|${root}`).toString(16) };
  }

  function ensureAudio() { if (!audioContext) { const AudioCtor = window.AudioContext || window.webkitAudioContext; if (!AudioCtor) throw new Error("当前浏览器不支持音频播放"); audioContext = new AudioCtor(); } if (audioContext.state === "suspended") audioContext.resume(); return audioContext; }
  function midiToFrequency(note) { return 440 * 2 ** ((note - 69) / 12); }
  function track(source) { if (!active) return source; active.sources.push(source); diagnostics.sourceCount += 1; return source; }
  function tone(ctx, destination, start, duration, note, wave, volume, attack = .018, release = .1) { const oscillator = track(ctx.createOscillator()); const gain = ctx.createGain(); oscillator.type = wave; oscillator.frequency.setValueAtTime(midiToFrequency(note), start); gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(Math.max(.001, volume), start + attack); gain.gain.setValueAtTime(Math.max(.001, volume * .88), Math.max(start + attack, start + duration - release)); gain.gain.exponentialRampToValueAtTime(.0001, start + duration); oscillator.connect(gain).connect(destination); oscillator.start(start); oscillator.stop(start + duration + .03); }
  function kick(ctx, destination, start, volume = .32) { const oscillator = track(ctx.createOscillator()); const gain = ctx.createGain(); oscillator.frequency.setValueAtTime(135, start); oscillator.frequency.exponentialRampToValueAtTime(48, start + .12); gain.gain.setValueAtTime(volume, start); gain.gain.exponentialRampToValueAtTime(.0001, start + .2); oscillator.connect(gain).connect(destination); oscillator.start(start); oscillator.stop(start + .22); }
  function noise(ctx, destination, start, duration, volume, highpass = 2500) { const length = Math.max(1, Math.floor(ctx.sampleRate * duration)); const buffer = ctx.createBuffer(1, length, ctx.sampleRate); const data = buffer.getChannelData(0); for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1; const source = track(ctx.createBufferSource()); const filter = ctx.createBiquadFilter(); const gain = ctx.createGain(); source.buffer = buffer; filter.type = "highpass"; filter.frequency.value = highpass; gain.gain.setValueAtTime(volume, start); gain.gain.exponentialRampToValueAtTime(.0001, start + duration); source.connect(filter).connect(gain).connect(destination); source.start(start); source.stop(start + duration + .02); }

  function selectChineseVoice() { if (!("speechSynthesis" in window)) return null; const voices = window.speechSynthesis.getVoices(); return voices.find(voice => /^zh-CN/i.test(voice.lang) && voice.localService) || voices.find(voice => /^zh/i.test(voice.lang)) || null; }
  function speechPitch(midi) { return Math.max(.7, Math.min(1.55, 1 + (Number(midi) - 60) / 25)); }
  function scheduleLyrics(blueprint, startAt, secondsPerBeat, playDuration, token, onLyric, vocal) {
    for (const cue of blueprint.cues || []) { const cueTime = cue.start * secondsPerBeat; if (cueTime >= playDuration) break; const timer = setTimeout(() => { if (!active || active.token !== token) return; onLyric?.(cue.line); }, Math.max(0, (startAt - audioContext.currentTime + cueTime) * 1000)); active.timers.push(timer); diagnostics.lyricCues += 1; }
    if (!vocal || !("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") return;
    const voice = selectChineseVoice();
    for (const cue of blueprint.vocalCues || []) { const cueTime = cue.start * secondsPerBeat; if (cueTime >= playDuration) break; const timer = setTimeout(() => { if (!active || active.token !== token) return; const utterance = new SpeechSynthesisUtterance(cue.text); utterance.lang = voice?.lang || "zh-CN"; if (voice) utterance.voice = voice; utterance.pitch = speechPitch(cue.pitchMidi) + (cue.isChorus ? .06 : 0); utterance.rate = Math.max(.72, Math.min(1.45, (profiles[blueprint.style] || profiles.pop).speechRate * (cue.isChorus ? 1.035 : 1))); utterance.volume = cue.isChorus ? 1 : .88; window.speechSynthesis.speak(utterance); }, Math.max(0, (startAt - audioContext.currentTime + cueTime - .035) * 1000)); active.timers.push(timer); diagnostics.speechCues += 1; }
  }
  function stop({ notify = true } = {}) { if (!active) return; const previous = active; active = null; previous.sources.forEach(source => { try { source.stop(); } catch (_) {} try { source.disconnect(); } catch (_) {} }); previous.timers.forEach(timer => clearTimeout(timer)); try { previous.master.disconnect(); } catch (_) {} if ("speechSynthesis" in window) window.speechSynthesis.cancel(); if (notify) previous.onState?.("stopped"); }

  async function play(blueprint, options = {}) {
    stop({ notify: true }); const ctx = ensureAudio(); await ctx.resume(); const fraction = Math.min(1, Math.max(.05, Number(options.fraction) || .3)); const profile = profiles[blueprint.style] || profiles.pop; const fullDuration = Number(blueprint.duration) || 20; const playDuration = Math.max(3, fullDuration * fraction); const secondsPerBeat = 60 / blueprint.bpm; const startAt = ctx.currentTime + .09; const token = ++playbackCounter;
    const master = ctx.createGain(); const compressor = ctx.createDynamicsCompressor(); master.gain.value = .64; compressor.threshold.value = -16; compressor.knee.value = 22; compressor.ratio.value = 5; master.connect(compressor).connect(ctx.destination); active = { token, sources: [], timers: [], master, onState: options.onState };
    diagnostics.sourceCount = 0; diagnostics.fullDuration = fullDuration; diagnostics.playDuration = playDuration; diagnostics.fraction = fraction; diagnostics.style = blueprint.style; diagnostics.lyricCues = 0; diagnostics.speechCues = 0; diagnostics.voiceEnabled = Boolean(options.vocal !== false && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function");
    const within = beat => beat * secondsPerBeat < playDuration;
    blueprint.chords.forEach(chord => { if (!within(chord.start)) return; const duration = Math.min(chord.duration * secondsPerBeat, playDuration - chord.start * secondsPerBeat + .05); chord.notes.forEach(note => tone(ctx, master, startAt + chord.start * secondsPerBeat, Math.max(.08, duration), note, profile.wave === "sawtooth" ? "square" : "sine", blueprint.style === "rock" ? .024 : .032, .08, .28)); });
    blueprint.bass.forEach(item => { if (!within(item.start)) return; const duration = Math.min(item.duration * secondsPerBeat, playDuration - item.start * secondsPerBeat + .03); tone(ctx, master, startAt + item.start * secondsPerBeat, Math.max(.06, duration), item.note, "triangle", .065, .015, .09); });
    blueprint.lead.forEach(item => { if (!within(item.start)) return; const duration = Math.min(item.duration * secondsPerBeat, playDuration - item.start * secondsPerBeat + .02); tone(ctx, master, startAt + item.start * secondsPerBeat, Math.max(.05, duration), item.note, profile.wave, profile.lead, .015, .07); });
    for (let beat = 0; beat < blueprint.totalBeats; beat += .5) { if (!within(beat)) break; const time = startAt + beat * secondsPerBeat; if (beat % 4 === 0 || (profile.drum === "rock" && beat % 2 === 0)) kick(ctx, master, time, profile.drum === "rock" ? .34 : .24); if (beat % 4 === 2) noise(ctx, master, time, .11, profile.drum === "rap" ? .13 : .09, 1100); if (beat % 1 === 0) noise(ctx, master, time, .035, profile.drum === "folk" ? .025 : .04, 4800); }
    scheduleLyrics(blueprint, startAt, secondsPerBeat, playDuration, token, options.onLyric, options.vocal !== false);
    const finishTimer = setTimeout(() => { if (!active || active.token !== token) return; const callback = active.onState; stop({ notify: false }); callback?.("ended"); }, (playDuration + .25) * 1000); active.timers.push(finishTimer); options.onState?.("playing"); return { fullDuration, playDuration, fraction, sourceCount: diagnostics.sourceCount, speechCues: diagnostics.speechCues };
  }
  function isPlaying() { return Boolean(active); }
  function styleLabel(style) { return (profiles[style] || profiles.pop).label; }
  window.FocusBeatMusic = { createBlueprint, play, stop, isPlaying, styleLabel, profiles, diagnostics };
})();
