// Service worker: the coordination hub. It owns the offscreen-document
// lifecycle, routes messages between the panel (an iframe the content script
// docks over the Meet page), the pill and the offscreen recorder, and keeps a
// small "recorder state" that every surface mirrors.
//
// Recording can live in TWO hosts:
//   - offscreen document ("offscreen"): silent tabCapture path — used when the
//     call's tab carries the activeTab grant (icon click / context menu / ⌘⇧9)
//     or a Chromium that honors the meet.google.com host permission;
//   - the panel iframe ("panel"): getDisplayMedia fallback — used when silent
//     capture is refused, since the standard share dialog needs no grant and
//     exists in every Chromium (Arc included).
import * as store from "./lib/store.js";
import * as sb from "./lib/supabase.js";
import { STAGE_LABELS } from "./lib/pipeline.js";

const OFFSCREEN_PATH = "offscreen.html";
// The Winday CRM web app (same Supabase project as the extension) — used for
// web sign-in. winday-auth.js runs there and bridges the session back.
const WINDAY_WEB_URL = "https://crm.winday.app/";
let authTabId = null; // the sign-in tab, while open

// --- Recorder state (mirrored to storage so the UI survives SW restarts) --

let state = {
  phase: "idle", // idle | recording | processing | done | failed
  meetingId: null,
  title: null,
  startedAt: null,
  stage: null, // pipeline stage key while processing
  notionURL: null,
  error: null,
  recorderHost: null, // "offscreen" | "panel" while recording
  recordingTabId: null, // the Meet tab being captured, while recording
  imminentCall: null, // {title, meet_url, start} from the calendar, for the pill
  panelOpen: false, // a NATIVE side panel is open somewhere (pill hides itself)
};

async function loadState() {
  const saved = (await chrome.storage.local.get("wn_recorder_state")).wn_recorder_state;
  if (saved) state = saved;
  // Presence is live-only: after a SW restart no port is connected yet, so
  // never resurrect a stale "open" flag (the panel re-connects immediately).
  state.panelOpen = false;
}

// --- Panel presence -------------------------------------------------------
// The side panel page holds a long-lived port while it exists; the Meet pill
// hides whenever a NATIVE panel is open (the docked iframe is tracked by the
// content script itself, which owns it and knows when it is visible).
const panelPorts = new Set();
// Recorder-host liveness: whichever document is recording (offscreen, native
// panel or docked iframe) — or running a pipeline — holds a "wn-recorder"
// port. If every such port is gone while the state still says
// recording/processing, the host died (panel closed, tab closed, restart):
// the offscreen document then rebuilds the meeting from the crash journal
// that lib/capture.js writes as it records, so the user still gets the
// transcript + summary of everything captured up to that moment.
const recorderPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "wn-recorder") {
    recorderPorts.add(port);
    port.onDisconnect.addListener(() => {
      recorderPorts.delete(port);
      if (recorderPorts.size === 0) scheduleRecoveryCheck(2500);
    });
    return;
  }
  if (port.name !== "wn-panel-native") return;
  panelPorts.add(port);
  if (panelPorts.size === 1) setState({ panelOpen: true });
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    if (panelPorts.size === 0) setState({ panelOpen: false });
  });
});

let recoveryTimer = null;
let recovering = false;
// Give a live host a moment to (re)connect its port — a service-worker restart
// also drops ports without anything actually dying.
function scheduleRecoveryCheck(delayMs) {
  if (!["recording", "processing"].includes(state.phase)) return;
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => { maybeRecover().catch(() => {}); }, delayMs);
}

async function maybeRecover() {
  if (recovering) return;
  if (!["recording", "processing"].includes(state.phase)) return;
  if (recorderPorts.size > 0) return; // a host is alive — nothing to do
  recovering = true;
  try {
    const session = await store.getSession();
    if (!session) {
      await setState({ phase: "failed", stage: null, error: "The recording was interrupted.", recorderHost: null });
      return;
    }
    await setState({ phase: "processing", stage: "uploading", recorderHost: null });
    await ensureOffscreen();
    await sendToOffscreen({ type: "RECOVER", session, settings: await store.getSettings() });
  } finally {
    recovering = false;
  }
}
async function setState(patch) {
  state = { ...state, ...patch };
  await chrome.storage.local.set({ wn_recorder_state: state });
  broadcast();
}

