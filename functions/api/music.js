const ACTIONS = new Set(["preview", "complete", "status", "delete"]);
const DEFAULT_ACE_BASE_URL = "https://api.acemusic.ai";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com";
const DEFAULT_TREBLO_BASE_URL = "https://api.treblo.com/v1";
const PREVIEW_DURATION = 30;
const DEFAULT_FULL_DURATION = 60;
const DEFAULT_SYNC_MAX_DURATION = 60;
const DEFAULT_TREBLO_TARGET_DURATION = 120;
const DEFAULT_CLOUD_INFERENCE_STEPS = 5;
const MAX_AUDIO_BYTES = 28 * 1024 * 1024;

function clean(value, limit = 2400) { return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, limit); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function hash(value) { let result = 2166136261; for (const char of String(value)) { result ^= char.codePointAt(0); result = Math.imul(result, 16777619); } return result >>> 0; }
function token() { return crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`; }
function jobId() { return `ace_${token().slice(0, 24)}`; }
function musicProvider(env) {
  const configured = String(env.MUSIC_PROVIDER || "").trim().toLowerCase();
  if (["treblo", "melodia"].includes(configured)) return "treblo";
  if (["minimax", "minimaxi"].includes(configured)) return "minimax";
  if (["ace", "acemusic", "ace-step"].includes(configured)) return "acemusic";
  return env.MINIMAX_API_KEY ? "minimax" : "acemusic";
}
function providerLabel(env) { return musicProvider(env) === "treblo" ? "Treblo Melodia" : musicProvider(env) === "minimax" ? "MiniMax Music" : "ACE Music"; }
function baseUrl(env) { return String(env.ACEMUSIC_BASE_URL || DEFAULT_ACE_BASE_URL).replace(/\/$/, ""); }
function minimaxBaseUrl(env) { return String(env.MINIMAX_BASE_URL || DEFAULT_MINIMAX_BASE_URL).replace(/\/$/, ""); }
function trebloBaseUrl(env) { return String(env.TREBLO_BASE_URL || DEFAULT_TREBLO_BASE_URL).replace(/\/$/, ""); }
function fullDuration(env) { const value = Number(env.ACEMUSIC_DURATION); return Number.isFinite(value) ? Math.min(120, Math.max(45, Math.round(value))) : DEFAULT_FULL_DURATION; }
function previewDuration(env) { const value = Number(env.ACEMUSIC_PREVIEW_DURATION); return Number.isFinite(value) ? Math.min(PREVIEW_DURATION, Math.max(20, Math.round(value))) : PREVIEW_DURATION; }
function syncMaxDuration(env) { const value = Number(env.ACEMUSIC_MAX_SYNC_DURATION); return Number.isFinite(value) ? Math.min(75, Math.max(45, Math.round(value))) : DEFAULT_SYNC_MAX_DURATION; }
function trebloTargetDuration(env, lyrics = "") {
  const configured = Number(env.TREBLO_TARGET_DURATION);
  const baseline = Number.isFinite(configured) ? configured : DEFAULT_TREBLO_TARGET_DURATION;
  const required = Math.ceil(lyricCount(lyrics) / 2.15 + 12);
  // V3 accepts 30-second boundaries up to [270, 300]. Grow only when the
  // supplied lyrics need it, so ordinary songs do not pay a latency penalty.
  return Math.min(270, Math.max(60, Math.ceil(Math.max(baseline, required) / 30) * 30));
}
/*
 * api.acemusic.ai only exposes the OpenRouter-compatible synchronous API.
 * The native queue API belongs to a separately deployed ACE-Step api_server.
 * Keep this as an explicit mode instead of trying to infer it from a URL.
 */
function apiMode(env) {
  const explicit = String(env.ACEMUSIC_API_MODE || "").trim().toLowerCase();
  if (["native_async", "native", "self_hosted", "self-hosted"].includes(explicit)) return "native_async";
  if (["cloud_completion", "cloud", "completion", "sync"].includes(explicit)) return "cloud_completion";
  // Backward compatibility for old private deployments. New installs default to cloud.
  const legacy = String(env.ACEMUSIC_ASYNC_MODE || "").trim().toLowerCase();
  return ["async", "native"].includes(legacy) ? "native_async" : "cloud_completion";
}
function nativeAsyncEnabled(env) { return apiMode(env) === "native_async"; }
function cloudInferenceSteps(env) { const value = Number(env.ACEMUSIC_INFERENCE_STEPS); return Number.isFinite(value) ? Math.min(20, Math.max(1, Math.round(value))) : DEFAULT_CLOUD_INFERENCE_STEPS; }
function songDurationForLyrics(env, lyrics, asynchronous = false) {
  const characters = lyricCount(lyrics); const required = Math.ceil(characters / 2.15 + 12);
  // ACE 公共同步网关通常会在约 60 秒返回 504。歌曲本身可为 60 秒，
  // 但不能再把歌词估算结果自动放大为 80-120 秒的同步请求。
  return asynchronous ? Math.min(120, Math.max(fullDuration(env), required)) : Math.min(syncMaxDuration(env), Math.max(fullDuration(env), required));
}
function audioBucket(context) { return context.env.MUSIC_AUDIO || context.env.SONG_AUDIO || null; }
function providerApiKey(env) { return musicProvider(env) === "treblo" ? env.TREBLO_API_KEY : musicProvider(env) === "minimax" ? env.MINIMAX_API_KEY : env.ACEMUSIC_API_KEY; }
function canUseMusic(env) { return Boolean(providerApiKey(env) && audioBucket({ env })); }
function renderMode(env) { return String(env.ACEMUSIC_RENDER_MODE || "text2music").toLowerCase() === "cover-guide" ? "cover-guide" : "text2music"; }
/* ACE Cover needs a real sung guide. The generated sine-wave score is useful
 * for analysis, but it contains no vocal stem and can make ACE return an
 * instrumental-only track. Only an explicitly supplied audio guide may opt
 * into Cover; otherwise text2music is the safe vocal-producing path. */
function effectiveRenderMode(env, payload = null) {
  return renderMode(env) === "cover-guide" && typeof payload?.vocalGuideAudio === "string" && payload.vocalGuideAudio.length > 128
    ? "cover-guide"
    : "text2music";
}
function objectKey(id) { return `ace/audio/${id}.mp3`; }
function previewObjectKey(id) { return `ace/previews/${id}.mp3`; }
function manifestKey(id) { return `ace/jobs/${id}.json`; }
function idempotencyKey(value) { return `ace/idempotency/${hash(value).toString(36)}.json`; }
function rateKey(value) { return `ace/rate/${hash(value).toString(36)}.json`; }
function quotaKey(value) { return `ace/quota/${hash(value).toString(36)}.json`; }
function nowIso() { return new Date().toISOString(); }

const STYLE_PROFILES = {
  pop: [
    { bpm: 108, key: "C Major", caption: "Chinese children's pop song, natural youthful vocal, clear Mandarin pronunciation, warm piano and acoustic guitar, melodic bass, realistic live drums, bright memorable chorus" },
    { bpm: 114, key: "D Major", caption: "Chinese uplifting pop song, clear sung Mandarin vocal, sparkling piano, clean electric guitar, acoustic guitar, real drum kit, lively chorus" },
    { bpm: 102, key: "G Major", caption: "Chinese sunshine pop song, child-friendly natural vocal, soft synth pads, piano, acoustic guitar and real drums, gentle verse growing into a soaring chorus" },
    { bpm: 118, key: "A Major", caption: "Chinese energetic pop anthem, young clear female vocal, bright piano, handclaps, real bass and drums, strong singable melody" },
  ],
  rock: [
    { bpm: 122, key: "A Major", caption: "Chinese melodic pop rock, clear natural Mandarin vocal, live electric guitars, melodic bass guitar, acoustic drum kit, uplifting singable chorus" },
    { bpm: 128, key: "E Major", caption: "Chinese youth rock song, warm expressive sung vocal, clean guitar arpeggios building to a full band chorus, optimistic energy" },
    { bpm: 116, key: "D Major", caption: "Chinese inspirational band pop rock, clear lead singer, piano intro, electric guitar, bass and live drums, strong melody" },
    { bpm: 132, key: "G Major", caption: "Chinese bright power pop rock, natural young vocal, guitar hooks, handclaps, full live drum kit and a memorable sung chorus" },
  ],
  rap: [
    { bpm: 94, key: "F Minor", caption: "Chinese melodic rap-pop, clear rhythmic Mandarin verses and a fully sung catchy hook, warm piano, modern bass, crisp hip hop drums" },
    { bpm: 98, key: "A Minor", caption: "Chinese school-day melodic hip hop, natural youthful vocal, clear rhythmic verse, emotional sung chorus, warm bass" },
    { bpm: 90, key: "D Minor", caption: "Chinese gentle melodic rap, clear relaxed flow, piano chords, soft bass and groove drums, a fully sung chorus" },
    { bpm: 104, key: "C Minor", caption: "Chinese upbeat rap-pop, youthful natural vocalist, precise Mandarin rhythm, bright piano, punchy drums and sung refrain" },
  ],
  folk: [
    { bpm: 86, key: "D Major", caption: "Chinese acoustic folk pop, warm clear Mandarin vocal, fingerpicked acoustic guitar, soft piano, upright bass, brush drums" },
    { bpm: 80, key: "G Major", caption: "Chinese gentle campus folk song, expressive natural singer, acoustic guitar, light strings and a comforting chorus" },
    { bpm: 92, key: "C Major", caption: "Chinese fresh folk-pop, bright clear young vocal, rhythmic acoustic guitar, piano, soft live drums and warm rising chorus" },
    { bpm: 84, key: "A Major", caption: "Chinese story-like folk ballad for children, natural Mandarin singing, acoustic guitar and cello, simple warm melody" },
  ],
  classic: [
    { bpm: 76, key: "C Major", caption: "Chinese cinematic pop ballad, clear expressive Mandarin singing, piano and string ensemble, warm cello, emotional chorus" },
    { bpm: 72, key: "D Major", caption: "Chinese dreamlike orchestral pop, natural young female vocal, delicate piano, flowing strings and graceful chorus" },
    { bpm: 82, key: "G Major", caption: "Chinese uplifting classical-pop song, clear sung Mandarin, piano ostinato, strings, light percussion and bright chorus" },
    { bpm: 70, key: "A Minor", caption: "Chinese gentle piano and strings ballad, warm natural vocal, lyrical verse, tender bridge and resolved finale" },
  ],
};
const NEGATIVE = "spoken narration, text to speech, robotic vocals, monotone chanting, metronome, click track, single-note melody, toy instruments, chiptune, harsh autotune, artist imitation, explicit lyrics";
function musicPlan(style, seed) { const choices = STYLE_PROFILES[style] || STYLE_PROFILES.pop; return choices[Math.abs(hash(`${style}|${seed}`)) % choices.length]; }
function promptFor(plan) { return `${plan.caption}. Genuinely sung coherent melody, clear Mandarin diction, distinct verse and chorus. Avoid: ${NEGATIVE}.`; }
function melodyMeter(payload, plan) {
  const source = payload?.melodyGuide && typeof payload.melodyGuide === "object" ? payload.melodyGuide : {}; const structured = payload?.compositionPlan && typeof payload.compositionPlan === "object" ? payload.compositionPlan : source.compositionPlan; const labels = { verse: "verse", chorus: "chorus", bridge: "bridge", outro: "final chorus" }; const parts = [];
  for (const section of Object.keys(labels)) {
    const values = Array.isArray(source?.slots?.[section]) ? source.slots[section].map(Number).filter(value => Number.isFinite(value) && value >= 4 && value <= 16).slice(0, 6) : [];
    if (values.length) parts.push(`${labels[section]} lines: ${values.join("/")} Chinese characters`);
  }
  const bpm = Number(source.bpm); const key = clean(source.key, 24);
  return { bpm: Number.isFinite(bpm) && bpm >= 60 && bpm <= 180 ? Math.round(bpm) : Number(structured?.bpm) || plan.bpm, key: key || clean(structured?.key, 24) || plan.key, planId: clean(structured?.planId, 120), text: parts.length ? `Strict fixed melody syllable slots: ${parts.join("; ")}. Keep every supplied line in order and do not invent a different melody.` : "" };
}

function lyricCount(value) { return Array.from(String(value || "").replace(/[\s，。！？、；：,.!?~～—-]/g, "")).length; }
function isSectionHeader(value) { return /^\s*[\[【].+[\]】]\s*$/.test(String(value || "")); }
function isContinuationHeader(value) { return /桥|bridge|终章|尾奏|outro|final chorus/i.test(String(value || "")); }
function splitLyricsForPreview(rawLyrics) {
  const lines = String(rawLyrics || "").split(/\r?\n/); const preview = []; const remainder = []; let count = 0; let done = false; let sawChorus = false;
  for (const raw of lines) {
    const value = raw.trim(); if (!value) { if (!done) preview.push(raw); else remainder.push(raw); continue; }
    if (!done && isSectionHeader(value) && isContinuationHeader(value) && count >= 42) done = true;
    if (!done && !isSectionHeader(value)) {
      const next = lyricCount(value);
      if (count >= 82 || (sawChorus && count >= 62 && next > 0)) done = true;
      else count += next;
    }
    if (!done) { preview.push(raw); if (isSectionHeader(value) && /副歌|chorus/i.test(value)) sawChorus = true; }
    else remainder.push(raw);
  }
  const previewText = preview.join("\n").trim(); let remainderText = remainder.join("\n").trim();
  if (!remainderText && previewText) {
    const reprise = preview.filter(line => line.trim() && !isSectionHeader(line.trim())).slice(-2).join("\n");
    if (reprise) remainderText = `[终章副歌]\n${reprise}`;
  }
  return { preview: previewText || String(rawLyrics || "").trim(), remainder: remainderText };
}

function lyricLineEntries(rawLyrics) {
  const result = []; let section = "";
  for (const raw of String(rawLyrics || "").split(/\r?\n/)) { const line = raw.trim(); if (!line) continue; if (isSectionHeader(line)) { section = line; continue; } result.push({ text: line, section }); }
  return result;
}
function plainLyric(value) { return Array.from(String(value || "").replace(/[\s，。！？、；：,.!?~～—\-\[\]【】]/g, "")).join(""); }
function timestampMs(value, milliseconds = false) { const number = Number(value); if (!Number.isFinite(number) || number < 0) return null; return Math.round(milliseconds ? number : number * 1000); }
function timedCharacters(text, startMs, endMs) {
  const chars = Array.from(plainLyric(text)); if (!chars.length) return [];
  const span = Math.max(chars.length * 80, Number(endMs) - Number(startMs));
  return chars.map((char, index) => ({ text: char, startMs: Math.round(startMs + span * index / chars.length), endMs: Math.round(startMs + span * (index + 1) / chars.length) }));
}
function alignmentFromLrc(lrcText, lyrics, duration) {
  const entries = [];
  for (const raw of String(lrcText || "").split(/\r?\n/)) {
    const match = raw.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/); if (!match) continue;
    const fraction = String(match[3] || "0").padEnd(3, "0").slice(0, 3); const text = match[4].trim();
    if (plainLyric(text)) entries.push({ text, startMs: (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(fraction) });
  }
  const expectedEntries = lyricLineEntries(lyrics); const expected = expectedEntries.map(item => item.text); if (entries.length < expected.length || expected.some((line, index) => plainLyric(line) !== plainLyric(entries[index]?.text))) return null;
  const durationMs = Math.max(1, Number(duration) || 60) * 1000;
  return { source: "ace-lrc", confidence: 0.9, verified: true, lines: expectedEntries.map((entry, index) => { const startMs = entries[index].startMs; const endMs = entries[index + 1]?.startMs || durationMs; return { text: entry.text, section: entry.section, syllables: timedCharacters(entry.text, startMs, endMs) }; }) };
}
function alignmentFromTokens(tokens, lyrics) {
  if (!Array.isArray(tokens) || !tokens.length) return null;
  const actual = [];
  for (const item of tokens) {
    const rawText = String(item?.text ?? item?.token ?? item?.lyric ?? ""); if (isSectionHeader(rawText)) continue;
    const text = plainLyric(rawText);
    const hasStartMs = item?.start_ms !== undefined || item?.startMs !== undefined; const hasEndMs = item?.end_ms !== undefined || item?.endMs !== undefined;
    const startMs = timestampMs(item?.start_ms ?? item?.startMs ?? item?.start, hasStartMs); const endMs = timestampMs(item?.end_ms ?? item?.endMs ?? item?.end, hasEndMs);
    if (!text || startMs === null || endMs === null || endMs <= startMs) continue;
    const chars = Array.from(text); chars.forEach((char, index) => actual.push({ text: char, startMs: Math.round(startMs + (endMs - startMs) * index / chars.length), endMs: Math.round(startMs + (endMs - startMs) * (index + 1) / chars.length) }));
  }
  const expectedEntries = lyricLineEntries(lyrics); const expectedLines = expectedEntries.map(item => item.text); const expected = expectedLines.map(plainLyric).join(""); const actualText = actual.map(item => item.text).join(""); const offset = actualText.indexOf(expected);
  if (!expected || offset < 0) return null;
  const matched = actual.slice(offset, offset + expected.length); let cursor = 0;
  return { source: "ace-token-timestamps", confidence: 0.98, verified: true, lines: expectedEntries.map(entry => { const length = plainLyric(entry.text).length; const syllables = matched.slice(cursor, cursor + length); cursor += length; return { text: entry.text, section: entry.section, syllables }; }) };
}
function providerRoots(result) {
  return [result, result?.data, result?.output, result?.metadata, result?.extra_outputs, result?.choices?.[0]?.message, result?.choices?.[0]?.message?.metadata, result?.choices?.[0]?.delta, result?.choices?.[0]?.message?.audio?.[0], result?.audio?.[0]].filter(Boolean);
}
function providerAlignment(result, lyrics, duration) {
  for (const root of providerRoots(result)) {
    const tokens = root.token_timestamps || root.lyric_token_timestamps || root.word_timestamps || root.words || root.lyric_timestamps?.tokens || root.alignment?.words || root.aligned_lyrics?.words; const fromTokens = alignmentFromTokens(tokens, lyrics); if (fromTokens) return fromTokens;
    const lrc = root.lrc_text || root.lrc || root.lyrics_lrc || root.alignment?.lrc || root.aligned_lyrics?.lrc; const fromLrc = alignmentFromLrc(lrc, lyrics, duration); if (fromLrc) return fromLrc;
  }
  return null;
}
function providerLyricScore(result) {
  for (const root of providerRoots(result)) { const value = Number(root.lyrics_score ?? root.lyric_score ?? root.alignment_score); if (Number.isFinite(value)) return value > 1 ? value / 100 : value; }
  return null;
}

function mp3FrameInfo(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[offset + 1] >> 3) & 3; const layerBits = (bytes[offset + 1] >> 1) & 3;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 15; const sampleIndex = (bytes[offset + 2] >> 2) & 3; const padding = (bytes[offset + 2] >> 1) & 1;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const mpeg1 = versionBits === 3; const sampleRates = versionBits === 3 ? [44100, 48000, 32000] : versionBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  const bitrates = mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = sampleRates[sampleIndex]; const bitrate = bitrates[bitrateIndex];
  const length = Math.floor((mpeg1 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding;
  return length > 4 ? { length, seconds: (mpeg1 ? 1152 : 576) / sampleRate } : null;
}

function id3Length(bytes) {
  if (bytes.length < 10 || String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "ID3") return 0;
  return 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) + ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
}

function mp3Duration(buffer) {
  const bytes = new Uint8Array(buffer); let offset = Math.min(bytes.length, id3Length(bytes)); let elapsed = 0; let frames = 0;
  while (offset + 4 <= bytes.length) {
    const frame = mp3FrameInfo(bytes, offset);
    if (!frame || offset + frame.length > bytes.length) { offset += 1; continue; }
    elapsed += frame.seconds; offset += frame.length; frames += 1;
  }
  return frames >= 8 ? elapsed : null;
}

function authHeaders(env) { return { authorization: `Bearer ${env.ACEMUSIC_API_KEY}`, "content-type": "application/json", accept: "text/event-stream, application/json" }; }

function completionBody(payload, context, options = {}) {
  const plan = musicPlan(clean(payload.style, 20), Number(payload.seed) || Date.now());
  const lyrics = clean(payload.lyrics, 2400);
  const meter = melodyMeter(payload, plan);
  const duration = Number(options.duration) || previewDuration(context.env);
  const inferenceSteps = cloudInferenceSteps(context.env);
  const continuation = options.taskType === "complete";
  const prompt = continuation
    ? `${promptFor(plan)} ${meter.text} Continue the supplied source song seamlessly. Sing every supplied continuation lyric line exactly once in order; do not restart, summarize, omit or replace any line. Start immediately after the source audio, preserve its key, tempo, vocalist and arrangement, add a short transition only when necessary, then finish with the bridge and resolved final chorus.`
    : `${promptFor(plan)} ${meter.text} Use one clear natural Mandarin lead singer. Sing every supplied lyric line once, in order, from the first phrase. No instrumental-only track, humming, spoken narration, omission, replacement, click track or long intro. Keep the melody natural and singable.`;
  const messageText = `<prompt>${prompt}</prompt>\n<lyrics>${lyrics}</lyrics>`;
  const messageContent = options.sourceAudio ? [{ type: "text", text: messageText }, { type: "input_audio", input_audio: { data: options.sourceAudio, format: options.sourceAudioFormat || "mp3" } }] : messageText;
  return {
    model: clean(context.env.ACEMUSIC_MODEL, 160) || "acemusic/acestep-v15-turbo",
    messages: [{ role: "user", content: messageContent }], lyrics, stream: false, sample_mode: false, thinking: false, use_format: false,
    use_cot_metas: false, use_cot_caption: false, use_cot_language: false, task_type: options.taskType || "text2music",
    seed: hash(String(payload.seed || Date.now())) % 2147483647, inference_steps: inferenceSteps, infer_method: "ode",
    duration, bpm: meter.bpm, key_scale: meter.key, time_signature: "4/4", vocal_language: "zh", instrumental: false,
    audio_config: { duration, bpm: meter.bpm, key_scale: meter.key, time_signature: "4/4", vocal_language: "zh", instrumental: false, format: "mp3" },
  };
}

function findAudioUrl(result, base) {
  const candidates = [
    result?.choices?.[0]?.message?.audio?.[0]?.audio_url?.url,
    result?.choices?.[0]?.message?.audio?.[0]?.url,
    result?.choices?.[0]?.message?.audio_url?.url,
    result?.choices?.[0]?.message?.audio_url,
    result?.choices?.[0]?.delta?.audio?.[0]?.audio_url?.url,
    result?.choices?.[0]?.delta?.audio?.[0]?.url,
    result?.audio?.[0]?.audio_url?.url,
    result?.audio?.[0]?.url,
    result?.audio_url?.url,
    result?.audio_url,
  ];
  const candidate = candidates.find(value => typeof value === "string" && value.trim());
  if (!candidate) throw new Error("ACE 云端生成接口没有返回音频地址");
  const value = candidate.trim();
  if (value.startsWith("data:")) return value;
  return new URL(value, base).toString();
}

async function requestCompletion(payload, context, options = {}) {
  const body = completionBody(payload, context, options); const base = baseUrl(context.env); const requestId = `fb_${token().slice(0, 16)}`; const startedAt = Date.now();
  const configuredTimeout = Number(context.env.ACEMUSIC_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(30_000, Math.min(180_000, configuredTimeout)) : 75_000;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { ...authHeaders(context.env), "x-focus-beat-request-id": requestId };
    const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const raw = await response.text(); let parsed = null; try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!response.ok) throw new Error(`ACE 云端生成接口返回 ${response.status}: ${(parsed?.detail || parsed?.error || raw || "空响应").toString().slice(0, 180)}（请求 ${requestId}，耗时 ${Date.now() - startedAt}ms，时长 ${body.duration}s，任务 ${body.task_type}）`);
    if (parsed) return { result: parsed, audioUrl: findAudioUrl(parsed, base), providerLyrics: clean(parsed?.choices?.[0]?.message?.content || parsed?.lyrics || "", 2400), alignment: providerAlignment(parsed, body.lyrics, body.duration), lyricScore: providerLyricScore(parsed), body };
    let id = ""; let audioUrl = ""; let providerLyrics = ""; let alignment = null; let lyricScore = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      let chunk; try { chunk = JSON.parse(line.slice(6)); } catch (_) { continue; }
      id ||= clean(chunk?.id, 160);
      providerLyrics += String(chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.message?.content || "");
      alignment ||= providerAlignment(chunk, body.lyrics, body.duration); lyricScore ??= providerLyricScore(chunk);
      try { audioUrl = findAudioUrl(chunk, base); } catch (_) {}
    }
    if (!audioUrl) throw new Error("ACE 云端流式响应结束，但没有返回音频数据");
    return { result: { id }, audioUrl, providerLyrics: clean(providerLyrics, 2400), alignment, lyricScore, body };
  } finally { clearTimeout(timeout); }
}

async function generateCompletion(payload, context, options = {}) {
  // 不再把完整歌曲失败静默降级成短音频。短音频会导致桥段/终章歌词丢失，
  // 而且用户保存后得到的也不再是试听时听到的同一首歌；失败必须交给上层退款。
  const generated = await requestCompletion(payload, context, options);
  const audio = await downloadAudio(generated.audioUrl, context);
  return { ...audio, id: clean(generated.result?.id, 160), providerLyrics: generated.providerLyrics || "", alignment: generated.alignment || null, lyricScore: generated.lyricScore, duration: generated.body.duration, plan: musicPlan(payload.style, payload.seed), compositionPlan: payload.compositionPlan || payload.melodyGuide?.compositionPlan || null, model: generated.body.model };
}

function minimaxLyrics(rawLyrics) {
  return String(rawLyrics || "")
    .replace(/^\s*[\[【]主歌\s*A[\]】]\s*$/gim, "[Verse 1]")
    .replace(/^\s*[\[【]主歌\s*B[\]】]\s*$/gim, "[Verse 2]")
    .replace(/^\s*[\[【](?:副歌|chorus)[\]】]\s*$/gim, "[Chorus]")
    .replace(/^\s*[\[【](?:桥段|桥|bridge)[\]】]\s*$/gim, "[Bridge]")
    .replace(/^\s*[\[【](?:终章副歌|终章|尾声|outro|final chorus)[\]】]\s*$/gim, "[Outro]")
    .trim();
}

function minimaxBody(payload, context) {
  const plan = musicPlan(clean(payload.style, 20), Number(payload.seed) || Date.now()); const meter = melodyMeter(payload, plan);
  const targetDuration = Math.min(120, Math.max(45, Number(context.env.MINIMAX_TARGET_DURATION) || fullDuration(context.env)));
  const prompt = `${plan.caption}. ${meter.bpm} BPM, ${meter.key}, compact approximately ${Math.round(targetDuration)}-second arrangement. Natural clearly audible Mandarin lead singing, short intro, distinct verse and chorus, warm child-friendly production. No speech, chanting, humming, robotic vocal, click track or long instrumental break.`;
  return {
    model: clean(context.env.MINIMAX_MUSIC_MODEL, 80) || "music-2.6-free",
    prompt, lyrics: minimaxLyrics(payload.lyrics), stream: false, output_format: "url", lyrics_optimizer: false, is_instrumental: false,
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
  };
}

function decodeHexAudio(value) {
  const hex = String(value || "").trim(); if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length / 2 > MAX_AUDIO_BYTES) throw new Error("MiniMax 返回的音频文件过大");
  const bytes = new Uint8Array(hex.length / 2); for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

async function generateMinimax(payload, context) {
  const body = minimaxBody(payload, context); const requestId = `fb_${token().slice(0, 16)}`; const startedAt = Date.now();
  const configuredTimeout = Number(context.env.MINIMAX_REQUEST_TIMEOUT_MS); const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(60_000, Math.min(360_000, configuredTimeout)) : 300_000;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${minimaxBaseUrl(context.env)}/v1/music_generation`, {
      method: "POST", headers: { authorization: `Bearer ${context.env.MINIMAX_API_KEY}`, "content-type": "application/json", accept: "application/json", "x-focus-beat-request-id": requestId }, body: JSON.stringify(body), signal: controller.signal,
    });
    const raw = await response.text(); let result = null; try { result = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!response.ok) throw new Error(`MiniMax 音乐接口返回 ${response.status}: ${String(result?.base_resp?.status_msg || result?.message || raw || "空响应").slice(0, 220)}（请求 ${requestId}，耗时 ${Date.now() - startedAt}ms）`);
    const statusCode = Number(result?.base_resp?.status_code || 0); if (statusCode) throw new Error(`MiniMax 音乐生成失败 ${statusCode}: ${clean(result?.base_resp?.status_msg || "未知错误", 220)}`);
    const audioValue = result?.data?.audio; if (typeof audioValue !== "string" || !audioValue.trim()) throw new Error("MiniMax 音乐接口没有返回音频");
    let audio;
    if (/^(?:https?:|data:)/i.test(audioValue.trim())) audio = await downloadAudio(audioValue.trim(), context, "minimax");
    else { const bytes = decodeHexAudio(audioValue); if (!bytes) throw new Error("MiniMax 返回了无法解析的音频数据"); audio = { bytes, contentType: "audio/mpeg" }; }
    if (!String(audio.contentType || "").toLowerCase().startsWith("audio/")) audio.contentType = "audio/mpeg";
    const reportedMs = Number(result?.extra_info?.music_duration); const duration = Number.isFinite(reportedMs) && reportedMs > 0 ? Math.max(1, reportedMs / 1000) : Math.min(120, Math.max(fullDuration(context.env), Math.ceil(lyricCount(payload.lyrics) / 2.15 + 12)));
    return { ...audio, id: clean(result?.trace_id || requestId, 160), providerLyrics: clean(payload.lyrics, 2400), alignment: null, lyricScore: null, duration, plan: musicPlan(payload.style, payload.seed), compositionPlan: payload.compositionPlan || payload.melodyGuide?.compositionPlan || null, model: body.model };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`MiniMax 音乐生成超过 ${Math.round(timeoutMs / 1000)} 秒，后端主动中止请求`);
    throw error;
  } finally { clearTimeout(timeout); }
}

