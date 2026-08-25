import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { onRequestPost } from "../functions/api/ai.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = process.env.QA_SCREENSHOT_DIR;
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/api/ai") { response.writeHead(404); response.end(); return; }
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": mime[path.extname(target)] || "application/octet-stream" });
  response.end(fs.readFileSync(target));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === "win32" && fs.existsSync(edge) ? edge : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];

async function newPage(viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  return { context, page, errors };
}

async function test(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

async function createLyrics(page) {
  await page.locator("#generateLyricsBtn").click();
  await page.waitForFunction(() => document.querySelector("#lyrics").value.length > 40);
}

await test("mock API obeys the production response contract", async () => {
  const call = seed => onRequestPost({
    env: { AI_MODE: "mock" },
    request: new Request("http://localhost/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "lyrics", payload: { title: "测试之歌", style: "pop", topic: "认真学习", seed } }) }),
  });
  const first = await (await call(101)).json();
  const second = await (await call(202)).json();
  assert(first.ok && first.meta.mode === "mock", "mock API response metadata is invalid");
  assert(first.data.lyrics.length > 40, "mock API returned empty lyrics");
  assert(first.data.lyrics !== second.data.lyrics, "different seeds returned identical mock lyrics");
  const crossSite = await onRequestPost({ env: { AI_MODE: "mock" }, request: new Request("http://localhost/api/ai", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.com" }, body: JSON.stringify({ task: "summary", payload: {} }) }) });
  assert(crossSite.status === 403, "cross-site API call was not rejected");
});

await test("page renders without runtime errors", async () => {
  const { context, page, errors } = await newPage();
  assert((await page.locator("h1").textContent()).includes("让专注"), "hero heading missing");
  assert(await page.locator(".feature-card").count() === 6, "feature grid incomplete");
  assert(errors.length === 0, errors.join(" | "));
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "focus-beat-v2-desktop.png"), fullPage: true });
  await context.close();
});

await test("direct file mode works without a backend", async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const page = await context.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(root, "index.html")).href, { waitUntil: "load" });
  await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  assert((await page.locator("#lyrics").inputValue()).length > 40, "file mode could not generate lyrics");
  assert(errors.length === 0, errors.join(" | "));
  await context.close();
});

await test("modal focus is trapped and restored", async () => {
  const { context, page } = await newPage();
  await page.locator("#openPlanBtn").click();
  assert(await page.evaluate(() => document.activeElement.closest("#planModal") !== null), "focus did not enter modal");
  await page.locator("#planModal [data-close]").click();
  assert(await page.evaluate(() => document.activeElement.id) === "openPlanBtn", "focus did not return to opener");
  await context.close();
});

await test("corrupt storage is normalized safely", async () => {
  const { context, page, errors } = await newPage();
  await page.evaluate(() => localStorage.setItem("focusBeatPlanet.v2", JSON.stringify({ totalNotes: "bad", mistakes: [null], songs: [null], day: "bad" })));
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.locator("#totalNotes").textContent() === "35", "invalid balance was not repaired");
  assert(errors.length === 0, errors.join(" | "));
  await context.close();
});

await test("same inputs generate a genuinely new lyric version", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: "创作一首歌" }).click();
  await createLyrics(page);
  const first = await page.locator("#lyrics").inputValue();
  await page.locator("#regenerateLyricsBtn").click();
  await page.locator("#regenerateLyricsBtn:not([disabled])").waitFor();
  await page.waitForFunction(previous => document.querySelector("#lyrics").value !== previous, first);
  const second = await page.locator("#lyrics").inputValue();
  assert(first !== second, "lyric version was reused");
  assert((await page.locator("#lyricsVersion").textContent()).includes("第 2 版"), "version counter missing");
  assert(await page.locator("#totalNotes").textContent() === "34", "lyric replacement did not charge one note");
  const firstJob = await page.evaluate(() => window.__focusBeat.currentDraft.preview.jobId);
  await page.locator("#regenerateTuneBtn").click();
  await page.waitForFunction(previous => window.__focusBeat.currentDraft.preview.jobId !== previous, firstJob);
  assert(await page.locator("#totalNotes").textContent() === "33", "tune replacement did not charge one note");
  await context.close();
});

