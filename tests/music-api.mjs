import assert from "node:assert/strict";
import { onRequestGet, onRequestPost } from "../functions/api/music.js";

class MemoryBucket {
  constructor() { this.items = new Map(); }
  async put(key, value, options = {}) { this.items.set(key, { value, options }); }
  async get(key, options = {}) {
    const item = this.items.get(key); if (!item) return null;
    const raw = typeof item.value === "string" ? new TextEncoder().encode(item.value) : new Uint8Array(item.value);
    const bytes = options.range ? raw.slice(options.range.offset, options.range.offset + options.range.length) : raw;
    return {
      body: bytes,
      size: raw.byteLength,
      httpMetadata: item.options.httpMetadata || {},
      async text() { return new TextDecoder().decode(bytes); },
    };
  }
  async delete(key) { this.items.delete(key); }
}

const bucket = new MemoryBucket();
const env = {
  ACEMUSIC_API_KEY: "test-key",
  ACEMUSIC_BASE_URL: "https://ace.test",
  ACEMUSIC_MODEL: "acemusic/acestep-v15-turbo",
  ACEMUSIC_DURATION: "60",
  ACEMUSIC_PREVIEW_DURATION: "30",
  ACEMUSIC_API_MODE: "cloud_completion",
  MUSIC_AUDIO: bucket,
};

let providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  providerCalls += 1;
  assert.equal(String(url), "https://ace.test/v1/chat/completions");
  const body = JSON.parse(options.body);
  assert.equal(body.task_type, "text2music");
  assert.match(body.lyrics, /今天发光/);
  assert.equal(body.duration, 60, "synchronous ACE requests must not grow beyond the upstream-safe duration");
  return Response.json({
    id: "provider-song-1",
    audio_url: "data:audio/mpeg;base64,SUQzBAAAAAAA",
    token_timestamps: [
      { text: "今", start: 1, end: 1.4 },
      { text: "天", start: 1.4, end: 1.8 },
      { text: "发", start: 1.8, end: 2.2 },
      { text: "光", start: 2.2, end: 2.6 },
    ],
    lyrics_score: 0.92,
  });
};

function context(action, payload, extraHeaders = {}) {
  return {
    env,
    request: new Request("http://127.0.0.1:8788/api/music", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788", ...extraHeaders },
      body: JSON.stringify({ action, payload }),
    }),
  };
}

