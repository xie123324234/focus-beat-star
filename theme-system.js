(() => {
  "use strict";

  const STORAGE_KEY = "focusBeatThemePrefsV1";
  const DEFAULT_THEME = "sunny";
  const THEMES = {
    sunny: { name: "晴日书房", transition: "#eee9df", browser: "#f7f5f1" },
    candy: { name: "糖果云朵", transition: "#ffd8e8", browser: "#fff3f8" },
    cosmos: { name: "星河实验室", transition: "#21194f", browser: "#0d1026" },
    pixel: { name: "像素电台", transition: "#3157d5", browser: "#f3f0df" },
    journal: { name: "诗页手账", transition: "#d8c8ad", browser: "#f3ede2" },
    forest: { name: "森野呼吸", transition: "#4f725c", browser: "#edf3e9" },
  };

  function readPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return { theme: Object.hasOwn(THEMES, value.theme) ? value.theme : DEFAULT_THEME, reduceMotion: Boolean(value.reduceMotion) };
    } catch (_) { return { theme: DEFAULT_THEME, reduceMotion: false }; }
  }

  let preferences = readPreferences();
  let transitioning = false;

  function prefersReducedMotion() {
    return preferences.reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function savePreferences() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch (_) {}
  }

  function updateBrowserColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEMES[theme].browser;
  }

  function syncControls() {
    document.querySelectorAll("[data-theme-option]").forEach(button => {
      const selected = button.dataset.themeOption === preferences.theme;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const reduce = document.querySelector("#reduceThemeMotion");
    if (reduce) reduce.checked = preferences.reduceMotion;
    const trigger = document.querySelector("#themeTrigger");
    if (trigger) trigger.title = `当前外观：${THEMES[preferences.theme].name}`;
  }

  function commitTheme(theme) {
    preferences.theme = theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("reduce-theme-motion", preferences.reduceMotion);
    updateBrowserColor(theme);
    savePreferences();
    syncControls();
    window.dispatchEvent(new CustomEvent("focusbeat:themechange", { detail: { theme, ...THEMES[theme] } }));
  }

  async function apply(theme, options = {}) {
    if (!Object.hasOwn(THEMES, theme) || transitioning) return false;
    if (theme === preferences.theme) { syncControls(); return true; }
    const animate = options.animate !== false && !prefersReducedMotion();
    if (!animate || !document.body || typeof Element.prototype.animate !== "function") { commitTheme(theme); return true; }

    transitioning = true;
    const origin = options.origin instanceof Element ? options.origin.getBoundingClientRect() : null;
    const x = origin ? origin.left + origin.width / 2 : window.innerWidth / 2;
    const y = origin ? origin.top + origin.height / 2 : window.innerHeight / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) + 40;
    const layer = document.createElement("div");
    layer.className = "theme-transition-layer";
    layer.style.background = THEMES[theme].transition;
    document.body.append(layer);
    document.documentElement.classList.add("theme-is-transitioning");
    try {
      const cover = layer.animate([
        { clipPath: `circle(0px at ${x}px ${y}px)`, opacity: .96 },
        { clipPath: `circle(${radius}px at ${x}px ${y}px)`, opacity: 1 },
      ], { duration: 430, easing: "cubic-bezier(.65,0,.25,1)", fill: "forwards" });
      await cover.finished;
      commitTheme(theme);
      document.body.classList.add("theme-settling");
      const reveal = layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, easing: "ease-out", fill: "forwards" });
      await reveal.finished;
    } catch (_) { commitTheme(theme); }
    finally {
      layer.remove();
      document.documentElement.classList.remove("theme-is-transitioning");
      window.setTimeout(() => document.body?.classList.remove("theme-settling"), 420);
      transitioning = false;
    }
    return true;
  }

  function closePanel({ restoreFocus = false } = {}) {
    const panel = document.querySelector("#themePanel"); const trigger = document.querySelector("#themeTrigger");
    if (!panel || panel.hidden) return;
    panel.hidden = true; trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
  }

  function openPanel() {
    const panel = document.querySelector("#themePanel"); const trigger = document.querySelector("#themeTrigger");
    if (!panel) return;
    panel.hidden = false; trigger?.setAttribute("aria-expanded", "true"); syncControls();
    panel.querySelector(".theme-option.is-selected")?.focus();
  }

  function setup() {
    const trigger = document.querySelector("#themeTrigger"); const panel = document.querySelector("#themePanel");
    if (!trigger || !panel || trigger.dataset.ready) return;
    document.querySelector(".theme-grid")?.removeAttribute("role");
    document.querySelectorAll("[data-theme-option]").forEach(option => option.removeAttribute("role"));
    trigger.dataset.ready = "true"; syncControls();
    trigger.addEventListener("click", () => panel.hidden ? openPanel() : closePanel());
    document.querySelector("#themePanelClose")?.addEventListener("click", () => closePanel({ restoreFocus: true }));
    panel.addEventListener("click", event => {
      const option = event.target.closest("[data-theme-option]");
      if (!option) return;
      void apply(option.dataset.themeOption, { origin: trigger }).then(() => closePanel({ restoreFocus: true }));
    });
    document.querySelector("#reduceThemeMotion")?.addEventListener("change", event => {
      preferences.reduceMotion = event.currentTarget.checked;
      document.documentElement.classList.toggle("reduce-theme-motion", preferences.reduceMotion);
      savePreferences(); syncControls();
      window.dispatchEvent(new CustomEvent("focusbeat:motionchange", { detail: { reduced: preferences.reduceMotion } }));
    });
    document.addEventListener("pointerdown", event => { if (!panel.hidden && !event.target.closest(".theme-picker")) closePanel(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !panel.hidden) { event.stopPropagation(); closePanel({ restoreFocus: true }); } });
  }

  // Apply before the stylesheet is parsed to avoid a light/dark flash.
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.classList.toggle("reduce-theme-motion", preferences.reduceMotion);
  updateBrowserColor(preferences.theme);
  window.FocusBeatThemes = { themes: THEMES, setup, apply, current: () => preferences.theme, reduced: prefersReducedMotion };
})();
