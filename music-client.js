(() => {
  "use strict";
  const API_PATH = "/api/music";
  const REQUEST_TIMEOUT = 370_000;

  async function request(action, payload = {}, options = {}) {
    if (location.protocol !== "http:" && location.protocol !== "https:") throw new Error("真唱版必须通过 Wrangler 或部署站点运行，不能直接双击 index.html");
    const timeoutMs = Number(options.timeoutMs) || REQUEST_TIMEOUT;
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (["preview", "complete"].includes(action)) headers["x-idempotency-key"] = options.idempotencyKey || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      const response = await fetch(API_PATH, { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ action, payload }), signal: controller.signal });
      const raw = await response.text(); let result = null; try { result = raw ? JSON.parse(raw) : null; } catch (_) {}
      if (response.ok && result?.ok && result.data) return { data: result.data, mode: result.meta?.mode || result.data.mode || "remote", meta: result.meta || {} };
      const detail = result?.error || (raw ? raw.slice(0, 220) : "没有收到后端响应"); throw new Error(`音乐服务请求失败（${response.status}）：${detail}`);
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("音乐生成等待超时，音符不会被扣除，请稍后重试");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function status() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return { mode: "unconfigured", provider: "treblo", supportsExtend: false, reason: "file" };
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 5_000);
    try { const response = await fetch(API_PATH, { headers: { accept: "application/json" }, credentials: "same-origin", signal: controller.signal, cache: "no-store" }); if (!response.ok) return { mode: "unconfigured", provider: "treblo", supportsExtend: false }; return (await response.json())?.meta || { mode: "unconfigured", provider: "treblo", supportsExtend: false }; }
    catch (_) { return { mode: "unconfigured", provider: "treblo", supportsExtend: false }; }
    finally { clearTimeout(timeout); }
  }

  async function jobStatus(jobId, accessToken) { return request("status", { jobId, accessToken }, { timeoutMs: 25_000 }); }
  async function release(jobId, accessToken) { if (!jobId || !accessToken) return; try { await request("delete", { jobId, accessToken }, { timeoutMs: 5_000 }); } catch (_) {} }
  window.FocusBeatMusicAPI = { request, status, jobStatus, release };
})();