function broadcast() {
  const msg = { type: "WN_STATE", state };
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  });
}

// --- Offscreen document lifecycle ---------------------------------------

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification:
      "Record the meeting tab audio and your microphone, then upload and process the recording.",
  });
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...message }).catch(() => {});
}

// --- Message handling ----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // WN_OPEN_PANEL is handled synchronously: in native mode, sidePanel.open()
  // consumes the user-gesture token from the pill's click, and that token
  // does not survive an `await`. In docked mode the content script is told to
  // open its own iframe.
  if (msg?.type === "WN_OPEN_PANEL") {
    if (panelModeCache === "native" && chrome.sidePanel && sender?.tab) {
      // WINDOW-scoped (not tab-scoped): a tab-scoped panel is destroyed the
      // moment the user switches tabs, which used to kill a panel-hosted
      // recording mid-call. The window-scoped panel survives tab switches.
      chrome.sidePanel
        .open(sender.tab.windowId != null ? { windowId: sender.tab.windowId } : { tabId: sender.tab.id })
        .then(() => sendResponse({ ok: true, mode: "native" }))
        .catch((e) => sendResponse({ ok: false, mode: "native", error: String(e?.message || e) }));
    } else {
      sendResponse({ ok: true, mode: "docked" });
    }
    return true;
  }
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

