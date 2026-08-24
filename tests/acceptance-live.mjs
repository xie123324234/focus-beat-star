import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const base = process.env.FOCUS_BEAT_TEST_URL || "http://127.0.0.1:8791";
const browser = await chromium.launch({ headless: true, executablePath: process.platform === "win32" && fs.existsSync(edge) ? edge : undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await context.newPage(); const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text()); });

try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#aiChipText")?.textContent.includes("云端文本 AI 已连接"));
  await page.getByRole("button", { name: "创作一首歌" }).click();
  await page.waitForFunction(() => document.querySelector("#musicEngineLabel")?.textContent.includes("ACE Music"));
  const action = await page.locator("#playSongBtn").boundingBox();
  if (!action || action.y < 0 || action.y + action.height > 800) throw new Error("移动端生成试听按钮未固定在可视区域");
  await page.locator("#songName").fill("分数小勇士"); await page.locator("#songTopic").fill("终于学会分数应用题");
  await page.locator("#generateLyricsBtn").click();
  await page.waitForFunction(() => document.querySelector("#lyrics")?.value.length > 80, null, { timeout: 40_000 });
  const status = await page.locator("#songAiStatus").textContent(); const lyrics = await page.locator("#lyrics").inputValue();
  const fit = await page.locator("#lyricFitSummary").textContent();
  if (!status.includes("云端 AI")) throw new Error(`歌词生成后状态不正确：${status}`);
  if (!["分数", "应用题", "分子", "分母", "题目"].some(word => lyrics.includes(word))) throw new Error("真实 AI 歌词没有体现用户主题");
  if (!fit.includes("符合")) throw new Error(`真实 AI 歌词未按当前音节位完成：${fit}`);
  if (errors.length) throw new Error(errors.join(" | "));
  console.log(JSON.stringify({ passed: true, ai: status, lyricsLength: lyrics.length, lyricFit: fit, mobileActionVisible: true }));
} finally {
  await context.close(); await browser.close();
}
