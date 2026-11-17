// The panel UI. Hosted as an iframe the content script docks over the Meet
// page (also usable as a full-tab dashboard from the toolbar icon elsewhere).
// Responsibilities: sign-in, the record trigger, live recording and pipeline
// status, and the recordings list.
//
// Recording starts through the service worker's SILENT path (tabCapture in
// the offscreen document) whenever the call's tab carries the activeTab grant
// (icon click / context menu / ⌘⇧9). When Chromium refuses, the panel runs
// the fallback ITSELF: getDisplayMedia — the standard share dialog, which
// needs no grant and exists in every Chromium (Arc included). Since the panel
// iframe lives inside the Meet tab, `preferCurrentTab` offers that very tab
// in one click, and the shared recording engine (lib/capture.js) runs here.
import * as sb from "../lib/supabase.js";
import * as store from "../lib/store.js";
import { createRecorder, acquireMic, requestMicPermission } from "../lib/capture.js";
import { applyTheme } from "../lib/theme.js";
import { icon } from "../lib/icons.js";

const $ = (id) => document.getElementById(id);

// Paint the static Hugeicons (header, banner) from their data-icon attribute.
function paintIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]:not([data-icon-done])")) {
    el.prepend(icon(el.dataset.icon, Number(el.dataset.iconSize) || 18));
    el.setAttribute("data-icon-done", "");
  }
}

// Apply the saved Theme choice as early as possible, then keep it in sync
// whenever settings change (the service worker broadcasts WN_STATE on save).
async function syncTheme() {
  const s = await store.getSettings();
  applyTheme(s.theme);
}
syncTheme();
let state = { phase: "idle" };
let meetings = [];        // local cache (in-flight + recent, from chrome.storage)
let remoteMeetings = [];  // durable history from Supabase (all devices)
let session = null;
let micGranted = false;
let timer = null;

// Pull the durable meeting history from Supabase and merge it with the local
// cache (local wins per id — it carries the freshest status mid-pipeline).
async function syncRemoteMeetings() {
  if (!session) return;
  sb.useSession(
    session,
    (s) => chrome.runtime.sendMessage({ type: "WN_SESSION_REFRESHED", session: s }).catch(() => {}),
    () => store.getSession(),
  );
  try {
    remoteMeetings = await sb.listMeetings(50);
    render();
  } catch (_) { /* offline / not signed in — keep the local list */ }
}

function allMeetings() {
  const byId = new Map();
  for (const m of remoteMeetings) byId.set(m.id, m);
  for (const m of meetings) byId.set(m.id, { ...byId.get(m.id), ...m }); // local overrides
  return [...byId.values()].sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
}

// Today's still-to-come calendar calls (with a Meet link), shown as their own
// section above the recordings so the user can see what's ahead. Source: the
// upcoming-meetings function, asked for a window that ends at LOCAL midnight —
// so strictly today, never tomorrow.
let upcoming = [];

async function syncUpcoming() {
  if (!session) { upcoming = []; paintUpcoming(); return; }
  try {
    const eod = new Date();
    eod.setHours(23, 59, 59, 999);
    const minutesLeftToday = Math.max(1, Math.ceil((eod.getTime() - Date.now()) / 60000));
    const r = await sb.fetchUpcomingMeetings(minutesLeftToday);
    upcoming = ((r && r.meetings) || [])
      .filter((m) => m.start)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  } catch (_) { upcoming = []; /* calendar not connected / offline */ }
  paintUpcoming();
}

function paintUpcoming() {
  const box = $("upcoming");
  if (!box) return;
  $("upcoming-section").classList.toggle("hidden", upcoming.length === 0);
  box.innerHTML = "";
  for (const m of upcoming) box.append(upcomingRow(m));
}

function upcomingRow(m) {
  const row = div("item upcoming");
  const start = new Date(m.start);
  const started = Date.now() >= start.getTime();

  const chip = div("up-time" + (started ? " now" : ""));
  chip.textContent = started ? "Now" : start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const main = document.createElement("div");
  main.style.flex = "1";
  main.style.overflow = "hidden";
  const title = div("title"); title.textContent = m.title || "Meeting";
  const sub = div("sub"); sub.textContent = m.company_name || "Scheduled call";
  main.append(title, sub);

  const actions = div("item-actions");
  if (m.meet_url) actions.append(iconBtn("join", "Open the call", () => chrome.tabs.create({ url: m.meet_url })));

  row.append(chip, main, actions);
  return row;
}

// Live session state (during + right after a recording).
let liveUtterances = [];      // committed finals: { channel, speaker, text }
let interim = {};             // in-progress text per channel: { 0:{speaker,text}, 1:{…} }
let vizBars = null;           // latest visualizer levels (array of 0..1)
let activeTab = "transcript"; // which session tab is shown
let viewingId = null;         // a past meeting opened from the list (read-only)