async function handle(msg, sender) {
  switch (msg.type) {
    case "WN_GET_STATE": {
      const [session, meetings, settings, micGranted] = await Promise.all([
        store.getSession(),
        store.getMeetings(),
        store.getSettings(),
        store.getMicGranted(),
      ]);
      return { ok: true, state, session, meetings, settings, micGranted };
    }

    // --- Web sign-in (Winday CRM, same Supabase project) ---
    case "WN_SIGN_IN_WEB": {
      // Open the CRM in a new tab in the current window. Its content script
      // (winday-auth.js) reads the Supabase session from localStorage —
      // instantly if the user is already logged in there, otherwise once they
      // finish — and posts it back via WN_WEB_SESSION.
      try {
        if (authTabId != null) {
          // A sign-in tab is already open — just bring it to the front.
          await chrome.tabs.update(authTabId, { active: true }).catch(() => {});
          return { ok: true };
        }
        const tab = await chrome.tabs.create({ url: WINDAY_WEB_URL, active: true });
        authTabId = tab.id;
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }

    case "WN_WEB_SESSION": {
      const s = msg.session;
      if (!s || !s.accessToken || !s.refreshToken) return { ok: false, error: "Invalid session." };
      // The bridged session belongs to the CRM web app, which keeps rotating
      // its refresh token — a shared copy soon dies with "Invalid Refresh
      // Token: Already Used" (faster still across several devices). Exchange
      // it right away for THIS device's own session (its own token family);
      // fall back to the shared copy only if the exchange fails.
      let own = null;
      try {
        sb.useSession(s, null);
        own = await sb.exchangeForOwnSession();
      } catch (_) { /* offline / function unavailable — shared copy still works */ }
      const final = own || s;
      sb.useSession(final, (ns) => store.setSession(ns).catch(() => {}), () => store.getSession());
      await store.setSession(final);
      broadcast();
      // Close the sign-in tab we opened (best-effort).
      if (authTabId != null) {
        chrome.tabs.remove(authTabId).catch(() => {});
        authTabId = null;
      }
      return { ok: true };
    }

    // Latest persisted session, for contexts without chrome.storage (offscreen).
    case "WN_GET_SESSION":
      return { ok: true, session: await store.getSession() };

    case "WN_RECORD_TAB": {
      // Try the SILENT path: mint a tabCapture stream id here and record in
      // the offscreen document. When Chromium refuses (no activeTab grant on
      // the call's tab), tell the panel to run the getDisplayMedia fallback
      // itself — the share dialog needs no grant.
      const tab = await resolveMeetTab(msg.tabId, sender);
      if (!tab) return { ok: false, error: "No Google Meet tab found — open your call, then try again." };
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        return await beginRecording({ streamId, title: msg.title || titleFromTab(tab), calendar: msg.calendar, tabId: tab.id });
      } catch (_) {
        return { ok: false, needsPickerFallback: true, title: msg.title || titleFromTab(tab), tabId: tab.id };
      }
    }

    // The NATIVE side panel refuses to host a fallback recording (the capture
    // dies with the panel document): dock the panel iframe in the call's tab,
    // bring that tab forward, and let the user start the capture from there —
    // a host that survives the side panel closing and tab switches.
    case "WN_FALLBACK_TO_TAB": {
      const tab = await resolveMeetTab(msg.tabId, sender);
      if (!tab) return { ok: false, error: "No Google Meet tab found — open your call, then try again." };
      // Arm the content script FIRST: while armed it keeps the docked overlay
      // visible even though the native panel is open (its usual self-heal
      // hides the redundant overlay — here the overlay is the whole point).
      await chrome.tabs.sendMessage(tab.id, { type: "WN_ARM_FALLBACK" }).catch(() => {});
      await openPanelInTab(tab); // re-injects a stale content script if needed
      await chrome.tabs.sendMessage(tab.id, { type: "WN_ARM_FALLBACK" }).catch(() => {});
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      // CTA inside the embedded panel — sent twice, the iframe may still be
      // booting when the first broadcast fires.
      chrome.runtime.sendMessage({ type: "WN_ARM_FALLBACK" }).catch(() => {});
      setTimeout(() => chrome.runtime.sendMessage({ type: "WN_ARM_FALLBACK" }).catch(() => {}), 1200);
      return { ok: true };
    }

    // The panel started a fallback (getDisplayMedia) recording in its iframe.
    case "WN_PANEL_REC_STARTED":
      clearCallEndedTimer();
      await setState({
        phase: "recording",
        meetingId: msg.meeting?.id || null,
        title: msg.meeting?.title || null,
        startedAt: msg.meeting?.startedAt || new Date().toISOString(),
        stage: null,
        notionURL: null,
        error: null,
        recorderHost: "panel",
        recordingTabId: sender?.tab?.id ?? null,
      });
      return { ok: true };

    case "WN_STOP":
      await stopRecording();
      return { ok: true };

    case "WN_CANCEL":
      if (state.phase === "recording") {
        if (state.recorderHost === "panel") chrome.runtime.sendMessage({ type: "WN_PANEL_CANCEL" }).catch(() => {});
        else await sendToOffscreen({ type: "CANCEL" });
      }
      clearCallEndedTimer();
      await setState({ phase: "idle", meetingId: null, stage: null, error: null, recorderHost: null, recordingTabId: null });
      return { ok: true };

    case "WN_DISMISS":
      await setState({ phase: "idle", stage: null, error: null, notionURL: null, recorderHost: null, recordingTabId: null });
      return { ok: true };

    // --- call lifecycle, reported by the Meet content script ---
    // The user left the call (Meet shows its "You left" screen) but the tab is
    // still open: without this the recording would run until someone remembers
    // to press Stop. A short grace period covers a flaky DOM read or a quick
    // rejoin — WN_CALL_RESUMED from the same tab cancels the pending stop.
    case "WN_CALL_ENDED":
      if (state.phase === "recording" && sender?.tab?.id != null && sender.tab.id === state.recordingTabId) {
        armCallEndedTimer();
      }
      return { ok: true };

    case "WN_CALL_RESUMED":
      if (sender?.tab?.id != null && sender.tab.id === state.recordingTabId) clearCallEndedTimer();
      return { ok: true };

    // --- recorder host -> background lifecycle events ---
    case "WN_REC_STARTED":
      return { ok: true };

    case "WN_REC_STAGE":
      clearCallEndedTimer();
      await setState({ phase: "processing", stage: msg.stage, recorderHost: null, recordingTabId: null });
      return { ok: true };

    case "WN_REC_DONE":
      clearCallEndedTimer();
      await setState({ phase: "done", stage: null, notionURL: msg.notionURL || null, error: null, recorderHost: null, recordingTabId: null });
      return { ok: true };

    case "WN_REC_FAILED":
      clearCallEndedTimer();
      await setState({ phase: "failed", stage: null, error: msg.error || "Processing failed.", recorderHost: null, recordingTabId: null });
      return { ok: true };

    // --- Actions on past meetings (run in offscreen so they survive) ---
    case "WN_RETRY": {
      const session = await store.getSession();
      if (!session) return { ok: false, error: "Not available." };
      sb.useSession(session, (s) => store.setSession(s), () => store.getSession());
      const local = (await store.getMeetings()).find((m) => m.id === msg.id) || null;
      // The server row is the truth about what already succeeded. A pipeline
      // can die AFTER the audio was uploaded and the transcript written (the
      // transcription call errored on its way back), leaving a local copy
      // that says "nothing was ever saved" — and a Retry that refused to run.
      // Synced meetings (another device, aged out of the cache) come from the
      // same row.
      const remote = await sb.getMeeting(msg.id).catch(() => null);
      const meeting = mergeForRetry(local, remote);
      if (!meeting) return { ok: false, error: "Not available." };
      await ensureOffscreen();
      await setState({ phase: "processing", meetingId: meeting.id, stage: null, error: null });
      await sendToOffscreen({ type: "RETRY", meeting, session, settings: await store.getSettings() });
      return { ok: true };
    }

    // A transcript file the user imported: same pipeline as a recorded call,
    // minus the audio. Runs in the offscreen document so it survives the panel
    // being closed mid-summary.
    case "WN_IMPORT": {
      const session = await store.getSession();
      if (!session || !msg.meeting) return { ok: false, error: "Not available." };
      await store.upsertMeeting({ ...msg.meeting, transcript: msg.transcript, status: "summarizing" });
      await ensureOffscreen();
      await setState({
        phase: "processing",
        meetingId: msg.meeting.id,
        title: msg.meeting.title,
        stage: "summarizing",
        error: null,
        notionURL: null,
      });
      await sendToOffscreen({
        type: "IMPORT",
        meeting: msg.meeting,
        transcript: msg.transcript,
        session,
        settings: await store.getSettings(),
      });
      return { ok: true };
    }

    case "WN_EXPORT": {
      const meeting = (await store.getMeetings()).find((m) => m.id === msg.id);
      const session = await store.getSession();
      if (!meeting || !session) return { ok: false, error: "Not available." };
      await ensureOffscreen();
      await setState({ phase: "processing", meetingId: meeting.id, stage: "exporting", error: null });
      await sendToOffscreen({ type: "EXPORT", meeting, session, settings: await store.getSettings() });
      return { ok: true };
    }

    case "WN_DISCARD":
      await store.removeMeeting(msg.id);
      broadcast();
      return { ok: true };

    // --- persistence relays (recorder hosts do not own chrome.storage) ---
    case "WN_MEETING_UPSERT":
      await store.upsertMeeting(msg.meeting);
      broadcast();
      return { ok: true };

    case "WN_MEETING_REMOVE":
      await store.removeMeeting(msg.id);
      broadcast();
      return { ok: true };

    case "WN_MIC_GRANTED":
      await store.setMicGranted(true);
      broadcast();
      return { ok: true };

    case "WN_SESSION_REFRESHED":
      if (msg.session) await store.setSession(msg.session);
      return { ok: true };

    // A context hit a REVOKED refresh token: the session is dead everywhere.
    // Clear it once so every surface flips to the Log In screen (and every
    // timer stops hammering the auth endpoint) instead of erroring forever.
    case "WN_SESSION_DEAD":
      if (await store.getSession()) {
        await store.setSession(null);
        sb.signOut();
        broadcast();
      }
      return { ok: true };

    case "WN_SETTINGS_CHANGED":
      await refreshPanelMode();
      broadcast();
      return { ok: true };

    // The panel's ✕: ask its host page to hide the docked iframe.
    case "WN_CLOSE_PANEL":
      if (sender?.tab?.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: "WN_TOGGLE_PANEL", ensure: "close" }).catch(() => {});
      }
      return { ok: true };

    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

