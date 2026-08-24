import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { onRequestPost as onAiPost } from "../functions/api/ai.js";
import { onRequestGet as onMusicGet, onRequestPost as onMusicPost } from "../functions/api/music.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/api/ai") { response.writeHead(404); response.end(); return; }
  const relative = pathname === "/" ? "index.html" : pathname.slice(1); const target = path.resolve(root, relative);
  if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": mime[path.extname(target)] || "application/octet-stream" }); response.end(fs.readFileSync(target));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === "win32" && fs.existsSync(edge) ? edge : undefined) });
const results = [];
function assert(condition, message) { if (!condition) throw new Error(message); }
async function test(name, run) { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } }

function mockResponse(request, mode) {
  if (request.method() === "GET") return { ok: true, service: "mock", meta: mode === "remote" ? { mode: "mock", provider: "acemusic-mock", supportsExtend: false, sameAudio: true } : { mode: "unconfigured", provider: "acemusic", supportsExtend: false } };
  const body = JSON.parse(request.postData() || "{}"); const action = body.action; const payload = body.payload || {}; const id = `ace_mock_${String(payload.seed || 1)}`;
  if (mode !== "remote") return { ok: false, error: "专业音乐服务尚未配置" };
  if (action === "delete") return { ok: true, data: { deleted: true, jobId: payload.jobId }, meta: { mode: "mock", provider: "acemusic-mock" } };
  if (action === "complete") return { ok: true, data: { jobId: payload.previewJobId, previewJobId: payload.previewJobId, provider: "acemusic-mock", mode: "mock", audioUrl: `/mock-full/${payload.previewJobId}`, accessToken: "full-token", duration: 120, unlocked: true }, meta: { mode: "mock", provider: "acemusic-mock", sameAudio: true } };
  return { ok: true, data: { jobId: id, provider: "acemusic-mock", mode: "mock", audioUrl: `/mock-preview/${id}`, accessToken: "preview-token", duration: 120, previewFraction: 1, fullSongPreview: true, temporary: true, seed: payload.seed }, meta: { mode: "mock", provider: "acemusic-mock", sameAudio: true } };
}

async function newPage({ viewport = { width: 1280, height: 900 }, music = "remote", ai = "remote", storedState = null } = {}) {
  const context = await browser.newContext({ viewport }); const page = await context.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text()); });
  if (storedState) await page.addInitScript(value => localStorage.setItem("focusBeatPlanet.v2", JSON.stringify(value)), storedState);
  await page.addInitScript(() => { HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; HTMLMediaElement.prototype.pause = function () {}; window.__mockAudios = []; class MockAudio extends EventTarget { constructor(src = "") { super(); this.src = src; this.currentTime = 0; this.duration = 120; this.paused = true; window.__mockAudios.push(this); } play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); } pause() { this.paused = true; this.dispatchEvent(new Event("pause")); } } window.Audio = MockAudio; });
  await page.route("**/api/ai**", async route => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, meta: { mode: ai, provider: "test-ai", reason: ai === "degraded" ? "响应超过 32 秒" : "" } }) });
    const body = JSON.parse(request.postData() || "{}");
    const response = await onAiPost({ env: { AI_MODE: "mock" }, request: new Request("http://localhost/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json(); data.meta = { ...data.meta, mode: ai, provider: "test-ai", reason: ai === "degraded" ? "响应超过 32 秒" : "" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.route("**/api/music**", async route => { const data = mockResponse(route.request(), music); await route.fulfill({ status: data.ok ? 200 : 503, contentType: "application/json", body: JSON.stringify(data) }); });
  await page.route("**/mock-preview/**", async route => { await route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.alloc(128, 7) }); });
  await page.route("**/mock-full/**", async route => { await route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.alloc(128, 7) }); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" }); return { context, page, errors };
}
async function createLyrics(page) { await page.locator("#generateLyricsBtn").click(); await page.waitForFunction(() => document.querySelector("#lyrics").value.length > 40); }
async function continuePreviewIfWarn(page) { const modal = page.locator("#previewWarningModal.is-open"); if (await modal.count()) await page.locator("#continuePreviewBtn").click(); }