function trebloBody(payload, context) {
  const plan = musicPlan(clean(payload.style, 20), Number(payload.seed) || Date.now()); const meter = melodyMeter(payload, plan);
  const target = trebloTargetDuration(context.env, payload.lyrics);
  // Treblo requires min < max; equal bounds such as [60, 60] are rejected
  // with HTTP 422 even though both values are valid 30-second multiples.
  const lengthRange = target >= 300 ? [270, 300] : [target, target + 30];
  const prompt = `${plan.caption}. ${meter.bpm} BPM, ${meter.key}. A concise Chinese children's song with a short intro, clear natural Mandarin lead singing, memorable chorus and complete ending. Sing every supplied lyric line exactly once in order. Avoid spoken narration, humming, robotic vocals, click track, long instrumental breaks and artist imitation.`;
  // Treblo expects MP3 bitrate in kbps (128/192/256/320), not bits per second.
  return { prompt, lyrics: clean(payload.lyrics, 2400), instrumental: false, length_range: lengthRange, output_format: "mp3", output_bit_rate: 192, align_lyrics: true, enable_streaming: false };
}

async function submitTreblo(payload, context) {
  const version = clean(context.env.TREBLO_MODEL_VERSION, 20) || "v3"; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${trebloBaseUrl(context.env)}/generations/${version}`, { method: "POST", headers: { authorization: `Bearer ${context.env.TREBLO_API_KEY}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(trebloBody(payload, context)), signal: controller.signal });
    const result = await readApiJson(response, "Treblo 创建任务接口"); const providerJobId = clean(result?.task_id, 160);
    if (!providerJobId) throw new Error("Treblo 创建任务接口没有返回 task_id");
    return { providerJobId, status: "queued", queuePosition: 0, etaSeconds: 0 };
  } finally { clearTimeout(timeout); }
}