try {
  const previewPayload = { title: "测试歌", style: "pop", lyrics: "[主歌 A]\n今天发光", seed: 7 };
  const previewResponse = await onRequestPost(context("preview", previewPayload, { "x-idempotency-key": "same-preview-request" }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.ok, true);
  assert.equal(preview.meta.apiMode, "cloud_completion");
  assert.equal(preview.meta.strategy, "single-master-v3");
  assert.equal(preview.data.duration, 60, "temporary preview must expose the complete generated song");
  assert.equal(preview.data.fullSongPreview, true);
  assert.equal(preview.data.previewFraction, 1);
  assert.equal(preview.data.alignmentStatus, "verified");
  assert.equal(preview.data.alignment.source, "ace-token-timestamps");
  const duplicate = await (await onRequestPost(context("preview", previewPayload, { "x-idempotency-key": "same-preview-request" }))).json();
  assert.equal(duplicate.data.jobId, preview.data.jobId, "idempotent retry should return the first completed preview");
  assert.equal(providerCalls, 1, "idempotent retry must not call ACE twice");
  const previewAudio = await onRequestGet({ env, request: new Request(preview.data.audioUrl, { headers: { range: "bytes=0-4" } }) });
  assert.equal(previewAudio.status, 206, "full-song preview must support streaming and seeking");
  assert.equal(previewAudio.headers.get("x-focus-beat-preview-kind"), "temporary-full-song");
  assert.equal(previewAudio.headers.get("x-focus-beat-preview-seconds"), "60");

  const completeResponse = await onRequestPost(context("complete", { previewJobId: preview.data.jobId, accessToken: preview.data.accessToken }));
  assert.equal(completeResponse.status, 200);
  const complete = await completeResponse.json();
  assert.equal(complete.ok, true);
  assert.equal(complete.data.unlocked, true);
  assert.ok(complete.data.duration >= 60);
  assert.equal(providerCalls, 1, "unlock must reuse the preview master without a second ACE request");
  assert.equal([...bucket.items.keys()].filter(key => key.startsWith("ace/audio/")).length, 1, "unlock must not duplicate the complete master in R2");
  assert.equal([...bucket.items.keys()].filter(key => key.startsWith("ace/previews/")).length, 0, "full-song preview must stream the existing master instead of duplicating it in R2");
  const audioUrl = `http://127.0.0.1:8788/api/music?audio=1&id=${complete.data.jobId}&scope=full&token=${complete.data.accessToken}`;
  const ranged = await onRequestGet({ env, request: new Request(audioUrl, { headers: { range: "bytes=0-4" } }) });
  assert.equal(ranged.status, 206, "full audio seeking should return a real partial response");
  assert.match(ranged.headers.get("content-range") || "", /^bytes 0-4\//);
} finally {
  globalThis.fetch = originalFetch;
}

const crossSite = await onRequestPost({ env, request: new Request("https://focus.example/api/music", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", payload: { title: "测试", lyrics: "测试" } }) }) });
assert.equal(crossSite.status, 403, "production requests without a same-origin Origin header must be rejected");

const asyncBucket = new MemoryBucket(); const asyncEnv = { ...env, ACEMUSIC_API_MODE: "native_async", MUSIC_AUDIO: asyncBucket }; let asyncPolls = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address.endsWith("/release_task")) {
    const body = JSON.parse(options.body); assert.equal(body.audio_duration, 60); assert.match(body.prompt, /lead singer/i); return Response.json({ code: 200, data: { task_id: "native-job-1", status: 0, queue_position: 2, eta_seconds: 12 } });
  }
  if (address.endsWith("/query_result")) {
    assert.deepEqual(JSON.parse(options.body), { task_id_list: ["native-job-1"] });
    asyncPolls += 1;
    return Response.json(asyncPolls === 1 ? { code: 200, data: [{ task_id: "native-job-1", status: 0, progress: .5 }] } : { code: 200, data: [{ task_id: "native-job-1", status: 1, first_audio_path: "/v1/audio?path=%2Ftmp%2Fsong.mp3", duration: 60 }] });
  }
  if (address.includes("/v1/audio?")) return new Response(new Uint8Array(1024).fill(7), { headers: { "content-type": "audio/mpeg" } });
  throw new Error(`Unexpected async URL: ${address}`);
};
try {
  const makeRequest = (action, payload) => onRequestPost({ env: asyncEnv, request: new Request("http://127.0.0.1:8788/api/music", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788" }, body: JSON.stringify({ action, payload }) }) });
  const payload = { title: "异步测试歌", style: "pop", lyrics: "[主歌 A]\n今天发光", seed: 13 };
  const submitted = await (await makeRequest("preview", payload)).json(); assert.equal(submitted.data.status, "queued"); assert.equal(submitted.data.asynchronous, true);
  const running = await (await makeRequest("status", { jobId: submitted.data.jobId, accessToken: submitted.data.accessToken })).json(); assert.equal(running.data.status, "running");
  const ready = await (await makeRequest("status", { jobId: submitted.data.jobId, accessToken: submitted.data.accessToken })).json(); assert.equal(ready.data.status, "ready"); assert.ok(ready.data.audioUrl, "async task completion should persist protected audio");
  const unlocked = await (await makeRequest("complete", { previewJobId: ready.data.jobId, accessToken: ready.data.accessToken })).json(); assert.equal(unlocked.data.unlocked, true, "async preview should unlock the same master without another ACE task");
} finally { globalThis.fetch = originalFetch; }

const trebloBucket = new MemoryBucket();
const trebloEnv = { MUSIC_PROVIDER: "treblo", TREBLO_API_KEY: "test-treblo-key", TREBLO_BASE_URL: "https://treblo.test/v1", TREBLO_MODEL_VERSION: "v3", TREBLO_TARGET_DURATION: "60", MUSIC_AUDIO: trebloBucket };
let trebloSubmits = 0; let trebloStatusCalls = 0; let trebloDownloads = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address === "https://treblo.test/v1/generations/v3") {
    trebloSubmits += 1; const body = JSON.parse(options.body);
    assert.match(body.prompt, /Mandarin lead singing/); assert.match(body.lyrics, /今天发光/);
    assert.deepEqual(body.length_range, [60, 90], "Treblo length bounds must be distinct 30-second multiples"); assert.equal(body.output_format, "mp3"); assert.equal(body.output_bit_rate, 192, "Treblo bitrate must use kbps units"); assert.equal(body.align_lyrics, true); assert.equal(body.instrumental, false); assert.equal("tags" in body, false);
    return Response.json({ task_id: "treblo-task-1" });
  }
  if (address.includes("/generations/status/treblo-task-1")) {
    trebloStatusCalls += 1;
    return Response.json(trebloStatusCalls === 1 ? { status: "GENERATING", alignment_status: "REQUESTED" } : { status: "SUCCESS", alignment_status: "SUCCESS" });
  }
  if (address === "https://treblo.test/v1/generations/treblo-task-1") return Response.json({ id: "treblo-task-1", status: "SUCCESS", model_version: "v3-preview", song_paths: ["https://cdn.treblo.test/song.mp3"], lyrics: "[主歌 A]\n今天发光", duration: 60 });
  if (address === "https://cdn.treblo.test/song.mp3") { trebloDownloads += 1; return new Response(new Uint8Array(4096).fill(11), { headers: { "content-type": "audio/mpeg" } }); }
  throw new Error(`Unexpected Treblo URL: ${address}`);
};
try {
  const makeRequest = (action, payload, idempotencyKey = "") => onRequestPost({ env: trebloEnv, request: new Request("http://127.0.0.1:8788/api/music", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788", ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}) }, body: JSON.stringify({ action, payload }) }) });
  const payload = { title: "Treblo 测试歌", style: "pop", lyrics: "[主歌 A]\n今天发光", seed: 31 };
  const submitted = await (await makeRequest("preview", payload, "same-treblo-preview")).json(); assert.equal(submitted.ok, true); assert.equal(submitted.data.status, "queued"); assert.equal(submitted.data.provider, "treblo"); assert.equal(submitted.meta.async, true); assert.equal(submitted.meta.strategy, "single-master-treblo-v3");
  const duplicatePending = await (await makeRequest("preview", payload, "same-treblo-preview")).json(); assert.equal(duplicatePending.data.jobId, submitted.data.jobId, "queued Treblo retries must return the accepted task"); assert.equal(trebloSubmits, 1, "queued idempotent retry must not spend credits on another Treblo task");
  const running = await (await makeRequest("status", { jobId: submitted.data.jobId, accessToken: submitted.data.accessToken })).json(); assert.equal(running.data.status, "running");
  const ready = await (await makeRequest("status", { jobId: submitted.data.jobId, accessToken: submitted.data.accessToken })).json(); assert.equal(ready.data.status, "ready"); assert.equal(ready.data.duration, 60); assert.equal(ready.data.fullSongPreview, true); assert.ok(ready.data.audioUrl);
  const unlocked = await (await makeRequest("complete", { previewJobId: ready.data.jobId, accessToken: ready.data.accessToken })).json(); assert.equal(unlocked.data.unlocked, true); assert.equal(unlocked.data.provider, "treblo"); assert.equal(unlocked.data.duration, 60);
  assert.equal(trebloSubmits, 1, "Treblo must create only one master task"); assert.equal(trebloDownloads, 1, "Treblo's expiring CDN song must be copied to R2 exactly once");
} finally { globalThis.fetch = originalFetch; }

const quotaBucket = new MemoryBucket(); const quotaEnv = { ...trebloEnv, MUSIC_AUDIO: quotaBucket, MUSIC_DAILY_LIMIT: "1", MUSIC_HOURLY_LIMIT: "8" }; let quotaSubmits = 0;
globalThis.fetch = async url => { if (String(url).endsWith("/generations/v3")) { quotaSubmits += 1; return Response.json({ task_id: `quota-task-${quotaSubmits}` }); } throw new Error(`Unexpected quota URL: ${url}`); };
try {
  const makeRequest = seed => onRequestPost({ env: quotaEnv, request: new Request("http://127.0.0.1:8788/api/music", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788" }, body: JSON.stringify({ action: "preview", payload: { title: "额度测试", style: "pop", lyrics: "[主歌 A]\n今天发光", seed } }) }) });
  assert.equal((await makeRequest(1)).status, 200);
  const limited = await makeRequest(2); const limitedBody = await limited.json(); assert.equal(limited.status, 429); assert.match(limitedBody.error, /今日全站真唱生成额度已达上限/); assert.equal(quotaSubmits, 1, "daily quota must reject before contacting Treblo");
} finally { globalThis.fetch = originalFetch; }

const adaptiveDurationBucket = new MemoryBucket();
const adaptiveDurationEnv = { ...trebloEnv, MUSIC_AUDIO: adaptiveDurationBucket };
delete adaptiveDurationEnv.TREBLO_TARGET_DURATION;
globalThis.fetch = async (_url, options = {}) => {
  const body = JSON.parse(options.body);
  assert.deepEqual(body.length_range, [180, 210], "long Treblo lyrics should expand the duration without forcing every song to the maximum");
  return Response.json({ task_id: "treblo-adaptive-duration" });
};
try {
  const longLyrics = `[主歌 A]\n${"今天认真学习勇敢向前".repeat(30)}`;
  const response = await onRequestPost({ env: adaptiveDurationEnv, request: new Request("http://127.0.0.1:8788/api/music", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788" }, body: JSON.stringify({ action: "preview", payload: { title: "长歌测试", style: "pop", lyrics: longLyrics, seed: 19 } }) }) });
  assert.equal(response.status, 200);
} finally { globalThis.fetch = originalFetch; }

const validationBucket = new MemoryBucket(); const validationEnv = { ...trebloEnv, MUSIC_AUDIO: validationBucket, TREBLO_TARGET_DURATION: "300" };
globalThis.fetch = async (_url, options = {}) => { assert.deepEqual(JSON.parse(options.body).length_range, [270, 300], "300-second setting must still produce distinct valid bounds"); return Response.json({ detail: [{ loc: ["body", "output_bit_rate"], msg: "Input should be 128, 192, 256 or 320", type: "enum" }] }, { status: 422 }); };
try {
  const response = await onRequestPost({ env: validationEnv, request: new Request("http://127.0.0.1:8788/api/music", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788" }, body: JSON.stringify({ action: "preview", payload: { title: "校验错误", style: "pop", lyrics: "[主歌 A]\n今天发光", seed: 9 } }) }) });
  const result = await response.json(); assert.equal(response.status, 502); assert.match(result.error, /output_bit_rate/); assert.doesNotMatch(result.error, /\[object Object\]/, "structured Treblo validation errors must remain readable");
} finally { globalThis.fetch = originalFetch; }

const minimaxBucket = new MemoryBucket();
const minimaxEnv = {
  MUSIC_PROVIDER: "minimax",
  MINIMAX_API_KEY: "test-minimax-key",
  MINIMAX_BASE_URL: "https://minimax.test",
  MINIMAX_MUSIC_MODEL: "music-2.6-free",
  MINIMAX_TARGET_DURATION: "60",
  MUSIC_AUDIO: minimaxBucket,
};
let minimaxGenerationCalls = 0; let minimaxDownloadCalls = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address === "https://minimax.test/v1/music_generation") {
    minimaxGenerationCalls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.model, "music-2.6-free");
    assert.equal(body.output_format, "url");
    assert.equal(body.is_instrumental, false);
    assert.equal(body.lyrics_optimizer, false);
    assert.match(body.lyrics, /\[Verse 1\]/);
    assert.match(body.lyrics, /今天发光/);
    return Response.json({
      data: { audio: "https://cdn.minimax.test/song.mp3", status: 2 },
      trace_id: "minimax-song-1",
      extra_info: { music_duration: 60_000 },
      base_resp: { status_code: 0, status_msg: "success" },
    });
  }
  if (address === "https://cdn.minimax.test/song.mp3") {
    minimaxDownloadCalls += 1;
    return new Response(new Uint8Array(4096).fill(9), { headers: { "content-type": "audio/mpeg" } });
  }
  throw new Error(`Unexpected MiniMax URL: ${address}`);
};
try {
  const makeRequest = (action, payload, idempotencyKey = "") => onRequestPost({ env: minimaxEnv, request: new Request("http://127.0.0.1:8788/api/music", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8788", ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}) }, body: JSON.stringify({ action, payload }) }) });
  const payload = { title: "MiniMax 测试歌", style: "pop", lyrics: "[主歌 A]\n今天发光\n[副歌]\n一起向前", seed: 26 };
  const preview = await (await makeRequest("preview", payload, "minimax-preview")).json();
  assert.equal(preview.ok, true);
  assert.equal(preview.meta.provider, "minimax");
  assert.equal(preview.meta.strategy, "single-master-minimax-v1");
  assert.equal(preview.data.provider, "minimax");
  assert.equal(preview.data.duration, 60, "MiniMax preview must expose the complete temporary song");
  assert.equal(preview.data.fullSongPreview, true);
  const unlocked = await (await makeRequest("complete", { previewJobId: preview.data.jobId, accessToken: preview.data.accessToken })).json();
  assert.equal(unlocked.data.unlocked, true);
  assert.equal(unlocked.data.provider, "minimax");
  assert.equal(unlocked.data.duration, 60);
  assert.equal(minimaxGenerationCalls, 1, "unlock must reuse the same MiniMax master");
  assert.equal(minimaxDownloadCalls, 1, "MiniMax's temporary URL must be downloaded exactly once into R2");
  assert.equal([...minimaxBucket.items.keys()].filter(key => key.startsWith("ace/audio/")).length, 1);
} finally { globalThis.fetch = originalFetch; }

const localTrebloEnv = { MUSIC_PROVIDER:"treblo", TREBLO_API_KEY:"local-treblo-key", TREBLO_BASE_URL:"https://treblo.local/v1", TREBLO_MODEL_VERSION:"v3", TREBLO_TARGET_DURATION:"60", MUSIC_SIGNING_SECRET:"this-is-a-test-only-signing-secret-with-enough-length" };
let localSubmits = 0; let localStatusCalls = 0; let localDownloads = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address === "https://treblo.local/v1/generations/v3") { localSubmits += 1; return Response.json({ task_id:"local-task-1" }); }
  if (address.includes("/generations/status/local-task-1")) { localStatusCalls += 1; return Response.json({ status:"SUCCESS", alignment_status:"SUCCESS" }); }
  if (address === "https://treblo.local/v1/generations/local-task-1") return Response.json({ status:"SUCCESS", song_paths:["https://cdn.treblo.local/local-song.mp3"], duration:60, lyrics:"[主歌 A]\\n今天发光" });
  if (address === "https://cdn.treblo.local/local-song.mp3") { localDownloads += 1; return new Response(new Uint8Array(1024).fill(7), { headers:{ "content-type":"audio/mpeg", "content-length":"1024" } }); }
  throw new Error(`Unexpected local Treblo URL: ${address}`);
};
try {
  const request = (action, payload, headers = {}) => onRequestPost({ env:localTrebloEnv, request:new Request("http://127.0.0.1:8788/api/music", { method:"POST", headers:{ "content-type":"application/json", origin:"http://127.0.0.1:8788", ...headers }, body:JSON.stringify({ action, payload }) }) });
  const payload = { title:"本地收藏测试", style:"pop", lyrics:"[主歌 A]\\n今天发光", seed:52 };
  const queued = await (await request("preview", payload, { "x-idempotency-key":"local-preview" })).json();
  assert.equal(queued.ok, true); assert.equal(queued.data.status, "queued"); assert.ok(queued.data.accessToken.length > 40, "local job must carry a signed short-lived task token");
  const duplicate = await (await request("preview", payload, { "x-idempotency-key":"local-preview" })).json(); assert.equal(duplicate.data.jobId, queued.data.jobId); assert.equal(localSubmits, 1, "local-mode retry created a duplicate Treblo task");
  const ready = await (await request("status", { jobId:queued.data.jobId, accessToken:queued.data.accessToken, lyrics:payload.lyrics })).json();
  assert.equal(ready.data.status, "ready"); assert.match(ready.data.audioUrl, /localAudio=1/); assert.equal(localDownloads, 0, "status must not download audio into a server bucket");
  const audio = await onRequestGet({ env:localTrebloEnv, request:new Request(ready.data.audioUrl) });
  assert.equal(audio.status, 200); assert.equal(Number(audio.headers.get("content-length")), 1024); assert.equal(localDownloads, 1, "the browser download proxy did not stream the provider audio");
} finally { globalThis.fetch = originalFetch; }

console.log("PASS music API single-master flow");