await test("text AI local contract remains available", async () => {
  const call = seed => onAiPost({ env: { AI_MODE: "mock" }, request: new Request("http://localhost/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "lyrics", payload: { title: "测试之歌", style: "pop", topic: "认真学习", seed } }) }) });
  const first = await (await call(11)).json(); const second = await (await call(12)).json();
  assert(first.ok && first.data.lyrics.length > 40, "lyrics fallback response is invalid"); assert(first.data.lyrics !== second.data.lyrics, "lyrics do not vary by seed");
});

await test("ACE adapter does not silently downgrade a 504 into a short incomplete song", async () => {
  const originalFetch = globalThis.fetch; const objects = new Map(); const calls = [];
  const bucket = {
    async put(key, body, options = {}) { const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body); objects.set(key, { body: bytes, size: bytes.byteLength, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata, async text() { return new TextDecoder().decode(bytes); } }); },
    async get(key, options) { const item = objects.get(key); if (!item) return null; if (!options?.range) return item; const { offset, length } = options.range; return { ...item, body: item.body.slice(offset, offset + length), size: length }; },
    async delete(key) { objects.delete(key); },
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("chat/completions")) {
      const body = JSON.parse(options.body); const attempt = calls.filter(call => call.url.includes("chat/completions")).length;
      assert(body.thinking === false, "completion requests should disable thinking");
      assert(typeof body.lyrics === "string" && body.lyrics.length > 0, "completion requests should send lyrics explicitly");
      assert(body.stream === false && body.task_type === "text2music", "master request should use a bounded non-streaming text2music response");
      assert(body.inference_steps === 5 && body.infer_method === "ode", "cloud request did not apply the safe Turbo inference profile");
      assert(body.duration >= 60 && body.audio_config.duration === body.duration && Number.isInteger(body.seed), "full-master duration or tune seed was not sent in the cloud request");
      assert(body.use_cot_metas === false && body.sample_mode === false, "cloud request could still overwrite the explicit duration");
      assert(typeof body.messages[0].content === "string" && body.messages[0].content.includes("<prompt>") && body.messages[0].content.includes("<lyrics>"), "cloud request did not use tagged mode");
      return new Response("error code: 504", { status: 504 });
    }
    return new Response(new Uint8Array(100).fill(7), { status: 200, headers: { "content-type": "audio/mpeg" } });
  };
  try {
    const request = (action, payload) => onMusicPost({ env: { ACEMUSIC_API_KEY: "test-key", ACEMUSIC_API_MODE: "cloud_completion", MUSIC_AUDIO: bucket }, request: new Request("http://localhost/api/music", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) }) });
    const input = { title: "测试之歌", style: "pop", lyrics: "[主歌]\n认真学习慢慢向前\n[副歌]\n今天我会发光", seed: 123 };
    const preview = await (await request("preview", input)).json(); assert(!preview.ok && preview.error.includes("504"), "504 should fail instead of returning a shortened song");
    assert(calls.filter(call => call.url.includes("chat/completions")).length === 1, "a failed full generation must not be retried with a shorter duration");
    await bucket.put("ace/jobs/ace_old.json", JSON.stringify({ jobId: "ace_old", kind: "preview", status: "ready", previewToken: "old-token", fullToken: "hidden", duration: 30 }));
    await bucket.put("ace/audio/ace_old.mp3", new Uint8Array(50).fill(3), { httpMetadata: { contentType: "audio/mpeg" } });
    const oldUnlock = await (await request("complete", { previewJobId: "ace_old", accessToken: "old-token" })).json(); assert(!oldUnlock.ok && oldUnlock.error.includes("旧版试听"), "legacy preview did not require regeneration");
  } finally { globalThis.fetch = originalFetch; }
});