/** The local copy of a meeting, completed with whatever the server already
 *  holds: audio path, transcript, summary. Local wins for the fields it has. */
function mergeForRetry(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const hasUtts = (t) => !!(t && t.utterances && t.utterances.length);
  return {
    ...local,
    audioPath: local.audioPath || remote.audioPath || null,
    transcript: hasUtts(local.transcript) ? local.transcript
      : hasUtts(remote.transcript) ? remote.transcript : (local.transcript || null),
    summary: local.summary || remote.summary || null,
    notionPageURL: local.notionPageURL || remote.notionPageURL || null,
    participants: remote.participants || local.participants || null,
    calendar: local.calendar || remote.calendar || null,
  };
}

/** Starts an offscreen (silent-path) recording from a tabCapture stream id. */
async function beginRecording({ streamId, title, calendar, tabId }) {
  if (state.phase === "recording") return { ok: false, error: "Already recording." };
  const session = await store.getSession();
  if (!session) return { ok: false, error: "Sign in first." };
  const settings = await store.getSettings();
  const meeting = {
    id: crypto.randomUUID(),
    title: title || `Meeting ${new Date().toLocaleString()}`,
    startedAt: new Date().toISOString(),
    calendar: calendar || null,
  };
  clearCallEndedTimer(); // a leftover grace timer must not end THIS recording
  await ensureOffscreen();
  await setState({
    phase: "recording",
    meetingId: meeting.id,
    title: meeting.title,
    startedAt: meeting.startedAt,
    stage: null,
    notionURL: null,
    error: null,
    recorderHost: "offscreen",
    recordingTabId: tabId ?? null,
  });
  await sendToOffscreen({ type: "START", streamId, meeting, session, settings });
  return { ok: true, meetingId: meeting.id };
}

