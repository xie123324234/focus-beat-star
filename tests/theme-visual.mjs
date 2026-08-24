import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(os.tmpdir(), "focus-beat-theme-visuals");
fs.mkdirSync(output, { recursive: true });
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8" };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) { response.writeHead(200, { "content-type":"application/json" }); response.end(JSON.stringify({ ok:true, meta:{ mode:"mock", provider:"visual-test" } })); return; }
  const target = path.resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
  if (!target.startsWith(root) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type":mime[path.extname(target)] || "application/octet-stream" }); response.end(fs.readFileSync(target));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (fs.existsSync(edge) ? edge : undefined) });
const page = await browser.newPage({ viewport:{ width:1440, height:900 }, deviceScaleFactor:1 });
await page.addInitScript(() => { window.__visualAudios=[]; class VisualAudio extends EventTarget { constructor(src="") { super(); this.src=src; this.currentTime=0; this.duration=126; this.paused=true; window.__visualAudios.push(this); } play(){ this.paused=false; this.dispatchEvent(new Event("play")); return Promise.resolve(); } pause(){ this.paused=true; this.dispatchEvent(new Event("pause")); } } window.Audio=VisualAudio; });
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil:"networkidle" });
for (const theme of ["sunny","candy","cosmos","pixel","journal","forest"]) {
  await page.evaluate(value => window.FocusBeatThemes.apply(value, { animate:false }), theme);
  await page.screenshot({ path:path.join(output, `${theme}.png`), fullPage:false });
}
await page.evaluate(() => window.FocusBeatThemes.apply("cosmos", { animate:false })); await page.locator(".uranus").click(); await page.waitForTimeout(500);
await page.screenshot({ path:path.join(output, "cosmos-content.png"), fullPage:false }); await page.locator("[data-content-close]").click();
await page.evaluate(() => { window.FocusBeatThemes.apply("cosmos", { animate:false }); window.__focusBeat.openModal("song"); });
await page.waitForTimeout(300);
await page.screenshot({ path:path.join(output, "cosmos-song.png"), fullPage:false });
await page.keyboard.press("Escape"); await page.evaluate(() => window.FocusBeatThemes.apply("forest", { animate:false }));
await page.locator("#themeTrigger").click();
await page.locator("#themePanel").waitFor({ state:"visible" });
await page.waitForTimeout(250);
await page.screenshot({ path:path.join(output, "picker.png"), fullPage:false });
await page.locator("#themePanelClose").click();
await page.evaluate(() => { const state=window.__focusBeat.state; state.songs=[{id:"visual-song",name:"月亮船",style:"folk",lyrics:"[主歌 A]\n月光洒在窗台前呀\n银白照亮我的脸吧\n抬头望见那圆月吧\n想起远方亲人面呢\n\n[副歌]\n月亮月亮告诉我向前\n思念藏在心窝窝起来\n月亮月亮陪着我起来\n梦里也能看见你起来",seed:24,duration:126,audioUrl:"/visual-song.mp3",provider:"treblo",createdAt:new Date().toISOString()}]; localStorage.setItem("focusBeatPlanet.v2",JSON.stringify(state)); });
await page.reload({waitUntil:"networkidle"}); await page.evaluate(() => window.FocusBeatThemes.apply("cosmos",{animate:false})); await page.locator("#openSongsTop").click(); await page.locator('[data-play-song="visual-song"]').click(); await page.evaluate(() => { const audio=window.__visualAudios.at(-1); audio.currentTime=38; audio.dispatchEvent(new Event("timeupdate")); }); await page.waitForTimeout(200);
for (const theme of ["sunny","candy","cosmos","pixel","journal","forest"]) { await page.evaluate(value => window.FocusBeatThemes.apply(value,{animate:false}),theme); await page.waitForTimeout(220); await page.screenshot({path:path.join(output,`${theme}-song-detail.png`),fullPage:false}); }
await page.locator("#songDetailModal [data-close]").click(); await page.locator("#globalPlayerClose").click(); await page.setViewportSize({ width:390, height:844 });
for (const theme of ["candy","cosmos","forest"]) {
  await page.evaluate(value => window.FocusBeatThemes.apply(value, { animate:false }), theme);
  await page.screenshot({ path:path.join(output, `mobile-${theme}.png`), fullPage:false });
}
await page.locator(".forest-bird").click(); await page.waitForTimeout(500); await page.screenshot({ path:path.join(output, "mobile-content.png"), fullPage:false });
await browser.close(); await new Promise(resolve => server.close(resolve));
console.log(output);