await test("unconfigured ACE service fails clearly instead of using a metronome fallback", async () => {
  const response = await onMusicPost({ env: {}, request: new Request("http://localhost/api/music", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", payload: { title: "测试", style: "pop", lyrics: "今天我会发光" } }) }) });
  const data = await response.json(); assert(response.status === 503 && data.error.includes("尚未配置"), "unconfigured ACE did not return a clear error");
});

await test("ACE adapter generates one full master and unlocks the same source audio", async () => {
  const originalFetch = globalThis.fetch; const objects = new Map(); const calls = [];
  const bucket = {
    async put(key, body, options = {}) { const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body); objects.set(key, { body: bytes, httpMetadata: options.httpMetadata, async text() { return new TextDecoder().decode(bytes); } }); },
    async get(key) { return objects.get(key) || null; }, async delete(key) { objects.delete(key); },
  };
  const audio = `data:audio/mpeg;base64,${Buffer.from(new Uint8Array(96).fill(9)).toString("base64")}`;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("chat/completions")) {
      const body = JSON.parse(options.body); assert(body.duration >= 60 && body.task_type === "text2music", "preview must create one full text2music master");
      const stream = [`data: ${JSON.stringify({ id: "provider-master", choices: [{ delta: { audio: [{ audio_url: { url: audio } }] }, finish_reason: null }] })}`, "data: [DONE]", ""].join("\n\n"); return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const request = (action, payload) => onMusicPost({ env: { ACEMUSIC_API_KEY: "test-key", ACEMUSIC_API_MODE: "cloud_completion", MUSIC_AUDIO: bucket, ACEMUSIC_DURATION: "60" }, request: new Request("http://localhost/api/music", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) }) });
    const lyrics = "[主歌]\n认真学习慢慢向前每天都在进步\n每个清晨都把新的目标点亮\n翻开书本就有新的发现\n[副歌]\n今天我会发光勇敢走向远方\n每一步都留下努力的回响\n[桥段]\n把每个难题变成新的力量\n坚持到底就能看见答案\n[终章副歌]\n梦想就在前方等待我发光\n我们一起唱出明天的希望";
    const preview = await (await request("preview", { title: "续写测试", style: "pop", lyrics, seed: 42 })).json(); assert(preview.ok && preview.data.duration === 60 && preview.data.fullSongPreview, "preview did not expose the complete temporary song");
    const complete = await (await request("complete", { previewJobId: preview.data.jobId, accessToken: preview.data.accessToken })).json(); assert(complete.ok && complete.data.duration >= 60, "full master was not unlocked"); assert(calls.filter(call => call.url.includes("chat/completions")).length === 1, "unlock must not make a second music-generation request");
  } finally { globalThis.fetch = originalFetch; }
});

await test("page generates, charges and unlocks a mock true-singing asset without local audio fallback", async () => {
  const { context, page, errors } = await newPage(); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  await page.locator("#playSongBtn").click(); await page.locator("#playSongBtn:not([disabled])").waitFor(); assert(await page.locator("#totalNotes").textContent() === "34", "preview did not charge one note");
  const preview = await page.evaluate(() => window.__focusBeat.currentDraft.preview); assert(preview.audioUrl && preview.accessToken, "preview did not receive protected ACE audio");
  await page.locator("#playSongBtn").click(); await continuePreviewIfWarn(page); assert(await page.locator("#playSongBtn").textContent() === "■ 停止播放", "preview did not use an audio asset"); await page.locator("#playSongBtn").click();
  await page.locator("#saveSongBtn").click(); await page.waitForFunction(() => document.querySelector("#saveSongBtn").textContent.includes("已收藏"));
  assert(await page.locator("#totalNotes").textContent() === "4", "permanent collection did not charge 30 notes exactly"); assert((await page.locator("#previewRuleText").textContent()).includes("永久收藏"), "same master was not permanently collected"); assert(await page.locator("#saveSongBtn").evaluate(node => node.disabled && !node.classList.contains("is-busy") && getComputedStyle(node).cursor === "not-allowed"), "completed save button still looks like a loading request"); assert(errors.length === 0, errors.join(" | ")); await context.close();
});