// --- Boot ----------------------------------------------------------------

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "WN_GET_STATE" }).catch(() => null);
  if (r) {
    state = r.state || { phase: "idle" };
    meetings = r.meetings || [];
    session = r.session || null;
    micGranted = r.micGranted || false;
  } else {
    session = await store.getSession();
    meetings = await store.getMeetings();
  }
  render();
  syncRemoteMeetings(); // pull durable history (re-renders when it lands)
  syncUpcoming(); // today's calendar calls (paints its own section)
}

// Live transcript + visualizer events. They reach an open panel over runtime
// messaging when the OFFSCREEN document hosts recording; when THIS panel hosts
// it, capture.js delivers them through its onEvent hook (a context can't
// receive its own runtime messages).
function handleRecEvent(msg) {
  if (msg.type === "WN_TRANSCRIPT") {
    const ch = msg.channel || 0;
    if (msg.isFinal) {
      if (msg.text) liveUtterances.push({ channel: ch, speaker: msg.speaker, text: msg.text });
      delete interim[ch];
    } else {
      interim[ch] = { speaker: msg.speaker, text: msg.text };
    }
    // Redraw only when the live session's transcript pane is actually on screen
    // (never while the user is viewing a PAST meeting — don't clobber it).
    if (!viewingId && !$("session-view").classList.contains("hidden") && activeTab === "transcript") renderTranscript();
  } else if (msg.type === "WN_REC_LEVEL") {
    vizBars = msg.bars;
    renderViz();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "WN_STATE") {
    const prev = state.phase;
    state = msg.state || { phase: "idle" };
    // A fresh recording clears the previous session's transcript; finishing one
    // (transcript done) flips to the Summary tab — the requested flow.
    if (prev !== "recording" && state.phase === "recording") {
      liveUtterances = []; interim = {}; vizBars = null; activeTab = "transcript"; viewingId = null;
    }
    if (prev === "recording" && state.phase !== "recording") activeTab = "summary";
    // Re-read session + micGranted from storage (web sign-in / mic grant happen
    // in the service worker and only broadcast WN_STATE).
    const hadSession = !!session;
    Promise.all([store.getMeetings(), store.getMicGranted(), store.getSession()]).then(([m, mic, sess]) => {
      meetings = m;
      micGranted = mic;
      session = sess;
      render();
      // Refresh the durable list when signing in, or after a call is saved.
      if (session && (!hadSession || state.phase === "done")) { syncRemoteMeetings(); syncUpcoming(); }
    });
    syncTheme(); // a settings change (e.g. Theme) also arrives as WN_STATE
  }
  if (msg?.type === "WN_TRANSCRIPT" || msg?.type === "WN_REC_LEVEL") handleRecEvent(msg);
  // Stop/cancel routed by the service worker when THIS panel hosts the recording.
  if (msg?.type === "WN_PANEL_STOP") panelRecorder?.stop(false);
  if (msg?.type === "WN_PANEL_CANCEL") panelRecorder?.stop(true);
});

// --- Render --------------------------------------------------------------

function render() {
  if (timer) { clearInterval(timer); timer = null; }
  const signedIn = !!session;
  $("signin").classList.toggle("hidden", signedIn);
  $("main").classList.toggle("hidden", !signedIn);
  if (!signedIn) return;

  $("mic-banner").classList.toggle("hidden", micGranted);

  // Viewing a past meeting from the list (read-only) takes over the session view.
  const viewing = viewingId ? allMeetings().find((m) => m.id === viewingId) : null;
  if (viewingId && !viewing) viewingId = null;

  const phase = state.phase;
  const liveSession = phase === "recording" || phase === "processing" || phase === "done" || phase === "failed";
  const inSession = liveSession || !!viewing;

  $("list-view").classList.toggle("hidden", inSession);
  $("session-view").classList.toggle("hidden", !inSession);
  $("btn-back").classList.toggle("hidden", !(viewing || phase === "done" || phase === "failed"));

  if (viewing) renderViewing(viewing);
  else if (liveSession) renderSession();
  else renderList();
  renderBottomBar();
}

// --- Session view (live recording, or a viewed past meeting) --------------

function renderSession() {
  const recording = state.phase === "recording";
  $("tab-btn-summary").disabled = recording; // no summary until the transcript is done
  if (recording && activeTab === "summary") activeTab = "transcript";
  setTab(activeTab);

  renderTranscript();

  if (state.phase === "processing") summaryPending(span("spinner"), text(stageLabel(state.stage)));
  else if (state.phase === "failed") summaryFailed(state.error, state.meetingId);
  else renderSummaryFor(allMeetings().find((x) => x.id === state.meetingId) || null);
}

// Light redraw of the LIVE transcript bubbles only — this is the hot path, run
// on every streaming event, so it skips the rest of the session view.
function renderTranscript() {
  const recording = state.phase === "recording";
  const bubbles = liveUtterances.slice();
  for (const ch of Object.keys(interim)) {
    const it = interim[ch];
    if (it && it.text) bubbles.push({ channel: Number(ch), speaker: it.speaker, text: it.text, interim: true });
  }
  renderBubbles(bubbles, recording ? "Listening… speech appears here as it's spoken." : "No transcript.", recording);
}