await test("quiz refresh is immediate, varied, and accepts numeric units", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: /AI 陪练场/ }).click();
  const questions = new Set([await page.locator("#quizQuestion").textContent()]);
  for (let index = 0; index < 4; index += 1) {
    const started = Date.now(); await page.locator("#newQuizBtn").click();
    assert(Date.now() - started < 700, "quiz refresh blocked on the AI request");
    questions.add(await page.locator("#quizQuestion").textContent());
  }
  assert(questions.size >= 2, "offline quiz generator repeated a fixed question");
  const quiz = await page.evaluate(() => window.__focusBeat.currentQuiz);
  const answer = /^-?\d+(?:\.\d+)?$/.test(quiz.answer) ? `${quiz.answer}个` : quiz.answer;
  await page.locator("#quizAnswer").fill(answer); await page.locator("#submitQuizBtn").click();
  assert((await page.locator("#quizFeedback").textContent()).includes("回答正确"), "reasonable answer format was rejected");
  await context.close();
});

await test("preview costs one note once and can be replayed free", async () => {
  const { context, page, errors } = await newPage();
  await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  await page.locator("#playSongBtn").click();
  await page.locator("#playSongBtn:not([disabled])").waitFor();
  assert(await page.locator("#totalNotes").textContent() === "34", "preview did not charge exactly one note");
  await page.locator("#playSongBtn").click();
  const audio = await page.evaluate(() => ({ ...window.FocusBeatMusic.diagnostics, playing: window.FocusBeatMusic.isPlaying() }));
  assert(audio.playing, "audio engine did not start");
  assert(audio.fraction === 0.3, `preview fraction is ${audio.fraction}`);
  assert(audio.playDuration < audio.fullDuration, "preview was not shorter than full song");
  assert(audio.sourceCount > 50, `arrangement only has ${audio.sourceCount} scheduled sources`);
  assert(audio.speechCues > 0, "local singing cues were not scheduled");
  if (screenshotDir) { await page.waitForTimeout(300); await page.screenshot({ path: path.join(screenshotDir, "focus-beat-v2-song-studio.png") }); }
  await page.locator("#playSongBtn").click();
  assert(await page.locator("#totalNotes").textContent() === "34", "replaying preview charged again");
  assert(errors.length === 0, errors.join(" | "));
  await context.close();
});

await test("all five music styles create playable multi-track blueprints", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  for (const style of ["pop", "rock", "rap", "folk", "classic"]) {
    await page.locator("#songStyle").selectOption(style);
    await page.locator("#playSongBtn").click();
    await page.locator("#playSongBtn:not([disabled])").waitFor();
    await page.locator("#playSongBtn").click();
    const info = await page.evaluate(() => ({ ...window.FocusBeatMusic.diagnostics, playing: window.FocusBeatMusic.isPlaying() }));
    assert(info.playing, `${style} did not start`);
    assert(info.sourceCount > 50, `${style} scheduled only ${info.sourceCount} sources`);
    await page.locator("#playSongBtn").click();
  }
  await context.close();
});

await test("saving unlocks the exact blueprint and full playback", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  await page.locator("#playSongBtn").click(); await page.locator("#playSongBtn:not([disabled])").waitFor();
  const before = await page.evaluate(() => window.__focusBeat.buildCurrentBlueprint().fingerprint);
  await page.locator("#saveSongBtn").click();
  await page.waitForFunction(() => document.querySelector("#saveSongBtn").textContent.includes("已收藏"));
  assert(await page.locator("#totalNotes").textContent() === "4", "song cost was not charged exactly once");
  assert((await page.locator("#previewRuleText").textContent()).includes("完整本地拟唱已收藏"), "full version did not unlock");
  const stored = await page.evaluate(() => window.__focusBeat.state.songs[0].blueprint.fingerprint);
  assert(before === stored, "saved blueprint changed");
  await context.close();
});