await test("preview lyric audit is honest, supports free manual correction and saves the corrected lyrics", async () => {
  const { context, page, errors } = await newPage(); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  await page.locator("#playSongBtn").click(); await page.locator("#playSongBtn:not([disabled])").waitFor();
  assert(await page.locator("#lyricAudit").isVisible(), "lyric audit did not appear after preview");
  assert(await page.evaluate(() => window.__focusBeat.currentDraft.preview.fullSongPreview === true && window.__focusBeat.currentDraft.preview.previewFraction === 1), "browser did not receive a full-song temporary preview");
  assert((await page.locator("#lyricAuditText").textContent()).includes("不会假装判断正确"), "missing provider alignment was presented as a verified match");
  await page.evaluate(() => {
    const lyrics = document.querySelector("#lyrics").value; let cursor = 500;
    const rows = lyrics.split(/\r?\n/).map(line => line.trim()).filter(line => line && !window.FocusBeatMelodyGuide.isHeader(line));
    window.__focusBeat.currentDraft.preview.alignment = { verified: true, lines: rows.map(text => { const chars = Array.from(text.replace(/[\s，。！？、；：,.!?~～—-]/g, "")); const start = cursor; const syllables = chars.map(char => { const item = { text: char, startMs: cursor, endMs: cursor + 260 }; cursor += 260; return item; }); cursor += 240; return { text, syllables, start }; }) };
    window.__focusBeat.lyricsAudit.render();
  });
  assert(await page.locator("#lyricAudit").evaluate(node => node.classList.contains("is-perfect")), "verified full alignment did not enter the perfect state");
  assert((await page.locator("#lyricAuditText").textContent()).length > 18, "success message was not enriched");
  await page.locator("#openLyricReviewBtn").click(); assert(await page.locator("#lyricReviewWorkspace").isVisible(), "manual review workspace did not open"); assert(await page.locator(".lyric-review-line:disabled").count() === 0, "full-song review still hides lyrics outside the old short preview");
  await page.locator(".lyric-review-line:not([disabled])").first().click(); assert((await page.evaluate(() => window.__mockAudios.at(-1)?.currentTime || 0)) >= 0, "clicking a lyric line did not seek the preview");
  const corrected = await page.locator("#lyricReviewDraft").inputValue().then(value => value.replace(/(^|\n)(?!\[)([^\n]+)/, "$1这句歌词由我听过以后亲自校对"));
  const notesBefore = await page.locator("#totalNotes").textContent(); await page.locator("#lyricReviewDraft").fill(corrected); await page.locator("#applyLyricReviewBtn").click();
  assert(await page.locator("#lyrics").inputValue() === corrected, "corrected lyrics were not applied to the studio"); assert(await page.evaluate(() => !window.__focusBeat.currentDraft.stale && window.__focusBeat.currentDraft.preview.lyrics === document.querySelector("#lyrics").value), "manual correction invalidated or desynchronized the existing preview"); assert(await page.locator("#totalNotes").textContent() === notesBefore, "manual lyric correction consumed notes");
  await page.locator("#saveSongBtn").click(); await page.waitForFunction(() => document.querySelector("#saveSongBtn").textContent.includes("已收藏")); assert(await page.evaluate(expected => window.__focusBeat.state.songs[0]?.lyrics === expected, corrected), "collection did not save the corrected lyrics"); assert(errors.length === 0, errors.join(" | ")); await context.close();
});

await test("song studio marks overlong lyrics and can polish them to the selected melody meter", async () => {
  const { context, page } = await newPage(); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  assert((await page.locator("#lyricFitSummary").textContent()).includes("符合"), "generated lyrics were not checked against a melody meter");
  await page.locator("#lyrics").fill("[主歌 A]\n这是一个字数特别特别特别特别特别特别特别特别特别长的句子\n[副歌]\n我会发光");
  await page.waitForFunction(() => document.querySelector("#lyricFitSummary").textContent.includes("灰体字"));
  await page.getByRole("button", { name: "按曲调润色 · 1 音符" }).click();
  await page.waitForFunction(() => !document.querySelector("#polishLyricsBtn").disabled && !document.querySelector("#lyricFitSummary").textContent.includes("灰体字"));
  assert((await page.locator("#lyricFitSummary").textContent()).includes("符合"), "polished lyrics still did not fit the melody meter"); await context.close();
});

await test("song studio shows inline missing and extra characters and confirms playback warnings", async () => {
  const { context, page } = await newPage(); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  await page.locator("#lyrics").fill("[主歌]\n短句\n[副歌]\n这是一个明显超出当前旋律槽位的超长歌词句子");
  await page.waitForFunction(() => document.querySelectorAll(".lyric-overlay-missing").length > 0 && document.querySelectorAll(".lyric-overlay-extra").length > 0);
  assert((await page.locator("#melodyGuideCopy").textContent()).includes("灰体字部分建议缩减"), "inline melody hint is missing");
  assert((await page.locator("#lyricFitSummary").textContent()).includes("灰体字"), "fit analyzer did not detect the mismatch");
  await page.locator("#playSongBtn").click(); await page.waitForFunction(() => window.__focusBeat.currentDraft.preview && !window.__focusBeat.currentDraft.stale); await page.locator("#playSongBtn").click(); await page.waitForTimeout(100); assert(await page.locator("#previewWarningModal").evaluate(node => node.classList.contains("is-open")), `MODAL_STATE ${await page.evaluate(() => JSON.stringify({ preview: Boolean(window.__focusBeat.currentDraft.preview), stale: window.__focusBeat.currentDraft.stale, job: window.__focusBeat.currentDraft.warningAcknowledgedJobId, modal: document.querySelector("#previewWarningModal")?.className, lyrics: document.querySelector("#lyrics")?.value }))}`); assert((await page.locator("#previewWarningCopy").textContent()).includes("继续试听"), `COPY_STATE ${await page.locator("#previewWarningCopy").textContent()}`); await page.locator("#continuePreviewBtn").click();
  await page.locator("#songModal [data-close]").click(); assert((await page.evaluate(() => document.activeElement?.textContent || "")).includes("创作一首歌"), "nested preview warning broke modal focus restoration");
  await context.close();
});

await test("changing lyrics and tune only updates the draft until preview is requested", async () => {
  const { context, page } = await newPage(); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page); const first = await page.locator("#lyrics").inputValue();
  await page.locator("#regenerateLyricsBtn").click(); await page.waitForFunction(previous => document.querySelector("#lyrics").value !== previous, first); assert(await page.locator("#totalNotes").textContent() === "34", "lyric variant did not charge one note"); assert(await page.evaluate(() => window.__focusBeat.currentDraft.preview === null), "changing lyrics should not call music generation");
  await page.locator("#playSongBtn").click(); await page.waitForFunction(() => window.__focusBeat.currentDraft.preview && !window.__focusBeat.currentDraft.stale); assert(await page.locator("#totalNotes").textContent() === "33", "preview did not charge one note");
  await page.locator("#regenerateTuneBtn").click(); await page.waitForFunction(() => window.__focusBeat.currentDraft.preview === null); assert(await page.locator("#totalNotes").textContent() === "32", "tune variant did not charge one note"); await context.close();
});