async function trebloRequest(path, context, label) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${trebloBaseUrl(context.env)}${path}`, { headers: { authorization: `Bearer ${context.env.TREBLO_API_KEY}`, accept: "application/json" }, signal: controller.signal });
    const raw = await response.text(); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw.replace(/^"|"$/g, ""); }
    if (!response.ok) throw new Error(`${label}返回 ${response.status}: ${clean(data?.detail || data?.error || data?.message || raw || "空响应", 240)}`);
    return data;
  } finally { clearTimeout(timeout); }
}

async function queryTreblo(manifest, context) {
  const statusResult = await trebloRequest(`/generations/status/${encodeURIComponent(manifest.providerTaskId)}?include_alignment=true`, context, "Treblo 状态接口");
  const status = clean(typeof statusResult === "string" ? statusResult : statusResult?.status, 80).toUpperCase(); const alignmentStatus = clean(statusResult?.alignment_status, 80).toUpperCase();
  if (status === "FAILURE") return { status: "failed", error: "Treblo 云端歌曲生成失败" };
  if (status !== "SUCCESS") return { status: ["GENERATING", "GENERATING_STREAMING_READY", "DECOMPRESSING", "SAVING"].includes(status) ? "running" : "queued", alignmentStatus };
  if (["REQUESTED", "TASK_SENT", "ALIGNING"].includes(alignmentStatus)) return { status: "running", alignmentStatus };
  const result = await trebloRequest(`/generations/${encodeURIComponent(manifest.providerTaskId)}`, context, "Treblo 结果接口");
  if (String(result?.status || "").toUpperCase() === "FAILURE") return { status: "failed", error: clean(result?.error_message || "Treblo 云端歌曲生成失败", 420) };
  const audioUrl = Array.isArray(result?.song_paths) ? result.song_paths.find(value => typeof value === "string" && value) : "";
  if (!audioUrl) return { status: "running", alignmentStatus };
  return { status: "ready", result, audioUrl };
}

function nativeTaskBody(payload, context, options = {}) {
  const plan = musicPlan(clean(payload.style, 20), Number(payload.seed) || Date.now()); const meter = melodyMeter(payload, plan); const duration = Number(options.duration) || fullDuration(context.env);
  const prompt = `${promptFor(plan)} ${meter.text} Use one clear natural Mandarin lead singer. Sing every supplied lyric line once, in order. No instrumental-only track, spoken narration, omission or long intro.`;
  return {
    model: clean(context.env.ACEMUSIC_MODEL, 160).replace(/^acemusic\//, "") || "acestep-v15-turbo",
    prompt, lyrics: clean(payload.lyrics, 2400), thinking: false, sample_mode: false, use_format: false,
    use_cot_caption: false, use_cot_language: false, task_type: options.taskType || "text2music",
    seed: hash(String(payload.seed || Date.now())) % 2147483647, use_random_seed: false,
    audio_duration: duration, duration, bpm: meter.bpm, key_scale: meter.key, time_signature: "4/4", vocal_language: "zh", audio_format: "mp3", instrumental: false,
    inference_steps: cloudInferenceSteps(context.env), infer_method: "ode",
  };
}

async function readApiJson(response, label) {
  const raw = await response.text(); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) {
    const detail = data?.detail ?? data?.error ?? data?.message ?? raw ?? "空响应";
    let readable;
    if (typeof detail === "string") readable = detail;
    else { try { readable = JSON.stringify(detail); } catch (_) { readable = String(detail); } }
    throw new Error(`${label} 返回 ${response.status}: ${String(readable || "空响应").slice(0, 420)}`);
  }
  if (!data || typeof data !== "object") throw new Error(`${label} 没有返回 JSON 对象`);
  return data;
}

function nativeData(result) {
  const data = result?.data;
  if (Array.isArray(data)) return data[0] || {};
  if (Array.isArray(data?.results)) return data.results[0] || {};
  return data && typeof data === "object" ? data : result || {};
}

function nativeTaskState(task) {
  const value = task?.status;
  if (value === 0 || value === "0") return Number(task?.progress) > 0 ? "running" : "queued";
  if (value === 1 || value === "1") return "succeeded";
  if (value === 2 || value === "2") return "failed";
  return String(value || "queued").toLowerCase();
}

async function submitNativeTask(payload, context, options = {}) {
  const base = baseUrl(context.env); const body = nativeTaskBody(payload, context, options); const requestId = `fb_${token().slice(0, 16)}`;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${base}/release_task`, { method: "POST", headers: { ...authHeaders(context.env), accept: "application/json", "x-focus-beat-request-id": requestId }, body: JSON.stringify(body), signal: controller.signal });
    const result = await readApiJson(response, "ACE 原生创建任务接口"); const task = nativeData(result); const providerJobId = clean(task.task_id || task.job_id || task.jobId || task.id, 180);
    if (!providerJobId) throw new Error("ACE 原生创建任务接口没有返回 task_id");
    return { providerJobId, status: nativeTaskState(task), queuePosition: Number(task.queue_position ?? task.queuePosition) || 0, etaSeconds: Number(task.eta_seconds ?? task.etaSeconds) || 0, body };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("ACE 原生创建任务接口 20 秒内未响应");
    throw error;
  } finally { clearTimeout(timeout); }
}