function renderViewing(m) {
  $("tab-btn-summary").disabled = false;
  if (!m.summary && activeTab === "summary") activeTab = "transcript";
  setTab(activeTab);
  const utts = (m.transcript && m.transcript.utterances) || [];
  const bubbles = utts.map((u) => ({ channel: u.speaker === "You" ? 0 : 1, speaker: u.speaker, text: u.text }));
  renderBubbles(bubbles, "No transcript for this meeting.", false);
  renderSummaryFor(m);
}

function setTab(tab) {
  activeTab = tab;
  $("tab-btn-transcript").classList.toggle("active", tab === "transcript");
  $("tab-btn-summary").classList.toggle("active", tab === "summary");
  $("tab-transcript").classList.toggle("hidden", tab !== "transcript");
  $("tab-summary").classList.toggle("hidden", tab !== "summary");
}

// Merge consecutive turns from the SAME speaker into one paragraph bubble, so a
// long stretch of speech reads as a block instead of a stack of tiny bubbles.
// Interim (in-progress) turns stay on their own so they can keep updating.
function coalesce(bubbles) {
  const out = [];
  for (const b of bubbles) {
    const key = b.channel === 0 ? "You" : (b.speaker || "Participant");
    const last = out[out.length - 1];
    if (last && !last.interim && !b.interim && last._key === key) {
      last.text += " " + b.text;
    } else {
      out.push({ ...b, _key: key });
    }
  }
  return out;
}

function renderBubbles(bubbles, emptyText, autoscroll) {
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  box.innerHTML = "";
  if (bubbles.length === 0) {
    const e = div("transcript-empty"); e.textContent = emptyText; box.append(e); return;
  }
  for (const b of coalesce(bubbles)) {
    const el = div("utt " + (b.channel === 0 ? "you" : "them") + (b.interim ? " interim" : ""));
    const who = div("who"); who.textContent = b.channel === 0 ? "You" : (b.speaker || "Participant");
    const t = document.createElement("div"); t.textContent = b.text;
    el.append(who, t); box.append(el);
  }
  if (autoscroll && atBottom) box.scrollTop = box.scrollHeight;
}

function summaryPending(...nodes) {
  const box = $("summary"); box.innerHTML = "";
  const p = div("summary-pending"); p.append(...nodes); box.append(p);
}
function summaryFailed(err, meetingId) {
  const box = $("summary"); box.innerHTML = "";
  const p = div("summary-pending");
  const e = document.createElement("div"); e.className = "error"; e.append(icon("alert", 15), document.createTextNode(" " + (err || "Processing failed")));
  p.append(e);
  if (meetingId) p.append(btn("Retry", "linkbtn", () => chrome.runtime.sendMessage({ type: "WN_RETRY", id: meetingId })));
  box.append(p);
}

// Summary layout: next steps FIRST (a to-do list — owner pill + checkbox, the
// user's items on top, no AI priorities), then "Meeting context" bullets, then
// the DYNAMIC topic sections. Older summaries (key_points + paragraph) render
// through the same order with sensible fallbacks.
function renderSummaryFor(m) {
  const box = $("summary"); box.innerHTML = "";
  const summary = m && m.summary;
  if (!summary) { const p = div("summary-pending"); p.append(text("Summary not available.")); box.append(p); return; }

  if (summary.headline) { const h = document.createElement("h2"); h.textContent = summary.headline; box.append(h); }

  const sep = () => { const hr = document.createElement("div"); hr.className = "sep"; box.append(hr); };

  // 1) Next steps — always first. User's items first even for old summaries.
  const rawSteps = (summary.next_steps || []).filter((ns) => ns && ns.task);
  const isUser = (ns) => ns.is_user === true || ns.owner === "You";
  const steps = [...rawSteps.filter(isUser), ...rawSteps.filter((ns) => !isUser(ns))];
  if (steps.length) {
    const s = document.createElement("section");
    const h = document.createElement("h3"); h.textContent = "Next steps";
    const list = div("todo");
    for (const ns of steps) {
      const item = document.createElement("label");
      item.className = "todo-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", () => item.classList.toggle("done", cb.checked));
      const owner = span("owner-pill " + (isUser(ns) ? "user" : "other"));
      owner.textContent = ns.owner || (isUser(ns) ? "You" : "Participant");
      const task = span("todo-task"); task.textContent = ns.task;
      item.append(cb, owner, task, sendStepCell(m, ns));
      list.append(item);
    }
    s.append(h, list); box.append(s);
    sep();
  }

  // 2) Meeting context (old summaries: their key points).
  const context = (summary.context && summary.context.length ? summary.context : summary.key_points) || [];
  if (context.length) {
    const s = document.createElement("section");
    const h = document.createElement("h3"); h.textContent = "Meeting context";
    const ul = document.createElement("ul");
    for (const c of context) { const li = document.createElement("li"); li.textContent = c; ul.append(li); }
    s.append(h, ul); box.append(s);
    sep();
  }

  // 3) Dynamic topic sections — whatever was actually discussed.
  const sections = (summary.sections || []).filter((sec) => sec && sec.title && sec.bullets && sec.bullets.length);
  for (const sec of sections) {
    const s = document.createElement("section");
    const h = document.createElement("h3"); h.textContent = sec.title;
    const ul = document.createElement("ul");
    for (const b of sec.bullets) { const li = document.createElement("li"); li.textContent = b; ul.append(li); }
    s.append(h, ul); box.append(s);
  }
  // Old summaries have no sections — keep their paragraph so nothing is lost.
  if (!sections.length && summary.summary) {
    const s = document.createElement("section");
    const h = document.createElement("h3"); h.textContent = "Summary";
    const p = document.createElement("p"); p.textContent = summary.summary;
    s.append(h, p); box.append(s);
  }

  const links = div("links");
  const notion = (m && m.notionPageURL) || state.notionURL || null;
  if (notion) links.append(linkA("Open in Notion", notion, "notion-open")); // Notion only if exported
  links.append(linkA("Open in CRM", crmURL(m || { id: state.meetingId }), "crm-open"));
  box.append(links);
}