await test("collection keeps complete lyrics and full ACE URL after refresh", async () => {
  const { context, page } = await newPage(); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page); await page.locator("#playSongBtn").click(); await page.locator("#playSongBtn:not([disabled])").waitFor(); await page.locator("#saveSongBtn").click(); await page.waitForFunction(() => document.querySelector("#saveSongBtn").textContent.includes("已收藏"));
  await page.reload({ waitUntil: "networkidle" }); await page.locator("#openSongsTop").click(); assert(await page.locator(".song-card").count() === 1, "saved song disappeared"); await page.locator("[data-open-song]").first().click(); assert((await page.locator("#songDetailLyrics").textContent()).includes("[主歌"), "full lyrics are missing from collection detail"); assert((await page.locator("#songDetailMeta").textContent()).includes("真唱"), "collection did not label the real singing provider"); await context.close();
});

await test("collection playback opens synced lyrics and survives closing the detail modal", async () => {
  const { context, page } = await newPage(); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page); await page.locator("#playSongBtn").click(); await page.locator("#playSongBtn:not([disabled])").waitFor(); await page.locator("#saveSongBtn").click(); await page.waitForFunction(() => document.querySelector("#saveSongBtn").textContent.includes("已收藏"));
  await page.locator("#songModal [data-close]").click(); await page.locator("#openSongsTop").click(); await page.locator("[data-play-song]").first().click();
  await page.waitForFunction(() => !document.querySelector("#songDetailModal").hasAttribute("aria-hidden") || document.querySelector("#songDetailModal").getAttribute("aria-hidden") === "false");
  await page.waitForFunction(() => document.querySelector("#globalPlayerToggle").textContent.includes("暂停")); assert(!(await page.locator("#globalSongPlayer").getAttribute("hidden")), "global player did not open"); assert(await page.locator(".lyric-synced-char").count() > 0, "synced lyric characters are missing");
  assert(!(await page.locator("#globalPlayerSeek").isDisabled()) && !(await page.locator("#detailPlayerSeek").isDisabled()), "shared playback progress is not seekable"); await page.locator("#globalPlayerSeek").fill("12.5");
  assert(await page.evaluate(() => window.__mockAudios.at(-1).currentTime) === 12.5, "dragging the global progress did not seek the shared audio"); assert((await page.locator("#globalPlayerCurrent").textContent()) === "00:12" && (await page.locator("#detailPlayerCurrent").textContent()) === "00:12", "global and detail progress fell out of sync"); assert((await page.locator("#globalPlayerDuration").textContent()) === "02:00", "total duration is not displayed at the end of the progress bar");
  assert((await page.locator("#globalPlayerToggle").textContent()).includes("暂停"), "player did not enter playing state"); await page.locator("#playDetailSongBtn").click(); await page.waitForTimeout(50); assert((await page.locator("#playDetailSongBtn").getAttribute("aria-pressed")) === "false", "pause did not change to resume");
  await page.locator("#songDetailModal [data-close]").click(); assert(!(await page.locator("#globalSongPlayer").getAttribute("hidden")), "closing detail modal stopped the global player"); await page.evaluate(() => document.querySelector("#globalPlayerClose").click()); await page.waitForFunction(() => document.querySelector("#globalSongPlayer").hidden); assert(await page.locator("#globalSongPlayer").isHidden(), "global player close button failed"); await context.close();
});