async function queryNativeTask(manifest, context) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl(context.env)}/query_result`, { method: "POST", headers: { ...authHeaders(context.env), accept: "application/json" }, body: JSON.stringify({ task_id_list: [manifest.providerTaskId] }), signal: controller.signal });
    const result = await readApiJson(response, "ACE 原生任务查询接口");
    return nativeData(result);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("ACE 原生任务状态查询超时");
    throw error;
  } finally { clearTimeout(timeout); }
}

function asyncAudioUrl(result, base) {
  const output = result?.result || result?.data?.result || result?.data || result;
  const candidates = [output?.first_audio_path, output?.audio_url, output?.audioUrl, ...(Array.isArray(output?.audio_paths) ? output.audio_paths : []), ...(Array.isArray(output?.audio_urls) ? output.audio_urls : [])];
  const value = candidates.find(item => typeof item === "string" && item.trim());
  if (!value) throw new Error("ACE 异步任务已完成，但没有返回音频路径");
  return new URL(value, base).toString();
}

async function putManifest(context, manifest) {
  await audioBucket(context).put(manifestKey(manifest.jobId), JSON.stringify(manifest), { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } });
}
async function getManifest(context, id) {
  const object = await audioBucket(context).get(manifestKey(id)); if (!object) return null;
  try { return JSON.parse(await object.text()); } catch (_) {
    try { return JSON.parse(new TextDecoder().decode(await new Response(object.body).arrayBuffer())); } catch (_) { return null; }
  }
}
function verifyManifest(manifest, accessToken) { return Boolean(manifest && accessToken && [manifest.previewToken, manifest.fullToken].includes(accessToken)); }
function publicAudioUrl(context, id, scope, accessToken) {
  const url = new URL(context.request.url); url.pathname = "/api/music"; url.search = "";
  url.searchParams.set("audio", "1"); url.searchParams.set("id", id); url.searchParams.set("scope", scope); url.searchParams.set("token", accessToken); return url.toString();
}
function publicJob(manifest, context) {
  const full = manifest.kind === "complete"; const ready = manifest.status === "ready";
  const fullSongPreview = manifest.fullSongPreview === true;
  const previewDuration = fullSongPreview ? Number(manifest.duration) || DEFAULT_FULL_DURATION : Math.min(PREVIEW_DURATION, Number(manifest.previewDuration || manifest.duration) || PREVIEW_DURATION);
  return {
    jobId: manifest.jobId, previewJobId: manifest.previewJobId || manifest.jobId,
    providerSongId: manifest.providerTaskId, status: manifest.status, mode: "remote", provider: manifest.provider || "acemusic",
    accessToken: full ? manifest.fullToken : manifest.previewToken,
    audioUrl: ready ? publicAudioUrl(context, manifest.jobId, full ? "full" : "preview", full ? manifest.fullToken : manifest.previewToken) : "",
    duration: full ? manifest.duration : previewDuration, durationMs: (full ? manifest.duration : previewDuration) * 1000, seed: manifest.seed,
    previewFraction: full ? undefined : previewDuration / manifest.duration, fullSongPreview: !full && fullSongPreview, temporary: !full, queuePosition: manifest.queuePosition || 0, etaSeconds: manifest.etaSeconds || 0, asynchronous: Boolean(manifest.async),
    error: manifest.error || "", previewLyrics: full || fullSongPreview ? manifest.lyrics : manifest.previewLyrics, plan: manifest.plan, compositionPlan: manifest.compositionPlan || null, alignment: manifest.alignment || null, alignmentStatus: manifest.alignment ? "verified" : "unavailable", lyricScore: Number.isFinite(manifest.lyricScore) ? manifest.lyricScore : null, renderMode: manifest.renderMode || "text2music", previewClipExact: fullSongPreview || manifest.previewClipExact !== false, compressedLyrics: Boolean(manifest.compressedLyrics), unlocked: full && ready,
  };
}

async function downloadAudio(url, context, provider = musicProvider(context.env)) {
  const label = provider === "treblo" ? "Treblo" : provider === "minimax" ? "MiniMax" : "ACE";
  if (String(url).startsWith("data:")) {
    const match = String(url).match(/^data:([^;,]+)?;base64,(.*)$/s); if (!match) throw new Error(`${label} 返回了无法解析的音频数据`);
    const encoded = match[2].replace(/\s/g, ""); if (Math.floor(encoded.length * .75) > MAX_AUDIO_BYTES) throw new Error(`${label} 返回的音频文件过大`);
    const binary = atob(encoded); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (!bytes.byteLength) throw new Error(`${label} 返回了空音频`); return { bytes: bytes.buffer, contentType: match[1] || "audio/mpeg" };
  }
  const providerBase = provider === "treblo" ? trebloBaseUrl(context.env) : provider === "minimax" ? minimaxBaseUrl(context.env) : baseUrl(context.env); const resolved = new URL(String(url), `${providerBase}/`).toString();
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const headers = new Headers(); if (provider === "acemusic" && new URL(resolved).host === new URL(baseUrl(context.env)).host) headers.set("authorization", `Bearer ${context.env.ACEMUSIC_API_KEY}`);
    const response = await fetch(resolved, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} 音频下载失败（${response.status}）`);
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_AUDIO_BYTES) throw new Error(`${label} 返回的音频文件过大`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new Error(`${label} 返回的不是音频文件`);
    const bytes = await response.arrayBuffer(); if (!bytes.byteLength) throw new Error(`${label} 返回了空音频`); if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error(`${label} 返回的音频文件过大`);
    return { bytes, contentType: contentType || "audio/mpeg" };
  } finally { clearTimeout(timeout); }
}