/** Stops the in-flight recording, whichever host holds it. */
async function stopRecording() {
  clearCallEndedTimer();
  if (state.phase !== "recording") return;
  if (state.recorderHost === "panel") {
    // The panel host may already be dead (closed mid-recording): recover
    // from the journal instead of messaging into the void.
    if (recorderPorts.size === 0) scheduleRecoveryCheck(1);
    else chrome.runtime.sendMessage({ type: "WN_PANEL_STOP" }).catch(() => {});
  } else await sendToOffscreen({ type: "STOP" });
}

// --- Auto-stop: the call is over, so the recording is too -----------------
// A recording used to outlive its call by hours whenever Stop was forgotten.
// Three signals end it now:
//   - the captured tab's audio track ends (tab closed) — handled inside the
//     recorder itself (lib/capture.js);
//   - the captured tab is closed or navigates away from the call — watched
//     here through the tabs API;
//   - the user leaves the call while the tab stays open — reported by the
//     content script (WN_CALL_ENDED), applied after a short grace period held
//     by an alarm so it survives a service-worker suspension.
const CALL_ENDED_ALARM = "wn-call-ended";
const CALL_ENDED_GRACE_MIN = 0.5;

function armCallEndedTimer() {
  chrome.alarms?.create(CALL_ENDED_ALARM, { delayInMinutes: CALL_ENDED_GRACE_MIN });
}
function clearCallEndedTimer() {
  chrome.alarms?.clear(CALL_ENDED_ALARM).catch(() => {});
}

async function onRecordedTabGone(tabId) {
  if (state.phase !== "recording" || tabId !== state.recordingTabId) return;
  await stopRecording();
}

