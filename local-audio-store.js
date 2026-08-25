(() => {
  "use strict";

  const DB_NAME = "focusBeatAudio";
  const STORE_NAME = "tracks";
  const VERSION = 1;
  const MAX_BYTES = 32 * 1024 * 1024;
  const urls = new Map();

  function supported() { return typeof indexedDB !== "undefined"; }
  function open() {
    if (!supported()) return Promise.reject(new Error("当前浏览器不支持本地歌曲存储"));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME) ? request.transaction.objectStore(STORE_NAME) : database.createObjectStore(STORE_NAME, { keyPath: "id" });
        if (!store.indexNames.contains("scope")) store.createIndex("scope", "scope", { unique: false });
        if (!store.indexNames.contains("updatedAt")) store.createIndex("updatedAt", "updatedAt", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本地歌曲存储"));
    });
  }
  async function transaction(mode, work) {
    const database = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, mode); const store = tx.objectStore(STORE_NAME);
        let value;
        try { value = work(store, tx); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error || new Error("本地歌曲存储操作失败"));
        tx.onabort = () => reject(tx.error || new Error("本地歌曲存储操作被取消"));
      });
    } finally { database.close(); }
  }
  function requestValue(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("读取本地歌曲失败")); }); }
  async function get(id) { if (!id) return null; return transaction("readonly", store => requestValue(store.get(id))); }
  async function has(id) { return Boolean(await get(id)); }
  async function estimate() {
    try { const value = await navigator.storage?.estimate?.(); return { quota:Number(value?.quota) || 0, usage:Number(value?.usage) || 0, available:Math.max(0, Number(value?.quota || 0) - Number(value?.usage || 0)) }; }
    catch (_) { return { quota:0, usage:0, available:0 }; }
  }
  async function cache(id, sourceUrl, metadata = {}) {
    if (!id || !sourceUrl) throw new Error("本地保存歌曲时缺少音频地址");
    const existing = await get(id); if (existing?.blob instanceof Blob && existing.blob.size) return existing;
    const response = await fetch(sourceUrl, { credentials:"same-origin", cache:"no-store" });
    if (!response.ok) throw new Error(`下载完整歌曲失败（${response.status}）`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("歌曲文件过大，无法安全保存到本设备");
    const blob = await response.blob();
    if (!blob.size) throw new Error("下载到的歌曲为空");
    if (blob.size > MAX_BYTES) throw new Error("歌曲文件过大，无法安全保存到本设备");
    const capacity = await estimate();
    if (capacity.available && capacity.available < blob.size * 1.15) throw new Error("本设备可用空间不足，无法保存这首歌曲");
    const record = { id, blob, scope:metadata.scope === "saved" ? "saved" : "draft", provider:String(metadata.provider || ""), createdAt:existing?.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString(), size:blob.size };
    await transaction("readwrite", store => store.put(record));
    return record;
  }
  async function promote(id) {
    const record = await get(id); if (!record?.blob) throw new Error("本地试听歌曲不存在，请重新生成");
    record.scope = "saved"; record.updatedAt = new Date().toISOString(); await transaction("readwrite", store => store.put(record));
    try { await navigator.storage?.persist?.(); } catch (_) {}
    return record;
  }
  async function remove(id) { if (!id) return; release(id); await transaction("readwrite", store => store.delete(id)); }
  async function cleanup({ keep = [] } = {}) {
    const protectedIds = new Set(keep); const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale = await transaction("readonly", store => requestValue(store.getAll()));
    await Promise.all(stale.filter(item => item.scope === "draft" && !protectedIds.has(item.id) && Date.parse(item.updatedAt || item.createdAt || 0) < cutoff).map(item => remove(item.id)));
  }
  async function source(id) {
    const record = await get(id); if (!record?.blob) return "";
    if (!urls.has(id)) urls.set(id, URL.createObjectURL(record.blob));
    return urls.get(id);
  }
  function release(id) { const url = urls.get(id); if (url) URL.revokeObjectURL(url); urls.delete(id); }
  function releaseAll() { [...urls.keys()].forEach(release); }

  window.FocusBeatAudioStore = { supported, get, has, estimate, cache, promote, remove, cleanup, source, release, releaseAll };
  window.addEventListener("pagehide", releaseAll);
})();