function previewManifest(payload, context, totalDuration, providerTaskId = "", status = "queued", details = {}) {
  const parts = splitLyricsForPreview(payload.lyrics); const plan = musicPlan(payload.style, payload.seed); const mode = effectiveRenderMode(context.env, payload);
  return {
    jobId: jobId(), kind: "preview", status, providerTaskId, provider: details.provider || musicProvider(context.env),
    strategy: "single-master-v4-async", renderMode: mode === "cover-guide" ? "cover-guide" : "text2music", previewDuration: totalDuration, fullSongPreview: true, continuationDuration: 0,
    previewToken: token(), fullToken: token(), title: clean(payload.title, 32), style: clean(payload.style, 20),
    lyrics: clean(payload.lyrics, 2400), previewLyrics: clean(parts.preview, 2400), continuationLyrics: "", providerLyrics: "", lyricScore: null, seed: Number(payload.seed) || Date.now(), plan, compositionPlan: payload.compositionPlan || payload.melodyGuide?.compositionPlan || null, alignment: null,
    duration: totalDuration, requestedDuration: totalDuration, compressedLyrics: false, queuePosition: Number(details.queuePosition) || 0, etaSeconds: Number(details.etaSeconds) || 0, createdAt: nowIso(), updatedAt: nowIso(), providerPath: "", error: "", async: Boolean(details.async),
  };
}