chrome.tabs.onRemoved.addListener((tabId) => { onRecordedTabGone(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (state.phase !== "recording" || tabId !== state.recordingTabId) return;
  // Still on the call (Meet keeps the meeting code in the URL after you leave,
  // which the content script covers) — only a navigation elsewhere ends it here.
  if (isCallTab(tab)) return;
  onRecordedTabGone(tabId).catch(() => {});
});

// --- Meet tab helpers, toolbar icon, context menu ------------------------

const MEET_URL = /^https:\/\/meet\.google\.com\//;

function isMeetTab(tab) {
  return !!tab?.id && MEET_URL.test(tab.url || "");
}

// An ACTIVE call (the "abc-defg-hij" code path), vs. the Meet home/lobby.
const CALL_PATH = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/i;
function isCallTab(tab) {
  if (!isMeetTab(tab)) return false;
  try { return CALL_PATH.test(new URL(tab.url).pathname); } catch (_) { return false; }
}

/** The tab to record: explicit id, else the panel's host tab (the panel is an
 *  iframe inside the Meet page, so sender.tab IS the call's tab), else any
 *  open Meet tab (audible first, then most recently used). */
async function resolveMeetTab(explicitId, sender) {
  if (explicitId != null) {
    const tab = await chrome.tabs.get(explicitId).catch(() => null);
    if (tab) return tab;
  }
  if (isMeetTab(sender?.tab)) return sender.tab;
  const meetTabs = await new Promise((resolve) =>
    chrome.tabs.query({ url: "https://meet.google.com/*" }, resolve),
  );
  if (!meetTabs || meetTabs.length === 0) return null;
  return meetTabs.find((t) => t.audible) ||
    meetTabs.slice().sort((a, z) => (z.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

function titleFromTab(tab) {
  let t = (tab?.title || "").replace(/\s*[-–]\s*Google Meet\s*$/i, "").replace(/^Meet\s*[-–]\s*/i, "").trim();
  if (!t || /^meet\.google\.com/i.test(t)) t = `Meeting ${new Date().toLocaleString()}`;
  return t;
}

/** Opens the docked panel in a Meet tab, injecting the content script if the
 *  copy in the page went stale (e.g. after an extension reload). */
async function openPanelInTab(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "WN_TOGGLE_PANEL", ensure: "open" });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "WN_TOGGLE_PANEL", ensure: "open" });
    } catch (_) {
      /* tab not reachable */
    }
  }
}

// --- Panel mode ------------------------------------------------------------
// "native": the browser renders its real side panel (Chrome, Dia) — the icon
// click opens it via setPanelBehavior, and pushes the page natively.
// "docked": browsers that never render that UI (Arc) — the icon click reaches
// action.onClicked (the behavior flag is off) and we dock the iframe instead.
// Cached in memory so gesture-sensitive paths never await storage.
let panelModeCache = "native";

async function refreshPanelMode() {
  const settings = await store.getSettings();
  panelModeCache = settings.panelMode === "docked" ? "docked" : "native";
  // We open the panel ourselves in action.onClicked (so the same click can also
  // grant activeTab and start recording), so the automatic open stays off.
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

// Toolbar icon (and ⌘⇧9 via _execute_action). On an active Meet call this is
// the zero-picker record path: the click grants activeTab, so we capture that
// exact tab silently — no "which tab?" share dialog — and open the panel to
// show the live transcript. On other Meet pages, just open the panel; elsewhere,
// open the full-tab dashboard.
chrome.action.onClicked.addListener((tab) => {
  // Open the panel synchronously — the native side panel needs this click's
  // user-gesture token, which an await would drop. WINDOW-scoped so it
  // survives tab switches (a recording may be hosted inside it).
  if (panelModeCache === "native" && chrome.sidePanel) {
    chrome.sidePanel.open(
      tab && tab.windowId != null ? { windowId: tab.windowId }
        : tab && tab.id != null ? { tabId: tab.id } : {},
    ).catch(() => {});
  } else if (isMeetTab(tab)) {
    openPanelInTab(tab);
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html") });
  }
  // In a call and idle → record it silently (the click just granted activeTab).
  if (isCallTab(tab) && state.phase === "idle") recordFromMenu(tab);
});

function ensureMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "wn-record",
      title: "Winday Meet — Record this call",
      contexts: ["page"],
      documentUrlPatterns: ["https://meet.google.com/*"],
    });
    chrome.contextMenus.create({
      id: "wn-panel",
      title: "Winday Meet — Open the panel",
      contexts: ["page"],
      documentUrlPatterns: ["https://meet.google.com/*"],
    });
  });
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!isMeetTab(tab)) return;
  // Open the panel synchronously first: in native mode sidePanel.open() needs
  // the menu click's user-gesture token, which an `await` would drop.
  // WINDOW-scoped: survives tab switches (see action.onClicked).
  if (panelModeCache === "native" && chrome.sidePanel) {
    chrome.sidePanel.open(tab.windowId != null ? { windowId: tab.windowId } : { tabId: tab.id }).catch(() => {});
  } else {
    openPanelInTab(tab);
  }
  if (info.menuItemId === "wn-record") {
    // The menu click grants activeTab: capture silently.
    recordFromMenu(tab);
  }
});

