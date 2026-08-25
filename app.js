(() => {
  "use strict";

  const STORAGE_KEY = "focusBeatPlanet.v2";
  const LEGACY_KEY = "focusBeatStar.v1";
  const PREVIEW_COST = 1;
  const SONG_COST = 30;
  const SONG_TARGET = PREVIEW_COST + SONG_COST;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const styleNames = { pop: "元气流行", rock: "热血摇滚", rap: "节奏说唱", folk: "清新民谣", classic: "梦幻古典" };
  const styleValues = { 元气流行: "pop", 热血摇滚: "rock", 节奏说唱: "rap", 清新民谣: "folk", 梦幻古典: "classic" };
  let currentDraft = { seed: 0, version: 0, tuneVersion: 0, fingerprint: "", savedFingerprint: "", preview: null, stale: false, completed: false, warningAcknowledgedJobId: "", melodyGuide: null, compositionPlan: null };
  let currentQuiz = null;
  let quizPrefetch = null;
  let quizPrefetchPromise = null;
  let selectedSongId = null;
  let timerInterval = null;
  let modalReturnTarget = null;
  let activePlayButton = null;
  let activeHtmlAudio = null;
  let globalPlayerAudio = null;
  let globalPlayerLocal = null;
  let globalPlayerSong = null;
  let globalPlayerTimeline = [];
  let globalPlayerPlaying = false;
  let globalPlayerActiveLine = -1;
  let previewTimeline = [];
  let previewAudio = null;
  let lyricReview = { open: false, original: "", draft: "", selectedLine: -1, loopLine: false, undo: null };
  let previewWarningPending = false;
  let collectionQueue = [];
  let collectionQueueIndex = -1;
  let collectionPlayMode = "sequence";
  let collectionFailedIds = new Set();
  let lyricOverlay = null;
  let lyricsGenerationPending = false;
  let musicServiceMeta = { mode: "unconfigured", provider: "treblo" };

  class PendingMusicError extends Error {
    constructor(message) { super(message); this.name = "PendingMusicError"; this.preserveCharge = true; }
  }

  function musicProviderName(provider = musicServiceMeta.provider) {
    if (provider === "treblo") return "Treblo Melodia";
    if (provider === "minimax") return "MiniMax Music";
    if (provider === "acemusic" || provider === "acemusic-mock") return "ACE Music";
    if (provider === "browser-synth") return "本地电子拟唱";
    return provider || "专业音乐服务";
  }

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function weekKey() {
    const date = new Date(); const day = (date.getDay() + 6) % 7;
    date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - day);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function number(value, fallback = 0, min = 0, max = 1_000_000) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  function text(value, limit = 2000, fallback = "") {
    return typeof value === "string" ? value.slice(0, limit) : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function initialState() {
    return {
      version: 2,
      totalNotes: 35,
      day: { key: todayKey(), focus: 0, notes: 0, sessions: 0, mistakeIds: [], quizIds: [] },
      mistakes: [], songs: [], weekly: null, timer: null, planSegments: [], streak: 1, lastFocusDate: "", pendingMusic: null,
    };
  }

  function blueprintIsValid(blueprint) {
    return blueprint && blueprint.version >= 2 && Number.isFinite(Number(blueprint.bpm)) && Number.isFinite(Number(blueprint.duration))
      && ["lead", "chords", "bass", "cues"].every(key => Array.isArray(blueprint[key]));
  }

  function normalizeSong(item) {
    if (!item || typeof item !== "object") return null;
    const lyrics = text(item.lyrics, 2400).trim();
    if (!lyrics) return null;
    const style = Object.hasOwn(styleNames, item.style) ? item.style : (styleValues[item.style] || "pop");
    const seed = number(item.seed || item.blueprint?.seed, Date.now(), 1, Number.MAX_SAFE_INTEGER);
    let blueprint = blueprintIsValid(item.blueprint) ? item.blueprint : null;
    try {
      if (!blueprint) blueprint = FocusBeatMusic.createBlueprint({ title: text(item.name, 32, "未命名歌曲"), style, lyrics, seed });
    } catch (_) { blueprint = null; }
    return {
      id: text(item.id, 80, uid("song")), name: text(item.name, 32, "未命名歌曲") || "未命名歌曲",
      style, lyrics, seed, blueprint, melodyGuide: item.melodyGuide && typeof item.melodyGuide === "object" ? item.melodyGuide : null, compositionPlan: item.compositionPlan && typeof item.compositionPlan === "object" ? item.compositionPlan : item.melodyGuide?.compositionPlan || null, alignment: item.alignment && typeof item.alignment === "object" ? item.alignment : null, unlocked: item.unlocked !== false,
      previewJobId: text(item.previewJobId, 160), fullJobId: text(item.fullJobId, 160),
      duration: number(item.duration || item.blueprint?.duration, 60, 1, 600), audioUrl: text(item.audioUrl, 2000), localAudioId: text(item.localAudioId, 180), accessToken: text(item.accessToken, 200), previewAccessToken: text(item.previewAccessToken, 200), storageKey: text(item.storageKey, 300), provider: text(item.provider, 40, "acemusic"), mode: text(item.mode, 40), localFallback: Boolean(item.localFallback || item.mode === "local-fallback" || item.provider === "browser-synth"),
      createdAt: text(item.createdAt || item.time, 80, new Date().toISOString()),
    };
  }

  function normalizeState(raw) {
    const base = initialState();
    if (!raw || typeof raw !== "object") return base;
    base.totalNotes = number(raw.totalNotes, base.totalNotes);
    base.streak = number(raw.streak, 1, 1, 9999);
    base.lastFocusDate = text(raw.lastFocusDate, 10);
    const sourceDay = raw.day && typeof raw.day === "object" ? raw.day : {};
    base.day = {
      key: text(sourceDay.key, 10, todayKey()), focus: number(sourceDay.focus ?? raw.todayFocus),
      notes: number(sourceDay.notes ?? raw.todayNotes), sessions: number(sourceDay.sessions ?? raw.todaySessions),
      mistakeIds: Array.isArray(sourceDay.mistakeIds) ? sourceDay.mistakeIds.map(String).slice(0, 500) : [],
      quizIds: Array.isArray(sourceDay.quizIds) ? sourceDay.quizIds.map(String).slice(0, 500) : [],
    };
    base.mistakes = (Array.isArray(raw.mistakes) ? raw.mistakes : []).filter(item => item && typeof item === "object").map(item => ({
      id: text(item.id, 80, uid("mistake")), subject: text(item.subject, 20, "数学"), tag: text(item.tag, 24, "待复习"),
      content: text(item.content || item.text, 1200), analysis: text(item.analysis, 1200, "已保存，稍后再回来看一次。"),
      nextStep: text(item.nextStep, 600), createdAt: text(item.createdAt || item.time, 80, new Date().toISOString()),
    })).filter(item => item.content).slice(0, 300);
    base.songs = (Array.isArray(raw.songs) ? raw.songs : []).map(normalizeSong).filter(Boolean).slice(0, 100);
    base.pendingMusic = raw.pendingMusic && typeof raw.pendingMusic === "object" ? raw.pendingMusic : null;
    base.weekly = raw.weekly && typeof raw.weekly === "object" && Array.isArray(raw.weekly.days) && (!raw.weekly.weekKey || raw.weekly.weekKey === weekKey()) ? { ...raw.weekly, weekKey: weekKey() } : null;
    const timerShapeValid = raw.timer && typeof raw.timer === "object" && raw.timer.active
      && [raw.timer.focusMin, raw.timer.breakMin, raw.timer.rounds, raw.timer.remainingMs, raw.timer.endAt, raw.timer.startedAt].every(value => Number.isFinite(Number(value)));
    if (timerShapeValid) {
      const timer = raw.timer;
      const phase = timer.phase === "break" ? "break" : "focus";
      const focusMin = number(timer.focusMin, 25, 1, 90); const breakMin = number(timer.breakMin, 5, 1, 30);
      const totalMs = number(timer.totalMs, (phase === "focus" ? focusMin : breakMin) * 60_000, 1_000, 5_400_000);
      base.timer = {
        active: true, paused: Boolean(timer.paused), phase, round: number(timer.round, 0, 0, 5), rounds: number(timer.rounds, 1, 1, 6),
        focusMin, breakMin, subject: text(timer.subject, 80, "今天的学习任务"), totalMs,
        remainingMs: number(timer.remainingMs, totalMs, 0, 5_400_000), endAt: number(timer.endAt, Date.now() + totalMs, 0, Number.MAX_SAFE_INTEGER),
        startedAt: number(timer.startedAt, Date.now() - Math.max(0, totalMs - Number(timer.remainingMs || totalMs)), 0, Number.MAX_SAFE_INTEGER),
      };
    }
    base.planSegments = Array.isArray(raw.planSegments) ? raw.planSegments.map(item => text(item, 100)).slice(0, 6) : [];
    if (base.day.key !== todayKey()) base.day = { key: todayKey(), focus: 0, notes: 0, sessions: 0, mistakeIds: [], quizIds: [] };
    return base;
  }

  function loadState() {
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (_) {}
    if (!parsed) {
      try { parsed = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch (_) {}
    }
    return normalizeState(parsed);
  }

  let state = loadState();

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
    catch (_) { showToast("浏览器存储空间不足，最新数据无法保存", "error"); return false; }
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || "") : new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    $("#toastRegion").append(toast);
    setTimeout(() => toast.remove(), type === "error" ? 30000 : 3200);
  }

  function updateAiMode(mode, reason) {
    const remote = mode === "remote";
    const fallback = mode === "local-fallback";
    const degraded = mode === "degraded";
    const local = mode === "local" || mode === "mock";
    const reasonText = /额度|上限|rate.?limit/i.test(String(reason || "")) ? "调用额度已达上限" : /json|non-whitespace|格式/i.test(String(reason || "")) ? "返回格式异常" : /abort|timeout|超时/i.test(String(reason || "")) ? "响应超时" : /API\s*\d{3}|\b[45]\d\d\b/.test(String(reason || "")) ? "服务暂时不可用" : "请求异常";
    $("#aiChipText").textContent = remote
      ? "云端文本 AI 已连接"
      : fallback
        ? "文本 AI 请求失败，已用本地模板"
        : degraded
          ? `文本 AI 后端已降级（${reasonText}）`
          : (reason === "file" ? "请启动 Wrangler 连接文本 AI" : local ? "本地内容引擎" : "文本 AI 状态未知");
    $("#songAiStatus").textContent = remote
      ? "歌词由云端 AI 生成"
      : fallback
        ? `文本 AI 请求失败，已用本地模板${reason ? `：${reason}` : ""}`
        : degraded
          ? `文本 AI 后端暂时降级（${reasonText}），当前结果可能来自模板`
          : (reason === "file" ? "请通过 Wrangler 地址打开，才能连接文本 AI" : local ? "当前使用本地内容引擎" : "文本 AI 状态未知");
  }

  function renderDashboard() {
    $("#totalNotes").textContent = Math.floor(state.totalNotes);
    $("#todayFocus").textContent = Math.floor(state.day.focus);
    $("#todayNotes").textContent = Math.floor(state.day.notes);
    $("#todaySessions").textContent = Math.floor(state.day.sessions);
    $("#todayMistakes").textContent = state.day.mistakeIds.length;
    $("#streakDays").textContent = state.streak;
    $("#todayLabel").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
    const progress = Math.min(SONG_TARGET, state.totalNotes);
    $("#songProgressFill").style.width = `${progress / SONG_TARGET * 100}%`;
    $("#songProgressText").textContent = `${Math.floor(progress)} / ${SONG_TARGET}`;
    const meter = $("[aria-label='歌曲创作进度']");
    meter.setAttribute("aria-valuemax", String(SONG_TARGET));
    meter.setAttribute("aria-valuenow", String(Math.floor(progress)));
    if (state.totalNotes >= SONG_TARGET) {
      $("#songReadyTitle").textContent = "下一首歌已就绪";
      $("#songReadyCopy").textContent = "已攒够一次全曲试听和一次本地收藏。";
    } else {
      $("#songReadyTitle").textContent = `还差 ${Math.ceil(SONG_TARGET - state.totalNotes)} 枚音符`;
      $("#songReadyCopy").textContent = "完成专注、分析错题和答题练习都能获得音符。";
    }
  }

  function modalByName(name) { return $(`#${name}Modal`); }
  function focusable(container) { return $$(`button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]`).filter(item => container.contains(item) && !item.hidden); }

  function openModal(name, trigger = document.activeElement) {
    const modal = modalByName(name);
    if (!modal) return;
    if (name !== "previewWarning") closeAllModals(false);
    // Nested confirmation dialogs must not overwrite the studio's original
    // return target, or closing the studio focuses a now-hidden button.
    if (name !== "previewWarning") modalReturnTarget = trigger;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    $("main").inert = true;
    $(".topbar").inert = true;
    $("footer").inert = true;
    $("#globalSongPlayer").inert = true;
    if (name === "mistake") renderMistakes();
    if (name === "songs") renderSongs();
    if (name === "songDetail") renderSongDetail();
    if (name === "weekly") renderWeekly();
    if (name === "summary") renderSummary();
    if (name === "quiz" && !currentQuiz) generateQuiz();
    focusable(modal)[0]?.focus();
  }

  function closeModal(modal, restore = true) {
    if (!modal?.classList.contains("is-open")) return;
    // 关闭创作室只停止当前试听；收藏歌曲使用全局播放器，关闭歌词页/收藏页也应继续播放。
    if (modal.id === "songModal") stopSongPlayback();
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (!$(".modal.is-open")) {
      document.body.classList.remove("modal-open");
      $("main").inert = false;
      $(".topbar").inert = false;
      $("footer").inert = false;
      $("#globalSongPlayer").inert = false;
      if (restore && modalReturnTarget?.isConnected) modalReturnTarget.focus();
    }
  }

  function closeAllModals(restore = false) { $$(".modal.is-open").forEach(modal => closeModal(modal, restore)); }

  async function runButton(button, busyText, action) {
    const original = button.textContent;
    button.disabled = true; button.classList.add("is-busy"); button.setAttribute("aria-busy", "true");
    button.textContent = busyText;
    try { return await action(); }
    catch (error) { showToast(error.message || "操作没有完成，请稍后再试", "error"); }
    finally { button.disabled = false; button.classList.remove("is-busy"); button.removeAttribute("aria-busy"); button.textContent = original; }
  }

  // 专注计划与倒计时
  function applyPreset() {
    const presets = { easy: [15, 5, 2], standard: [25, 5, 2], deep: [40, 10, 2] };
    const [focus, rest, rounds] = presets[$("#planPreset").value];
    $("#focusMin").value = focus; $("#breakMin").value = rest; $("#roundCount").value = rounds;
  }

  async function generatePlan() {
    await runButton($("#generatePlanBtn"), "正在安排…", async () => {
      const result = await FocusBeatAI.request("plan", { subject: $("#planSubject").value, preset: $("#planPreset").value });
      updateAiMode(result.mode, result.reason);
      $("#focusMin").value = result.data.focusMin;
      $("#breakMin").value = result.data.breakMin;
      $("#roundCount").value = result.data.roundCount;
      state.planSegments = result.data.segments || [];
      $("#planHelper").textContent = result.data.note || "计划已经准备好了。";
      saveState();
      showToast("今日专注计划已生成");
    });
  }

  function timerValues() {
    return {
      focusMin: number($("#focusMin").value, 25, 1, 90), breakMin: number($("#breakMin").value, 5, 1, 30),
      rounds: number($("#roundCount").value, 2, 1, 6), subject: text($("#planSubject").value.trim(), 80, "今天的学习任务") || "今天的学习任务",
    };
  }

  function startPlan() {
    const config = timerValues();
    const totalMs = config.focusMin * 60_000;
    state.timer = { active: true, paused: false, phase: "focus", round: 0, ...config, totalMs, remainingMs: totalMs, endAt: Date.now() + totalMs, startedAt: Date.now() };
    saveState();
    closeAllModals(false);
    openFocusOverlay();
  }

  function openFocusOverlay() {
    const overlay = $("#focusOverlay");
    overlay.classList.add("is-open"); overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open"); $("main").inert = true; $(".topbar").inert = true;
    $("footer").inert = true; $("#globalSongPlayer").inert = true;
    if (globalPlayerAudio && globalPlayerPlaying) { globalPlayerAudio.pause(); globalPlayerPlaying = false; syncGlobalPlayerButtons(); }
    if (globalPlayerLocal && globalPlayerPlaying) { stopLocalGlobalPlayback(); syncGlobalPlayerButtons(); }
    stopSongPlayback();
    overlay.focus();
    clearInterval(timerInterval);
    timerInterval = setInterval(tickTimer, 250);
    tickTimer();
  }

  function closeFocusOverlay() {
    clearInterval(timerInterval); timerInterval = null;
    $("#focusOverlay").classList.remove("is-open", "paused", "resting"); $("#focusOverlay").setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open"); $("main").inert = false; $(".topbar").inert = false;
    $("footer").inert = false; $("#globalSongPlayer").inert = false;
    $("#openPlanBtn").focus();
  }

  function tickTimer() {
    const timer = state.timer;
    if (!timer?.active) return closeFocusOverlay();
    if (!timer.paused) timer.remainingMs = Math.max(0, timer.endAt - Date.now());
    if (timer.remainingMs <= 0) return advanceTimer();
    renderTimer();
  }

  function renderTimer() {
    const timer = state.timer;
    if (!timer) return;
    const seconds = Math.ceil(timer.remainingMs / 1000);
    $("#timerTime").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    $("#timerMode").textContent = timer.phase === "focus" ? (timer.paused ? "已暂停" : "专注中") : (timer.paused ? "休息暂停" : "休息中");
    $("#focusRoundLabel").textContent = `第 ${timer.round + 1} / ${timer.rounds} 段`;
    $("#focusSegmentTitle").textContent = timer.phase === "focus" ? (state.planSegments[timer.round] || timer.subject) : "起身活动一下";
    $("#focusEncourage").textContent = timer.phase === "focus" ? "只看眼前这一小段，跟着节拍慢慢来。" : "喝口水、看看远处，休息结束后继续下一拍。";
    $("#focusProgressFill").style.width = `${Math.min(100, Math.max(0, (1 - timer.remainingMs / timer.totalMs) * 100))}%`;
    $("#pauseFocusBtn").textContent = timer.paused ? "继续" : "暂停";
    $("#skipFocusBtn").textContent = timer.phase === "focus" ? "完成这一段" : "结束休息";
    $("#focusOverlay").classList.toggle("paused", timer.paused); $("#focusOverlay").classList.toggle("resting", timer.phase === "break");
  }

  function rewardFocus(timer) {
    const earned = 10;
    const today = todayKey();
    if (state.lastFocusDate !== today) {
      const previous = state.lastFocusDate ? new Date(`${state.lastFocusDate}T00:00:00`) : null;
      const current = new Date(`${today}T00:00:00`);
      const gap = previous && !Number.isNaN(previous.getTime()) ? Math.round((current - previous) / 86_400_000) : 0;
      state.streak = gap === 1 ? state.streak + 1 : 1;
      state.lastFocusDate = today;
    }
    state.totalNotes += earned; state.day.notes += earned; state.day.sessions += 1; state.day.focus += timer.focusMin;
    showToast(`完成一段专注，获得 ${earned} 枚音符`);
    window.dispatchEvent(new CustomEvent("focusbeat:focuscomplete", { detail: { earned, sessions: state.day.sessions, minutes: timer.focusMin } }));
  }

  function advanceTimer(event) {
    const timer = state.timer;
    if (!timer) return;
    if (timer.phase === "focus") {
      const naturalCompletion = timer.remainingMs <= 1000;
      const completedRatio = 1 - timer.remainingMs / Math.max(1, timer.totalMs);
      if (!naturalCompletion && completedRatio < 0.8) {
        showToast(`至少完成本段的 80% 才能提前结束并获得音符（当前 ${Math.max(0, Math.floor(completedRatio * 100))}%）`, "error");
        renderTimer();
        return;
      }
      rewardFocus(timer);
      if (timer.round >= timer.rounds - 1) {
        state.timer = null; saveState(); renderDashboard(); closeFocusOverlay(); showToast("今日计划完成，做得漂亮！"); return;
      }
      timer.phase = "break"; timer.totalMs = timer.breakMin * 60_000;
    } else {
      timer.phase = "focus"; timer.round += 1; timer.totalMs = timer.focusMin * 60_000;
    }
    timer.paused = false; timer.remainingMs = timer.totalMs; timer.endAt = Date.now() + timer.totalMs; timer.startedAt = Date.now();
    saveState(); renderDashboard(); renderTimer();
  }

  function togglePause() {
    const timer = state.timer; if (!timer) return;
    if (timer.paused) { timer.paused = false; timer.endAt = Date.now() + timer.remainingMs; }
    else { timer.remainingMs = Math.max(0, timer.endAt - Date.now()); timer.paused = true; }
    saveState(); renderTimer();
  }

  function endFocus() {
    if (!state.timer || !confirm("确定结束本次专注吗？未完成的这一段不会获得音符。")) return;
    state.timer = null; saveState(); closeFocusOverlay();
  }

  // 错题与练习
  function mistakeRewardId(subject, content) { return `${todayKey()}:${FocusBeatAI.hashString(`${subject}|${content.trim().toLowerCase()}`)}`; }

  async function saveMistake() {
    const content = $("#mistakeText").value.trim();
    if (!content) { showToast("请先写下题目和你的思路", "error"); $("#mistakeText").focus(); return; }
    const subject = $("#mistakeSubject").value; const tag = $("#mistakeTag").value.trim() || "待复习";
    const rewardId = mistakeRewardId(subject, content); const canReward = !state.day.mistakeIds.includes(rewardId);
    await runButton($("#saveMistakeBtn"), "AI 正在分析…", async () => {
      const result = await FocusBeatAI.request("mistake", { subject, tag, text: content });
      updateAiMode(result.mode, result.reason);
      state.mistakes.unshift({ id: uid("mistake"), subject, tag, content, analysis: result.data.analysis, nextStep: result.data.nextStep, createdAt: new Date().toISOString() });
      state.mistakes = state.mistakes.slice(0, 300);
      if (canReward) { state.day.mistakeIds.push(rewardId); state.totalNotes += 6; state.day.notes += 6; }
      saveState(); renderDashboard(); renderMistakes();
      $("#mistakeText").value = ""; $("#mistakeTag").value = "";
      showToast(canReward ? "错题已分析，获得 6 枚音符" : "错题已更新；重复内容今天不重复奖励");
    });
  }

  function renderMistakes() {
    $("#mistakeCount").textContent = `${state.mistakes.length} 条`;
    $("#mistakeList").innerHTML = state.mistakes.length ? state.mistakes.map(item => `<article class="mistake-item"><div class="item-top"><span class="tag">${escapeHtml(item.subject)} · ${escapeHtml(item.tag)}</span><button class="delete-button" data-delete-mistake="${escapeHtml(item.id)}" type="button" aria-label="删除这道错题">删除</button></div><p>${escapeHtml(item.content)}</p><div class="analysis"><strong>AI 分析：</strong>${escapeHtml(item.analysis)}${item.nextStep ? `<br><strong>下一步：</strong>${escapeHtml(item.nextStep)}` : ""}</div></article>`).join("") : `<div class="empty">还没有错题记录。把卡住你的地方写下来，它就会变成下一次进步的线索。</div>`;
  }

  function deleteMistake(id) {
    if (!confirm("确定删除这条错题记录吗？")) return;
    state.mistakes = state.mistakes.filter(item => item.id !== id); saveState(); renderMistakes(); showToast("错题记录已删除");
  }

  function showQuiz(quiz) {
    currentQuiz = { ...quiz, attempts: 0 };
    $("#quizQuestion").textContent = currentQuiz.question;
    $("#quizHint").textContent = `提示：${currentQuiz.hint}`;
    $("#quizLevel").textContent = currentQuiz.level || "基础巩固";
    $("#quizAnswer").value = ""; $("#quizFeedback").textContent = ""; $("#quizAnswer").focus();
  }

  function prefetchQuiz(subject) {
    if (quizPrefetchPromise) return;
    const seed = Date.now() + Math.floor(Math.random() * 100_000);
    const excludeQuestions = [currentQuiz?.question, quizPrefetch?.data?.question].filter(Boolean);
    quizPrefetchPromise = FocusBeatAI.request("quiz", { subject, seed, weakness: state.mistakes[0]?.tag || "", excludeQuestions })
      .then(result => { if ($("#quizSubject").value === subject) { quizPrefetch = { subject, data: result.data }; updateAiMode(result.mode, result.reason); } })
      .catch(() => {})
      .finally(() => { quizPrefetchPromise = null; });
  }

  function generateQuiz() {
    const subject = $("#quizSubject").value;
    const next = quizPrefetch?.subject === subject ? quizPrefetch.data : FocusBeatAI.local.quiz({ subject, seed: Date.now() + Math.floor(Math.random() * 100_000) });
    quizPrefetch = null;
    showQuiz(next);
    prefetchQuiz(subject);
  }

  function normalizeAnswer(value) { return String(value || "").toLowerCase().replace(/[\s，。,.!！?？℃°c]/g, ""); }
  function answerIsCorrect(input, quiz) {
    const normalized = normalizeAnswer(input);
    const accepted = [...new Set([quiz.answer, ...(Array.isArray(quiz.answers) ? quiz.answers : [])].filter(Boolean))];
    if (accepted.some(answer => normalizeAnswer(answer) === normalized)) return true;
    const numeric = value => {
      const normalizedValue = String(value || "").trim().toLowerCase().replace(/\s/g, "");
      const match = normalizedValue.match(/^(-?\d+(?:\.\d+)?)(?:天|小时|分钟|页|厘米|平方厘米|支|个|本|盒|℃|摄氏度|度)?$/);
      return match ? Number(match[1]) : NaN;
    };
    const inputNumber = numeric(input);
    return accepted.some(answer => {
      const expectedNumber = numeric(answer);
      return Number.isFinite(inputNumber) && Number.isFinite(expectedNumber) && inputNumber === expectedNumber;
    });
  }
  function submitQuiz() {
    if (!currentQuiz) return generateQuiz();
    const answer = $("#quizAnswer").value.trim(); if (!answer) { $("#quizFeedback").textContent = "先写下你的答案。"; return; }
    const correct = answerIsCorrect(answer, currentQuiz);
    if (!correct) {
      currentQuiz.attempts = (currentQuiz.attempts || 0) + 1;
      $("#quizFeedback").textContent = currentQuiz.attempts >= 2 ? `还差一点。${currentQuiz.hint} 可以先检查思路，再提交一次。` : `再想一步：${currentQuiz.hint}`;
      return;
    }
    const rewardId = `${todayKey()}:${currentQuiz.id}`; const canReward = !state.day.quizIds.includes(rewardId);
    if (canReward) { state.day.quizIds.push(rewardId); state.totalNotes += 3; state.day.notes += 3; saveState(); renderDashboard(); }
    $("#quizFeedback").textContent = `回答正确！${currentQuiz.explanation}${canReward ? " 获得 3 枚音符。" : " 这道题今天已经奖励过。"}`;
  }

  // 真唱版：试听阶段生成并临时开放整首母带；收藏时永久保留同一母带。
  function updateMusicMode(meta = {}) {
    musicServiceMeta = { ...musicServiceMeta, ...meta };
    const remote = musicServiceMeta.mode === "remote" || musicServiceMeta.mode === "mock";
    const fallback = musicServiceMeta.mode === "local-fallback" || musicServiceMeta.provider === "browser-synth";
    const providerName = musicProviderName();
    $("#musicEngineLabel").textContent = remote ? `${providerName} 真唱服务已连接` : fallback ? "真人服务失败 · 已切换电子拟唱" : "专业音乐服务尚未配置";
    $("#musicEngineHelp").textContent = remote
      ? (musicServiceMeta.provider === "treblo" ? "Treblo Melodia v3 异步真唱：生成完成后可临时试听全曲；收藏时永久保留同一份母带。" : musicServiceMeta.provider === "minimax" ? "MiniMax 真唱模式：生成后可临时试听全曲；收藏时永久保留同一音频。" : musicServiceMeta.async ? "异步真唱模式：任务完成后可临时试听全曲；收藏时永久保留同一母带。" : musicServiceMeta.renderMode === "cover-guide" ? "已配置真实人声引导；可临时试听全曲，收藏后永久保留同一音频。" : "ACE 同步真唱兼容模式：可临时试听全曲，收藏时永久保留同一母带。")
      : fallback ? "本地电子拟唱使用同一份歌词和曲调蓝图，不再请求音乐 API。" : `请通过 Wrangler 运行，并配置 ${musicServiceMeta.provider === "treblo" ? "TREBLO_API_KEY" : musicServiceMeta.provider === "minimax" ? "MINIMAX_API_KEY" : "ACEMUSIC_API_KEY"}；真人服务失败时会自动回退本地电子拟唱。`;
  }

  function guideFor(seed = currentDraft.seed || Date.now()) {
    const guide = currentDraft.melodyGuide || (currentDraft.compositionPlan ? { compositionPlan: currentDraft.compositionPlan } : null);
    return FocusBeatMelodyGuide.normalize(guide, { style: $("#songStyle").value, seed }) || FocusBeatMelodyGuide.create({ style: $("#songStyle").value, seed });
  }

  function lyricCharacter(char) { return !/[\s，。！？、；：,.!?~～—-]/.test(char); }
  function renderInlineLyricOverlay(guide = guideFor()) {
    if (!lyricOverlay) return FocusBeatMelodyGuide.analyze($("#lyrics").value, guide);
    const lyrics = $("#lyrics").value; const safeGuide = FocusBeatMelodyGuide.normalize(guide, { style: $("#songStyle").value, seed: currentDraft.seed || Date.now() });
    const result = FocusBeatMelodyGuide.analyze(lyrics, safeGuide); const byLine = new Map(result.lines.map(line => [line.lineNumber, line]));
    lyricOverlay.innerHTML = lyrics.split(/\r?\n/).map((raw, index) => {
      const value = raw; if (!value.trim()) return "<div class=\"lyric-overlay-line lyric-overlay-empty\">&nbsp;</div>";
      if (FocusBeatMelodyGuide.isHeader(value.trim())) return `<div class="lyric-overlay-line lyric-overlay-header">${escapeHtml(value)}</div>`;
      const line = byLine.get(index + 1); if (!line) return `<div class="lyric-overlay-line">${escapeHtml(value)}</div>`;
      let counted = 0; let html = "";
      for (const char of Array.from(value)) {
        if (!lyricCharacter(char)) { html += `<span class="lyric-overlay-punctuation">${escapeHtml(char)}</span>`; continue; }
        const className = counted < line.target ? "lyric-overlay-fit" : "lyric-overlay-extra"; counted += 1;
        html += `<span class="${className}">${escapeHtml(char)}</span>`;
      }
      if (counted < line.target) html += `<span class="lyric-overlay-missing">${"☆".repeat(line.target - counted)}</span>`;
      return `<div class="lyric-overlay-line ${line.status}" data-overlay-line="${line.lineNumber}">${html}</div>`;
    }).join("");
    lyricOverlay.scrollTop = $("#lyrics").scrollTop;
    return result;
  }

  function setupLyricOverlay() {
    const textarea = $("#lyrics"); const tools = $(".lyric-editor-tools"); if (!textarea || !tools) return;
    $("#lyricMeterPreview")?.remove(); $("#forceLyricsBtn")?.remove();
    const shell = document.createElement("div"); shell.className = "lyrics-editor-shell"; textarea.parentNode.insertBefore(shell, textarea); shell.appendChild(textarea);
    lyricOverlay = document.createElement("div"); lyricOverlay.className = "lyric-overlay"; lyricOverlay.setAttribute("aria-hidden", "true"); shell.insertBefore(lyricOverlay, textarea);
    textarea.classList.add("lyrics-source");
    const syncScroll = () => { lyricOverlay.scrollTop = textarea.scrollTop; lyricOverlay.scrollLeft = textarea.scrollLeft; };
    textarea.addEventListener("scroll", syncScroll); textarea.addEventListener("input", () => { renderInlineLyricOverlay(); syncScroll(); });
    renderInlineLyricOverlay();
  }

  function setupPreviewLyricsPanel() {
    const track = $(".track-panel"); if (!track || $("#previewLyrics")) return;
    const panel = document.createElement("div"); panel.className = "preview-lyrics"; panel.id = "previewLyrics"; panel.setAttribute("aria-label", "试听歌词"); panel.innerHTML = "<span class=\"preview-lyrics-empty\">生成试听后显示歌词</span>";
    const anchor = $("#nowLyric"); anchor?.after(panel);
  }

  const lyricAuditSuccessMessages = [
    "这次 AI 创作很顺利，歌词和演唱基本一步到位，咱们真是太棒了。",
    "这次生成很顺利，歌词和演唱基本一步到位，不愧是本天才认可的小伙伴。",
    "这一拍配合得很默契，歌词和演唱完整对上啦，继续把这份好状态唱下去。",
    "歌词稳稳落进旋律里，这次合作堪称一步到位，今天的灵感配合得刚刚好。",
    "每一句都找到了自己的旋律位置，今天的创作状态满格。",
    "系统检查通过，歌词和演唱默契得像排练过很多次。",
    "这一版很争气，歌词一句都没有掉队，连旋律都在为我们鼓掌。",
    "旋律接住了每一句歌词，这次创作漂亮收官，可以放心把整首歌听完啦。",
    "从第一句到最后一句都对上了，今天的灵感特别会配合。",
    "好消息：歌词已经全部站上自己的节拍，这一版很稳，我们的合作越来越默契了。",
    "演唱和歌词成功牵手，没有一句落单，继续保持这个手感，下一首也值得期待。",
    "这次不用返工，歌词和旋律已经默契通关，不愧是认真听完整首歌的小小制作人。",
  ];

  function lyricRows(value) {
    let section = "";
    return String(value || "").split(/\r?\n/).map((raw, rawIndex) => {
      const textValue = raw.trim();
      if (!textValue) return { type: "empty", rawIndex, text: "", section };
      if (FocusBeatMelodyGuide.isHeader(textValue)) { section = textValue; return { type: "header", rawIndex, text: textValue, section }; }
      return { type: "line", rawIndex, text: textValue, section };
    });
  }

  function comparableLyric(value) {
    return String(value || "").replace(/[\s，。！？、；：,.!?~～—\-_'“”‘’（）()《》]/g, "").toLowerCase();
  }

  function inspectLyricCoverage(preview = currentDraft.preview, lyrics = $("#lyrics")?.value) {
    const source = lyricRows(lyrics).filter(row => row.type === "line");
    const aligned = Array.isArray(preview?.alignment?.lines) ? preview.alignment.lines : [];
    const reliable = preview?.alignment?.verified === true && source.length > 0 && aligned.length === source.length;
    let matched = 0;
    if (reliable) {
      matched = source.filter((row, index) => {
        const line = aligned[index]; const syllables = Array.isArray(line?.syllables) ? line.syllables : [];
        const timed = syllables.length > 0 && syllables.every(item => Number.isFinite(Number(item.startMs)) && Number.isFinite(Number(item.endMs)) && Number(item.endMs) > Number(item.startMs));
        const performed = line?.text || syllables.map(item => item?.text || "").join("");
        return timed && comparableLyric(row.text) === comparableLyric(performed);
      }).length;
    }
    return { reliable, manual: preview?.manualLyricsConfirmed === true, total: source.length, matched, perfect: reliable && matched === source.length, percentage: reliable && source.length ? Math.round(matched / source.length * 100) : null };
  }

  function lyricAuditMessage(preview = currentDraft.preview) {
    const key = String(preview?.jobId || preview?.seed || currentDraft.seed || "focus-beat");
    const hash = Array.from(key).reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 3), 0);
    return lyricAuditSuccessMessages[hash % lyricAuditSuccessMessages.length];
  }

  function setupLyricAudit() {
    const controls = $(".studio-controls"); if (!controls || $("#lyricAudit")) return;
    const section = document.createElement("section"); section.id = "lyricAudit"; section.className = "lyric-audit"; section.hidden = true; section.setAttribute("aria-live", "polite");
    section.innerHTML = `<div class="lyric-audit-summary"><span class="lyric-audit-mark" id="lyricAuditMark" aria-hidden="true">✓</span><div class="lyric-audit-copy"><strong id="lyricAuditTitle">歌词演唱检查</strong><p id="lyricAuditText"></p></div><button class="button ghost lyric-audit-open" id="openLyricReviewBtn" type="button">我听到有差异，手动校对</button></div><button class="text-button lyric-audit-undo" id="undoLyricReviewBtn" type="button" hidden>撤销刚才的歌词更新</button><div class="lyric-review" id="lyricReviewWorkspace" hidden><div class="lyric-review-head"><div><strong>手动校对歌词</strong><p>点击左侧某一句可跳到对应试听位置。这里的修改只改变显示与保存的歌词，不会改变已经生成的声音，也不会消耗音符。</p></div><button class="icon-button lyric-review-close" id="closeLyricReviewBtn" type="button" aria-label="取消校对">×</button></div><div class="lyric-review-tabs" role="tablist" aria-label="校对视图"><button class="is-active" data-review-tab="source" type="button" role="tab">试听原稿</button><button data-review-tab="draft" type="button" role="tab">修改后歌词</button></div><div class="lyric-review-grid"><section class="lyric-review-pane is-mobile-active" data-review-pane="source"><div class="lyric-review-pane-title"><strong>试听原稿</strong><button class="text-button" id="reviewLoopBtn" type="button" aria-pressed="false">↻ 循环当前行：关</button></div><div class="lyric-review-lines" id="lyricReviewOriginal"></div></section><section class="lyric-review-pane" data-review-pane="draft"><div class="lyric-review-pane-title"><strong>修改后歌词</strong><span id="lyricReviewCount">0 / 2400</span></div><textarea id="lyricReviewDraft" maxlength="2400" rows="16" aria-label="修改后歌词"></textarea></section></div><div class="lyric-review-actions"><button class="button ghost" id="cancelLyricReviewBtn" type="button">取消，不更新</button><button class="button secondary" id="applyLyricReviewBtn" type="button">应用为最终歌词</button></div></div>`;
    const status = $(".studio-status"); controls.insertBefore(section, status || null);
    $("#openLyricReviewBtn").addEventListener("click", openLyricReview);
    $("#closeLyricReviewBtn").addEventListener("click", closeLyricReview);
    $("#cancelLyricReviewBtn").addEventListener("click", closeLyricReview);
    $("#applyLyricReviewBtn").addEventListener("click", applyLyricReview);
    $("#undoLyricReviewBtn").addEventListener("click", undoLyricReview);
    $("#reviewLoopBtn").addEventListener("click", toggleReviewLoop);
    $("#lyricReviewDraft").addEventListener("input", event => { lyricReview.draft = event.currentTarget.value; $("#lyricReviewCount").textContent = `${event.currentTarget.value.length} / 2400`; });
    $$("[data-review-tab]").forEach(button => button.addEventListener("click", () => setLyricReviewTab(button.dataset.reviewTab)));
    $("#lyricReviewOriginal").addEventListener("click", event => { const button = event.target.closest("[data-review-line]"); if (button && !button.disabled) void playReviewLine(Number(button.dataset.reviewLine)); });
  }

  function renderLyricAudit() {
    const audit = $("#lyricAudit"); if (!audit) return;
    const preview = currentDraft.preview;
    audit.hidden = !preview || preview.pending || currentDraft.stale;
    if (audit.hidden) { lyricReview.open = false; $("#lyricReviewWorkspace").hidden = true; return; }
    const result = inspectLyricCoverage(preview, $("#lyrics").value);
    audit.classList.toggle("is-perfect", result.perfect || result.manual); audit.classList.toggle("is-unknown", !result.reliable && !result.manual); audit.classList.toggle("has-difference", result.reliable && !result.perfect);
    $("#lyricAuditMark").textContent = result.perfect || result.manual ? "✓" : result.reliable ? "!" : "?";
    $("#lyricAuditTitle").textContent = result.manual ? "已采用你的校对版本" : result.perfect ? `${result.matched}/${result.total} 行完整覆盖` : result.reliable ? `${result.matched}/${result.total} 行已可靠匹配` : "等待你的耳朵来验收";
    $("#lyricAuditText").textContent = result.manual ? "你的判断优先：这份歌词会进入完整保存和歌曲收藏；当前音频保持原样。" : result.perfect ? lyricAuditMessage(preview) : result.reliable ? "有些歌词没有被时间轴完整覆盖，建议听一遍后手动校对再收藏。" : `${musicProviderName(preview.provider)} 没有返回可验证的完整歌词时间轴，系统不会假装判断正确；请按实际试听决定是否校对。`;
    $("#openLyricReviewBtn").textContent = result.manual ? "继续校对" : result.perfect ? "我听到有差异，手动校对" : "手动校对歌词";
    $("#undoLyricReviewBtn").hidden = !lyricReview.undo;
  }

  function setLyricReviewTab(name) {
    $$("[data-review-tab]").forEach(node => node.classList.toggle("is-active", node.dataset.reviewTab === name));
    $$("[data-review-pane]").forEach(node => node.classList.toggle("is-mobile-active", node.dataset.reviewPane === name));
  }

  function fullPreviewTimeline() {
    const preview = currentDraft.preview; if (!preview) return [];
    return buildLyricTimeline({ lyrics: preview.previewLyrics || preview.lyrics || $("#lyrics").value, alignment: preview.alignment || null, compositionPlan: preview.compositionPlan || preview.melodyGuide?.compositionPlan || null, melodyGuide: preview.melodyGuide || null, duration: Number(preview.duration) || 30 });
  }

  function renderLyricReviewSource() {
    const root = $("#lyricReviewOriginal"); if (!root) return;
    const timeline = fullPreviewTimeline(); const duration = Number(currentDraft.preview?.duration) || 30; let lineIndex = 0;
    root.innerHTML = lyricRows(lyricReview.original).map(row => {
      if (row.type === "empty") return "<div class=\"lyric-review-empty\">&nbsp;</div>";
      if (row.type === "header") return `<div class="lyric-review-section">${escapeHtml(row.text)}</div>`;
      const index = lineIndex++; const line = timeline[index]; const playable = Boolean(line && line.start < duration); const timeLabel = line ? formatPlaybackTime(line.start) : "--:--";
      return `<button class="lyric-review-line${index === lyricReview.selectedLine ? " is-selected" : ""}" data-review-line="${index}" type="button" ${playable ? "" : "disabled"}><span>${escapeHtml(row.text)}</span><small>${playable ? `▶ ${timeLabel}` : "当前时间轴不可用"}</small></button>`;
    }).join("");
  }

  function openLyricReview() {
    if (!currentDraft.preview || currentDraft.stale) { showToast("请先生成当前歌曲的试听", "error"); return; }
    lyricReview.open = true; lyricReview.original = $("#lyrics").value; lyricReview.draft = lyricReview.original; lyricReview.selectedLine = -1; lyricReview.loopLine = false;
    $("#lyricReviewDraft").value = lyricReview.draft; $("#lyricReviewCount").textContent = `${lyricReview.draft.length} / 2400`; $("#lyricReviewWorkspace").hidden = false; $("#reviewLoopBtn").textContent = "↻ 循环当前行：关"; $("#reviewLoopBtn").setAttribute("aria-pressed", "false");
    setLyricReviewTab("source"); renderLyricReviewSource(); $("#lyricReviewWorkspace").scrollIntoView({ block: "nearest", behavior: window.FocusBeatThemes?.reduced?.() ? "auto" : "smooth" });
  }

  function closeLyricReview() {
    lyricReview.open = false; lyricReview.loopLine = false; lyricReview.selectedLine = -1; $("#lyricReviewWorkspace").hidden = true;
  }

  async function playReviewLine(index) {
    const line = fullPreviewTimeline()[index]; if (!line || line.start >= (Number(currentDraft.preview?.duration) || 30)) return;
    lyricReview.selectedLine = index; renderLyricReviewSource();
    if (!previewAudio) await playSongAsset(currentDraft.preview, currentDraft.preview.blueprint, $("#playSongBtn"), false);
    if (!previewAudio) return;
    previewAudio.currentTime = Math.max(0, line.start + .01);
    try { await previewAudio.play(); } catch (_) {}
  }

  function toggleReviewLoop() {
    if (lyricReview.selectedLine < 0) { showToast("请先点击左侧的一句歌词", "error"); return; }
    lyricReview.loopLine = !lyricReview.loopLine; const button = $("#reviewLoopBtn"); button.textContent = `↻ 循环当前行：${lyricReview.loopLine ? "开" : "关"}`; button.setAttribute("aria-pressed", String(lyricReview.loopLine));
  }

  function retimeAlignmentForLyrics(lyrics, alignment) {
    const rows = lyricRows(lyrics).filter(row => row.type === "line"); const lines = Array.isArray(alignment?.lines) ? alignment.lines : [];
    if (!rows.length || rows.length !== lines.length) return null;
    const rematched = rows.map((row, index) => {
      const previous = lines[index]; const sourceSyllables = Array.isArray(previous?.syllables) ? previous.syllables : [];
      const startMs = Number(sourceSyllables[0]?.startMs); const endMs = Number(sourceSyllables.at(-1)?.endMs); const chars = Array.from(row.text.replace(/[\s，。！？、；：,.!?~～—-]/g, ""));
      if (!chars.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      const slice = (endMs - startMs) / chars.length;
      return { text: row.text, section: row.section, syllables: chars.map((char, charIndex) => ({ text: char, startMs: Math.round(startMs + slice * charIndex), endMs: Math.round(startMs + slice * (charIndex + 1)) })) };
    });
    if (rematched.some(line => !line)) return null;
    return { ...alignment, verified: false, manuallyConfirmed: true, source: "manual-lyric-review", lines: rematched };
  }

  function applyLyricReview() {
    const next = $("#lyricReviewDraft").value.trim(); if (!next) { showToast("最终歌词不能为空", "error"); return; }
    const preview = currentDraft.preview; if (!preview) return;
    lyricReview.undo = { lyrics: $("#lyrics").value, previewLyrics: preview.previewLyrics, previewSourceLyrics: preview.lyrics, alignment: preview.alignment, manualLyricsConfirmed: preview.manualLyricsConfirmed };
    $("#lyrics").value = next; preview.lyrics = next; preview.previewLyrics = next; preview.alignment = retimeAlignmentForLyrics(next, preview.alignment); preview.manualLyricsConfirmed = true;
    currentDraft.fingerprint = ""; currentDraft.savedFingerprint = ""; currentDraft.completed = false; currentDraft.stale = false;
    $("#lyricsVersion").textContent = "手动校对版 · 已绑定当前试听"; closeLyricReview(); renderInlineLyricOverlay(); renderLyricFit(); renderPreviewLyrics(); updateStudioMeta(); renderLyricAudit();
    showToast("最终歌词已更新；当前音频没有重新生成，也没有消耗音符");
  }

  function undoLyricReview() {
    const undo = lyricReview.undo; const preview = currentDraft.preview; if (!undo || !preview) return;
    $("#lyrics").value = undo.lyrics; preview.previewLyrics = undo.previewLyrics; preview.lyrics = undo.previewSourceLyrics; preview.alignment = undo.alignment; preview.manualLyricsConfirmed = undo.manualLyricsConfirmed; lyricReview.undo = null;
    currentDraft.fingerprint = ""; currentDraft.stale = false; renderInlineLyricOverlay(); renderLyricFit(); renderPreviewLyrics(); updateStudioMeta(); renderLyricAudit(); showToast("已恢复校对前的歌词");
  }

  function renderLyricFit(guide = guideFor()) {
    const lyrics = $("#lyrics").value.trim(); const safeGuide = FocusBeatMelodyGuide.normalize(guide, { style: $("#songStyle").value, seed: currentDraft.seed || Date.now() });
    $("#melodyGuideLabel").textContent = `${safeGuide.name} · ${safeGuide.bpm} BPM`;
    $("#melodyGuideCopy").textContent = `${FocusBeatMelodyGuide.description(safeGuide)}。这是当前曲调规划与填词建议，不代表音乐服务成品的实际音符。${lyrics ? "灰体字部分建议缩减行字数，“☆”部分建议补充音节。" : "生成歌词后会显示建议音节位。"}`;
    const summary = $("#lyricFitSummary"); const list = $("#lyricFitList"); list.innerHTML = "";
    if (!lyrics) { summary.textContent = "尚未检测歌词"; summary.className = "lyric-fit-summary"; $("#lyricWarning").hidden = true; renderInlineLyricOverlay(safeGuide); return { total: 0, issues: 0, severe: 0 }; }
    const result = FocusBeatMelodyGuide.analyze(lyrics, safeGuide);
    summary.textContent = result.issues ? "灰体字部分建议缩减行字数，“☆”部分建议补充音节。" : "歌词已符合当前曲调建议，可以生成试听。";
    summary.className = `lyric-fit-summary ${result.issues ? "warn" : "good"}`;
    $("#lyricWarning").hidden = true; renderInlineLyricOverlay(safeGuide);
    return result;
  }

  function updateStudioMeta() {
    const name = $("#songName").value.trim() || "未命名歌曲"; const style = $("#songStyle").value;
    const pending = Boolean(currentDraft.preview?.pending);
    const fallback = currentDraft.preview?.mode === "local-fallback";
    const phase = pending ? "真唱任务正在云端创作" : fallback ? "电子拟唱试听已就绪" : currentDraft.preview && !currentDraft.stale ? `试听第 ${currentDraft.tuneVersion} 版已就绪` : ($("#lyrics").value.trim() ? "等待生成试听" : "等待歌词");
    $("#trackTitle").textContent = name; $("#trackStyle").textContent = `${styleNames[style]} · ${phase}`;
    $("#playSongBtn").textContent = pending ? "真唱正在生成…" : currentDraft.preview && !currentDraft.stale ? (fallback ? "▶ 播放电子拟唱" : "▶ 播放全曲试听") : `生成全曲试听 · ${PREVIEW_COST} 音符`;
    $("#previewRuleText").textContent = currentDraft.completed ? "完整歌曲已收藏到本设备" : (pending ? `任务已提交 · 正在等待 ${musicProviderName()} 真唱完成` : fallback ? "真人服务失败 · 试听音符已退回 · 可保存电子拟唱版" : currentDraft.preview && !currentDraft.stale ? `全曲临时试听已生成 · 收藏到本设备 ${SONG_COST} 音符` : `全曲临时试听 ${PREVIEW_COST} 音符 · 收藏到本设备 ${SONG_COST} 音符`);
    $("#generateLyricsBtn").hidden = currentDraft.version > 0;
    $("#polishLyricsBtn").hidden = !$("#lyrics").value.trim();
    $("#regenerateTuneBtn").hidden = !$("#lyrics").value.trim();
    ["generateLyricsBtn", "polishLyricsBtn", "regenerateTuneBtn", "playSongBtn"].forEach(id => { $("#" + id).disabled = pending; });
    $("#saveSongBtn").disabled = currentDraft.completed || pending;
    $("#saveSongBtn").textContent = currentDraft.completed ? "✓ 已收藏 · 已保存到本设备" : fallback ? `收藏电子拟唱版到本设备 · ${SONG_COST} 音符` : `收藏完整歌曲到本设备 · ${SONG_COST} 音符`;
    renderLyricFit();
  }

  function invalidateDraft() {
    currentDraft.fingerprint = ""; currentDraft.savedFingerprint = ""; currentDraft.completed = false;
    currentDraft.warningAcknowledgedJobId = "";
    if (currentDraft.preview) currentDraft.stale = true;
    updateStudioMeta(); stopSongPlayback();
  }

  function debitNotes(cost) {
    if (state.totalNotes < cost) { showToast(`还差 ${Math.ceil(cost - state.totalNotes)} 枚音符`, "error"); return false; }
    const previous = state.totalNotes; state.totalNotes -= cost;
    if (!saveState()) { state.totalNotes = previous; return false; }
    renderDashboard(); return true;
  }

  function refundNotes(cost) {
    state.totalNotes += cost; saveState(); renderDashboard();
  }

  function setMusicButtonsDisabled(disabled) {
    ["generateLyricsBtn", "polishLyricsBtn", "regenerateTuneBtn", "playSongBtn", "saveSongBtn"].forEach(id => { const node = $("#" + id); if (node) node.disabled = disabled; });
  }

  async function chargedMusicAction(button, busyText, cost, action) {
    if (!debitNotes(cost)) return false;
    const original = button.textContent; setMusicButtonsDisabled(true); button.classList.add("is-busy"); button.setAttribute("aria-busy", "true"); button.textContent = busyText;
    try {
      const outcome = await action();
      if (outcome?.chargeable === false) {
        refundNotes(cost);
        showToast(`云端服务未成功，本次未扣除 ${cost} 枚音符`, "error");
      }
      return outcome ?? true;
    }
    catch (error) {
      if (error?.preserveCharge) showToast(error.message || "歌曲仍在云端生成，稍后会自动恢复查询", "error");
      else { refundNotes(cost); showToast(`${error.message || "生成失败"}，${cost} 枚音符已退还`, "error"); }
      return false;
    }
    finally { setMusicButtonsDisabled(false); button.classList.remove("is-busy"); button.removeAttribute("aria-busy"); button.textContent = original; updateStudioMeta(); }
  }

  function songSnapshot(lyrics = $("#lyrics").value.trim(), guide = guideFor()) {
    return { title: $("#songName").value.trim(), style: $("#songStyle").value, topic: $("#songTopic").value.trim(), lyrics, melodyGuide: guide };
  }

  function validateSongSnapshot(snapshot) {
    if (!snapshot.title) { showToast("请先填写歌曲名字", "error"); $("#songName").focus(); return false; }
    if (!snapshot.lyrics) { showToast("请先生成或填写歌词", "error"); $("#lyrics").focus(); return false; }
    const fit = renderLyricFit(snapshot.melodyGuide);
    return true;
  }

  function sameLyricStructure(before, after) {
    const shape = lyrics => String(lyrics || "").split(/\r?\n/).map(raw => raw.trim()).filter(Boolean).map(value => ({
      type: FocusBeatMelodyGuide.isHeader(value) ? "header" : "line",
      value: FocusBeatMelodyGuide.isHeader(value) ? value.replace(/[\[\]【】]/g, "").trim() : "",
    }));
    const source = shape(before); const target = shape(after);
    return source.length === target.length && source.every((item, index) => item.type === target[index].type && (item.type !== "header" || item.value === target[index].value));
  }

  async function discardCurrentPreview(preview = currentDraft.preview) {
    if (!preview) return;
    const jobId = preview.jobId; const accessToken = preview.accessToken;
    currentDraft.preview = null; currentDraft.stale = false; currentDraft.completed = false; currentDraft.savedFingerprint = ""; currentDraft.warningAcknowledgedJobId = "";
    lyricReview = { open: false, original: "", draft: "", selectedLine: -1, loopLine: false, undo: null };
    stopSongPlayback(); updateStudioMeta(); renderPreviewLyrics();
    if (preview.localAudioId) void window.FocusBeatAudioStore?.remove(preview.localAudioId);
    if (jobId && accessToken) void FocusBeatMusicAPI.release(jobId, accessToken);
  }

  function previewFromResult(result, snapshot, seed) {
    if (!result.data?.jobId) throw new Error("音乐服务没有返回试听任务");
    const previewSeed = Number(result.data.seed) || seed;
    const blueprint = FocusBeatMusic.createBlueprint({ title: snapshot.title, style: snapshot.style, lyrics: snapshot.lyrics, seed: previewSeed });
    const compositionPlan = snapshot.compositionPlan || snapshot.melodyGuide?.compositionPlan || null;
    const alignment = result.data.alignment || null;
    const status = String(result.data.status || (result.data.audioUrl ? "ready" : "queued")).toLowerCase();
    return { ...result.data, status, lyrics: snapshot.lyrics, previewLyrics: result.data.previewLyrics || snapshot.lyrics, seed: previewSeed, blueprint, melodyGuide: snapshot.melodyGuide, compositionPlan, alignment, mode: result.mode, stale: false, pending: !["ready", "succeeded"].includes(status) };
  }

  function localPreviewId(preview) { return `draft:${String(preview?.jobId || uid("audio"))}`; }
  async function cachePreviewLocally(preview) {
    if (preview?.mode === "local-fallback" || preview?.localFallback) return preview;
    const store = window.FocusBeatAudioStore;
    if (!store?.supported?.()) throw new Error("当前浏览器不支持本地歌曲存储，无法安全保存试听");
    const id = preview.localAudioId || localPreviewId(preview); preview.localAudioId = id;
    if (await store.has(id)) return preview;
    $("#nowLyric").textContent = "真唱已完成，正在保存到本设备…";
    await store.cache(id, preview.audioUrl, { scope:"draft", provider:preview.provider });
    return preview;
  }
  async function localAudioSource(asset) {
    const store = window.FocusBeatAudioStore;
    if (asset?.localAudioId && store?.supported?.()) {
      const source = await store.source(asset.localAudioId); if (source) return source;
      throw new Error("本设备中没有这首歌曲的音频；请重新生成并收藏");
    }
    if (asset?.audioUrl && store?.supported?.()) {
      const id = asset.unlocked && asset.id ? `song:${asset.id}` : localPreviewId(asset);
      try {
        await store.cache(id, asset.audioUrl, { scope:asset.unlocked ? "saved" : "draft", provider:asset.provider });
        asset.localAudioId = id; if (asset.unlocked) saveState();
        return store.source(id);
      } catch (_) { /* Legacy links may already have expired; the existing URL fallback remains available. */ }
    }
    if (asset?.audioUrl) return asset.audioUrl;
    throw new Error("真实歌曲音频不可用，请重新生成试听");
  }

  function pause(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

  function createLocalFallbackPreview(snapshot, seed, error) {
    const blueprint = FocusBeatMusic.createBlueprint({ title: snapshot.title, style: snapshot.style, lyrics: snapshot.lyrics, seed });
    const message = text(error?.message || error || "真人歌曲服务暂时不可用", 240, "真人歌曲服务暂时不可用");
    return {
      jobId: `local_fallback_${uid("song")}`, status: "ready", mode: "local-fallback", localFallback: true,
      provider: "browser-synth", renderMode: "browser-synth", error: message, lyrics: snapshot.lyrics,
      previewLyrics: snapshot.lyrics, seed, duration: Number(blueprint.duration) || 60,
      blueprint, melodyGuide: snapshot.melodyGuide, compositionPlan: snapshot.compositionPlan || snapshot.melodyGuide?.compositionPlan || null,
      alignment: null, pending: false, stale: false,
    };
  }

  async function waitForPreview(preview, snapshot, seed) {
    const deadline = Date.now() + 600_000;
    let consecutiveErrors = 0;
    while (Date.now() < deadline) {
      let result;
      try {
        result = await FocusBeatMusicAPI.jobStatus(preview.jobId, preview.accessToken, { lyrics:snapshot.lyrics });
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        $("#nowLyric").textContent = `${musicProviderName(preview.provider)} 状态查询暂时失败，歌曲任务仍保留，正在重试（${consecutiveErrors}/5）。`;
        if (consecutiveErrors >= 5) throw new PendingMusicError(`${musicProviderName(preview.provider)} 歌曲任务已提交，但状态查询连续失败；不会重复提交或扣费，刷新页面后会继续查询`);
        await pause(3000);
        continue;
      }
      const next = previewFromResult(result, snapshot, seed); const status = String(next.status || "").toLowerCase();
      if (["ready", "succeeded"].includes(status) && next.audioUrl) return next;
      if (["failed", "cancelled", "canceled"].includes(status)) throw new Error(next.error || `${musicProviderName()} 真唱任务失败`);
      const eta = Number(next.etaSeconds) || 0;
      $("#nowLyric").textContent = status === "running" ? `${musicProviderName()} 正在编曲和演唱，歌曲会在完成后自动出现。` : `${musicProviderName()} 真唱任务排队中${next.queuePosition ? `，前方还有 ${next.queuePosition} 个任务` : ""}${eta ? `，预计约 ${eta} 秒` : ""}。`;
      await pause(Math.max(1500, Math.min(4000, eta ? 2000 : 3000)));
    }
    throw new PendingMusicError(`${musicProviderName(preview.provider)} 真唱任务已提交但仍在生成；不会重复提交或退款，刷新页面后会继续查询`);
  }

  async function requestPreview(snapshot, seed) {
    let remotePreview = null;
    try {
      const result = await FocusBeatMusicAPI.request("preview", { ...snapshot, seed, fullSongPreview: true });
      remotePreview = previewFromResult(result, snapshot, seed);
      if (!remotePreview.pending) return remotePreview;
      currentDraft.preview = remotePreview; currentDraft.stale = false; state.pendingMusic = { preview: remotePreview, snapshot, seed }; saveState(); updateStudioMeta();
      const completed = await waitForPreview(remotePreview, snapshot, seed);
      state.pendingMusic = null; saveState(); return completed;
    } catch (error) {
      if (error?.preserveCharge) throw error;
      if (remotePreview?.jobId && remotePreview?.accessToken) void FocusBeatMusicAPI.release(remotePreview.jobId, remotePreview.accessToken);
      state.pendingMusic = null; saveState();
      const fallback = createLocalFallbackPreview(snapshot, seed, error);
      showToast(`真人歌曲生成失败，已退回 ${PREVIEW_COST} 枚音符，改用本地电子拟唱`, "error");
      return fallback;
    }
  }

  async function installPreview(preview, previousPreview) {
    await cachePreviewLocally(preview);
    currentDraft.preview = preview; currentDraft.seed = preview.seed; currentDraft.melodyGuide = preview.melodyGuide || currentDraft.melodyGuide; currentDraft.compositionPlan = preview.compositionPlan || currentDraft.compositionPlan || currentDraft.melodyGuide?.compositionPlan || null; currentDraft.fingerprint = preview.blueprint.fingerprint; currentDraft.warningAcknowledgedJobId = "";
    currentDraft.savedFingerprint = ""; currentDraft.stale = false; currentDraft.completed = false; currentDraft.tuneVersion += 1; state.pendingMusic = null; lyricReview = { open: false, original: "", draft: "", selectedLine: -1, loopLine: false, undo: null }; saveState();
    updateMusicMode({ mode: preview.mode, provider: preview.provider, renderMode: preview.renderMode }); updateStudioMeta();
    $("#nowLyric").textContent = preview.alignment
      ? `全曲临时试听已就绪，并已取得 ${musicProviderName(preview.provider)} 真实歌词时间轴。`
      : `全曲临时试听已就绪；${musicProviderName(preview.provider)} 未返回字级时间轴，已启用估算逐行同步。`;
    renderPreviewLyrics();
    if (previousPreview?.localAudioId && previousPreview.localAudioId !== preview.localAudioId) void window.FocusBeatAudioStore?.remove(previousPreview.localAudioId);
    if (previousPreview?.jobId && previousPreview.jobId !== preview.jobId) void FocusBeatMusicAPI.release(previousPreview.jobId, previousPreview.accessToken);
  }

  async function resumePendingMusic() {
    const pending = state.pendingMusic;
    if (!pending?.preview?.jobId || !pending?.snapshot) return;
    const preview = pending.preview; const snapshot = pending.snapshot;
    $("#songName").value = snapshot.title || $("#songName").value; $("#songStyle").value = snapshot.style || $("#songStyle").value; $("#songTopic").value = snapshot.topic || ""; $("#lyrics").value = snapshot.lyrics || "";
    currentDraft.preview = preview; currentDraft.seed = preview.seed || pending.seed || Date.now(); currentDraft.melodyGuide = snapshot.melodyGuide || null; currentDraft.compositionPlan = snapshot.melodyGuide?.compositionPlan || null; currentDraft.stale = false; updateStudioMeta();
    try {
      const completed = await waitForPreview(preview, snapshot, currentDraft.seed);
      await installPreview(completed, null); showToast(`之前提交的 ${musicProviderName(completed.provider)} 真唱任务已经完成，可以试听了`);
    } catch (error) {
      if (!error?.preserveCharge && /失败|failed|取消|cancelled/i.test(String(error.message || ""))) { state.pendingMusic = null; currentDraft.preview = null; refundNotes(PREVIEW_COST); updateStudioMeta(); showToast(`${musicProviderName()} 真唱任务失败，${PREVIEW_COST} 枚音符已退还`, "error"); }
      else { updateStudioMeta(); showToast(error.message || "歌曲任务仍在云端生成，稍后会继续查询", "error"); }
    }
  }

  async function createLyricsDraft({ conditions, melodyGuide, previousLyrics, seed }) {
    const result = await FocusBeatAI.request("lyrics", { ...conditions, seed, previousLyrics, melodyGuide });
    let nextLyrics = String(result.data?.lyrics || "").trim();
    if (!nextLyrics || nextLyrics === previousLyrics) throw new Error("没有生成不同的新歌词，请再试一次");
    const outputSeed = Number(result.data?.seed) || seed;
    const normalizedGuide = FocusBeatMelodyGuide.normalize(result.data?.melodyGuide || (result.data?.compositionPlan ? { compositionPlan: result.data.compositionPlan } : null) || melodyGuide, { style: conditions.style, seed: outputSeed });
    return { lyrics: nextLyrics, seed: outputSeed, melodyGuide: normalizedGuide, result };
  }

  async function generateLyrics() {
    if (lyricsGenerationPending) return;
    const name = $("#songName").value.trim();
    if (!name) { showToast("请先填写歌曲名字", "error"); $("#songName").focus(); return; }
    const button = $("#generateLyricsBtn");
    const conditions = { title: name, style: $("#songStyle").value, topic: $("#songTopic").value.trim() };
    const create = async () => {
      const previous = $("#lyrics").value.trim(); const seed = Date.now() + currentDraft.version * 997;
      const draft = await createLyricsDraft({ conditions, melodyGuide: FocusBeatMelodyGuide.create({ style: conditions.style, seed }), previousLyrics: previous, seed });
      const { lyrics: nextLyrics, melodyGuide, result } = draft; const outputSeed = draft.seed;
      if (conditions.title !== $("#songName").value.trim() || conditions.style !== $("#songStyle").value || conditions.topic !== $("#songTopic").value.trim()) throw new Error("创作条件已经变化，请重新操作");
      await discardCurrentPreview();
      $("#lyrics").value = nextLyrics; currentDraft.seed = outputSeed; currentDraft.melodyGuide = melodyGuide; currentDraft.compositionPlan = melodyGuide.compositionPlan || currentDraft.compositionPlan; currentDraft.stale = false; updateStudioMeta();
      currentDraft.version += 1;
      $("#lyricsVersion").textContent = `第 ${currentDraft.version} 版 · 种子 ${String(outputSeed).slice(-6)}`;
      updateAiMode(result.mode, result.reason); updateStudioMeta(); $("#nowLyric").textContent = `歌词已生成，支付${PREVIEW_COST}音符即可生成试听。`;
      showToast(result.mode === "remote" ? "歌词已经生成" : "云端文本 AI 未成功，已展示本地草稿且未扣音符", result.mode === "remote" ? "success" : "error");
      return { chargeable: result.mode === "remote" };
    };
    lyricsGenerationPending = true;
    try {
      await runButton(button, "AI 创作中…", create);
    } finally { lyricsGenerationPending = false; }
  }

  async function generatePreview() {
    const seed = Date.now() + currentDraft.tuneVersion * 7919 + Math.floor(Math.random() * 1000);
    const melodyGuide = guideFor(currentDraft.seed || seed);
    let snapshot = songSnapshot(undefined, melodyGuide); if (!validateSongSnapshot(snapshot)) return false;
    const button = $("#playSongBtn");
    const previousPreview = currentDraft.preview;
    return chargedMusicAction(button, "正在生成试听…", PREVIEW_COST, async () => {
      const preview = await requestPreview(snapshot, seed);
      await installPreview(preview, previousPreview);
      const coverage = inspectLyricCoverage(preview, snapshot.lyrics);
      if (preview.mode === "local-fallback") {
        return { chargeable: false };
      }
      showToast(coverage.perfect ? lyricAuditMessage(preview) : "全曲试听已生成，可重复播放而不再扣费；建议听完后检查歌词");
      return { chargeable: ["remote", "mock"].includes(preview.mode) };
    });
  }

  async function changeTune() {
    const name = $("#songName").value.trim(); const previousLyrics = $("#lyrics").value.trim();
    if (!name || !previousLyrics) { showToast("请先生成歌词，再更换曲调", "error"); return; }
    const button = $("#regenerateTuneBtn"); const conditions = { title: name, style: $("#songStyle").value, topic: $("#songTopic").value.trim() };
    await chargedMusicAction(button, "正在生成新曲调和填词…", PREVIEW_COST, async () => {
      const seed = Date.now() + currentDraft.tuneVersion * 7919 + Math.floor(Math.random() * 1000); const melodyGuide = FocusBeatMelodyGuide.create({ style: conditions.style, seed });
      const draft = await createLyricsDraft({ conditions, melodyGuide, previousLyrics, seed });
      await discardCurrentPreview();
      $("#lyrics").value = draft.lyrics; currentDraft.seed = draft.seed; currentDraft.melodyGuide = draft.melodyGuide; currentDraft.compositionPlan = draft.melodyGuide.compositionPlan; currentDraft.stale = false; currentDraft.completed = false; currentDraft.version += 1; currentDraft.tuneVersion += 1;
      $("#lyricsVersion").textContent = `新曲调歌词 · 种子 ${String(draft.seed).slice(-6)}`; updateAiMode(draft.result.mode, draft.result.reason); updateStudioMeta(); $("#nowLyric").textContent = "新曲调和填词已生成，旧试听已清理；请点击生成试听。"; showToast("新曲调已生成，请确认歌词后生成试听");
      return { chargeable: draft.result.mode === "remote" };
    });
  }

  async function polishLyrics() {
    const snapshot = songSnapshot(); if (!snapshot.title || !snapshot.lyrics) { showToast("请先填写歌名并生成歌词", "error"); return; }
    const guide = guideFor(currentDraft.seed || Date.now()); const button = $("#polishLyricsBtn");
    await chargedMusicAction(button, "正在润色歌词…", PREVIEW_COST, async () => {
      const seed = Date.now() + currentDraft.version * 577 + 19;
      const result = await FocusBeatAI.request("lyrics", { ...snapshot, seed, mode: "polish", melodyGuide: guide });
      const nextLyrics = String(result.data.lyrics || "").trim(); if (!nextLyrics) throw new Error("AI 没有返回润色后的歌词");
      const nextGuide = FocusBeatMelodyGuide.normalize(result.data.melodyGuide || (result.data.compositionPlan ? { compositionPlan: result.data.compositionPlan } : null) || guide, { style: snapshot.style, seed });
      const fit = FocusBeatMelodyGuide.analyze(nextLyrics, nextGuide); if (fit.issues) throw new Error("润色后仍有歌词偏离音节位，请按提示修改后再试"); if (!sameLyricStructure(snapshot.lyrics, nextLyrics)) throw new Error("润色必须保留原有段落和每行结构，请重新尝试");
      await discardCurrentPreview();
      $("#lyrics").value = nextLyrics; currentDraft.seed = Number(result.data.seed) || seed; currentDraft.melodyGuide = nextGuide; currentDraft.compositionPlan = nextGuide.compositionPlan || currentDraft.compositionPlan; currentDraft.version += 1; currentDraft.stale = false; currentDraft.completed = false;
      $("#lyricsVersion").textContent = `适唱润色版 · 种子 ${String(currentDraft.seed).slice(-6)}`; updateAiMode(result.mode, result.reason); updateStudioMeta(); showToast("已按当前曲调润色歌词，请生成新的试听");
      return { chargeable: result.mode === "remote" };
    });
  }

  function buildCurrentBlueprint() {
    const snapshot = songSnapshot(); if (!validateSongSnapshot(snapshot)) return null;
    const seed = currentDraft.preview?.seed || currentDraft.seed || Date.now();
    const blueprint = FocusBeatMusic.createBlueprint({ title: snapshot.title, style: snapshot.style, lyrics: snapshot.lyrics, seed });
    currentDraft.fingerprint = blueprint.fingerprint; return blueprint;
  }

  function resetPlayButton(button = activePlayButton) {
    if (!button) return;
    button.textContent = button.id === "playSongBtn" ? (currentDraft.preview && !currentDraft.stale ? "▶ 播放全曲试听" : `生成全曲试听 · ${PREVIEW_COST} 音符`) : "▶ 播放完整版";
    button.setAttribute("aria-pressed", "false");
  }

  function stopSongPlayback() {
    if (globalPlayerLocal) { stopLocalGlobalPlayback(); globalPlayerPlaying = false; syncGlobalPlayerButtons(); }
    else FocusBeatMusic.stop();
    if (activeHtmlAudio) { activeHtmlAudio.pause(); activeHtmlAudio.src = ""; activeHtmlAudio = null; }
    if (currentDraft.preview?.localAudioId) window.FocusBeatAudioStore?.release(currentDraft.preview.localAudioId);
    previewAudio = null; lyricReview.loopLine = false;
    const loopButton = $("#reviewLoopBtn"); if (loopButton) { loopButton.textContent = "↻ 循环当前行：关"; loopButton.setAttribute("aria-pressed", "false"); }
    resetPlayButton(); activePlayButton = null;
    $(".track-panel")?.classList.remove("playing");
  }

  function stopLocalGlobalPlayback() {
    const local = globalPlayerLocal;
    globalPlayerLocal = null;
    if (local?.timerId) clearInterval(local.timerId);
    FocusBeatMusic.stop();
    if (local?.song?.localAudioId) window.FocusBeatAudioStore?.release(local.song.localAudioId);
  }

  function isLocalFallback(song) {
    return Boolean(song?.localFallback || song?.mode === "local-fallback" || song?.provider === "browser-synth");
  }

  function buildLyricTimeline(song) {
    const aligned = song?.alignment?.lines;
    if (Array.isArray(aligned) && aligned.length && aligned.every(line => Array.isArray(line.syllables))) {
      return aligned.map(line => {
        const chars = line.syllables.map(item => ({ char: String(item.text || ""), start: Number(item.startMs || 0) / 1000, end: Number(item.endMs || item.startMs || 0) / 1000 }));
        return { text: line.text || chars.map(item => item.char).join(""), chars, section: line.section || "", start: chars[0]?.start || 0, end: chars.at(-1)?.end || chars[0]?.start || 0, target: chars.length, beats: 0, timed: true, estimated: false };
      }).filter(line => line.chars.length && line.end > line.start);
    }
    const entries = []; const rawLines = String(song?.lyrics || "").split(/\r?\n/); let section = ""; const positions = { verse: 0, chorus: 0, bridge: 0, outro: 0 };
    rawLines.forEach((raw, rawIndex) => {
      const value = raw.trim(); if (!value) return;
      if (FocusBeatMelodyGuide.isHeader(value)) { section = value; return; }
      const chars = Array.from(value.replace(/[\s，。！？、；：,.!?~～—-]/g, "")); if (!chars.length) return;
      const kind = FocusBeatMelodyGuide.sectionKind(section); const plan = song?.compositionPlan || song?.melodyGuide?.compositionPlan || null;
      const phrases = Array.isArray(plan?.sections?.[kind]) ? plan.sections[kind] : [];
      const phrase = phrases[Math.min(positions[kind], Math.max(0, phrases.length - 1))]; positions[kind] += 1;
      entries.push({ text: value, chars, section, target: Number(phrase?.syllableSlots?.length) || chars.length, beats: Math.max(1, Number(phrase?.durationBeats) || Math.max(4, Math.ceil(chars.length / 2) * 2)) });
    });
    // 音乐接口不一定返回歌词时间戳。为了不再出现“同步功能消失”，
    // 按生成前的曲调节拍和真实音频总时长安排逐行高亮；这是可见的估算同步，
    // 不伪造逐字/逐音节的真实时间戳。
    const duration = Math.max(8, Number(song?.duration) || 60); const leadIn = Math.min(4, Math.max(.8, duration * .055)); const tail = Math.min(3, Math.max(.6, duration * .04));
    const totalBeats = entries.reduce((sum, line) => sum + line.beats, 0) || 1; const playable = Math.max(2, duration - leadIn - tail); let cursor = leadIn;
    return entries.map(line => {
      const span = playable * line.beats / totalBeats; const start = cursor; const end = Math.min(duration - tail, cursor + span); cursor = end;
      return { ...line, chars: line.chars.map(char => ({ char, start: null, end: null })), start, end, timed: true, estimated: true };
    });
  }

  function renderSyncedLyrics(song) {
    const timeline = buildLyricTimeline(song);
    if (globalPlayerSong?.id === song?.id) globalPlayerTimeline = timeline;
    const html = []; let lastSection = null;
    timeline.forEach((line, index) => {
      if (line.section && line.section !== lastSection) { html.push(`<div class="synced-section">${escapeHtml(line.section)}</div>`); lastSection = line.section; }
      html.push(`<div class="synced-lyric-line${line.estimated ? " is-estimated" : ""}" data-timeline-index="${index}">${line.chars.map((char, charIndex) => `<span class="lyric-synced-char" data-char-index="${charIndex}">${escapeHtml(char.char)}</span>`).join("")}</div>`);
    });
    return html.join("");
  }

  function formatPlaybackTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0); const minutes = Math.floor(value / 60); const rest = Math.floor(value % 60);
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function activePlaybackDuration() {
    const mediaDuration = Number(globalPlayerAudio?.duration);
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
    if (globalPlayerLocal) return Math.max(0, Number(globalPlayerLocal.duration) || 0);
    return Math.max(0, Number(globalPlayerSong?.duration) || 0);
  }

  function setProgressControl(prefix, current, duration, enabled) {
    const range = $(`#${prefix}Seek`); const currentLabel = $(`#${prefix}Current`); const durationLabel = $(`#${prefix}Duration`); if (!range || !currentLabel || !durationLabel) return;
    const safeDuration = Math.max(0, Number(duration) || 0); const safeCurrent = Math.min(safeDuration || Infinity, Math.max(0, Number(current) || 0));
    range.max = String(safeDuration || 0); range.value = String(safeCurrent); range.disabled = !enabled || safeDuration <= 0;
    range.style.setProperty("--seek-progress", `${safeDuration ? Math.min(100, safeCurrent / safeDuration * 100) : 0}%`);
    currentLabel.textContent = formatPlaybackTime(safeCurrent); currentLabel.dateTime = `PT${Math.floor(safeCurrent)}S`;
    durationLabel.textContent = safeDuration ? formatPlaybackTime(safeDuration) : "--:--"; durationLabel.dateTime = safeDuration ? `PT${Math.floor(safeDuration)}S` : "PT0S";
  }

  function syncPlayerProgress() {
    const current = globalPlayerLocal ? Number(globalPlayerLocal.elapsed) || 0 : Number(globalPlayerAudio?.currentTime) || 0; const duration = activePlaybackDuration(); const active = Boolean(globalPlayerAudio && globalPlayerSong);
    setProgressControl("globalPlayer", current, duration, active);
    const detailSong = state.songs.find(item => item.id === selectedSongId); const detailMatches = Boolean(active && detailSong?.id === globalPlayerSong?.id);
    setProgressControl("detailPlayer", detailMatches ? current : 0, detailMatches ? duration : Number(detailSong?.duration) || 0, detailMatches);
  }

  function seekGlobalPlayer(value) {
    if (!globalPlayerAudio || !globalPlayerSong) return false;
    const duration = activePlaybackDuration(); const target = Math.min(duration, Math.max(0, Number(value) || 0));
    try { globalPlayerAudio.currentTime = target; updateGlobalPlayer(); return true; }
    catch (_) { return false; }
  }

  function bindPlayerSeek(selector) {
    const range = $(selector); if (!range) return;
    range.addEventListener("input", event => { seekGlobalPlayer(event.currentTarget.value); });
    range.addEventListener("change", event => { if (!seekGlobalPlayer(event.currentTarget.value)) showToast("音频尚未加载完成，暂时不能跳转", "error"); });
  }

  function updateGlobalPlayer() {
    if ((!globalPlayerAudio && !globalPlayerLocal) || !globalPlayerSong) { syncPlayerProgress(); return; }
    const time = globalPlayerLocal ? Number(globalPlayerLocal.elapsed) || 0 : Number(globalPlayerAudio.currentTime) || 0;
    let active = -1;
    globalPlayerTimeline.forEach((line, index) => {
      const node = selectedSongId === globalPlayerSong.id ? $(`#songDetailLyrics .synced-lyric-line[data-timeline-index="${index}"]`) : null;
      if (node) {
        node.classList.toggle("is-current", line.timed && time >= line.start && time < line.end);
        node.querySelectorAll(".lyric-synced-char").forEach((charNode, charIndex) => {
          charNode.classList.toggle("is-sung", line.timed && !line.estimated && time >= line.chars[charIndex].end);
          charNode.classList.toggle("is-current", line.timed && !line.estimated && time >= line.chars[charIndex].start && time < line.chars[charIndex].end);
        });
      }
      if (line.timed && time >= line.start && time < line.end) active = index;
    });
    const line = globalPlayerTimeline[active]; $("#globalPlayerLyric").textContent = line ? `♪ ${line.text}` : "♪ 正在播放";
    if (active !== globalPlayerActiveLine) {
      globalPlayerActiveLine = active; const node = active >= 0 && selectedSongId === globalPlayerSong.id ? $(`#songDetailLyrics .synced-lyric-line[data-timeline-index="${active}"]`) : null; const container = $("#songDetailLyrics");
      if (node && container && $("#songDetailModal")?.classList.contains("is-open")) container.scrollTo({ top: Math.max(0, node.offsetTop - container.offsetTop - container.clientHeight * .38), behavior: window.FocusBeatThemes?.reduced?.() ? "auto" : "smooth" });
    }
    syncPlayerProgress();
  }

  function syncGlobalPlayerButtons() {
    const playing = Boolean((globalPlayerAudio || globalPlayerLocal) && globalPlayerPlaying);
    $("#globalPlayerToggle").textContent = playing ? "Ⅱ 暂停" : "▶ 继续";
    $("#globalPlayerToggle").setAttribute("aria-pressed", String(playing));
    const detailPlaying = playing && globalPlayerSong?.id === selectedSongId;
    $("#playDetailSongBtn").textContent = detailPlaying ? "Ⅱ 暂停播放" : globalPlayerSong?.id === selectedSongId ? "▶ 继续播放" : "▶ 播放完整版";
    $("#playDetailSongBtn").setAttribute("aria-pressed", String(detailPlaying));
    const canSkip = collectionQueue.filter(item => (item?.localAudioId || item?.audioUrl || isLocalFallback(item)) && !collectionFailedIds.has(item.id)).length > 1;
    $("#globalPlayerPrev").disabled = !canSkip; $("#globalPlayerNext").disabled = !canSkip;
    syncPlayerProgress();
  }

  function setupPlayerModeControl() {
    const actions = $(".global-player-actions"); if (!actions || $("#globalPlayerMode")) return;
    const select = document.createElement("select"); select.id = "globalPlayerMode"; select.className = "global-player-mode"; select.setAttribute("aria-label", "播放模式");
    [["sequence", "顺序播放"], ["repeat-one", "单曲循环"], ["reverse", "倒序播放"], ["shuffle", "随机播放"]].forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option); });
    select.value = collectionPlayMode; select.addEventListener("change", () => { collectionPlayMode = select.value; }); actions.prepend(select);
  }

  function prepareCollectionQueue(song) {
    collectionQueue = state.songs.filter(item => item?.localAudioId || item?.audioUrl || isLocalFallback(item)); collectionFailedIds = new Set(); collectionQueueIndex = collectionQueue.findIndex(item => item.id === song?.id); if (collectionQueueIndex < 0) { collectionQueue.unshift(song); collectionQueueIndex = 0; }
  }

  async function playNextCollectionSong() {
    if (!globalPlayerSong || !collectionQueue.length) return false;
    if (collectionPlayMode === "repeat-one" && !collectionFailedIds.has(globalPlayerSong.id)) {
      if (isLocalFallback(globalPlayerSong)) return startGlobalPlayer(globalPlayerSong, { openDetail: false, restart: true });
      globalPlayerAudio.currentTime = 0; try { await globalPlayerAudio.play(); globalPlayerPlaying = true; } catch (_) { return false; } syncGlobalPlayerButtons(); updateGlobalPlayer(); return true;
    }
    if (collectionPlayMode === "shuffle") {
      const candidates = collectionQueue.filter(item => item.id !== globalPlayerSong.id && !collectionFailedIds.has(item.id)); if (!candidates.length) return false;
      const next = candidates[Math.floor(Math.random() * candidates.length)]; collectionQueueIndex = collectionQueue.findIndex(item => item.id === next.id); return startGlobalPlayer(next, { openDetail: false });
    }
    const delta = collectionPlayMode === "reverse" ? -1 : 1; return playNextCollectionSongByIndex(collectionQueueIndex + delta);
  }

  async function playNextCollectionSongByIndex(index, step = collectionPlayMode === "reverse" ? -1 : 1) {
    while (index >= 0 && index < collectionQueue.length && collectionFailedIds.has(collectionQueue[index].id)) index += step;
    if (index < 0 || index >= collectionQueue.length) { globalPlayerPlaying = false; syncGlobalPlayerButtons(); return false; }
    collectionQueueIndex = index; return startGlobalPlayer(collectionQueue[index], { openDetail: false });
  }

  async function playAdjacentCollectionSong(direction) {
    if (!globalPlayerSong || !collectionQueue.length) return false;
    if (collectionPlayMode === "shuffle") {
      const candidates = collectionQueue.filter(item => item.id !== globalPlayerSong.id && !collectionFailedIds.has(item.id)); if (!candidates.length) return false;
      const song = candidates[Math.floor(Math.random() * candidates.length)]; collectionQueueIndex = collectionQueue.findIndex(item => item.id === song.id); return startGlobalPlayer(song, { openDetail: false });
    }
    const order = collectionPlayMode === "reverse" ? -1 : 1; const step = direction * order; const index = collectionQueueIndex + step;
    return playNextCollectionSongByIndex(index, step);
  }

  async function startLocalGlobalPlayer(song, { openDetail = true, restart = false } = {}) {
    if (!song?.blueprint) { showToast("本地电子拟唱缺少曲调蓝图，请重新生成", "error"); return false; }
    if (!restart && globalPlayerSong?.id === song.id && globalPlayerLocal) {
      stopLocalGlobalPlayback(); globalPlayerPlaying = false; syncGlobalPlayerButtons(); updateGlobalPlayer(); return true;
    }
    const previousAudio = globalPlayerAudio; const previousSong = globalPlayerSong;
    globalPlayerAudio = null;
    if (previousAudio) { previousAudio.pause(); previousAudio.src = ""; }
    stopLocalGlobalPlayback();
    if (previousSong?.localAudioId) window.FocusBeatAudioStore?.release(previousSong.localAudioId);
    if (!collectionQueue.length || !collectionQueue.some(item => item.id === song.id)) prepareCollectionQueue(song); else collectionQueueIndex = collectionQueue.findIndex(item => item.id === song.id);
    selectedSongId = song.id; globalPlayerSong = song; globalPlayerTimeline = buildLyricTimeline(song); globalPlayerActiveLine = -1;
    $("#globalPlayerTitle").textContent = song.name; $("#globalSongPlayer").hidden = false;
    if (openDetail) openModal("songDetail"); else if ($("#songDetailModal").classList.contains("is-open")) renderSongDetail();
    const duration = Math.max(3, Number(song.duration || song.blueprint.duration) || 60);
    const local = { song, duration, elapsed: 0, startedAt: performance.now(), timerId: null };
    globalPlayerLocal = local; globalPlayerPlaying = true;
    const finish = () => {
      if (globalPlayerLocal !== local) return;
      if (local.timerId) clearInterval(local.timerId); local.timerId = null; local.elapsed = duration; globalPlayerPlaying = false; updateGlobalPlayer();
      globalPlayerLocal = null; syncGlobalPlayerButtons(); void playNextCollectionSong();
    };
    local.timerId = setInterval(() => {
      if (globalPlayerLocal !== local || !globalPlayerPlaying) return;
      local.elapsed = Math.min(duration, (performance.now() - local.startedAt) / 1000);
      updateGlobalPlayer();
      if (local.elapsed >= duration) finish();
    }, 100);
    try {
      await FocusBeatMusic.play(song.blueprint, { fraction: 1, vocal: true, onLyric: () => updateGlobalPlayer(), onState: stateName => { if (stateName === "ended") finish(); } });
    } catch (error) {
      if (globalPlayerLocal === local) { stopLocalGlobalPlayback(); globalPlayerPlaying = false; syncGlobalPlayerButtons(); }
      showToast(error.message || "本地电子拟唱启动失败，请检查浏览器音频权限", "error"); return false;
    }
    renderSongDetail(); syncGlobalPlayerButtons(); updateGlobalPlayer(); return true;
  }

  async function startGlobalPlayer(song, { openDetail = true, restart = false } = {}) {
    if (!song?.localAudioId && !song?.audioUrl && !isLocalFallback(song)) { showToast("完整歌曲音频不可用，请重新生成并收藏", "error"); return false; }
    if (isLocalFallback(song)) return startLocalGlobalPlayer(song, { openDetail, restart });
    if (globalPlayerSong?.id === song.id && globalPlayerAudio) {
      if (!globalPlayerPlaying) { try { await globalPlayerAudio.play(); globalPlayerPlaying = true; } catch (error) { if (error?.name !== "AbortError") showToast("歌曲暂时无法播放，请稍后再试", "error"); } } else { globalPlayerAudio.pause(); globalPlayerPlaying = false; }
      syncGlobalPlayerButtons(); return true;
    }
    const previousAudio = globalPlayerAudio; const previousSong = globalPlayerSong; globalPlayerAudio = null; stopLocalGlobalPlayback();
    if (previousAudio) { previousAudio.pause(); previousAudio.src = ""; }
    if (previousSong?.localAudioId) window.FocusBeatAudioStore?.release(previousSong.localAudioId);
    if (!collectionQueue.length || !collectionQueue.some(item => item.id === song.id)) prepareCollectionQueue(song); else collectionQueueIndex = collectionQueue.findIndex(item => item.id === song.id);
    globalPlayerSong = song; globalPlayerTimeline = buildLyricTimeline(song); globalPlayerActiveLine = -1;
    $("#globalPlayerTitle").textContent = song.name; $("#globalSongPlayer").hidden = false;
    let source;
    try { source = await localAudioSource(song); } catch (error) { showToast(error.message || "歌曲暂时无法播放", "error"); return false; }
    const audio = new Audio(source); globalPlayerAudio = audio;
    selectedSongId = song.id;
    if (openDetail) openModal("songDetail"); else if ($("#songDetailModal").classList.contains("is-open")) renderSongDetail();
    audio.addEventListener("loadedmetadata", () => { if (globalPlayerAudio !== audio) return; if (Number.isFinite(audio.duration) && audio.duration > 1) { globalPlayerSong.duration = audio.duration; globalPlayerTimeline = buildLyricTimeline(globalPlayerSong); renderSongDetail(); } });
    audio.addEventListener("timeupdate", () => { if (globalPlayerAudio === audio) updateGlobalPlayer(); });
    audio.addEventListener("play", () => { if (globalPlayerAudio !== audio) return; globalPlayerPlaying = true; syncGlobalPlayerButtons(); });
    audio.addEventListener("pause", () => { if (globalPlayerAudio !== audio) return; globalPlayerPlaying = false; syncGlobalPlayerButtons(); });
    audio.addEventListener("ended", () => { if (globalPlayerAudio !== audio) return; globalPlayerPlaying = false; syncGlobalPlayerButtons(); updateGlobalPlayer(); void playNextCollectionSong(); });
    audio.addEventListener("error", () => { if (globalPlayerAudio !== audio) return; collectionFailedIds.add(song.id); globalPlayerPlaying = false; syncGlobalPlayerButtons(); void playNextCollectionSong().then(moved => { if (!moved && globalPlayerAudio === audio) { closeGlobalPlayer(); showToast("收藏中没有可继续播放的有效歌曲", "error"); } }); }, { once: true });
    renderSongDetail();
    try { await audio.play(); if (globalPlayerAudio === audio) globalPlayerPlaying = true; }
    catch (error) { if (globalPlayerAudio === audio && error?.name !== "AbortError") { globalPlayerPlaying = false; showToast("歌曲暂时无法播放，请检查音频服务", "error"); } }
    syncGlobalPlayerButtons(); updateGlobalPlayer();
    return globalPlayerAudio === audio;
  }

  function closeGlobalPlayer() {
    const audio = globalPlayerAudio; const song = globalPlayerSong; globalPlayerAudio = null; stopLocalGlobalPlayback(); if (audio) { audio.pause(); audio.src = ""; }
    if (song?.localAudioId) window.FocusBeatAudioStore?.release(song.localAudioId);
    globalPlayerSong = null; globalPlayerTimeline = []; globalPlayerPlaying = false; globalPlayerActiveLine = -1; collectionQueue = []; collectionQueueIndex = -1; collectionFailedIds = new Set();
    $("#globalSongPlayer").hidden = true; $("#globalPlayerLyric").textContent = ""; syncGlobalPlayerButtons();
  }

  function renderPreviewLyrics() {
    const panel = $("#previewLyrics"); if (!panel) return;
    const preview = currentDraft.preview; if (!preview) { panel.innerHTML = "<span class=\"preview-lyrics-empty\">生成试听后显示歌词</span>"; previewTimeline = []; renderLyricAudit(); return; }
    const duration = Number(preview.duration) || 30;
    previewTimeline = buildLyricTimeline({ lyrics: preview.previewLyrics || preview.lyrics || $("#lyrics").value, alignment: preview.alignment || null, compositionPlan: preview.compositionPlan || preview.melodyGuide?.compositionPlan || null, melodyGuide: preview.melodyGuide || null, duration }).filter(line => !line.timed || line.start < duration);
    const estimated = previewTimeline.some(line => line.estimated); panel.innerHTML = `${estimated ? `<small class="preview-lyrics-note">估算逐行同步（${escapeHtml(musicProviderName(currentDraft.preview?.provider))} 未返回字级时间轴）</small>` : ""}${previewTimeline.map((line, index) => `<div class="preview-lyrics-line${line.estimated ? " is-estimated" : ""}" data-preview-index="${index}">${escapeHtml(line.text)}</div>`).join("")}`; updatePreviewLyric(0); renderLyricAudit();
  }

  function updatePreviewLyric(time = Number(previewAudio?.currentTime) || 0) {
    const panel = $("#previewLyrics"); if (!panel) return; let active = -1;
    if (lyricReview.loopLine && previewAudio && lyricReview.selectedLine >= 0) {
      const loop = fullPreviewTimeline()[lyricReview.selectedLine];
      if (loop && time >= Math.max(loop.start + .15, loop.end - .03)) { previewAudio.currentTime = loop.start; void previewAudio.play().catch(() => {}); time = loop.start; }
    }
    previewTimeline.forEach((line, index) => { const node = panel.querySelector(`[data-preview-index="${index}"]`); if (!node) return; const current = line.timed && time >= line.start && time < line.end; node.classList.toggle("is-current", current); if (current) active = index; });
    const activeNode = active >= 0 ? panel.querySelector(`[data-preview-index="${active}"]`) : null; activeNode?.scrollIntoView({ block: "nearest" });
  }

  async function playSongAsset(asset, blueprint, button, full) {
    if (full) { await startGlobalPlayer(asset); return; }
    const alreadyPlaying = activePlayButton === button && (FocusBeatMusic.isPlaying() || activeHtmlAudio);
    if (alreadyPlaying) { stopSongPlayback(); return; }
    stopSongPlayback(); activePlayButton = button; button.textContent = "■ 停止播放"; button.setAttribute("aria-pressed", "true"); $(".track-panel")?.classList.add("playing");
    if (isLocalFallback(asset)) {
      try {
        await FocusBeatMusic.play(blueprint, { fraction: 1, vocal: true, onLyric: line => {
          const match = previewTimeline.findIndex(item => item.text === line);
          if (match >= 0) updatePreviewLyric(previewTimeline[match].start);
        }, onState: stateName => {
          if (stateName !== "ended" || activePlayButton !== button) return;
          resetPlayButton(button); activePlayButton = null; $(".track-panel")?.classList.remove("playing"); updatePreviewLyric(0);
        } });
      } catch (error) { stopSongPlayback(); showToast(error.message || "本地电子拟唱启动失败，请检查浏览器音频权限", "error"); }
      return;
    }
    try {
      const audio = new Audio(await localAudioSource(asset)); activeHtmlAudio = audio; previewAudio = audio;
      audio.addEventListener("loadedmetadata", () => { if (Number.isFinite(audio.duration) && audio.duration > 1) { asset.duration = audio.duration; renderPreviewLyrics(); } }); audio.addEventListener("timeupdate", () => updatePreviewLyric());
      audio.addEventListener("ended", () => { resetPlayButton(button); activePlayButton = null; activeHtmlAudio = null; previewAudio = null; if (asset?.localAudioId) window.FocusBeatAudioStore?.release(asset.localAudioId); $(".track-panel")?.classList.remove("playing"); updatePreviewLyric(0); }, { once: true });
      audio.addEventListener("error", () => { stopSongPlayback(); showToast("音频地址已失效或试听权限已过期，请重新生成", "error"); }, { once: true });
      await audio.play();
    } catch (error) { stopSongPlayback(); showToast(error.message || "音频启动失败，请检查浏览器声音设置", "error"); }
  }

  async function previewCurrentSong() {
    if (currentDraft.preview?.pending) { showToast(`${musicProviderName(currentDraft.preview.provider)} 真唱任务仍在云端创作，请稍候`, "error"); return; }
    if (!currentDraft.preview || currentDraft.stale) { await generatePreview(false); return; }
    const fit = FocusBeatMelodyGuide.analyze($("#lyrics").value, guideFor(currentDraft.seed));
    if (fit.issues && currentDraft.warningAcknowledgedJobId !== currentDraft.preview.jobId) {
      previewWarningPending = true; $("#previewWarningCopy").textContent = "歌词不符合曲调旋律，可能影响效果，建议修改。当前歌词中存在灰体字或 ☆ 标记；你可以返回修改，也可以继续试听。"; openModal("previewWarning"); return;
    }
    playSongAsset(currentDraft.preview, currentDraft.preview.blueprint, $("#playSongBtn"), false);
  }

  async function saveSong() {
    if (currentDraft.preview?.pending) { showToast("真唱任务尚未完成，暂时不能收藏", "error"); return; }
    if (!currentDraft.preview || currentDraft.stale) { showToast("请先生成当前歌词和曲调的试听", "error"); return; }
    const snapshot = songSnapshot(); if (!validateSongSnapshot(snapshot)) return;
    const fallback = isLocalFallback(currentDraft.preview);
    if (fallback && !confirm("真人歌曲服务暂时不可用。确定要保存这首本地电子拟唱版吗？保存后不会自动变成真人演唱版。")) return;
    await chargedMusicAction($("#saveSongBtn"), "正在收藏到本设备…", SONG_COST, async () => {
      const localAudioId = currentDraft.preview.localAudioId || "";
      if (!fallback) {
        if (!localAudioId || !window.FocusBeatAudioStore?.supported?.()) throw new Error("试听尚未保存到本设备，请重新生成试听");
        await window.FocusBeatAudioStore.promote(localAudioId);
      }
      const blueprint = buildCurrentBlueprint(); if (!blueprint) throw new Error("歌曲蓝图无效");
      const fullDuration = Number(currentDraft.preview.duration || 60); const savedPlan = currentDraft.compositionPlan || currentDraft.melodyGuide?.compositionPlan || null; const alignment = currentDraft.preview.manualLyricsConfirmed ? currentDraft.preview.alignment || null : currentDraft.preview.alignment || null;
      const song = { id: uid("song"), name: blueprint.title, style: blueprint.style, lyrics: snapshot.lyrics, seed: currentDraft.preview.seed, duration: fullDuration, blueprint, melodyGuide: currentDraft.melodyGuide, compositionPlan: savedPlan, alignment, previewJobId: currentDraft.preview.jobId, previewAccessToken: currentDraft.preview.accessToken, fullJobId: currentDraft.preview.jobId, audioUrl: "", localAudioId, accessToken: "", storageKey: "", provider: currentDraft.preview.provider || (fallback ? "browser-synth" : "treblo"), mode: fallback ? "local-fallback" : currentDraft.preview.mode, localFallback: fallback, unlocked: true, createdAt: new Date().toISOString() };
      const previousSongs = state.songs; state.songs = [song, ...state.songs].slice(0, 100);
      if (!saveState()) { state.songs = previousSongs; throw new Error("浏览器未能保存歌曲"); }
      currentDraft.savedFingerprint = blueprint.fingerprint; currentDraft.completed = true; renderDashboard();
      $("#previewRuleText").textContent = "完整歌曲已收藏到本设备";
      showToast("试听对应的同一首歌曲已收藏到本设备");
    });
  }

  function renderSongs() {
    const list = $("#songList");
    if (!state.songs.length) { list.innerHTML = `<div class="empty">收藏还是空的。先用 ${PREVIEW_COST} 音符临时试听全曲，满意后再用 ${SONG_COST} 音符收藏到本设备。</div>`; return; }
    list.innerHTML = state.songs.map(song => { const providerLabel = isLocalFallback(song) ? "本地电子拟唱版" : song.provider === "demo" ? "演示音频" : song.provider; return `<article class="song-card"><button class="song-card-open" data-open-song="${escapeHtml(song.id)}" type="button" aria-label="查看《${escapeHtml(song.name)}》完整歌曲"><small>${escapeHtml(styleNames[song.style] || song.style)} · ${escapeHtml(providerLabel)}</small><h3>${escapeHtml(song.name)}</h3><p>${escapeHtml(formatDate(song.createdAt))} · ${escapeHtml(providerLabel)} · 蓝图 ${escapeHtml(song.blueprint?.fingerprint || "已迁移")}</p><p class="song-preview">${escapeHtml(song.lyrics)}</p></button><div class="song-actions"><button class="button secondary" data-play-song="${escapeHtml(song.id)}" type="button" aria-pressed="false">▶ 播放完整版</button><button class="button ghost" data-open-song="${escapeHtml(song.id)}" type="button">查看歌词</button><button class="button danger" data-delete-song="${escapeHtml(song.id)}" type="button">删除</button></div></article>`; }).join("");
  }

  function openSongDetail(id, trigger) {
    selectedSongId = id; openModal("songDetail", trigger);
  }

  function renderSongDetail() {
    const song = state.songs.find(item => item.id === selectedSongId);
    if (!song) { $("#songDetailTitle").textContent = "歌曲不存在"; $("#songDetailLyrics").textContent = "这首歌曲可能已经被删除。"; return; }
    $("#songDetailTitle").textContent = song.name;
    const providerLabel = isLocalFallback(song) ? "本地电子拟唱" : musicProviderName(song.provider);
    $("#songDetailMeta").textContent = `${styleNames[song.style] || song.style} · ${formatDate(song.createdAt)} · ${providerLabel}${isLocalFallback(song) ? " · 浏览器实时合成" : ` 真唱${song.alignment ? " · 真实歌词时间轴" : " · 估算逐行同步"}`}`;
    $("#songDetailLyrics").innerHTML = renderSyncedLyrics(song);
    globalPlayerActiveLine = -1; syncGlobalPlayerButtons(); updateGlobalPlayer();
  }

  function deleteSong(id) {
    if (!confirm("确定删除这首歌曲吗？已经消耗的音符不会返还。")) return;
    const song = state.songs.find(item => item.id === id); stopSongPlayback(); if (globalPlayerSong?.id === id) closeGlobalPlayer(); state.songs = state.songs.filter(item => item.id !== id); saveState(); renderSongs();
    if (song?.localAudioId) void window.FocusBeatAudioStore?.remove(song.localAudioId);
    showToast("歌曲已从收藏中删除");
  }

  // 周计划与总结
  async function generateWeekly() {
    await runButton($("#generateWeeklyBtn"), "安排中…", async () => {
      const result = await FocusBeatAI.request("weekly", { goal: $("#weeklyGoal").value.trim() }); updateAiMode(result.mode, result.reason);
      state.weekly = { ...result.data, weekKey: weekKey() }; saveState(); renderWeekly(); showToast("本周学习节奏已生成");
    });
  }

  function renderWeekly() {
    const days = state.weekly?.days || FocusBeatAI.local.weekly({}).days;
    if (state.weekly?.goal) $("#weeklyGoal").value = state.weekly.goal;
    const dayIndex = (new Date().getDay() + 6) % 7;
    $("#weekGrid").innerHTML = days.map((item, index) => `<article class="day-card ${index === dayIndex ? "today" : ""}"><strong>${escapeHtml(item.day)}</strong><small>${index === dayIndex ? "今天" : `第 ${index + 1} 拍`}</small><p>${escapeHtml(item.task)}</p></article>`).join("");
  }

  async function renderSummary(force = false) {
    const button = $("#refreshSummaryBtn"); if (force) button.disabled = true;
    try {
      const result = await FocusBeatAI.request("summary", { focus: state.day.focus, sessions: state.day.sessions, mistakes: state.day.mistakeIds.length, notes: state.day.notes });
      updateAiMode(result.mode, result.reason); $("#summaryKeyword").textContent = result.data.keyword; $("#summaryCopy").textContent = result.data.copy;
    } finally { button.disabled = false; }
  }

  function initWaveform() {
    $("#waveform").innerHTML = Array.from({ length: 38 }, (_, index) => `<i style="height:${12 + (index * 17 % 30)}px"></i>`).join("");
  }

  function bindEvents() {
    $$('[data-open]').forEach(button => button.addEventListener("click", () => openModal(button.dataset.open, button)));
    $("#openPlanBtn").addEventListener("click", event => openModal("plan", event.currentTarget));
    $("#featurePlanBtn").addEventListener("click", event => openModal("plan", event.currentTarget));
    $("#openSongsTop").addEventListener("click", event => openModal("songs", event.currentTarget));
    $$("[data-close]").forEach(button => button.addEventListener("click", () => closeModal(button.closest(".modal"))));
    $$(".modal").forEach(modal => {
      modal.addEventListener("mousedown", event => { if (event.target === modal) closeModal(modal); });
      modal.addEventListener("keydown", event => {
        if (event.key === "Escape") return closeModal(modal);
        if (event.key !== "Tab") return;
        const items = focusable(modal); if (!items.length) return;
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    });
    $("#planPreset").addEventListener("change", applyPreset); $("#generatePlanBtn").addEventListener("click", generatePlan); $("#startPlanBtn").addEventListener("click", startPlan);
    $("#pauseFocusBtn").addEventListener("click", togglePause); $("#skipFocusBtn").addEventListener("click", advanceTimer); $("#endFocusBtn").addEventListener("click", endFocus);
    $("#focusOverlay").addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const items = focusable($("#focusOverlay")); if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    $("#saveMistakeBtn").addEventListener("click", saveMistake); $("#mistakeList").addEventListener("click", event => { const button = event.target.closest("[data-delete-mistake]"); if (button) deleteMistake(button.dataset.deleteMistake); });
    $("#newQuizBtn").addEventListener("click", generateQuiz); $("#quizSubject").addEventListener("change", () => { quizPrefetch = null; generateQuiz(); }); $("#submitQuizBtn").addEventListener("click", submitQuiz); $("#quizAnswer").addEventListener("keydown", event => { if (event.key === "Enter") submitQuiz(); });
    $("#generateLyricsBtn").addEventListener("click", generateLyrics); $("#polishLyricsBtn").addEventListener("click", polishLyrics);
    $("#regenerateTuneBtn").addEventListener("click", changeTune);
    $("#continuePreviewBtn").addEventListener("click", () => { currentDraft.warningAcknowledgedJobId = currentDraft.preview?.jobId || ""; previewWarningPending = false; closeModal($("#previewWarningModal"), false); playSongAsset(currentDraft.preview, currentDraft.preview.blueprint, $("#playSongBtn"), false); });
    $("#cancelPreviewBtn").addEventListener("click", () => { previewWarningPending = false; closeModal($("#previewWarningModal"), false); $("#lyrics").focus(); });
    $("#songName").addEventListener("input", invalidateDraft); $("#songTopic").addEventListener("input", invalidateDraft); $("#songStyle").addEventListener("change", () => { currentDraft.melodyGuide = FocusBeatMelodyGuide.create({ style: $("#songStyle").value, seed: currentDraft.seed || Date.now() }); currentDraft.compositionPlan = currentDraft.melodyGuide.compositionPlan; invalidateDraft(); }); $("#lyrics").addEventListener("input", () => { invalidateDraft(); renderLyricFit(); });
    $("#playSongBtn").addEventListener("click", previewCurrentSong); $("#saveSongBtn").addEventListener("click", saveSong);
    $("#songList").addEventListener("click", event => {
      const play = event.target.closest("[data-play-song]");
      if (play) { const song = state.songs.find(item => item.id === play.dataset.playSong); if (song?.blueprint) playSongAsset(song, song.blueprint, play, true); return; }
      const open = event.target.closest("[data-open-song]"); if (open) { openSongDetail(open.dataset.openSong, open); return; }
      const remove = event.target.closest("[data-delete-song]"); if (remove) deleteSong(remove.dataset.deleteSong);
    });
    $("#playDetailSongBtn").addEventListener("click", async () => { const song = state.songs.find(item => item.id === selectedSongId); if (song?.blueprint) await startGlobalPlayer(song); });
    $("#globalPlayerPrev").addEventListener("click", () => { void playAdjacentCollectionSong(-1); });
    $("#globalPlayerNext").addEventListener("click", () => { void playAdjacentCollectionSong(1); });
    $("#globalPlayerLyric").addEventListener("click", event => { if (globalPlayerSong?.id) openSongDetail(globalPlayerSong.id, event.currentTarget); });
    $("#globalPlayerToggle").addEventListener("click", async () => {
      if (globalPlayerLocal && globalPlayerSong) {
        if (globalPlayerPlaying) { stopLocalGlobalPlayback(); globalPlayerPlaying = false; syncGlobalPlayerButtons(); updateGlobalPlayer(); }
        else { await startLocalGlobalPlayer(globalPlayerSong, { openDetail: false, restart: true }); }
        return;
      }
      const audio = globalPlayerAudio; if (!audio) return;
      if (!globalPlayerPlaying) { try { await audio.play(); if (globalPlayerAudio === audio) globalPlayerPlaying = true; } catch (error) { if (globalPlayerAudio === audio && error?.name !== "AbortError") showToast("歌曲暂时无法播放，请稍后再试", "error"); } }
      else { audio.pause(); if (globalPlayerAudio === audio) globalPlayerPlaying = false; }
      syncGlobalPlayerButtons();
    });
    $("#globalPlayerClose").addEventListener("click", closeGlobalPlayer);
    bindPlayerSeek("#globalPlayerSeek"); bindPlayerSeek("#detailPlayerSeek");
    $("#generateWeeklyBtn").addEventListener("click", generateWeekly); $("#refreshSummaryBtn").addEventListener("click", () => renderSummary(true));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.timer?.active) tickTimer(); });
    window.addEventListener("beforeunload", () => {
      saveState();
      if (currentDraft.preview?.jobId && currentDraft.preview?.accessToken && !currentDraft.preview.pending && !currentDraft.savedFingerprint && location.protocol.startsWith("http")) {
        navigator.sendBeacon("/api/music", new Blob([JSON.stringify({ action: "delete", payload: { jobId: currentDraft.preview.jobId, accessToken: currentDraft.preview.accessToken } })], { type: "application/json" }));
      }
    });
  }

  function init() {
    window.FocusBeatThemes?.setup();
    const lyricTools = $(".lyric-editor-tools"); if (lyricTools && $(".studio-controls")) $(".studio-controls").append(lyricTools);
    const melodyTitle = $(".melody-fit-head strong"); if (melodyTitle) melodyTitle.textContent = "曲调和建议";
    $("#lyrics").placeholder = "先生成节奏规划，再按建议音节位生成歌词……";
    $("#regenerateTuneBtn").textContent = "换个歌词和曲调 · 1 音符";
    setupLyricOverlay(); setupPreviewLyricsPanel(); setupLyricAudit(); setupPlayerModeControl(); initWaveform(); bindEvents(); renderDashboard(); renderMistakes(); renderWeekly(); updateStudioMeta(); renderPreviewLyrics(); updateAiMode("local"); updateMusicMode({ mode: "unconfigured", provider: "treblo" }); saveState();
    void window.FocusBeatAudioStore?.cleanup();
    FocusBeatAI.status().then(meta => updateAiMode(meta.mode, meta.reason));
    resumePendingMusic();
    FocusBeatMusicAPI.status().then(updateMusicMode);
    if (state.timer?.active) {
      if (!state.timer.paused) state.timer.remainingMs = Math.max(0, state.timer.endAt - Date.now());
      if (state.timer.remainingMs <= 0) advanceTimer(); else openFocusOverlay();
    }
    window.__focusBeat = { get state() { return state; }, get currentQuiz() { return currentQuiz; }, get currentDraft() { return currentDraft; }, music: FocusBeatMusic.diagnostics, buildCurrentBlueprint, openModal, lyricsAudit: { render: renderLyricAudit, inspect: inspectLyricCoverage } };
    window.FocusBeatAmbience?.setup({ getState: () => state });
  }

  init();
})();