// --- Next steps → Winday Data tasks --------------------------------------
// Each next step carries, on hover, a button with Winday's mark: it puts the
// step on the user's Tasks list in a Winday Data workspace they pick. The
// service worker holds the Winday Data connection (lib/winday-data.js); a
// step already sent keeps its mark, ticked, with where it went.

let sentTasks = {};
store.getSentTasks().then((v) => { sentTasks = v || {}; repaintSentButtons(); }).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.wn_sent_tasks) {
    sentTasks = changes.wn_sent_tasks.newValue || {};
    repaintSentButtons();
  }
});

// The buttons on screen, by step key, to tick the one just sent.
const sendButtons = new Map();
function repaintSentButtons() {
  for (const [key, b] of sendButtons) {
    if (b.isConnected) paintSendButton(b, sentTasks[key]);
    else sendButtons.delete(key);
  }
}

function paintSendButton(b, sent) {
  b.replaceChildren(icon("winday", 14));
  if (sent) {
    const tick = span("send-tick");
    tick.append(icon("check", 11));
    b.append(tick);
  }
  b.classList.toggle("sent", !!sent);
  const label = sent
    ? `Added to ${sent.workspaceName || "Winday Data"} — add it to another workspace`
    : "Add as a task in Winday Data";
  b.title = label;
  b.setAttribute("aria-label", label);
}

/** A next step as a Winday Data task: its text as the title, the call it came from in the description. */
function taskFromStep(m, ns, isUserStep) {
  const full = String(ns.task || "").replace(/\s+/g, " ").trim();
  const title = full.length <= 200 ? full : full.slice(0, 199).replace(/\s+\S*$/, "") + "…";
  const lines = [];
  if (title !== full) lines.push(full, "");
  const when = m && m.startedAt
    ? new Date(m.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : null;
  const company = m && m.calendar && m.calendar.companyName;
  const call = (m && m.title) || "a call";
  lines.push(`Next step from the call "${call}"${when ? ` on ${when}` : ""}${company ? ` with ${company}` : ""}.`);
  lines.push(`Owner: ${ns.owner || (isUserStep ? "You" : "Participant")}.`);
  if (m && m.id) lines.push(`Call notes: ${crmURL(m)} (Winday CRM meeting ${m.id}).`);
  return { title, description: lines.join("\n") };
}

function sendStepCell(m, ns) {
  const cell = span("todo-send");
  const key = store.sentTaskKey(m && m.id, ns.task);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "send-task";
  paintSendButton(b, sentTasks[key]);
  sendButtons.set(key, b);
  b.addEventListener("click", (e) => {
    // Inside the step's <label>: never tick its checkbox.
    e.preventDefault();
    e.stopPropagation();
    toggleStepMenu(cell, b, m, ns, key);
  });
  cell.append(b);
  return cell;
}

function toggleStepMenu(cell, b, m, ns, key) {
  const wasOurs = openMenu && openMenu._btn === b;
  closeMenu();
  if (wasOurs) return;
  const menu = div("row-menu task-menu");
  menu._btn = b;
  // Clicks inside the menu stay in it: the step's <label> would take them.
  menu.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
  const head = div("task-menu-head");
  head.textContent = sentTasks[key] ? `Added to ${sentTasks[key].workspaceName || "Winday Data"}` : "Add to Winday Data";
  const body = div("task-menu-body");
  menu.append(head, body);
  cell.append(menu);
  openMenu = menu;
  b.classList.add("open");
  fillStepMenu(menu, body, b, m, ns, key);
}

function menuNote(textContent, cls = "task-menu-note") {
  const n = div(cls);
  n.textContent = textContent;
  return n;
}

function menuAction(label, onClick, cls = "") {
  const a = document.createElement("button");
  a.type = "button";
  a.className = cls;
  a.textContent = label;
  a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(a); });
  return a;
}