async function materializePreview(manifest, generated, context) {
  const minimumScore = Math.max(0, Math.min(1, Number(context.env.ACEMUSIC_MIN_LYRIC_SCORE) || 0.72));
  if (Number.isFinite(generated.lyricScore) && generated.lyricScore < minimumScore) throw new Error(`${providerLabel(context.env)} 歌词匹配评分过低（${Math.round(generated.lyricScore * 100)} 分），已拒绝这版歌曲`);
  if (Number.isFinite(Number(generated.duration)) && Number(generated.duration) > 0) manifest.duration = Number(generated.duration);
  manifest.status = "ready"; manifest.providerLyrics = clean(generated.providerLyrics, 2400); manifest.lyricScore = generated.lyricScore; manifest.alignment = generated.alignment || null; manifest.queuePosition = 0; manifest.etaSeconds = 0; manifest.updatedAt = nowIso(); manifest.error = "";
  manifest.fullSongPreview = true; manifest.previewDuration = manifest.duration; manifest.previewLyrics = manifest.lyrics; manifest.previewClipExact = true;
  const provider = manifest.provider || musicProvider(context.env);
  await audioBucket(context).put(objectKey(manifest.jobId), generated.bytes, { httpMetadata: { contentType: generated.contentType, cacheControl: "private, max-age=3600" }, customMetadata: { provider, previewToken: manifest.previewToken, fullToken: manifest.fullToken, duration: String(manifest.duration), kind: manifest.kind, createdAt: manifest.createdAt } });
  await putManifest(context, manifest);
}

async function startPreview(payload, context) {
  const previewPayload = { ...payload, lyrics: clean(payload.lyrics, 2400) }; const minimumRequiredDuration = Math.ceil(lyricCount(previewPayload.lyrics) / 2.15 + 12);
  const provider = musicProvider(context.env); const maximumDuration = provider === "treblo" ? 300 : 120;
  if (minimumRequiredDuration > maximumDuration) throw new Error(`歌词过长，预计至少需要 ${minimumRequiredDuration} 秒演唱；当前音乐服务最多支持约 ${maximumDuration} 秒`);
  if (provider === "treblo") {
    const task = await submitTreblo(previewPayload, context); const totalDuration = trebloTargetDuration(context.env, previewPayload.lyrics);
    const manifest = previewManifest(previewPayload, context, totalDuration, task.providerJobId, task.status, { async: true, provider: "treblo" });
    manifest.strategy = "single-master-treblo-v3"; await putManifest(context, manifest); return publicJob(manifest, context);
  }
  if (musicProvider(context.env) === "minimax") {
    const generated = await generateMinimax(previewPayload, context);
    const manifest = previewManifest(previewPayload, context, generated.duration, generated.id, "queued", { async: false, provider: "minimax" });
    manifest.strategy = "single-master-minimax-v1";
    await materializePreview(manifest, generated, context); return publicJob(manifest, context);
  }
  const asynchronous = nativeAsyncEnabled(context.env); const mode = effectiveRenderMode(context.env, previewPayload); const cover = mode === "cover-guide"; const totalDuration = songDurationForLyrics(context.env, previewPayload.lyrics, asynchronous);
  if (asynchronous) {
    const task = await submitNativeTask(previewPayload, context, { duration: totalDuration, taskType: cover ? "cover" : "text2music" });
    const manifest = previewManifest(previewPayload, context, totalDuration, task.providerJobId, task.status, { async: true, queuePosition: task.queuePosition, etaSeconds: task.etaSeconds });
    await putManifest(context, manifest); return publicJob(manifest, context);
  }
  const generated = await generateCompletion(previewPayload, context, { duration: totalDuration, taskType: cover ? "cover" : "text2music", sourceAudio: cover ? previewPayload.vocalGuideAudio : null, sourceAudioFormat: "mp3" });
  const manifest = previewManifest(previewPayload, context, totalDuration, generated.id, "queued", { async: false });
  manifest.strategy = "single-master-v3";
  await materializePreview(manifest, generated, context); return publicJob(manifest, context);
}