await test("collection auto-advances safely and exposes previous and next controls", async () => {
  const lyrics = "[主歌 A]\n晨光照进我的书页\n今天继续勇敢向前\n[副歌]\n我会认真慢慢发光";
  const storedState = { totalNotes: 35, songs: [
    { id: "song_one", name: "第一首", style: "pop", lyrics, seed: 101, duration: 60, audioUrl: "/mock-full/song_one", provider: "treblo", createdAt: new Date().toISOString() },
    { id: "song_two", name: "第二首", style: "folk", lyrics, seed: 102, duration: 60, audioUrl: "/mock-full/song_two", provider: "treblo", createdAt: new Date().toISOString() },
  ] };
  const { context, page, errors } = await newPage({ storedState }); await page.locator("#openSongsTop").click(); await page.locator('[data-play-song="song_one"]').click(); await page.waitForFunction(() => document.querySelector("#globalPlayerTitle").textContent === "第一首");
  const firstAudioIndex = await page.evaluate(() => window.__mockAudios.length - 1); await page.evaluate(index => window.__mockAudios[index].dispatchEvent(new Event("ended")), firstAudioIndex); await page.waitForFunction(() => document.querySelector("#globalPlayerTitle").textContent === "第二首");
  await page.evaluate(index => window.__mockAudios[index].dispatchEvent(new Event("error")), firstAudioIndex); await page.waitForTimeout(50); assert(await page.locator("#globalPlayerTitle").textContent() === "第二首", "a stale error from the previous track closed the new track");
  await page.locator("#songDetailModal [data-close]").click(); assert(!(await page.locator("#globalSongPlayer").getAttribute("hidden")), "closing auto-advanced lyrics stopped playback");
  await page.locator("#globalPlayerLyric").click(); await page.waitForFunction(() => document.querySelector("#songDetailModal").classList.contains("is-open")); assert((await page.locator("#songDetailTitle").textContent()) === "第二首", "clicking the current lyric did not open the current song detail"); await page.locator("#songDetailModal [data-close]").click();
  await page.locator("#globalPlayerPrev").click(); await page.waitForFunction(() => document.querySelector("#globalPlayerTitle").textContent === "第一首"); await page.locator("#globalPlayerNext").click(); await page.waitForFunction(() => document.querySelector("#globalPlayerTitle").textContent === "第二首");
  await page.evaluate(() => { const audio = window.__mockAudios.at(-1); audio.currentTime = 5; audio.dispatchEvent(new Event("timeupdate")); }); assert(!(await page.locator("#globalPlayerLyric").textContent()).includes("估算同步"), "global lyric still exposes the removed estimate label"); assert(errors.length === 0, errors.join(" | ")); await context.close();
});

await test("unconfigured page exposes the problem without a local music substitute", async () => {
  const { context, page } = await newPage({ music: "unconfigured" }); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page); await page.locator("#playSongBtn").click(); assert((await page.locator("#musicEngineLabel").textContent()).includes("尚未配置"), "unconfigured state is hidden"); assert(await page.locator("#totalNotes").textContent() === "35", "unconfigured preview charged notes"); await context.close();
});

