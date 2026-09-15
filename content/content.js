// Content script for meet.google.com. Two jobs:
//
// 1. The floating pill (top center, shadow DOM): shows the recorder state —
//    idle -> recording (timer + stop) -> processing -> done/failed.
// 2. The DOCKED PANEL: the panel UI (sidepanel/sidepanel.html) embedded as an
//    iframe fixed to the right edge, over the page. The ✕ HIDES the iframe
//    instead of destroying it: a fallback (getDisplayMedia) recording runs
//    INSIDE that iframe, and must survive the panel being dismissed.
//
// Wrapped in a guard so the background can re-inject it (chrome.scripting)
// into tabs whose copy went stale without redeclaring top-level bindings.
(() => {
  if (window.__windayNotetaker) {
    return;
  }
  const api = {};
  window.__windayNotetaker = api;

  // Winday Data design-system palettes. The pill + docked panel live inside the
  // Meet page, so they can't use the extension's theme.css — we resolve the
  // user's Theme choice here and paint from these role-based tokens. Brand blue
  // is reserved for the mark, links and active states; primary is inverse.
  const PALETTES = {
    light: {
      cardBg: "#FAF9F5", cardBorder: "#D6D3CB", text: "#1F1E1D",
      secondary: "#6E6D66", muted: "#9B9A93", accent: "#3670B2", link: "#2E5F9C",
      danger: "#B4553F", inset: "#E8E6E0", btnBg: "#1F1E1D", btnText: "#FAF9F5",
      onDanger: "#FAF9F5", panelBg: "#FAF9F5", panelBorder: "#D6D3CB", shadow: "rgba(31,30,29,.14)",
    },
    dark: {
      cardBg: "#232220", cardBorder: "#3A3835", text: "#F2F1EC",
      secondary: "#B4B2AA", muted: "#86847C", accent: "#5B9BD8", link: "#82B3E8",
      danger: "#D98466", inset: "#333029", btnBg: "#F2F1EC", btnText: "#1F1E1D",
      onDanger: "#1B1A18", panelBg: "#1B1A18", panelBorder: "#3A3835", shadow: "rgba(0,0,0,.45)",
    },
  };
  let P = PALETTES.light; // active palette; set for real by initTheme() below
  const PANEL_WIDTH = 380;

  let host, root, els; // pill
  let panelHost = null; // docked panel (kept alive once created)
  let state = { phase: "idle" };
  let inCall = false;
  let tick = null;
  let dismissedKey = null; // pill closed via its ✕, for the current prompt only
  // The native side panel delegated a fallback capture to our docked iframe:
  // while armed, the "hide the overlay when the native panel is open"
  // self-heal is suspended — the overlay IS the capture host being set up.
  let fallbackArmed = false;

  // Identity of what the pill is currently prompting for — the dismissal
  // sticks to THIS call/prompt and naturally clears when it changes.
  function pillKey() {
    if (inCall) return "call:" + location.pathname;
    const imm = state.imminentCall || null;
    if (imm) return "imm:" + (imm.meet_url || imm.title || "x");
    return null;
  }

  // --- Docked panel -------------------------------------------------------

  function openPanel() {
    if (panelHost) {
      panelHost.style.display = "block";
      render(); // the pill hides while the docked panel shows
      return;
    }
    panelHost = document.createElement("winday-panel");
    panelHost.style.cssText = [
      "position:fixed",
      "top:0",
      "right:0",
      "bottom:0",
      `width:${PANEL_WIDTH}px`,
      "max-width:85vw",
      "z-index:2147483646",
      `background:${P.panelBg}`,
      `border-left:1px solid ${P.panelBorder}`,
      "box-shadow:-10px 0 30px rgba(0,0,0,.10)",
      "display:block",
    ].join(";");
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("sidepanel/sidepanel.html");
    // Let the embedded extension page use the mic and the share dialog for
    // the fallback capture path.
    frame.allow = "microphone; display-capture; autoplay";
    frame.style.cssText = "width:100%;height:100%;border:0;display:block;background:transparent;";
    panelHost.appendChild(frame);
    document.documentElement.appendChild(panelHost);
    render(); // the pill hides while the docked panel shows
  }

  function hidePanel() {
    fallbackArmed = false;
    if (panelHost) panelHost.style.display = "none";
    render(); // panel gone -> the pill may come back
  }

  api.open = openPanel;
  api.close = hidePanel;

  // --- Pill ---------------------------------------------------------------

  function detectInCall() {
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/.test(location.pathname);
  }
  // "abc-defg-hij" out of any Meet URL, or null.
  function meetCode(url) {
    const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i.exec(url || "");
    return m ? m[1].toLowerCase() : null;
  }

  function mount() {
    if (host) return;
    host = document.createElement("div");
    host.id = "winday-notetaker-root";
    // Top-right, tucked under the browser toolbar's extension icon.
    host.style.cssText =
      "position:fixed;top:10px;right:16px;z-index:2147483647;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
        .card {
          position: relative;
          display: inline-flex; align-items: center; gap: 12px;
          background: ${P.cardBg}; border: 1px solid ${P.cardBorder}; border-radius: 12px;
          padding: 8px 12px; box-shadow: 0 6px 24px ${P.shadow};
          color: ${P.text}; font-size: 14px; white-space: nowrap;
        }
        .close {
          position: absolute; top: -8px; left: -8px; width: 20px; height: 20px;
          display: flex; align-items: center; justify-content: center; padding: 0;
          border-radius: 999px; border: 1px solid ${P.cardBorder};
          background: ${P.btnBg}; color: ${P.btnText}; cursor: pointer;
          box-shadow: 0 2px 8px ${P.shadow};
          opacity: 0; pointer-events: none; transition: opacity 0.12s ease;
        }
        .card:hover .close { opacity: 1; pointer-events: auto; }
        .close svg { display: block; }
        .body { display: inline-flex; align-items: center; gap: 10px; }
        .logo { width: 18px; height: 18px; flex: 0 0 auto; }
        .dot { width: 9px; height: 9px; border-radius: 999px; background: ${P.danger}; animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        .time { font-variant-numeric: tabular-nums; font-weight: 500; }
        .spinner { width: 13px; height: 13px; border: 2px solid ${P.inset}; border-top-color: ${P.accent}; border-radius: 999px; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        button {
          border: 0; border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 500;
          cursor: pointer; color: ${P.btnText}; background: ${P.btnBg};
          display: inline-flex; align-items: center; gap: 6px;
        }
        button.ghost { background: transparent; color: ${P.secondary}; padding: 6px 8px; }
        button.stop { background: ${P.danger}; color: ${P.onDanger}; }
        button svg { display: block; flex: none; }
        a { color: ${P.link}; text-decoration: none; font-weight: 500; }
        .muted { color: ${P.muted}; }
      </style>
      <div class="card" part="card">
        <button class="close" title="Dismiss" aria-label="Dismiss">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none">${ICONS.cancel}</svg>
        </button>
        <svg class="logo" viewBox="0 0 24 24" fill="${P.accent}" aria-hidden="true">
          <rect x="3" y="9" width="2.5" height="6" rx="1.25"/>
          <rect x="7.5" y="6" width="2.5" height="12" rx="1.25"/>
          <rect x="12" y="3" width="2.5" height="18" rx="1.25"/>
          <rect x="16.5" y="7" width="2.5" height="10" rx="1.25"/>
          <rect x="21" y="10" width="2.5" height="4" rx="1.25"/>
        </svg>
        <span class="body"></span>
      </div>`;
    els = { card: root.querySelector(".card"), body: root.querySelector(".body") };
    root.querySelector(".close").addEventListener("click", () => {
      dismissedKey = pillKey(); // stay hidden for THIS call/prompt only
      unmount();
    });
    document.documentElement.appendChild(host);
  }

  function unmount() {
    if (tick) { clearInterval(tick); tick = null; }
    if (host) { host.remove(); host = root = els = null; }
  }

  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function send(type, extra) {
    return chrome.runtime.sendMessage({ type, ...(extra || {}) }).catch(() => {});
  }

  function render() {
    // The pill is a lightweight prompt only: it shows when a call is imminent
    // (from the calendar) or you're on a call but not yet recording, and gets
    // out of the way once recording starts — the side panel owns the in-call UI.
    const phase = state.phase || "idle";
    const imm = state.imminentCall || null;
    // Self-heal a double panel: if the NATIVE side panel is present while our
    // docked overlay is also showing, the overlay is redundant — drop it.
    // EXCEPT while a delegated fallback capture is being set up in the overlay
    // (fallbackArmed): the overlay is the capture host, keep it up. Once the
    // recording starts the overlay can hide again — hiding keeps it alive.
    if (state.panelOpen === true && !fallbackArmed && panelHost && panelHost.style.display !== "none") {
      panelHost.style.display = "none";
    }
    if (phase !== "idle" || (!inCall && !imm)) { unmount(); return; }
    // While a panel is showing — the native side panel (anywhere) or this
    // page's docked iframe — the pill is redundant: stay away.
    const panelShowing = state.panelOpen === true || (panelHost && panelHost.style.display !== "none");
    if (panelShowing) { unmount(); return; }
    // Closed via its ✕ for this specific prompt.
    if (dismissedKey && dismissedKey === pillKey()) { unmount(); return; }
    mount();
    const b = els.body;
    b.innerHTML = "";
    if (tick) { clearInterval(tick); tick = null; }

    if (inCall) {
      // On the call, not yet recording → start it (silent if the tab already
      // carries the activeTab grant) and reveal the panel.
      // The imminent calendar call, when it IS this call: its title and
      // calendar context (company, contacts) go with the recording.
      const here = imm && meetCode(imm.meet_url) && meetCode(imm.meet_url) === meetCode(location.href) ? imm : null;
      const label = document.createElement("span");
      label.textContent = here && here.title ? here.title : "Winday Meet";
      const rec = button("Record", "rec", async () => {
        // silent path, best-effort — the panel handles any fallback
        await send("WN_RECORD_TAB", here ? { title: here.title, calendar: here.calendar || null } : undefined);
        const p = await send("WN_OPEN_PANEL");
        // The docked overlay is ONLY the fallback for browsers whose native
        // side panel doesn't render (Arc). If the native panel opened, it owns
        // the UI — opening the overlay too would show the panel twice.
        if (!p || p.ok === false || p.mode === "docked") openPanel();
      }, "mic");
      b.append(label, rec);
    } else if (imm) {
      // A scheduled call is imminent but we're not in it yet → jump to it.
      const label = document.createElement("span");
      label.textContent = `${imm.title || "Your meeting"} · starting now`;
      const join = button("Join", "rec", () => {
        if (imm.meet_url) location.href = imm.meet_url;
        else openPanel();
      }, "join");
      b.append(label, join);
    }
  }

  // Hugeicons (stroke, currentColor, 24 grid) — inlined since a content script
  // can't import the shared lib/icons.js module.
  const ICONS = {
    mic: '<path d="M17 7V11C17 13.7614 14.7614 16 12 16C9.23858 16 7 13.7614 7 11V7C7 4.23858 9.23858 2 12 2C14.7614 2 17 4.23858 17 7Z" stroke="currentColor" stroke-width="1.5"/><path d="M17 7H14M17 11H14" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><path d="M20 11C20 15.4183 16.4183 19 12 19M12 19C7.58172 19 4 15.4183 4 11M12 19V22M12 22H15M12 22H9" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/>',
    join: '<path d="M2 11C2 7.70017 2 6.05025 3.02513 5.02513C4.05025 4 5.70017 4 9 4H10C13.2998 4 14.9497 4 15.9749 5.02513C17 6.05025 17 7.70017 17 11V13C17 16.2998 17 17.9497 15.9749 18.9749C14.9497 20 13.2998 20 10 20H9C5.70017 20 4.05025 20 3.02513 18.9749C2 17.9497 2 16.2998 2 13V11Z" stroke="currentColor" stroke-width="1.5"/><path d="M17 8.90585L17.1259 8.80196C19.2417 7.05623 20.2996 6.18336 21.1498 6.60482C22 7.02628 22 8.42355 22 11.2181V12.7819C22 15.5765 22 16.9737 21.1498 17.3952C20.2996 17.8166 19.2417 16.9438 17.1259 15.198L17 15.0941" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/><circle cx="11.5" cy="9.5" r="1.5" stroke="currentColor" stroke-width="1.5"/>',
    cancel: '<path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>',
  };
  function hi(name, size = 15) {
    const wrap = document.createElement("span");
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">${ICONS[name] || ""}</svg>`;
    return wrap.firstElementChild;
  }

  function button(text, cls, onClick, iconName) {
    const el = document.createElement("button");
    if (iconName) el.append(hi(iconName));
    el.append(document.createTextNode(text));
    if (cls) el.className = cls;
    el.addEventListener("click", onClick);
    return el;
  }

  function stageLabel(stage) {
    return (
      { uploading: "Preparing…", transcribing: "Transcribing…", summarizing: "Summarizing…", exporting: "Saving notes…" }[stage] ||
      "Processing…"
    );
  }

  // --- Wiring --------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "WN_STATE") {
      state = msg.state || { phase: "idle" };
      // Recording started (or the pipeline is running): the delegated-capture
      // setup is over — the normal overlay behavior resumes.
      if (state.phase && state.phase !== "idle") fallbackArmed = false;
      render();
    }
    if (msg?.type === "WN_ARM_FALLBACK") {
      fallbackArmed = true;
      openPanel();
    }
    if (msg?.type === "WN_TOGGLE_PANEL") {
      if (msg.ensure === "open") openPanel();
      else if (msg.ensure === "close") hidePanel();
      else if (panelHost && panelHost.style.display !== "none") hidePanel();
      else openPanel();
    }
  });

  async function refreshState() {
    try {
      const r = await chrome.runtime.sendMessage({ type: "WN_GET_STATE" });
      if (r?.state) state = r.state;
    } catch (_) {}
    render();
  }

  function poll() {
    const now = detectInCall();
    if (now !== inCall) { inCall = now; render(); }
    pollCallLifecycle();
  }

  // --- Call lifecycle -------------------------------------------------------
  // Leaving a call keeps the meeting code in the URL: Meet just swaps the
  // in-call UI for its "You left the meeting" screen. The in-call markers are
  // the mic/camera toggles (data-is-muted) and the leave button; once they
  // were seen during a recording and then vanish, the call is over and the
  // service worker is told so it can end the recording (after a grace
  // period — a rejoin reports WN_CALL_RESUMED). Gated on the markers having
  // been seen at all, so a Meet redesign degrades to "no auto-stop", never to
  // "stops every recording".
  const LEAVE_RE = /leave call|quitter l.appel|end call|hang up|raccrocher|anruf verlassen|salir de la llamada/i;
  function detectCallUI() {
    if (document.querySelector("[data-is-muted]")) return true;
    for (const b of document.querySelectorAll("button[aria-label], [role=button][aria-label]")) {
      if (LEAVE_RE.test(b.getAttribute("aria-label") || "")) return true;
    }
    return false;
  }
  let callUiSeen = false;    // markers observed while the current recording ran
  let inactivePolls = 0;     // consecutive polls without them (debounce)
  let endedReported = false;
  function pollCallLifecycle() {
    if ((state.phase || "idle") !== "recording") {
      callUiSeen = false; inactivePolls = 0; endedReported = false;
      return;
    }
    if (inCall && detectCallUI()) {
      callUiSeen = true;
      inactivePolls = 0;
      if (endedReported) { endedReported = false; send("WN_CALL_RESUMED"); }
      return;
    }
    if (!callUiSeen || endedReported) return;
    if (++inactivePolls >= 2) { endedReported = true; send("WN_CALL_ENDED"); }
  }

  // --- Theme --------------------------------------------------------------
  // Mirror the extension's Theme setting for the pill + docked panel. "system"
  // follows the OS live; the choice is read from storage and watched for edits.
  const themeMQ = window.matchMedia("(prefers-color-scheme: dark)");
  let themeMode = "system";
  function resolveTheme() {
    if (themeMode === "light" || themeMode === "dark") return themeMode;
    return themeMQ.matches ? "dark" : "light";
  }
  function repaintTheme() {
    const next = PALETTES[resolveTheme()];
    if (next === P) return;
    P = next;
    if (panelHost) {
      panelHost.style.background = P.panelBg;
      panelHost.style.borderLeft = `1px solid ${P.panelBorder}`;
    }
    if (host) { unmount(); render(); } // rebuild the pill with the new palette
  }
  P = PALETTES[resolveTheme()]; // synchronous best guess before the first paint
  themeMQ.addEventListener("change", repaintTheme);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.wn_settings) {
      themeMode = changes.wn_settings.newValue?.theme || "system";
      repaintTheme();
    }
  });
  chrome.storage.local
    .get("wn_settings")
    .then(({ wn_settings }) => { themeMode = wn_settings?.theme || "system"; repaintTheme(); })
    .catch(() => {});

  setInterval(poll, 1500);
  poll();
  refreshState();
})();
