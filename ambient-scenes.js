(() => {
  "use strict";

  const PREF_KEY = "focusBeatAmbiencePrefsV1";
  const REMINDER_KEY = "focusBeatDailyWhisperV1";
  const levels = new Set(["quiet", "standard", "rich"]);
  const themeIcons = { sunny:"☀", candy:"☁", cosmos:"✦", pixel:"▦", journal:"✎", forest:"❧" };
  let preferences = readPreferences();
  let context = null; let stage = null; let whisper = null; let contentCard = null; let sceneAbort = null; let sceneTimers = []; let whisperTimer = 0; let reminderTimer = 0; let contentTimer = 0; let heroVisible = true; let setupDone = false;

  function todayKey() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`; }
  function readPreferences() {
    try { const value = JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); return { intensity:levels.has(value.intensity) ? value.intensity : "standard", reminders:value.reminders !== false, dismissedDay:String(value.dismissedDay || "") }; }
    catch (_) { return { intensity:"standard", reminders:true, dismissedDay:"" }; }
  }
  function savePreferences() { try { localStorage.setItem(PREF_KEY, JSON.stringify(preferences)); } catch (_) {} }
  function addTimer(id) { sceneTimers.push(id); return id; }
  function clearScene() { sceneAbort?.abort(); sceneAbort = new AbortController(); sceneTimers.forEach(clearTimeout); sceneTimers = []; if (stage) { stage.className = "theme-stage"; stage.replaceChildren(); } }
  function isPaused() { return document.hidden || !heroVisible || document.body.classList.contains("modal-open") || document.querySelector("#focusOverlay.is-open"); }
  function syncPauseState() { document.body.classList.toggle("ambience-paused", isPaused()); }
  function currentTheme() { return window.FocusBeatThemes?.current?.() || document.documentElement.dataset.theme || "sunny"; }
  function reduced() { return window.FocusBeatThemes?.reduced?.() || false; }

  function syncControls() {
    document.documentElement.dataset.ambience = preferences.intensity;
    document.querySelectorAll("[data-ambience-level]").forEach(button => { const active = button.dataset.ambienceLevel === preferences.intensity; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
    const toggle = document.querySelector("#ambientReminderToggle"); if (toggle) toggle.checked = preferences.reminders;
  }

  function injectControls() {
    const motion = document.querySelector(".motion-setting"); if (!motion || document.querySelector("#ambienceSettings")) return;
    const settings = document.createElement("section"); settings.className = "ambience-settings"; settings.id = "ambienceSettings";
    settings.innerHTML = `<div class="ambience-setting-row"><span><strong>氛围效果</strong><small>控制主题中的生命感</small></span><div class="ambience-levels" role="group" aria-label="氛围效果强度"><button type="button" data-ambience-level="quiet">安静</button><button type="button" data-ambience-level="standard">标准</button><button type="button" data-ambience-level="rich">丰富</button></div></div><label class="ambient-reminder-setting"><span><strong>今日灵感</strong><small>每天生成一句轻提醒</small></span><input id="ambientReminderToggle" type="checkbox"><i aria-hidden="true"></i></label>`;
    motion.before(settings); syncControls();
    settings.addEventListener("click", event => { const level = event.target.closest("[data-ambience-level]")?.dataset.ambienceLevel; if (!levels.has(level)) return; preferences.intensity = level; savePreferences(); syncControls(); renderScene(); if (level !== "quiet") scheduleDailyReminder(1800); });
    settings.querySelector("#ambientReminderToggle").addEventListener("change", event => { preferences.reminders = event.currentTarget.checked; if (!preferences.reminders) hideWhisper(); savePreferences(); if (preferences.reminders) scheduleDailyReminder(1200); });
  }

  function makeStage() {
    const hero = document.querySelector(".hero"); if (!hero || stage) return;
    stage = document.createElement("div"); stage.className = "theme-stage"; stage.setAttribute("role","group"); stage.setAttribute("aria-label","主题互动场景"); hero.prepend(stage);
    if ("IntersectionObserver" in window) new IntersectionObserver(entries => { heroVisible = Boolean(entries[0]?.isIntersecting); syncPauseState(); }, { threshold:.08 }).observe(hero);
  }

  function makeWhisper() {
    if (whisper) return;
    whisper = document.createElement("aside"); whisper.className = "daily-whisper"; whisper.setAttribute("aria-live","polite"); whisper.hidden = true;
    whisper.innerHTML = `<span class="daily-whisper-icon" aria-hidden="true">✦</span><div><small>今日灵感</small><p></p><button type="button" data-dismiss-day>今天不再出现</button></div><button class="daily-whisper-close" type="button" aria-label="关闭提醒">×</button>`;
    document.body.append(whisper);
    whisper.querySelector(".daily-whisper-close").addEventListener("click", hideWhisper);
    whisper.querySelector("[data-dismiss-day]").addEventListener("click", () => { preferences.dismissedDay = todayKey(); savePreferences(); hideWhisper(); });
  }

  function makeContentCard() {
    if (contentCard) return;
    contentCard = document.createElement("aside"); contentCard.className = "theme-content-card"; contentCard.hidden = true; contentCard.setAttribute("role","dialog"); contentCard.setAttribute("aria-modal","false"); contentCard.setAttribute("aria-labelledby","themeContentTitle");
    contentCard.innerHTML = `<header><span class="theme-content-icon" aria-hidden="true">✦</span><div><small class="theme-content-space">主题探索</small><strong class="theme-content-kind">发现</strong></div><button type="button" data-content-close aria-label="关闭主题内容">×</button></header><h3 id="themeContentTitle"></h3><p class="theme-content-copy"></p>`;
    document.body.append(contentCard);
    contentCard.querySelector("[data-content-close]").addEventListener("click", hideThemeContent);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !contentCard.hidden) hideThemeContent(); });
  }

  function showThemeContent(type="") {
    if (currentTheme() === "journal") return;
    const item = window.FocusBeatThemeContent?.next(currentTheme(), { type }); if (!item || !contentCard) return;
    showThemeContentItem(item);
  }

  function showThemeContentItem(item) {
    if (!item || !contentCard || item.theme === "journal") return;
    clearTimeout(contentTimer);
    hideWhisper(); contentCard.hidden = false; contentCard.dataset.themeContent = item.theme;
    contentCard.dataset.autoclose = "true";
    contentCard.querySelector(".theme-content-icon").textContent = themeIcons[item.theme] || "✦";
    contentCard.querySelector(".theme-content-space").textContent = window.FocusBeatThemes?.themes?.[item.theme]?.name || "主题探索";
    contentCard.querySelector(".theme-content-kind").textContent = item.typeName;
    contentCard.querySelector("h3").textContent = item.title;
    contentCard.querySelector(".theme-content-copy").textContent = item.text;
    contentCard.classList.remove("is-leaving"); requestAnimationFrame(() => contentCard.classList.add("is-visible"));
    contentTimer = window.setTimeout(hideThemeContent, 10_000);
  }

  function hideThemeContent() {
    clearTimeout(contentTimer); contentTimer = 0;
    if (!contentCard || contentCard.hidden) return; contentCard.classList.remove("is-visible"); contentCard.classList.add("is-leaving");
    window.setTimeout(() => { if (!contentCard.classList.contains("is-visible")) contentCard.hidden = true; }, 420);
  }

  function showWhisper(message, options = {}) {
    if (!whisper || !message || isPaused()) return;
    clearTimeout(whisperTimer); whisper.hidden = false; whisper.querySelector("p").textContent = String(message).slice(0, 90); whisper.querySelector(".daily-whisper-icon").textContent = options.icon || themeIcons[currentTheme()] || "✦";
    whisper.classList.remove("is-leaving"); requestAnimationFrame(() => whisper.classList.add("is-visible"));
    whisper.querySelector("[data-dismiss-day]").hidden = options.daily === false;
    whisperTimer = window.setTimeout(hideWhisper, Math.max(4500, Number(options.duration) || 9000));
  }
  function hideWhisper() { if (!whisper || whisper.hidden) return; clearTimeout(whisperTimer); whisper.classList.remove("is-visible"); whisper.classList.add("is-leaving"); window.setTimeout(() => { if (!whisper.classList.contains("is-visible")) whisper.hidden = true; }, 500); }

  function sceneMarkup(theme) {
    if (theme === "candy") return `<div class="candy-puff puff-one ambient-extra" aria-hidden="true"></div><div class="candy-puff puff-two ambient-extra" aria-hidden="true"></div><button class="ambient-interaction candy-cloud" type="button" data-action="cloud" data-face="happy" aria-label="和棉花糖云朵打招呼"><span class="cloud-face">˶ᵔ ᵕ ᵔ˶</span><small>点点我</small></button>`;
    if (theme === "cosmos") return `<div class="cosmos-rings" aria-hidden="true"></div><button class="ambient-interaction mini-planet uranus" type="button" data-action="planet" data-name="天王星" data-message="天王星像侧躺着转动，淡青色来自大气中的甲烷">天王星</button><button class="ambient-interaction mini-planet neptune" type="button" data-action="planet" data-name="海王星" data-message="海王星拥有太阳系中非常强劲的风，颜色像深海一样蓝">海王星</button><div class="cosmos-comet ambient-extra" aria-hidden="true"></div>`;
    if (theme === "pixel") return `<div class="pixel-equalizer" aria-hidden="true">${"<i></i>".repeat(9)}</div><button class="ambient-interaction pixel-buddy" type="button" data-action="pixel" data-state="idle" aria-label="唤醒像素节拍伙伴"><span class="pixel-screen"><b>•ᴗ•</b></span><small>BEAT BUDDY</small></button><div class="pixel-signal ambient-extra" aria-hidden="true">+ 10 FOCUS</div>`;
    if (theme === "journal") return `<div class="journal-doodle ambient-extra" aria-hidden="true">✦  ♪  ⌁</div><button class="ambient-interaction journal-note" type="button" data-action="journal" aria-label="在便签里生成一句话"><span class="journal-tape" aria-hidden="true"></span><small>写给今天</small><strong class="journal-note-copy">点击翻开一句话</strong></button>`;
    if (theme === "forest") return `<div class="forest-leaves" aria-hidden="true"><i></i><i></i><i></i></div><div class="forest-fireflies ambient-extra" aria-hidden="true">${"<i></i>".repeat(7)}</div><button class="ambient-interaction forest-bird" type="button" data-action="bird" aria-label="让枝头的小鸟飞一圈"><span>⌁</span><b>●</b><i></i><small>啾</small></button>`;
    return `<div class="sunny-rays" aria-hidden="true"></div><div class="sunny-dust ambient-extra" aria-hidden="true">${"<i></i>".repeat(6)}</div><button class="ambient-interaction sunny-plane" type="button" data-action="plane" aria-label="放飞今日纸飞机"><span>➤</span><small>放飞一句话</small></button>`;
  }

  function renderScene() {
    if (!stage) return; hideThemeContent(); clearScene(); const theme = currentTheme(); stage.classList.add(`scene-${theme}`); stage.innerHTML = sceneMarkup(theme); syncControls();
    const signal = sceneAbort.signal; stage.addEventListener("click", handleSceneClick, { signal });
    if (theme === "forest" && preferences.intensity !== "quiet" && !reduced()) scheduleForestFlight(preferences.intensity === "rich" ? 9000 : 18000);
    observeMusicActivity(signal); syncPauseState();
  }

  function spawnPops(button) {
    for (let index = 0; index < (preferences.intensity === "rich" ? 7 : 4); index += 1) { const pop = document.createElement("i"); pop.className = "cloud-pop"; pop.textContent = index % 2 ? "✦" : "♡"; pop.style.setProperty("--pop-x",`${(index - 3) * 18}px`); pop.style.animationDelay = `${index * 35}ms`; button.append(pop); window.setTimeout(() => pop.remove(), 1050); }
  }
  function typeNote(node, value) {
    if (!node) return; const characters = Array.from(String(value || ""));
    if (reduced()) { node.textContent = characters.join(""); return; }
    node.textContent = ""; let index = 0;
    const write = () => { node.textContent += characters[index++] || ""; if (index < characters.length) addTimer(window.setTimeout(write, 55)); };
    write();
  }
  function handleSceneClick(event) {
    const button = event.target.closest("[data-action]"); if (!button) return; const action = button.dataset.action;
    if (action === "cloud") { const faces = [["happy","˶ᵔ ᵕ ᵔ˶"],["shy","˶˃ ᵕ ˂˶"],["sleepy","－ ᴗ －"],["spark","✧ ᴗ ✧"]]; const current = faces.findIndex(item => item[0] === button.dataset.face); const next = faces[(current + 1) % faces.length]; button.dataset.face = next[0]; button.querySelector(".cloud-face").textContent = next[1]; spawnPops(button); showThemeContent(); }
    if (action === "planet") { button.classList.add("is-discovered"); showThemeContent("knowledge"); }
    if (action === "pixel") { const states = [["dance","≧▽≦"],["focus","•̀ᴗ•́"],["rest","－ᴗ－"]]; const current = states.findIndex(item => item[0] === button.dataset.state); const next = states[(current + 1) % states.length]; button.dataset.state = next[0]; button.querySelector("b").textContent = next[1]; showThemeContent(); }
    if (action === "journal") { const item = window.FocusBeatThemeContent?.next("journal"); if (item) { typeNote(button.querySelector(".journal-note-copy"), `${item.title}：${item.text}`.slice(0, 44)); button.classList.add("is-open"); } }
    if (action === "bird") { button.classList.remove("is-flying"); void button.offsetWidth; button.classList.add("is-flying"); showThemeContent(); }
    if (action === "plane") { button.classList.remove("is-flying"); void button.offsetWidth; button.classList.add("is-flying"); showThemeContent(); }
  }

  function scheduleForestFlight(delay) {
    addTimer(window.setTimeout(() => { if (!isPaused() && preferences.intensity !== "quiet" && stage?.classList.contains("scene-forest")) { const bird = document.createElement("span"); bird.className = "forest-flyby"; bird.setAttribute("aria-hidden","true"); bird.textContent = "⌁●"; stage.append(bird); window.setTimeout(() => bird.remove(), 9000); } scheduleForestFlight(preferences.intensity === "rich" ? 24000 + Math.random()*18000 : 48000 + Math.random()*28000); }, delay));
  }

  function observeMusicActivity(signal) {
    const update = () => stage?.classList.toggle("music-active", !document.querySelector("#globalSongPlayer")?.hidden || document.querySelector(".track-panel.playing")); update();
    const observer = new MutationObserver(update); const player = document.querySelector("#globalSongPlayer"); const track = document.querySelector(".track-panel"); if (player) observer.observe(player,{ attributes:true, attributeFilter:["hidden"] }); if (track) observer.observe(track,{ attributes:true, attributeFilter:["class"] }); signal.addEventListener("abort",() => observer.disconnect(),{ once:true });
  }

  async function loadDailyReminder() {
    if (!preferences.reminders || preferences.dismissedDay === todayKey() || preferences.intensity === "quiet") return;
    let cached = null; try { cached = JSON.parse(localStorage.getItem(REMINDER_KEY) || "null"); } catch (_) {}
    if (cached?.day === todayKey() && cached.message) { scheduleDailyReminder(7000 + Math.random() * 7000,cached.message); return; }
    const state = context?.getState?.() || {}; const day = state.day || {};
    try {
      const result = await window.FocusBeatAI.request("ambient", { day:todayKey(), focus:Number(day.focus)||0, sessions:Number(day.sessions)||0, mistakes:Array.isArray(day.mistakeIds)?day.mistakeIds.length:0, streak:Number(state.streakDays || state.streak)||1, hasPlan:Boolean(state.timer || state.weekly) });
      const message = String(result?.data?.message || "").trim(); if (!message) return;
      try { localStorage.setItem(REMINDER_KEY,JSON.stringify({ day:todayKey(), message, mood:result.data.mood || "gentle" })); } catch (_) {}
      scheduleDailyReminder(7000 + Math.random() * 7000,message);
    } catch (_) { scheduleDailyReminder(7000 + Math.random() * 7000,"不用等状态完美，完成第一小步就会有新的节奏。"); }
  }
  function scheduleDailyReminder(delay=9000,message="") { clearTimeout(reminderTimer); if (!preferences.reminders || preferences.dismissedDay === todayKey() || preferences.intensity === "quiet") return; reminderTimer = window.setTimeout(() => { let value=message; if (!value) { try { const cached=JSON.parse(localStorage.getItem(REMINDER_KEY)||"null"); if (cached?.day===todayKey()) value=cached.message; } catch (_) {} } if (value && !isPaused()) showWhisper(value,{ daily:true,duration:10000 }); },delay); }

  function setup(options={}) {
    if (setupDone) return; setupDone=true; context=options; makeStage(); makeWhisper(); makeContentCard(); injectControls(); renderScene();
    window.addEventListener("focusbeat:themechange",renderScene); window.addEventListener("focusbeat:motionchange",renderScene); document.addEventListener("visibilitychange",syncPauseState);
    const pauseObserver=new MutationObserver(syncPauseState); pauseObserver.observe(document.body,{ attributes:true,attributeFilter:["class"] }); const focus=document.querySelector("#focusOverlay"); if (focus) pauseObserver.observe(focus,{attributes:true,attributeFilter:["class"]});
    const begin=() => loadDailyReminder(); if ("requestIdleCallback" in window) requestIdleCallback(begin,{timeout:5000}); else window.setTimeout(begin,3500);
  }

  window.FocusBeatAmbience={ setup, render:renderScene, show:message => showWhisper(message,{daily:false}), explore:showThemeContent, preferences:() => ({...preferences}) };
})();