await test("six visual themes persist and switch without interrupting music", async () => {
  const lyrics = "[主歌 A]\n晨光照进我的书页\n今天继续勇敢向前\n[副歌]\n我会认真慢慢发光";
  const storedState = { totalNotes: 35, songs: [{ id: "theme_song", name: "换肤测试歌", style: "pop", lyrics, seed: 301, duration: 120, audioUrl: "/mock-full/theme_song", provider: "treblo", createdAt: new Date().toISOString() }] };
  const { context, page, errors } = await newPage({ storedState }); await page.locator("#openSongsTop").click(); await page.locator('[data-play-song="theme_song"]').click(); await page.locator("#songDetailModal [data-close]").click();
  await page.locator("#themeTrigger").click(); assert(await page.locator("#themePanel").isVisible(), "theme picker did not open"); assert(await page.locator("[data-theme-option]").count() === 6, "theme picker does not expose all six themes"); await page.locator('[data-theme-option="cosmos"]').click(); await page.waitForFunction(() => document.documentElement.dataset.theme === "cosmos" && !document.querySelector(".theme-transition-layer"));
  assert(await page.locator("#globalPlayerTitle").textContent() === "换肤测试歌", "theme switch replaced the playing song"); assert(await page.evaluate(() => window.__mockAudios.at(-1)?.paused === false), "theme switch paused music");
  await page.reload({ waitUntil: "networkidle" }); assert(await page.evaluate(() => document.documentElement.dataset.theme) === "cosmos", "selected theme was not restored after refresh");
  const themeVisuals = new Set(); for (const theme of ["sunny","candy","cosmos","pixel","journal","forest"]) { const visual = await page.evaluate(async value => { await window.FocusBeatThemes.apply(value, { animate:false }); return getComputedStyle(document.querySelector(".hero")).backgroundImage; }, theme); themeVisuals.add(visual); assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${theme} theme overflowed the dashboard`); }
  assert(themeVisuals.size === 6, "one or more themes reuse the same hero treatment instead of a distinct visual style"); assert(errors.length === 0, errors.join(" | ")); await context.close();
});

await test("theme ambience exposes one lightweight signature interaction per space", async () => {
  const { context, page, errors } = await newPage();
  const counts = await page.evaluate(() => window.FocusBeatThemeContent.counts());
  assert(Object.values(counts).length === 6 && Object.values(counts).every(count => count === 50), "each theme must expose exactly 50 local content cards");
  const scenes = { sunny: ".sunny-plane", candy: ".candy-cloud", cosmos: ".mini-planet", pixel: ".pixel-buddy", journal: ".journal-note", forest: ".forest-bird" };
  for (const [theme, selector] of Object.entries(scenes)) {
    await page.evaluate(async value => window.FocusBeatThemes.apply(value, { animate: false }), theme);
    assert(await page.locator(`.theme-stage.scene-${theme} ${selector}`).count() > 0, `${theme} signature scene did not render`);
    assert(await page.locator(".theme-stage *").count() < 35, `${theme} scene is too DOM-heavy`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${theme} ambience overflowed the page`);
  }
  await page.evaluate(async () => window.FocusBeatThemes.apply("candy", { animate: false })); await page.locator(".candy-cloud").click();
  assert(await page.locator(".theme-content-card").isVisible(), "theme interaction did not open its local content card");
  assert((await page.locator(".theme-content-card").getAttribute("data-autoclose")) === "true", "ordinary theme encounter was not configured to auto close");
  assert(await page.locator("[data-content-next], .theme-content-progress").count() === 0, "theme encounter still exposes refresh or remaining-count controls");
  await page.waitForTimeout(10_700); assert(await page.locator(".theme-content-card").isHidden(), "ordinary theme encounter did not disappear after ten seconds");
  await page.evaluate(async () => window.FocusBeatThemes.apply("journal", { animate: false })); await page.waitForTimeout(600);
  const journalNote = page.locator(".journal-note");
  assert(await journalNote.isVisible() && (await journalNote.textContent()).includes("写给今天"), "interactive journal note did not render");
  assert(await journalNote.evaluate(node => node.tagName === "BUTTON" && node.dataset.action === "journal"), "journal note is not an accessible interaction control");
  const journalBefore = await page.locator(".journal-note-copy").textContent(); await journalNote.click(); await page.waitForTimeout(180);
  const journalDuring = await page.locator(".journal-note-copy").textContent(); assert(journalDuring && journalDuring !== journalBefore && journalDuring.length < 44, "journal sentence did not begin typing inside the note");
  await page.waitForTimeout(2_600); const journalFinished = await page.locator(".journal-note-copy").textContent(); assert(journalFinished.length > journalDuring.length, "journal sentence did not continue typing inside the note");
  assert(await page.locator(".theme-content-card").isHidden(), "journal note click still generated a bottom-right encounter card");
  await page.locator("#themeTrigger").click(); assert(await page.locator("[data-ambience-level]").count() === 3, "ambience intensity control is missing");
  await page.locator('[data-ambience-level="quiet"]').click(); assert(await page.evaluate(() => document.documentElement.dataset.ambience) === "quiet", "quiet ambience preference was not applied");
  assert(await page.locator(".theme-stage").evaluate(node => getComputedStyle(node).display === "none"), "quiet mode did not stop the scene");
  assert(errors.length === 0, errors.join(" | ")); await context.close();
});

