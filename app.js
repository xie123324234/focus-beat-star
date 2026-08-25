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
  let currentDraft = { seed: 0, version: 0, tuneVersion: 0, fingerprint: "", savedFingerprint: "", preview: null, stale: false, completed: false };
  let currentQuiz = null;
  let quizPrefetch = null;
  let quizPrefetchPromise = null;
  let selectedSongId = null;
  let timerInterval = null;
  let modalReturnTarget = null;
  let activePlayButton = null;
  let lyricsGenerationPending = false;

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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
      mistakes: [], songs: [], weekly: null, timer: null, planSegments: [], streak: 1,
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
      style, lyrics, seed, blueprint, unlocked: item.unlocked !== false,
      previewJobId: text(item.previewJobId, 160), fullJobId: text(item.fullJobId, 160),
      audioUrl: text(item.audioUrl, 2000), storageKey: text(item.storageKey, 300), provider: text(item.provider, 40, "demo"),
      createdAt: text(item.createdAt || item.time, 80, new Date().toISOString()),
    };
  }

  function normalizeState(raw) {
    const base = initialState();
    if (!raw || typeof raw !== "object") return base;
    base.totalNotes = number(raw.totalNotes, base.totalNotes);
    base.streak = number(raw.streak, 1, 1, 9999);
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
    base.weekly = raw.weekly && typeof raw.weekly === "object" && Array.isArray(raw.weekly.days) ? raw.weekly : null;
    if (raw.timer && typeof raw.timer === "object" && raw.timer.active) {
      const timer = raw.timer;
      const phase = timer.phase === "break" ? "break" : "focus";
      const focusMin = number(timer.focusMin, 25, 1, 90); const breakMin = number(timer.breakMin, 5, 1, 30);
      const totalMs = number(timer.totalMs, (phase === "focus" ? focusMin : breakMin) * 60_000, 1_000, 5_400_000);
      base.timer = {
        active: true, paused: Boolean(timer.paused), phase, round: number(timer.round, 0, 0, 5), rounds: number(timer.rounds, 1, 1, 6),
        focusMin, breakMin, subject: text(timer.subject, 80, "今天的学习任务"), totalMs,
        remainingMs: number(timer.remainingMs, totalMs, 0, 5_400_000), endAt: number(timer.endAt, Date.now() + totalMs, 0, Number.MAX_SAFE_INTEGER),
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
    setTimeout(() => toast.remove(), type === "error" ? 12000 : 3200);
  }

  function updateAiMode(mode, reason) {
    const remote = ["remote", "mimo", "agnes"].includes(mode);
    $("#aiChipText").textContent = remote ? "云端文本 AI 已连接" : (reason === "file" ? "请启动 Wrangler 连接文本 AI" : "文本 AI 未连接，使用本地回退");
    $("#songAiStatus").textContent = remote ? "歌词由云端 AI 生成" : (reason === "file" ? "请通过 Wrangler 地址打开，才能连接 Agnes AI" : "歌词使用本地回退；音乐服务状态请看右侧");
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
      $("#songReadyCopy").textContent = "已攒够一次试听和一次完整续写。";
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
    closeAllModals(false);
    modalReturnTarget = trigger;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    $("main").inert = true;
    $(".topbar").inert = true;
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
    if (["songModal", "songsModal", "songDetailModal"].includes(modal.id)) stopSongPlayback();
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (!$(".modal.is-open")) {
      document.body.classList.remove("modal-open");
      $("main").inert = false;
      $(".topbar").inert = false;
      if (restore && modalReturnTarget?.isConnected) modalReturnTarget.focus();
    }
  }

  function closeAllModals(restore = false) { $$(".modal.is-open").forEach(modal => closeModal(modal, restore)); }

  async function runButton(button, busyText, action) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try { return await action(); }
    catch (error) { showToast(error.message || "操作没有完成，请稍后再试", "error"); }
    finally { button.disabled = false; button.textContent = original; }
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
      updateAiMode(result.mode);
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
    state.timer = { active: true, paused: false, phase: "focus", round: 0, ...config, totalMs, remainingMs: totalMs, endAt: Date.now() + totalMs };
    saveState();
    closeAllModals(false);
    openFocusOverlay();
  }

  function openFocusOverlay() {
    const overlay = $("#focusOverlay");
    overlay.classList.add("is-open"); overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open"); $("main").inert = true; $(".topbar").inert = true;
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
    state.totalNotes += earned; state.day.notes += earned; state.day.sessions += 1; state.day.focus += timer.focusMin;
    showToast(`完成一段专注，获得 ${earned} 枚音符`);
  }

  function advanceTimer() {
    const timer = state.timer;
    if (!timer) return;
    if (timer.phase === "focus") {
      rewardFocus(timer);
      if (timer.round >= timer.rounds - 1) {
        state.timer = null; saveState(); renderDashboard(); closeFocusOverlay(); showToast("今日计划完成，做得漂亮！"); return;
      }
      timer.phase = "break"; timer.totalMs = timer.breakMin * 60_000;
    } else {
      timer.phase = "focus"; timer.round += 1; timer.totalMs = timer.focusMin * 60_000;
    }
    timer.paused = false; timer.remainingMs = timer.totalMs; timer.endAt = Date.now() + timer.totalMs;
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
      updateAiMode(result.mode);
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
      .then(result => { if ($("#quizSubject").value === subject) { quizPrefetch = { subject, data: result.data }; updateAiMode(result.mode); } })
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
    const inputNumber = Number(String(input).match(/-?\d+(?:\.\d+)?/)?.[0]);
    return accepted.some(answer => {
      const expectedText = String(answer).trim(); const expectedNumber = Number(expectedText.match(/^-?\d+(?:\.\d+)?/)?.[0]);
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

  // 歌曲创作：本地拟唱的试听与完整播放共享同一份可重建蓝图。
  function updateMusicMode(meta = {}) {
    $("#musicEngineLabel").textContent = "浏览器本地拟唱引擎";
    $("#musicEngineHelp").textContent = "本地伴奏配合浏览器中文语音拟唱；无需音乐 API，不同设备的声音会略有不同。";
  }

  function updateStudioMeta() {
    const name = $("#songName").value.trim() || "未命名歌曲"; const style = $("#songStyle").value;
    const phase = currentDraft.preview && !currentDraft.stale ? `试听第 ${currentDraft.tuneVersion} 版已就绪` : ($("#lyrics").value.trim() ? "等待生成试听" : "等待歌词");
    $("#trackTitle").textContent = name; $("#trackStyle").textContent = `${styleNames[style]} · ${phase}`;
    $("#playSongBtn").textContent = currentDraft.preview && !currentDraft.stale ? "▶ 播放当前试听" : `生成试听 · ${PREVIEW_COST} 音符`;
    $("#previewRuleText").textContent = currentDraft.completed ? "完整歌曲已生成并收藏" : (currentDraft.preview && !currentDraft.stale ? `试听已生成 · 完整续写 ${SONG_COST} 音符` : `试听 ${PREVIEW_COST} 音符 · 完整版 ${SONG_COST} 音符`);
    $("#generateLyricsBtn").hidden = currentDraft.version > 0;
    $("#regenerateLyricsBtn").hidden = currentDraft.version === 0;
    $("#regenerateTuneBtn").hidden = !$("#lyrics").value.trim();
    $("#saveSongBtn").disabled = currentDraft.completed;
    $("#saveSongBtn").textContent = currentDraft.completed ? "✓ 完整拟唱已收藏" : `保存完整拟唱 · ${SONG_COST} 音符`;
  }

  function invalidateDraft() {
    currentDraft.fingerprint = ""; currentDraft.savedFingerprint = ""; currentDraft.completed = false;
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
    ["generateLyricsBtn", "regenerateLyricsBtn", "regenerateTuneBtn", "playSongBtn", "saveSongBtn"].forEach(id => { $("#" + id).disabled = disabled; });
  }

  async function chargedMusicAction(button, busyText, cost, action) {
    if (!debitNotes(cost)) return false;
    const original = button.textContent; setMusicButtonsDisabled(true); button.textContent = busyText;
    try { await action(); return true; }
    catch (error) { refundNotes(cost); showToast(`${error.message || "生成失败"}，${cost} 枚音符已退还`, "error"); return false; }
    finally { setMusicButtonsDisabled(false); button.textContent = original; updateStudioMeta(); }
  }

  function songSnapshot(lyrics = $("#lyrics").value.trim()) {
    return { title: $("#songName").value.trim(), style: $("#songStyle").value, topic: $("#songTopic").value.trim(), lyrics };
  }

  function validateSongSnapshot(snapshot) {
    if (!snapshot.title) { showToast("请先填写歌曲名字", "error"); $("#songName").focus(); return false; }
    if (!snapshot.lyrics) { showToast("请先生成或填写歌词", "error"); $("#lyrics").focus(); return false; }
    return true;
  }

  async function requestPreview(snapshot, seed) {
    const result = await FocusBeatMusicAPI.request("preview", { ...snapshot, seed, previewSeconds: 42, includeChorus: true });
    if (!result.data?.jobId) throw new Error("音乐服务没有返回试听任务");
    const previewSeed = Number(result.data.seed) || seed;
    const blueprint = FocusBeatMusic.createBlueprint({ title: snapshot.title, style: snapshot.style, lyrics: snapshot.lyrics, seed: previewSeed });
    return { ...result.data, seed: previewSeed, blueprint, mode: result.mode, stale: false };
  }

  async function installPreview(preview, previousPreview) {
    currentDraft.preview = preview; currentDraft.seed = preview.seed; currentDraft.fingerprint = preview.blueprint.fingerprint;
    currentDraft.savedFingerprint = ""; currentDraft.stale = false; currentDraft.completed = false; currentDraft.tuneVersion += 1;
    updateMusicMode({ mode: preview.mode, provider: preview.provider }); updateStudioMeta();
    $("#nowLyric").textContent = "本地拟唱试听已就绪：歌词会跟随旋律短句朗读。";
  }

  async function generateLyrics(isVariant = false) {
    if (lyricsGenerationPending) return;
    const name = $("#songName").value.trim();
    if (!name) { showToast("请先填写歌曲名字", "error"); $("#songName").focus(); return; }
    const button = isVariant ? $("#regenerateLyricsBtn") : $("#generateLyricsBtn");
    const conditions = { title: name, style: $("#songStyle").value, topic: $("#songTopic").value.trim() };
    const create = async () => {
      let result; let attempts = 0; let nextLyrics = ""; const previous = $("#lyrics").value.trim();
      do {
        const seed = Date.now() + currentDraft.version * 997 + attempts * 37;
        result = await FocusBeatAI.request("lyrics", { ...conditions, seed, previousLyrics: previous });
        nextLyrics = String(result.data.lyrics || "").trim(); attempts += 1;
      } while (nextLyrics === previous && attempts < 3);
      if (!nextLyrics || nextLyrics === previous) throw new Error("没有生成不同的新歌词，请再试一次");
      if (conditions.title !== $("#songName").value.trim() || conditions.style !== $("#songStyle").value || conditions.topic !== $("#songTopic").value.trim()) throw new Error("创作条件已经变化，请重新操作");
      const seed = Number(result.data.seed) || Date.now();
      if (isVariant) {
        const previousPreview = currentDraft.preview;
        const preview = await requestPreview({ ...conditions, lyrics: nextLyrics }, seed);
        $("#lyrics").value = nextLyrics; await installPreview(preview, previousPreview);
      } else {
        $("#lyrics").value = nextLyrics; currentDraft.seed = seed; currentDraft.stale = Boolean(currentDraft.preview); updateStudioMeta();
      }
      currentDraft.version += 1;
      $("#lyricsVersion").textContent = `第 ${currentDraft.version} 版 · 种子 ${String(seed).slice(-6)}`;
      updateAiMode(result.mode); updateStudioMeta(); $("#nowLyric").textContent = isVariant ? "新歌词和新试听均已生成。" : `歌词已生成，支付${PREVIEW_COST}音符即可生成试听。`;
      showToast(isVariant ? "已换歌词并生成新试听，旧试听已清理" : "歌词已经生成");
    };
    lyricsGenerationPending = true;
    try {
      if (isVariant) await chargedMusicAction(button, "正在换歌词并生成试听…", PREVIEW_COST, create);
      else await runButton(button, "AI 创作中…", create);
    } finally { lyricsGenerationPending = false; }
  }

  async function generatePreview(tuneVariant = false) {
    const snapshot = songSnapshot(); if (!validateSongSnapshot(snapshot)) return false;
    const button = tuneVariant ? $("#regenerateTuneBtn") : $("#playSongBtn");
    const previousPreview = currentDraft.preview;
    const seed = Date.now() + currentDraft.tuneVersion * 7919 + Math.floor(Math.random() * 1000);
    return chargedMusicAction(button, tuneVariant ? "正在创作新曲调…" : "正在生成试听…", PREVIEW_COST, async () => {
      const preview = await requestPreview(snapshot, seed);
      await installPreview(preview, previousPreview);
      showToast(tuneVariant ? "新曲调已就绪，旧试听已清理" : "试听已生成，可重复播放而不再扣费");
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
    button.textContent = button.id === "playSongBtn" ? (currentDraft.preview && !currentDraft.stale ? "▶ 播放当前试听" : `生成试听 · ${PREVIEW_COST} 音符`) : "▶ 播放完整版";
    button.setAttribute("aria-pressed", "false");
  }

  function stopSongPlayback() {
    FocusBeatMusic.stop();
    resetPlayButton(); activePlayButton = null;
    $(".track-panel")?.classList.remove("playing");
  }

  async function playSongAsset(asset, blueprint, button, full) {
    const alreadyPlaying = activePlayButton === button && FocusBeatMusic.isPlaying();
    if (alreadyPlaying) { stopSongPlayback(); return; }
    stopSongPlayback(); activePlayButton = button; button.textContent = "■ 停止播放"; button.setAttribute("aria-pressed", "true"); $(".track-panel")?.classList.add("playing");
    try {
      await FocusBeatMusic.play(blueprint, {
        fraction: full ? 1 : .3, vocal: true,
        onLyric: line => { if ($("#nowLyric")) $("#nowLyric").textContent = line; },
        onState: status => { if (status !== "playing") { resetPlayButton(button); if (activePlayButton === button) activePlayButton = null; $(".track-panel")?.classList.remove("playing"); } },
      });
    } catch (error) { stopSongPlayback(); showToast(error.message || "音频启动失败，请检查浏览器声音设置", "error"); }
  }

  async function previewCurrentSong() {
    if (!currentDraft.preview || currentDraft.stale) { await generatePreview(false); return; }
    playSongAsset(currentDraft.preview, currentDraft.preview.blueprint, $("#playSongBtn"), false);
  }

  async function saveSong() {
    if (!currentDraft.preview || currentDraft.stale) { showToast("请先生成当前歌词和曲调的试听", "error"); return; }
    const snapshot = songSnapshot(); if (!validateSongSnapshot(snapshot)) return;
    await chargedMusicAction($("#saveSongBtn"), "正在保存完整拟唱…", SONG_COST, async () => {
      const result = await FocusBeatMusicAPI.request("complete", { ...snapshot, seed: currentDraft.preview.seed, previewJobId: currentDraft.preview.jobId, providerSongId: currentDraft.preview.providerSongId || currentDraft.preview.jobId, previewDurationMs: currentDraft.preview.durationMs || Math.round((currentDraft.preview.duration || 40) * 1000), previewAudioUrl: currentDraft.preview.audioUrl || "" });
      if (!result.data?.jobId) throw new Error("音乐服务没有返回完整歌曲");
      const blueprint = buildCurrentBlueprint(); if (!blueprint) throw new Error("歌曲蓝图无效");
      const song = { id: uid("song"), name: blueprint.title, style: blueprint.style, lyrics: snapshot.lyrics, seed: currentDraft.preview.seed, blueprint, previewJobId: currentDraft.preview.jobId, fullJobId: result.data.jobId, audioUrl: result.data.audioUrl || "", storageKey: result.data.storageKey || "", provider: result.data.provider || currentDraft.preview.provider || "demo", unlocked: true, createdAt: new Date().toISOString() };
      const previousSongs = state.songs; state.songs = [song, ...state.songs].slice(0, 100);
      if (!saveState()) { state.songs = previousSongs; throw new Error("浏览器未能保存歌曲"); }
      currentDraft.savedFingerprint = blueprint.fingerprint; currentDraft.completed = true; renderDashboard();
      $("#previewRuleText").textContent = "完整本地拟唱已收藏";
      showToast("完整本地拟唱蓝图已收藏，可以随时完整播放");
    });
  }

  function renderSongs() {
    const list = $("#songList");
    if (!state.songs.length) { list.innerHTML = `<div class="empty">收藏还是空的。先用 ${PREVIEW_COST} 音符生成试听，满意后再用 ${SONG_COST} 音符续写并收藏完整歌曲。</div>`; return; }
    list.innerHTML = state.songs.map(song => `<article class="song-card"><button class="song-card-open" data-open-song="${escapeHtml(song.id)}" type="button" aria-label="查看《${escapeHtml(song.name)}》完整拟唱"><small>${escapeHtml(styleNames[song.style] || song.style)} · 本地拟唱完整版</small><h3>${escapeHtml(song.name)}</h3><p>${escapeHtml(formatDate(song.createdAt))} · 浏览器拟唱 · 蓝图 ${escapeHtml(song.blueprint?.fingerprint || "已迁移")}</p><p class="song-preview">${escapeHtml(song.lyrics)}</p></button><div class="song-actions"><button class="button secondary" data-play-song="${escapeHtml(song.id)}" type="button" aria-pressed="false">▶ 播放完整拟唱</button><button class="button ghost" data-open-song="${escapeHtml(song.id)}" type="button">查看歌词</button><button class="button danger" data-delete-song="${escapeHtml(song.id)}" type="button">删除</button></div></article>`).join("");
  }

  function openSongDetail(id, trigger) {
    selectedSongId = id; openModal("songDetail", trigger);
  }

  function renderSongDetail() {
    const song = state.songs.find(item => item.id === selectedSongId);
    if (!song) { $("#songDetailTitle").textContent = "歌曲不存在"; $("#songDetailLyrics").textContent = "这首歌曲可能已经被删除。"; return; }
    $("#songDetailTitle").textContent = song.name;
    $("#songDetailMeta").textContent = `${styleNames[song.style] || song.style} · ${formatDate(song.createdAt)} · 浏览器本地拟唱`;
    $("#songDetailLyrics").textContent = song.lyrics;
  }

  function deleteSong(id) {
    if (!confirm("确定删除这首歌曲吗？已经消耗的音符不会返还。")) return;
    const song = state.songs.find(item => item.id === id); stopSongPlayback(); state.songs = state.songs.filter(item => item.id !== id); saveState(); renderSongs();
    showToast("歌曲已从收藏中删除");
  }

  // 周计划与总结
  async function generateWeekly() {
    await runButton($("#generateWeeklyBtn"), "安排中…", async () => {
      const result = await FocusBeatAI.request("weekly", { goal: $("#weeklyGoal").value.trim() }); updateAiMode(result.mode);
      state.weekly = result.data; saveState(); renderWeekly(); showToast("本周学习节奏已生成");
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
      updateAiMode(result.mode); $("#summaryKeyword").textContent = result.data.keyword; $("#summaryCopy").textContent = result.data.copy;
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
    $("#saveMistakeBtn").addEventListener("click", saveMistake); $("#mistakeList").addEventListener("click", event => { const button = event.target.closest("[data-delete-mistake]"); if (button) deleteMistake(button.dataset.deleteMistake); });
    $("#newQuizBtn").addEventListener("click", generateQuiz); $("#quizSubject").addEventListener("change", () => { quizPrefetch = null; generateQuiz(); }); $("#submitQuizBtn").addEventListener("click", submitQuiz); $("#quizAnswer").addEventListener("keydown", event => { if (event.key === "Enter") submitQuiz(); });
    $("#generateLyricsBtn").addEventListener("click", () => generateLyrics(false)); $("#regenerateLyricsBtn").addEventListener("click", () => generateLyrics(true));
    $("#regenerateTuneBtn").addEventListener("click", () => generatePreview(true));
    $("#songName").addEventListener("input", invalidateDraft); $("#songTopic").addEventListener("input", invalidateDraft); $("#songStyle").addEventListener("change", invalidateDraft); $("#lyrics").addEventListener("input", invalidateDraft);
    $("#playSongBtn").addEventListener("click", previewCurrentSong); $("#saveSongBtn").addEventListener("click", saveSong);
    $("#songList").addEventListener("click", event => {
      const play = event.target.closest("[data-play-song]");
      if (play) { const song = state.songs.find(item => item.id === play.dataset.playSong); if (song?.blueprint) playSongAsset(song, song.blueprint, play, true); return; }
      const open = event.target.closest("[data-open-song]"); if (open) { openSongDetail(open.dataset.openSong, open); return; }
      const remove = event.target.closest("[data-delete-song]"); if (remove) deleteSong(remove.dataset.deleteSong);
    });
    $("#playDetailSongBtn").addEventListener("click", event => { const song = state.songs.find(item => item.id === selectedSongId); if (song?.blueprint) playSongAsset(song, song.blueprint, event.currentTarget, true); });
    $("#generateWeeklyBtn").addEventListener("click", generateWeekly); $("#refreshSummaryBtn").addEventListener("click", () => renderSummary(true));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.timer?.active) tickTimer(); });
    window.addEventListener("beforeunload", saveState);
  }

  function init() {
    initWaveform(); bindEvents(); renderDashboard(); renderMistakes(); renderWeekly(); updateStudioMeta(); updateAiMode("local"); updateMusicMode({ mode: "local" }); saveState();
    FocusBeatAI.status().then(meta => updateAiMode(meta.mode, meta.reason));
    FocusBeatMusicAPI.status().then(updateMusicMode);
    if (state.timer?.active) {
      if (!state.timer.paused) state.timer.remainingMs = Math.max(0, state.timer.endAt - Date.now());
      if (state.timer.remainingMs <= 0) advanceTimer(); else openFocusOverlay();
    }
    window.__focusBeat = { get state() { return state; }, get currentQuiz() { return currentQuiz; }, get currentDraft() { return currentDraft; }, music: FocusBeatMusic.diagnostics, buildCurrentBlueprint, openModal };
  }

  init();
})();