await test("collection preserves and fully replays a saved song after refresh", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page); await page.locator("#playSongBtn").click(); await page.locator("#playSongBtn:not([disabled])").waitFor(); await page.locator("#saveSongBtn").click(); await page.waitForFunction(() => document.querySelector("#saveSongBtn").textContent.includes("已收藏"));
  const fingerprint = await page.evaluate(() => window.__focusBeat.state.songs[0].blueprint.fingerprint);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#openSongsTop").click();
  assert(await page.locator(".song-card").count() === 1, "saved song disappeared after refresh");
  assert((await page.locator(".song-card").textContent()).includes(fingerprint), "blueprint fingerprint changed");
  await page.locator("[data-open-song]").first().click();
  assert((await page.locator("#songDetailLyrics").textContent()).includes("[主歌"), "song detail did not show full lyrics");
  await page.locator("#songDetailModal [data-close]").click();
  await page.locator("#openSongsTop").click();
  await page.locator("[data-play-song]").click();
  assert(await page.evaluate(() => window.FocusBeatMusic.diagnostics.fraction) === 1, "collection playback was restricted");
  await page.locator("[data-play-song]").click(); await context.close();
});

await test("blank song cannot be saved or charged", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: "创作一首歌" }).click();
  await page.locator("#songName").fill(""); await page.locator("#lyrics").fill(""); await page.locator("#saveSongBtn").click();
  assert(await page.locator("#totalNotes").textContent() === "35", "blank song consumed notes");
  assert(await page.evaluate(() => window.__focusBeat.state.songs.length) === 0, "blank song was stored");
  await context.close();
});

await test("storage failure rolls back song charge and collection mutation", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: "创作一首歌" }).click(); await createLyrics(page);
  await page.locator("#playSongBtn").click(); await page.locator("#playSongBtn:not([disabled])").waitFor();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); }; });
  await page.locator("#saveSongBtn").click();
  assert(await page.locator("#totalNotes").textContent() === "34", "failed save still charged notes");
  assert(await page.evaluate(() => window.__focusBeat.state.songs.length) === 0, "failed save remained in collection memory");
  await context.close();
});

await test("active and paused timers survive refresh", async () => {
  const { context, page } = await newPage();
  await page.locator("#openPlanBtn").click(); await page.locator("#focusMin").fill("1"); await page.locator("#roundCount").fill("1"); await page.locator("#startPlanBtn").click();
  await page.waitForTimeout(700); await page.locator("#pauseFocusBtn").click();
  const paused = await page.locator("#timerTime").textContent(); await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(700);
  assert(await page.locator("#timerTime").textContent() === paused, "paused timer lost time after refresh");
  assert(await page.locator("#pauseFocusBtn").textContent() === "继续", "paused state not restored");
  await context.close();
});

await test("mistake reward is deduplicated for the same day", async () => {
  const { context, page } = await newPage();
  await page.getByRole("button", { name: /错题收集站/ }).click();
  for (let index = 0; index < 2; index += 1) { await page.locator("#mistakeText").fill("1 + 1 被我算成了 3"); await page.locator("#saveMistakeBtn").click(); await page.locator("#saveMistakeBtn:not([disabled])").waitFor(); }
  assert(await page.locator("#totalNotes").textContent() === "41", "duplicate mistake received another reward");
  await context.close();
});

await test("mobile home and song studio have no horizontal overflow", async () => {
  const { context, page } = await newPage({ width: 320, height: 700 });
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow === 0, `home overflow: ${overflow}px`);
  await page.getByRole("button", { name: "创作一首歌" }).click();
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow === 0, `studio overflow: ${overflow}px`);
  if (screenshotDir) { await page.waitForTimeout(350); await page.screenshot({ path: path.join(screenshotDir, "focus-beat-v2-mobile-song.png") }); }
  await context.close();
});

await browser.close(); await new Promise(resolve => server.close(resolve));
for (const result of results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}${result.error ? ` — ${result.error}` : ""}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