async function fillStepMenu(menu, body, b, m, ns, key) {
  body.replaceChildren(menuNote("Loading your workspaces…"));
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: "WN_DATA_WORKSPACES" });
  } catch (e) {
    r = { ok: false, error: String(e && e.message || e) };
  }
  if (openMenu !== menu) return; // closed meanwhile

  if (!r || !r.ok) {
    if (r && r.code === "not_connected") {
      body.replaceChildren(
        menuNote("Connect Winday Data to send this call's next steps to your Tasks list. It only gets access to your workspaces and tasks."),
        menuAction("Connect Winday Data", async (a) => {
          a.disabled = true;
          a.textContent = "Waiting for Winday Data…";
          const c = await chrome.runtime.sendMessage({ type: "WN_DATA_CONNECT" }).catch((e) => ({ ok: false, error: String(e) }));
          if (openMenu !== menu) return;
          if (c && c.ok) fillStepMenu(menu, body, b, m, ns, key);
          else {
            a.disabled = false;
            a.textContent = "Connect Winday Data";
            body.prepend(menuNote((c && c.error) || "Could not connect.", "task-menu-error"));
          }
        }, "primary-action"),
      );
      return;
    }
    body.replaceChildren(
      menuNote((r && r.error) || "Winday Data could not be reached.", "task-menu-error"),
      menuAction("Try again", () => fillStepMenu(menu, body, b, m, ns, key)),
    );
    return;
  }

  if (!r.tasksEnabled) {
    body.replaceChildren(menuNote("Tasks is not available on your Winday Data account yet."));
    return;
  }
  const usable = (r.workspaces || []).filter((w) => w.can_add_tasks);
  if (!usable.length) {
    body.replaceChildren(menuNote("You don't edit any Winday Data workspace yet."));
    return;
  }

  const list = div("task-menu-list");
  for (const w of usable) {
    const label = w.id === (sentTasks[key] && sentTasks[key].workspaceId) ? `${w.name} ✓` : w.name;
    list.append(menuAction(label, (a) => createStepTask(menu, body, a, b, m, ns, key, w)));
  }
  const foot = div("task-menu-foot");
  foot.append(menuAction("Disconnect Winday Data", async () => {
    await chrome.runtime.sendMessage({ type: "WN_DATA_DISCONNECT" }).catch(() => {});
    if (openMenu === menu) fillStepMenu(menu, body, b, m, ns, key);
  }, "foot-action"));
  body.replaceChildren(list, foot);
}

async function createStepTask(menu, body, a, b, m, ns, key, w) {
  for (const other of body.querySelectorAll("button")) other.disabled = true;
  a.textContent = `Adding to ${w.name}…`;
  const isUserStep = ns.is_user === true || ns.owner === "You";
  const { title, description } = taskFromStep(m, ns, isUserStep);
  const r = await chrome.runtime
    .sendMessage({ type: "WN_DATA_CREATE_TASK", key, workspaceId: w.id, workspaceName: w.name, title, description })
    .catch((e) => ({ ok: false, error: String(e) }));
  if (r && r.ok) {
    sentTasks = { ...sentTasks, [key]: r.sent };
    paintSendButton(b, r.sent);
    if (openMenu === menu) {
      body.replaceChildren(menuNote(`Added to ${w.name}'s Tasks in Winday Data.`, "task-menu-done"));
      setTimeout(() => { if (openMenu === menu) closeMenu(); }, 1400);
    }
    return;
  }
  if (openMenu !== menu) return;
  if (r && r.code === "not_connected") return fillStepMenu(menu, body, b, m, ns, key);
  for (const other of body.querySelectorAll("button")) other.disabled = false;
  a.textContent = w.name;
  body.prepend(menuNote((r && r.error) || "The task could not be added.", "task-menu-error"));
}

// --- Bottom bar ----------------------------------------------------------

function renderBottomBar() {
  const bar = $("bottombar");
  bar.innerHTML = "";
  const phase = state.phase;

  if (phase === "recording") {
    const row = div("rec-controls");
    const viz = div("viz"); viz.id = "viz";
    for (let i = 0; i < 24; i++) viz.append(div("bar"));
    const stop = btn("Stop", "stop-btn", () => chrome.runtime.sendMessage({ type: "WN_STOP" }));
    stop.prepend(icon("stop", 16));
    const cancel = iconBtn("cancel", "Discard", () => chrome.runtime.sendMessage({ type: "WN_CANCEL" }));
    cancel.className = "ghost cancel-btn";
    row.append(viz, timeEl(), stop, cancel);
    bar.append(row);
    renderViz();
  } else if (phase === "processing") {
    const s = div("status-bar");
    s.append(span("spinner"), text(stageLabel(state.stage)));
    bar.append(s);
  } else {
    // idle / done / failed → start a (new) recording
    const start = btn("Start Recording", "start", startRecording);
    start.prepend(icon("mic", 20));
    bar.append(start);
  }
}