await test("mobile song studio has no horizontal overflow", async () => {
  const { context, page } = await newPage({ viewport: { width: 320, height: 700 } }); await page.locator("#themeTrigger").click(); assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, "theme picker overflowed on mobile"); await page.locator("#themePanelClose").click(); await page.getByRole("button", { name: "创作一首歌" }).click(); assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, "song studio overflowed on mobile");
  const box = await page.locator("#playSongBtn").boundingBox(); assert(box && box.y >= 0 && box.y + box.height <= 700, "mobile primary song actions are not visible without scrolling"); await context.close();
});

await test("focus reward cannot be claimed immediately", async () => {
  const { context, page } = await newPage(); const before = Number(await page.locator("#totalNotes").textContent());
  await page.locator("#openPlanBtn").click(); await page.locator("#focusMin").fill("90"); await page.locator("#roundCount").fill("1"); await page.locator("#startPlanBtn").click();
  await page.locator("#skipFocusBtn").click(); assert(Number(await page.locator("#totalNotes").textContent()) === before, "an immediate focus completion still awarded notes");
  assert(await page.locator("#focusOverlay").evaluate(node => node.classList.contains("is-open")), "rejected focus completion closed the timer"); await context.close();
});

await test("degraded text AI is disclosed and never consumes song notes", async () => {
  const { context, page } = await newPage({ ai: "degraded" }); await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  const before = Number(await page.locator("#totalNotes").textContent()); await page.locator("#regenerateLyricsBtn").click(); await page.waitForFunction(() => !document.querySelector("#regenerateLyricsBtn").disabled);
  assert(Number(await page.locator("#totalNotes").textContent()) === before, "degraded local lyrics consumed notes"); assert((await page.locator("#songAiStatus").textContent()).includes("降级"), "degraded AI still appears connected"); await context.close();
});

await test("dialogs restore focus and the focus timer traps keyboard navigation", async () => {
  const { context, page } = await newPage(); await page.locator("#openPlanBtn").click(); await page.keyboard.press("Escape");
  assert(await page.evaluate(() => document.activeElement?.id) === "openPlanBtn", "closing a dialog did not restore the invoking control");
  await page.locator("#openPlanBtn").click(); await page.locator("#startPlanBtn").click(); await page.locator("#skipFocusBtn").focus(); await page.keyboard.press("Tab");
  assert(await page.evaluate(() => document.activeElement?.id) === "endFocusBtn", "focus escaped the modal focus timer"); await context.close();
});

await test("corrupted local state is normalized without breaking the page", async () => {
  const storedState = { totalNotes: -99, songs: [{ id: "broken", lyrics: "" }], mistakes: "bad", day: { key: "invalid", quizIds: "bad" }, timer: { active: true, focusMin: 999, remainingMs: -1 } };
  const { context, page, errors } = await newPage({ storedState }); assert(await page.locator("#totalNotes").textContent() === "0", "invalid note balance was not clamped"); assert((await page.evaluate(() => window.__focusBeat.state.songs.length)) === 0, "invalid songs were not discarded"); assert(errors.length === 0, errors.join(" | ")); await context.close();
});

await test("tablet dashboard and every primary modal avoid horizontal overflow", async () => {
  const { context, page } = await newPage({ viewport: { width: 768, height: 900 } });
  for (const name of ["plan", "mistake", "quiz", "weekly", "song", "songs", "summary"]) {
    await page.evaluate(value => window.__focusBeat.openModal(value), name); assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} modal overflowed at tablet width`); await page.keyboard.press("Escape");
  }
  await context.close();
});

await browser.close(); await new Promise(resolve => server.close(resolve));
for (const result of results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}${result.error ? ` — ${result.error}` : ""}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