async function startComplete(payload, context) {
  const previewId = clean(payload.previewJobId, 80); const preview = await getManifest(context, previewId); const supplied = clean(payload.accessToken, 160);
  if (!verifyManifest(preview, supplied) || preview.previewToken !== supplied) throw new Error("试听凭证无效");
  if (preview.status !== "ready") throw new Error("试听尚未生成完成，不能解锁完整版");
  if (!["single-master-v3", "single-master-v4-async", "single-master-minimax-v1", "single-master-treblo-v3"].includes(preview.strategy)) throw new Error("这是旧版试听，不是完整母带试听；请重新生成试听后再解锁");
  const previewObject = await audioBucket(context).get(objectKey(previewId)); if (!previewObject) throw new Error("试听音频不存在，请重新生成");
  const completeDuration = Number(preview.duration) || fullDuration(context.env); const providerTaskId = preview.providerTaskId;
  const manifest = {
    jobId: jobId(), kind: "complete", previewJobId: preview.jobId, status: "ready", providerTaskId: preview.providerTaskId, provider: preview.provider || "acemusic",
    strategy: preview.strategy,
    previewToken: preview.previewToken, fullToken: token(), title: preview.title, style: preview.style, lyrics: preview.lyrics,
    previewLyrics: preview.previewLyrics || preview.lyrics, continuationLyrics: "", providerLyrics: preview.providerLyrics || "", lyricScore: preview.lyricScore, seed: preview.seed, plan: preview.plan, compositionPlan: preview.compositionPlan || null, alignment: preview.alignment || null, renderMode: preview.renderMode || "text2music", sourceJobId: preview.jobId, duration: completeDuration, createdAt: nowIso(), updatedAt: nowIso(), providerPath: "", error: "",
  };
  manifest.providerTaskId = providerTaskId;
  await putManifest(context, manifest); return publicJob(manifest, context);
}

async function refreshJob(payload, context) {
  const id = clean(payload.jobId, 80); const accessToken = clean(payload.accessToken, 160); const manifest = await getManifest(context, id);
  if (!verifyManifest(manifest, accessToken)) throw new Error("歌曲任务凭证无效或已经过期");
  if (manifest.async && ["queued", "running", "processing"].includes(manifest.status)) {
    if (manifest.provider === "treblo") {
      const task = await queryTreblo(manifest, context);
      if (["queued", "running"].includes(task.status)) { manifest.status = task.status; manifest.queuePosition = 0; manifest.etaSeconds = 0; }
      else if (task.status === "ready") {
        const audio = await downloadAudio(task.audioUrl, context, "treblo"); const result = task.result || {};
        const duration = Number(result.duration || result.audio_duration || result.song_duration) || mp3Duration(audio.bytes) || manifest.duration;
        await materializePreview(manifest, { ...audio, id: manifest.providerTaskId, providerLyrics: clean(result.lyrics || manifest.lyrics, 2400), alignment: providerAlignment(result, manifest.lyrics, duration), lyricScore: providerLyricScore(result), duration }, context);
      } else { manifest.status = "failed"; manifest.error = clean(task.error || "Treblo 云端歌曲生成失败", 420); manifest.updatedAt = nowIso(); await putManifest(context, manifest); }
    } else {
      const task = await queryNativeTask(manifest, context); const state = nativeTaskState(task);
      if (["queued", "pending"].includes(state)) { manifest.status = "queued"; manifest.queuePosition = Number(task.queue_position ?? task.queuePosition) || 0; manifest.etaSeconds = Number(task.eta_seconds ?? task.etaSeconds) || 0; }
      else if (["running", "processing"].includes(state)) { manifest.status = "running"; manifest.queuePosition = 0; manifest.etaSeconds = Number(task.eta_seconds ?? task.etaSeconds) || 0; }
      else if (["succeeded", "success", "completed", "ready"].includes(state)) {
        const providerLyrics = clean(task?.result?.lyrics || task?.lyrics || "", 2400); const alignment = providerAlignment(task, manifest.lyrics, manifest.duration); const lyricScore = providerLyricScore(task);
        const audio = await downloadAudio(asyncAudioUrl(task, baseUrl(context.env)), context, manifest.provider || "acemusic");
        await materializePreview(manifest, { ...audio, id: manifest.providerTaskId, providerLyrics, alignment, lyricScore }, context);
      } else { manifest.status = "failed"; manifest.error = clean(task?.error?.message || task?.error || task?.detail || "ACE 异步任务失败", 420); manifest.updatedAt = nowIso(); await putManifest(context, manifest); }
    }
    if (manifest.status !== "ready" && manifest.status !== "failed") { manifest.updatedAt = nowIso(); await putManifest(context, manifest); }
  }
  return publicJob(manifest, context);
}

function byteRange(header, size) {
  const match = String(header || "").match(/^bytes=(\d*)-(\d*)$/i); if (!match || !Number.isFinite(size) || size <= 0) return null;
  let start = match[1] ? Number(match[1]) : null; let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; }
  else { start = start ?? 0; end = Math.min(size - 1, end ?? size - 1); }
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && start < size ? { start, end, length: end - start + 1 } : null;
}