async function recordFromMenu(tab) {
  if (state.phase === "recording") return;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await beginRecording({ streamId, title: titleFromTab(tab), tabId: tab.id });
  } catch (e) {
    await setState({ phase: "failed", stage: null, error: String(e?.message || e) });
  }
}

// Expose stage labels to any page that wants them via a getter message.
export { STAGE_LABELS };

// If the user closes the sign-in tab themselves, forget it.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === authTabId) authTabId = null;
});

// --- Calendar: surface the next imminent scheduled call to the pill --------
// Polled ~every minute (chrome.alarms survives SW suspension). The pill shows
// ~2 min before a scheduled Meet call so the user can join and start recording.
async function refreshUpcoming() {
  let imminent = null;
  try {
    const session = await store.getSession();
    if (session) {
      sb.useSession(session, (s) => store.setSession(s), () => store.getSession());
      const r = await sb.fetchUpcomingMeetings(2); // starts within 2 min or ongoing
      const m = (r && r.meetings && r.meetings[0]) || null;
      if (m) {
        imminent = {
          title: m.title || "Meeting",
          meet_url: m.meet_url || null,
          start: m.start || null,
          // What the recorder needs to link the meeting to the event's
          // company and contacts (same shape the panel builds).
          calendar: {
            googleEventID: m.google_event_id || null,
            contactIDs: m.contact_ids || [],
            companyID: m.company_id || null,
            companyName: m.company_name || null,
            companyLogoURL: m.company_logo_url || null,
            meetURL: m.meet_url || null,
          },
        };
      }
    }
  } catch (e) {
    // Dead session discovered by the SW itself (it can't receive its own
    // runtime message): sign the extension out cleanly.
    if (sb.isSessionDead(e)) {
      await store.setSession(null);
      sb.signOut();
      broadcast();
    }
    /* otherwise: calendar not connected / offline — no prompt */
  }
  if (JSON.stringify(imminent) !== JSON.stringify(state.imminentCall || null)) {
    await setState({ imminentCall: imminent });
  }
}
chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === "wn-upcoming") refreshUpcoming();
  // Grace period over and the call was not resumed: end the recording.
  if (a.name === CALL_ENDED_ALARM) stopRecording().catch(() => {});
});

function boot() {
  loadState().then(() => {
    // The state says a recording/pipeline is in flight. If its host doesn't
    // announce itself within a few seconds (a healthy one reconnects its
    // wn-recorder port right away), it died with the browser/extension —
    // recover the journaled audio + transcript so the meeting isn't lost.
    if (["recording", "processing"].includes(state.phase)) scheduleRecoveryCheck(5000);
  });
  ensureMenus();
  refreshPanelMode();
  chrome.alarms?.create("wn-upcoming", { periodInMinutes: 1 });
  refreshUpcoming();
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();