function renderViz() {
  const viz = $("viz");
  if (!viz) return;
  const bars = viz.querySelectorAll(".bar");
  if (!bars.length) return;
  const data = vizBars || [];
  for (let i = 0; i < bars.length; i++) {
    const v = data[i] != null ? data[i] : 0;
    bars[i].style.height = Math.max(8, Math.round(v * 100)) + "%";
  }
}

function linkA(label, url, iconName) {
  const a = document.createElement("a");
  a.className = "linkbtn";
  if (iconName) a.append(icon(iconName, 15));
  a.append(document.createTextNode(label));
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  return a;
}

function renderList() {
  closeMenu(); // a rebuilt list orphans any open row menu
  const list = $("list");
  list.innerHTML = "";
  const items = allMeetings().filter((m) => m.status !== "recording");
  if (items.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No recordings yet.";
    list.append(e);
    return;
  }
  for (const m of items) list.append(itemRow(m));
}

function itemRow(m) {
  const row = div("item");
  const busy = ["transcribing", "summarizing", "exporting"].includes(m.status);
  const local = meetings.some((x) => x.id === m.id); // Retry/Export/Delete act on the local cache
  const viewable = !busy && (m.summary || (m.transcript && m.transcript.utterances && m.transcript.utterances.length));

  const main = document.createElement("div");
  main.style.flex = "1";
  main.style.overflow = "hidden";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = m.title || "Untitled";
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = subtitle(m);
  main.append(title, sub);
  if (viewable) {
    main.style.cursor = "pointer";
    main.title = "Open notes";
    main.addEventListener("click", () => { viewingId = m.id; activeTab = m.summary ? "summary" : "transcript"; render(); });
  }

  // Success is the norm — no badge for it. Only failures are tagged (plus a
  // transient "Processing…" while a retry is actively running).
  let tag = null;
  if (m.status === "failed") {
    tag = document.createElement("span");
    tag.className = "tag failed";
    tag.textContent = "Failed";
  } else if (busy) {
    tag = document.createElement("span");
    tag.className = "tag busy";
    tag.textContent = "Processing…";
  }

  const actions = div("item-actions");
  if (!busy) {
    if (local && (m.status === "recorded" || m.status === "failed"))
      actions.append(iconBtn("retry", "Transcribe & summarize", () => chrome.runtime.sendMessage({ type: "WN_RETRY", id: m.id })));
    if (local && m.status === "ready" && !m.notionPageURL)
      actions.append(iconBtn("notion-send", "Send to Notion", () => chrome.runtime.sendMessage({ type: "WN_EXPORT", id: m.id })));
    if (m.notionPageURL) actions.append(iconLink("notion-open", "Open in Notion", m.notionPageURL));
    actions.append(iconLink("crm-open", "Open in CRM", crmURL(m)));
  }
  // Far right: ⋮ menu (Rename / Delete) — works for local AND synced meetings.
  actions.append(kebabMenu(row, m, { local, title }));
  row.append(main);
  if (tag) row.append(tag);
  row.append(actions);
  return row;
}

// The per-row "more" menu. Only one menu is open at a time; any outside click
// or Escape closes it.
let openMenu = null;
function closeMenu() {
  if (openMenu) {
    if (openMenu._btn) openMenu._btn.classList.remove("open");
    openMenu.remove();
    openMenu = null;
  }
}
document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.contains(e.target) && !openMenu._btn.contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

function kebabMenu(row, m, { local, title }) {
  const btn = iconBtn("more", "More", (e) => {
    e.stopPropagation();
    const wasOurs = openMenu && openMenu._btn === btn;
    closeMenu();
    if (wasOurs) return; // second click toggles off

    const menu = div("row-menu");
    menu._btn = btn;

    const rename = document.createElement("button");
    rename.textContent = "Rename";
    rename.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenu(); startRename(m, title); });

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      closeMenu();
      row.style.opacity = "0.45";
      if (local) chrome.runtime.sendMessage({ type: "WN_DISCARD", id: m.id }).catch(() => {});
      try { await sb.deleteMeeting(m.id); } catch (_) { /* local-only or offline */ }
      remoteMeetings = remoteMeetings.filter((x) => x.id !== m.id);
      render();
    });

    menu.append(rename, del);
    row.append(menu);
    openMenu = menu;
  });
  btn.classList.add("kebab");
  return btn;
}