async function audioResponse(object, bucket, key, request, extraHeaders = {}) {
  const type = object.httpMetadata?.contentType || "audio/mpeg"; const size = Number(object.size);
  const requested = request.headers.get("range"); const range = requested ? byteRange(requested, size) : null;
  if (requested && Number.isFinite(size) && !range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  if (range) {
    // R2 range reads avoid loading the complete master merely to seek a few seconds.
    const ranged = await bucket.get(key, { range: { offset: range.start, length: range.length } });
    return new Response(ranged?.body || null, { status: 206, headers: { "content-type": type, "content-length": String(range.length), "content-range": `bytes ${range.start}-${range.end}/${size}`, "accept-ranges": "bytes", "cache-control": "private, max-age=300", ...extraHeaders } });
  }
  return new Response(object.body, { headers: { "content-type": type, ...(Number.isFinite(size) ? { "content-length": String(size) } : {}), "accept-ranges": "bytes", "cache-control": "private, max-age=300", ...extraHeaders } });
}

async function serveAudio(context) {
  const url = new URL(context.request.url); const id = clean(url.searchParams.get("id"), 80); const scope = clean(url.searchParams.get("scope"), 12); const accessToken = clean(url.searchParams.get("token"), 160);
  if (!/^ace_[a-z0-9]+$/i.test(id) || !["preview", "full"].includes(scope) || !accessToken) return new Response("Not found", { status: 404 });
  const manifest = await getManifest(context, id); const expected = scope === "full" ? manifest?.fullToken : manifest?.previewToken;
  if (!manifest || manifest.status !== "ready" || !expected || expected !== accessToken) return new Response("Forbidden", { status: 403 });
  const sourceId = clean(manifest.sourceJobId, 80) || id; const key = scope === "preview" && manifest.fullSongPreview !== true ? previewObjectKey(sourceId) : objectKey(sourceId);
  const bucket = audioBucket(context); const object = await bucket.get(key); if (!object) return new Response("Not found", { status: 404 });
  return audioResponse(object, bucket, key, context.request, { "x-focus-beat-scope": scope, ...(scope === "preview" ? { "x-focus-beat-preview-seconds": String(manifest.fullSongPreview === true ? manifest.duration : previewDuration(context.env)), "x-focus-beat-preview-kind": manifest.fullSongPreview === true ? "temporary-full-song" : "legacy-clip" } : {}) });
}

async function deleteAce(payload, context) {
  const id = clean(payload.jobId, 80); const accessToken = clean(payload.accessToken, 160); const manifest = await getManifest(context, id);
  if (!manifest) return { deleted: true, jobId: id };
  if (!verifyManifest(manifest, accessToken)) throw new Error("删除凭证无效");
  const keys = [manifestKey(id)];
  if (manifest.kind !== "complete") keys.push(objectKey(id), previewObjectKey(id));
  await Promise.all(keys.map(key => audioBucket(context).delete(key))); return { deleted: true, jobId: id };
}

function mock(action, payload, context) {
  const seed = Number(payload.seed) || Date.now(); const id = clean(payload.jobId, 80) || `ace_mock_${hash(`${payload.title}|${payload.lyrics}|${seed}`).toString(36)}`;
  if (action === "delete") return { deleted: true, jobId: id };
  if (action === "status") return { jobId: id, status: "ready", mode: "mock", provider: "acemusic-mock", audioUrl: "/mock-ready", accessToken: payload.accessToken || "mock-token", duration: 60, seed, previewFraction: 1, fullSongPreview: true, temporary: true };
  if (action === "complete") return { jobId: `ace_mock_full_${seed}`, previewJobId: clean(payload.previewJobId, 80), status: "ready", mode: "mock", provider: "acemusic-mock", audioUrl: "/mock-full", accessToken: "mock-full", duration: 60, seed, unlocked: true };
  return { jobId: id, status: "ready", mode: "mock", provider: "acemusic-mock", audioUrl: "/mock-preview", accessToken: "mock-preview", duration: 60, seed, previewFraction: 1, fullSongPreview: true, temporary: true };
}

function isLocalRequest(request) { const hostname = new URL(request.url).hostname; return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"; }
function checkOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return isLocalRequest(request);
  try { return new URL(origin).host === new URL(request.url).host; } catch (_) { return false; }
}
function clientIdentity(request) { return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || (isLocalRequest(request) ? "local-development" : "unknown"); }
async function readJsonObject(bucket, key) {
  const object = await bucket.get(key); if (!object) return null;
  try { return JSON.parse(await object.text()); } catch (_) { return null; }
}
async function rateLimitPreview(context) {
  const now = new Date(); const hour = now.toISOString().slice(0, 13); const day = now.toISOString().slice(0, 10); const identity = clientIdentity(context.request);
  const hourlyLimit = Math.max(1, Math.min(30, Number(context.env.MUSIC_HOURLY_LIMIT || context.env.ACEMUSIC_HOURLY_LIMIT) || 8));
  const dailyLimit = Math.max(1, Math.min(1000, Number(context.env.MUSIC_DAILY_LIMIT) || 15));
  const hourlyKey = rateKey(`${identity}|${hour}`); const dailyKey = quotaKey(`global|${day}`);
  const [hourly, daily] = await Promise.all([readJsonObject(audioBucket(context), hourlyKey), readJsonObject(audioBucket(context), dailyKey)]);
  if (Number(hourly?.count) >= hourlyLimit) throw new Error(`本小时真唱生成次数已达上限（${hourlyLimit} 次），请稍后再试`);
  if (Number(daily?.count) >= dailyLimit) throw new Error(`今日全站真唱生成额度已达上限（${dailyLimit} 次），请明天再试或提高 MUSIC_DAILY_LIMIT`);
  return [{ key: hourlyKey, count: Number(hourly?.count) || 0 }, { key: dailyKey, count: Number(daily?.count) || 0 }];
}
async function commitRate(context, rates) { await Promise.all(rates.map(rate => audioBucket(context).put(rate.key, JSON.stringify({ count: rate.count + 1, updatedAt: nowIso() }), { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } }))); }
async function idempotentPreview(context) {
  const value = clean(context.request.headers.get("x-idempotency-key"), 120); if (!value) return null;
  const key = idempotencyKey(`${clientIdentity(context.request)}|${value}`); const cached = await readJsonObject(audioBucket(context), key);
  // Asynchronous tasks must remain idempotent while queued/running. Otherwise a
  // browser retry can create a second paid provider task before the first ends.
  if (cached?.jobId) { const manifest = await getManifest(context, cached.jobId); if (manifest) return { key, data: publicJob(manifest, context) }; }
  return { key, data: null };
}
function publicError(error, context) {
  const aborted = error?.name === "AbortError" || /operation was aborted/i.test(String(error?.message || ""));
  const label = providerLabel(context.env);
  if (aborted) return `${label} 云端生成请求在限定时间内没有响应；这通常表示服务拥堵或生成超时，未交付不完整歌曲`;
  let raw = String(error?.message || "未知错误");
  for (const key of [context.env.TREBLO_API_KEY, context.env.MINIMAX_API_KEY, context.env.ACEMUSIC_API_KEY]) if (key) raw = raw.replaceAll(String(key), "[已隐藏]");
  if (/返回 504/.test(raw)) return `${raw}；${label} 上游网关超时，未生成不完整歌曲，请稍后重试`;
  return raw.slice(0, 420);
}

export async function onRequestPost(context) {
  if (!checkOrigin(context.request)) return json({ ok: false, error: "不允许跨站调用" }, 403);
  let body; try { body = await context.request.json(); } catch (_) { return json({ ok: false, error: "请求必须是 JSON" }, 400); }
  const action = clean(body?.action, 20); const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  if (!ACTIONS.has(action)) return json({ ok: false, error: "不支持的音乐任务" }, 400);
  if (JSON.stringify(payload).length > 20_000) return json({ ok: false, error: "输入内容过长" }, 413);
  if (context.env.MUSIC_MODE === "mock") return json({ ok: true, data: mock(action, payload, context), meta: { mode: "mock", provider: "acemusic-mock", async: false } });
  if (!canUseMusic(context.env)) {
    const provider = musicProvider(context.env); const keyName = provider === "treblo" ? "TREBLO_API_KEY" : provider === "minimax" ? "MINIMAX_API_KEY" : "ACEMUSIC_API_KEY";
    return json({ ok: false, error: `专业音乐服务尚未配置：请设置 ${keyName} 并绑定 MUSIC_AUDIO R2` }, 503);
  }
  try {
    let data;
    if (action === "delete") data = await deleteAce(payload, context);
    else if (action === "status") data = await refreshJob(payload, context);
    else if (action === "complete") data = await startComplete(payload, context);
    else {
      if (!clean(payload.title, 32) || !clean(payload.lyrics, 2400)) return json({ ok: false, error: "歌曲名称和歌词不能为空" }, 400);
      const idempotent = await idempotentPreview(context);
      if (idempotent?.data) data = idempotent.data;
      else {
        const rate = await rateLimitPreview(context);
        data = await startPreview(payload, context);
        await commitRate(context, rate);
        if (idempotent?.key) await audioBucket(context).put(idempotent.key, JSON.stringify({ jobId: data.jobId, createdAt: nowIso() }), { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } });
      }
    }
    const provider = musicProvider(context.env); const asynchronous = provider === "treblo" || (provider === "acemusic" && nativeAsyncEnabled(context.env));
    const strategy = provider === "treblo" ? "single-master-treblo-v3" : provider === "minimax" ? "single-master-minimax-v1" : asynchronous ? "single-master-v4-async" : "single-master-v3";
    const providerMode = provider === "treblo" ? "melodia-v3" : provider === "minimax" ? "music-generation" : apiMode(context.env);
    return json({ ok: true, data, meta: { mode: "remote", provider, apiMode: providerMode, async: asynchronous, supportsExtend: false, sameAudio: true, strategy, renderMode: data?.renderMode || effectiveRenderMode(context.env, payload) } });
  } catch (error) {
    const label = providerLabel(context.env); console.error(`${label} task failed`, error?.message);
    const message = publicError(error, context); const unavailable = /返回 (404|405)/.test(message);
    const limited = /(?:本小时真唱生成次数|今日全站真唱生成额度)已达上限/.test(message);
    return json({ ok: false, error: unavailable ? `${label} 云端接口不可用：${message}` : `${label} 音乐任务失败：${message}` }, limited ? 429 : unavailable ? 501 : 502);
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url); if (url.searchParams.get("audio") === "1") return serveAudio(context);
  const provider = musicProvider(context.env); const configured = canUseMusic(context.env) && context.env.MUSIC_MODE !== "mock";
  const asynchronous = provider === "treblo" || (provider === "acemusic" && nativeAsyncEnabled(context.env));
  const strategy = provider === "treblo" ? "single-master-treblo-v3" : provider === "minimax" ? "single-master-minimax-v1" : asynchronous ? "single-master-v4-async" : "single-master-v3";
  const providerMode = provider === "treblo" ? "melodia-v3" : provider === "minimax" ? "music-generation" : apiMode(context.env);
  return json({ ok: true, service: `Focus Beat ${providerLabel(context.env)} single-master gateway`, actions: [...ACTIONS], meta: configured ? { mode: "remote", provider, apiMode: providerMode, supportsExtend: false, sameAudio: true, async: asynchronous, strategy, renderMode: effectiveRenderMode(context.env) } : { mode: "unconfigured", provider, supportsExtend: false, sameAudio: false, async: false } });
}
