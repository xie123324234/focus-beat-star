(() => {
  "use strict";

  // 本地拟唱版不依赖音乐后端。保留与真唱版一致的任务接口，避免业务层分叉。
  function hashString(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  }
  function localJob(action, payload = {}) {
    const seed = Number(payload.seed) || Date.now(); const signature = hashString(`${action}|${payload.title}|${payload.style}|${payload.lyrics}|${seed}`);
    if (action === "delete") return { deleted: true, jobId: String(payload.jobId || "") };
    if (action === "complete") return { jobId: `local_full_${signature.toString(36)}`, previewJobId: String(payload.previewJobId || ""), status: "ready", mode: "local", provider: "web-speech", duration: 168, seed, supportsExtend: false };
    return { jobId: `local_preview_${signature.toString(36)}`, status: "ready", mode: "local", provider: "web-speech", duration: 42, seed, supportsExtend: false };
  }
  async function request(action, payload = {}) { return { data: localJob(action, payload), mode: "local" }; }
  async function status() { return { mode: "local", provider: "web-speech", supportsExtend: false }; }
  async function release() {}
  window.FocusBeatMusicAPI = { request, status, release, localJob };
})();
