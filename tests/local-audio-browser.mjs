import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url); const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8" };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname; const relative = pathname === "/" ? "index.html" : pathname.slice(1); const target = path.resolve(root, relative);
  if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type":mime[path.extname(target)] || "application/octet-stream" }); response.end(fs.readFileSync(target));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless:true, executablePath:process.platform === "win32" && fs.existsSync(edge) ? edge : undefined });
try {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.addInitScript(() => {
    const song = { id:"local-song", name:"离线收藏测试", style:"pop", lyrics:"[主歌 A]\n今天我会发光", seed:1, duration:60, localAudioId:"song:local-song", provider:"treblo", unlocked:true, createdAt:new Date().toISOString() };
    localStorage.setItem("focusBeatPlanet.v2", JSON.stringify({ totalNotes:35, songs:[song] }));
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    class MockAudio extends EventTarget { constructor(src="") { super(); this.src=src; this.currentTime=0; this.duration=60; this.paused=true; window.__localSources=(window.__localSources || []).concat(src); } play(){ this.paused=false; this.dispatchEvent(new Event("play")); return Promise.resolve(); } pause(){ this.paused=true; this.dispatchEvent(new Event("pause")); } }
    window.Audio = MockAudio;
    const request = indexedDB.open("focusBeatAudio", 1);
    request.onupgradeneeded = () => { const store=request.result.createObjectStore("tracks", { keyPath:"id" }); store.createIndex("scope", "scope"); store.createIndex("updatedAt", "updatedAt"); };
    request.onsuccess = () => { const db=request.result; const tx=db.transaction("tracks", "readwrite"); tx.objectStore("tracks").put({ id:"song:local-song", blob:new Blob([new Uint8Array([1,2,3])], { type:"audio/mpeg" }), scope:"saved", size:3, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }); };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil:"networkidle" });
  await page.locator("#openSongsTop").click(); await page.locator("[data-play-song]").click();
  await page.waitForFunction(() => window.__localSources?.some(value => String(value).startsWith("blob:")));
  assert.equal(await page.locator("#globalSongPlayer").isHidden(), false, "local IndexedDB song did not open the global player");
  await page.reload({ waitUntil:"networkidle" }); await page.locator("#openSongsTop").click(); await page.locator("[data-play-song]").click();
  await page.waitForFunction(() => window.__localSources?.some(value => String(value).startsWith("blob:")));
  await context.close(); console.log("PASS IndexedDB collection playback survives refresh without a network audio URL");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