// Inline rename: the row's title becomes an input; Enter/blur saves, Esc cancels.
function startRename(m, titleEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = m.title || "";
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const next = input.value.trim();
    input.replaceWith(titleEl);
    if (!save || !next || next === m.title) return;
    titleEl.textContent = next;
    m.title = next;
    // Local cache (if present) + the durable Supabase row, best effort.
    if (meetings.some((x) => x.id === m.id)) {
      chrome.runtime.sendMessage({ type: "WN_MEETING_UPSERT", meeting: { ...m, title: next } }).catch(() => {});
    }
    try { await sb.renameMeeting(m.id, next); } catch (_) { /* offline / local-only */ }
    const remote = remoteMeetings.find((x) => x.id === m.id);
    if (remote) remote.title = next;
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// --- Actions -------------------------------------------------------------

let panelRecorder = null;
// Three hosting contexts: embedded iframe in the Meet tab (docked mode),
// the browser's native side panel (no tab, no parent), or a full-tab
// dashboard (has a tab).
const isEmbedded = window.parent !== window;
let isTabPage = false;
chrome.tabs.getCurrent().then((t) => { isTabPage = !!t && !isEmbedded; }).catch(() => {});

async function startRecording() {
  // 1) Silent path via the service worker (tabCapture -> offscreen).
  const r = await chrome.runtime
    .sendMessage({ type: "WN_RECORD_TAB" })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (r?.ok) return;
  if (!r?.needsPickerFallback) {
    return recorderHint(r?.error || "Couldn't capture the call tab.");
  }

  // 2) Fallback: capture HERE via the standard share dialog. Works embedded
  //    in the Meet tab (one-click, preferCurrentTab) and in the native side
  //    panel (generic picker). A full-tab dashboard has no call to point at.
  if (isTabPage) {
    return recorderHint("Open the panel from the call tab, then try again.");
  }
  recorderHint("In the share dialog, pick the call tab and keep 'Share audio' on.", false);
  let tabStream;
  try {
    tabStream = await captureThisTab();
  } catch (e) {
    return recorderHint("Sharing canceled (" + String(e?.message || e) + ") — try again and click 'Share'.");
  }
  if (tabStream.getAudioTracks().length === 0) {
    tabStream.getTracks().forEach((t) => t.stop());
    return recorderHint("No audio shared — try again and keep 'Share tab audio' on.");
  }
  // Only the audio matters; drop the mandatory video track right away.
  tabStream.getVideoTracks().forEach((t) => t.stop());

  const micStream = await acquireMic();
  const meeting = {
    id: crypto.randomUUID(),
    title: r.title || `Meeting ${new Date().toLocaleString()}`,
    startedAt: new Date().toISOString(),
    calendar: null,
  };
  panelRecorder = createRecorder();
  try {
    await panelRecorder.start({
      tabStream,
      micStream,
      monitorTab: false, // getDisplayMedia keeps local playback — no re-routing
      meeting,
      session: await store.getSession(),
      settings: await store.getSettings(),
      // This context can't receive its own runtime messages, so take the live
      // transcript + level events directly.
      onEvent: (m) => { if (m.type === "WN_TRANSCRIPT" || m.type === "WN_REC_LEVEL") handleRecEvent(m); },
    });
  } catch (e) {
    panelRecorder.failNow(e);
    panelRecorder = null;
    return;
  }
  await chrome.runtime
    .sendMessage({ type: "WN_PANEL_REC_STARTED", meeting: { id: meeting.id, title: meeting.title, startedAt: meeting.startedAt } })
    .catch(() => {});
  // If the user stops the share from the browser bar (or the source ends),
  // finish the meeting instead of recording silence.
  const audioTrack = tabStream.getAudioTracks()[0];
  audioTrack.addEventListener("ended", () => {
    if (panelRecorder?.isActive()) panelRecorder.stop(false);
  });
}

/** getDisplayMedia — scoped to this iframe's top-level tab (the Meet tab)
 *  when embedded; the generic tab picker from the native side panel. */
async function captureThisTab() {
  const base = { video: true, audio: true };
  const scoped = isEmbedded
    ? { ...base, preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "include" }
    : { ...base, systemAudio: "include" };
  try {
    return await navigator.mediaDevices.getDisplayMedia(scoped);
  } catch (e) {
    // Older builds reject unknown dictionary members with a TypeError: retry
    // with the plain form (generic picker; the user picks the call's tab).
    if (e && e.name === "TypeError") return navigator.mediaDevices.getDisplayMedia(base);
    throw e;
  }
}

// Show a start-flow message in the bottom bar (share-dialog guidance, errors).
// On an error, keep a Start button so the user can retry right there.
function recorderHint(msg, isError = true) {
  const bar = $("bottombar");
  bar.innerHTML = "";
  const s = div("status-bar");
  const t = document.createElement("div");
  if (isError) t.className = "error";
  t.style.textAlign = "center";
  t.textContent = msg;
  s.append(t);
  bar.append(s);
  if (isError) {
    const start = btn("Start Recording", "start", startRecording);
    start.prepend(icon("mic", 20));
    bar.append(start);
  }
}

// --- Helpers -------------------------------------------------------------

function subtitle(m) {
  const parts = [];
  if (m.calendar?.companyName) parts.push(m.calendar.companyName);
  if (m.startedAt) parts.push(new Date(m.startedAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  if (m.endedAt && m.startedAt) {
    const min = Math.round((new Date(m.endedAt) - new Date(m.startedAt)) / 60000);
    if (min > 0) parts.push(`${min} min`);
  }
  return parts.join("  ·  ");
}
function stageLabel(stage) {
  return { uploading: "Preparing…", transcribing: "Transcribing…", summarizing: "Summarizing…", exporting: "Saving notes…" }[stage] || "Processing…";
}
function crmURL(m) {
  return `https://crm.winday.app/meetings?m=${(m.id || "").toLowerCase()}`;
}
function timeEl() {
  const el = span("time");
  const started = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
  const upd = () => (el.textContent = fmt((Date.now() - started) / 1000));
  upd();
  timer = setInterval(upd, 1000);
  return el;
}
function fmt(sec) { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function div(cls) { const d = document.createElement("div"); d.className = cls; return d; }
function span(cls) { const s = document.createElement("span"); s.className = cls; return s; }
function text(t) { const s = document.createElement("span"); s.textContent = t; return s; }
function btn(label, cls, onClick) { const b = document.createElement("button"); b.textContent = label; b.className = cls; b.addEventListener("click", onClick); return b; }
function iconBtn(name, title, onClick) { const b = document.createElement("button"); b.append(icon(name, 16)); b.title = title; b.setAttribute("aria-label", title); b.addEventListener("click", onClick); return b; }
function iconLink(name, title, url) { const a = document.createElement("button"); a.append(icon(name, 16)); a.title = title; a.setAttribute("aria-label", title); a.addEventListener("click", () => chrome.tabs.create({ url })); return a; }

/** Opens Settings as a plain tab instead of chrome.runtime.openOptionsPage() —
 *  that API can silently no-op on some Chromium forks (no error, no tab), which
 *  is exactly what left users unable to reach it at all. A direct tab open is a
 *  basic, universally-supported operation. Focuses an existing Options tab
 *  rather than piling up duplicates on repeated clicks. */
async function openSettings() {
  const url = chrome.runtime.getURL("options/options.html");
  try {
    const [existing] = await chrome.tabs.query({ url });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch (_) {
    /* fall through to a plain create */
  }
  chrome.tabs.create({ url }).catch(() => {});
}

// --- Events --------------------------------------------------------------

// Web sign-in: open the Winday CRM in a tab; its content script bridges the
// session back (WN_WEB_SESSION -> stored -> WN_STATE broadcast -> render flips
// this panel to the signed-in view). No password handled by the extension.
$("btn-web-signin").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "WN_SIGN_IN_WEB" }).catch(() => {});
});
$("btn-signout").addEventListener("click", async () => { sb.signOut(); await store.setSession(null); session = null; render(); });
$("btn-settings").addEventListener("click", openSettings);

// Grant the mic permission INLINE — no navigation to a separate settings page.
// That page-hop (via chrome.runtime.openOptionsPage()) is what left users
// stuck: on some Chromium forks it silently no-ops, so "enable it" looked
// like it did nothing. getUserMedia's own browser prompt appears right here.
$("mic-link").addEventListener("click", async (e) => {
  e.preventDefault();
  $("mic-banner-error").classList.add("hidden");
  try {
    await requestMicPermission();
    micGranted = true;
    render();
  } catch (err) {
    $("mic-banner-error").textContent =
      "Microphone denied (" + (err?.message || err) + "). Check the microphone/lock icon " +
      "in the address bar, or this site's Microphone permission in your browser settings.";
    $("mic-banner-error").classList.remove("hidden");
  }
});

// Back to the recordings list — from a viewed past meeting, or a finished session.
$("btn-back").addEventListener("click", () => {
  if (viewingId) { viewingId = null; render(); return; }
  chrome.runtime.sendMessage({ type: "WN_DISMISS" }).catch(() => {});
});

paintIcons();

// Tabs. Both panes are always kept rendered by renderSession/renderViewing;
// switching tabs only toggles which one is visible.
$("tab-btn-transcript").addEventListener("click", () => { setTab("transcript"); renderTranscript(); });
$("tab-btn-summary").addEventListener("click", () => {
  if ($("tab-btn-summary").disabled) return;
  setTab("summary");
});

refresh();

// Keep the "Today" section honest while the panel stays open: passed calls
// drop off and the "Now" chip appears as start times arrive.
setInterval(syncUpcoming, 60_000);

// Presence beacon: hold a port open for as long as this panel exists, so the
// Meet pill can hide while the side panel is showing. Docked (iframe) panels
// use a different name — the content script tracks their visibility itself,
// since the iframe stays alive even when hidden.
(function announcePresence() {
  try {
    const name = window.top === window ? "wn-panel-native" : "wn-panel-docked";
    const port = chrome.runtime.connect({ name });
    // If the service worker restarts, the port drops — reconnect so the
    // "panel open" flag survives SW lifecycles.
    port.onDisconnect.addListener(() => setTimeout(announcePresence, 500));
  } catch (_) { /* extension context going away */ }
})();
