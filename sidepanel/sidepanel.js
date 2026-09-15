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
import { createRecorder, acquireMic, requestMicPermission, journalPeekUtterances } from "../lib/capture.js";
import { applyTheme } from "../lib/theme.js";
import { icon } from "../lib/icons.js";
import { parseTranscript, renameSpeakers, titleFromFilename } from "../lib/transcript-import.js";

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
let settings = null;      // user settings (theme is applied separately)
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

// The Meet call the user is looking at right now (the active tab of this
// window — in docked mode that is the tab hosting this iframe). A Today row
// whose Meet link is that call gets a Record button instead of Join, and a
// plain Start Recording picks up that row's calendar context on its own.
const MEET_CODE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i;
function meetCode(url) {
  const m = MEET_CODE.exec(url || "");
  return m ? m[1].toLowerCase() : null;
}
let currentCallCode = null;
async function refreshCurrentCall() {
  let code = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    code = meetCode(tab && tab.url);
  } catch (_) { /* no tabs access in this context */ }
  if (code !== currentCallCode) { currentCallCode = code; paintUpcoming(); }
}
chrome.tabs?.onActivated?.addListener(() => { refreshCurrentCall(); });
chrome.tabs?.onUpdated?.addListener((_id, info) => { if (info.url) refreshCurrentCall(); });

function upcomingForCurrentCall() {
  if (!currentCallCode) return null;
  return upcoming.find((m) => meetCode(m.meet_url) === currentCallCode) || null;
}

/** The recorder's calendar context for a Today row — what links the saved
 *  meeting to its Google event, company and CRM contacts. */
function calendarContext(m) {
  return {
    googleEventID: m.google_event_id || null,
    contactIDs: m.contact_ids || [],
    companyID: m.company_id || null,
    companyName: m.company_name || null,
    companyLogoURL: m.company_logo_url || null,
    meetURL: m.meet_url || null,
  };
}

function upcomingRow(m) {
  const row = div("item upcoming");
  const start = new Date(m.start);
  const started = Date.now() >= start.getTime();
  const onThisCall = !!currentCallCode && meetCode(m.meet_url) === currentCallCode;

  const chip = div("up-time" + (started ? " now" : ""));
  chip.textContent = started ? "Now" : start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const main = document.createElement("div");
  main.style.flex = "1";
  main.style.overflow = "hidden";
  const title = div("title"); title.textContent = m.title || "Meeting";
  const sub = div("sub"); sub.textContent = m.company_name || "Scheduled call";
  main.append(title, sub);

  const actions = div("item-actions");
  if (onThisCall) {
    row.classList.add("here");
    if (state.phase === "idle") {
      // You're on this call: record it, with its calendar context attached.
      const rec = btn("Record", "record-now", () => startRecording({ title: m.title, calendar: calendarContext(m) }));
      rec.prepend(icon("mic", 15));
      rec.title = "Record this call";
      actions.append(rec);
    } else {
      const tag = span("tag busy");
      tag.textContent = state.phase === "recording" ? "Recording" : "Saving…";
      actions.append(tag);
    }
  } else if (m.meet_url) {
    actions.append(iconBtn("join", "Open the call", () => chrome.tabs.create({ url: m.meet_url })));
  }

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
  settings = await store.getSettings();
  render();
  syncRemoteMeetings(); // pull durable history (re-renders when it lands)
  syncUpcoming(); // today's calendar calls (paints its own section)
  refreshCurrentCall(); // which Meet call this panel is looking at

  // (Re)opened while a recording runs elsewhere (offscreen / another panel
  // instance): this document wasn't there to accumulate the live finals, so
  // seed them from the recorder's crash journal — the transcript picks up
  // where the call actually is instead of starting blank.
  if (state.phase === "recording" && liveUtterances.length === 0) {
    journalPeekUtterances().then((utts) => {
      if (state.phase !== "recording" || liveUtterances.length > 0 || !utts.length) return;
      liveUtterances = utts.map((u) => ({
        channel: u.speaker === "You" ? 0 : 1,
        speaker: u.speaker,
        text: u.text,
      }));
      if (!viewingId && !$("session-view").classList.contains("hidden") && activeTab === "transcript") {
        renderTranscript();
      }
    }).catch(() => {});
  }
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
    // Import and Retry never pass through "recording": land on the summary
    // when their run finishes, which is the thing the user was waiting for.
    if (prev === "processing" && state.phase === "done") activeTab = "summary";
    // Re-read session + micGranted from storage (web sign-in / mic grant happen
    // in the service worker and only broadcast WN_STATE).
    const hadSession = !!session;
    Promise.all([store.getMeetings(), store.getMicGranted(), store.getSession(), store.getSettings()]).then(([m, mic, sess, st]) => {
      meetings = m;
      micGranted = mic;
      session = sess;
      settings = st;
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
  // The native side panel delegated its fallback capture to THIS embedded
  // panel (see startRecording): surface a clear call to action.
  if (msg?.type === "WN_ARM_FALLBACK" && isEmbedded && state.phase === "idle") armFallbackCta();
});

// Delegated-fallback CTA: the hint + the Start button, front and center.
function armFallbackCta() {
  const bar = $("bottombar");
  bar.innerHTML = "";
  const s = div("status-bar");
  const t = document.createElement("div");
  t.className = "hint";
  t.style.textAlign = "center";
  t.textContent = "Capture this call from here — click Start Recording, then 'Share'.";
  s.append(t);
  const start = btn("Start Recording", "start", startRecording);
  start.prepend(icon("mic", 20));
  bar.append(s, start);
}

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
  paintUpcoming(); // its Record button depends on the phase
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
  // Once the call is saved, its transcript is the meeting's: show the SAVED
  // one (the batch pass may have re-diarized it) and allow renames.
  const saved = !recording && state.meetingId ? allMeetings().find((x) => x.id === state.meetingId) : null;
  if (saved && saved.transcript && saved.transcript.utterances && saved.transcript.utterances.length) {
    renderBubbles(toBubbles(saved.transcript.utterances), "No transcript.", false, (from, to) => renameParticipant(saved, from, to));
    return;
  }
  const bubbles = liveUtterances.slice();
  for (const ch of Object.keys(interim)) {
    const it = interim[ch];
    if (it && it.text) bubbles.push({ channel: Number(ch), speaker: it.speaker, text: it.text, interim: true });
  }
  renderBubbles(bubbles, recording ? "Listening… speech appears here as it's spoken." : "No transcript.", recording);
}

function toBubbles(utts) {
  return utts.map((u) => ({ channel: u.speaker === "You" ? 0 : 1, speaker: u.speaker, text: u.text }));
}

function renderViewing(m) {
  $("tab-btn-summary").disabled = false;
  if (!m.summary && activeTab === "summary") activeTab = "transcript";
  setTab(activeTab);
  const utts = (m.transcript && m.transcript.utterances) || [];
  renderBubbles(toBubbles(utts), "No transcript for this meeting.", false, (from, to) => renameParticipant(m, from, to));
  renderSummaryFor(m);
}

// --- Participant renaming ----------------------------------------------------
// Diarization labels the other voices "Participant 1, 2, 3…" — and splits
// one person into several when it is unsure. The user knows who spoke: a
// rename applies everywhere the label appears (transcript turns, next-step
// owners) and is saved with the meeting, on every device.
const DIARIZED = /^Participant \d+$/i;
function isDiarized(name) { return DIARIZED.test(String(name || "").trim()); }

function renameParticipant(m, from, to) {
  const next = String(to || "").trim();
  if (!m || !from || !next || next === from || next === "You") return;
  if (m.transcript && Array.isArray(m.transcript.utterances)) {
    m.transcript = {
      ...m.transcript,
      utterances: m.transcript.utterances.map((u) => (u.speaker === from ? { ...u, speaker: next } : u)),
    };
  }
  if (m.summary && Array.isArray(m.summary.next_steps)) {
    for (const ns of m.summary.next_steps) if (ns && ns.owner === from) ns.owner = next;
  }
  // The live view's own copy (the session that just finished).
  for (const u of liveUtterances) if (u.speaker === from) u.speaker = next;
  // Persist first: `m` is a merged view, and the repaint reads the cached
  // entries that persistMeetingEdit brings up to date.
  persistMeetingEdit(m, { transcript: true, summary: !!m.summary });
  render();
}

/** Turns a "Participant N" label into an inline input; Enter renames. */
function inlineRename(labelEl, from, onRename) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = "";
  input.placeholder = from;
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== from) onRename(from, v);
    else input.replaceWith(labelEl);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  labelEl.replaceWith(input);
  input.focus();
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

function renderBubbles(bubbles, emptyText, autoscroll, onRename) {
  const box = $("transcript");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  box.innerHTML = "";
  if (bubbles.length === 0) {
    const e = div("transcript-empty"); e.textContent = emptyText; box.append(e); return;
  }
  for (const b of coalesce(bubbles)) {
    const el = div("utt " + (b.channel === 0 ? "you" : "them") + (b.interim ? " interim" : ""));
    const who = div("who"); who.textContent = b.channel === 0 ? "You" : (b.speaker || "Participant");
    if (onRename && b.channel !== 0 && isDiarized(b.speaker)) {
      who.classList.add("renamable");
      who.title = "Rename this participant";
      who.append(icon("edit", 10));
      who.addEventListener("click", () => inlineRename(who, b.speaker, onRename));
    }
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

  if (summary.headline) {
    const h = document.createElement("h2");
    h.textContent = summary.headline;
    editable(h, m, (v) => { if (v) summary.headline = v; });
    box.append(h);
  }

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
      // A div, not a <label>: the task text is editable, so a click on it must
      // not toggle the checkbox — only the box itself does.
      const item = div("todo-item");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = ns.done === true; // ticked state is saved with the summary
      item.classList.toggle("done", cb.checked);
      cb.addEventListener("change", () => {
        ns.done = cb.checked;
        item.classList.toggle("done", cb.checked);
        persistSummaryEdit(m);
      });
      const owner = span("owner-pill " + (isUser(ns) ? "user" : "other"));
      owner.textContent = ns.owner || (isUser(ns) ? "You" : "Participant");
      // The pill is editable: the summary sometimes assigns a step to the
      // wrong person — click to reassign it to another participant.
      if (m && m.id) {
        owner.title = "Reassign to…";
        owner.addEventListener("click", (e) => {
          e.preventDefault();   // inside a <label>: don't toggle the checkbox
          e.stopPropagation();
          openOwnerMenu(owner, m, summary, ns);
        });
      }
      const task = span("todo-task"); task.textContent = ns.task;
      editable(task, m, (v) => {
        if (v) ns.task = v;
        else summary.next_steps = summary.next_steps.filter((x) => x !== ns); // emptied → removed
      });
      // 4th grid cell — every row needs one (display:contents grid). For the
      // USER'S items it holds the Notion action: add this to-do to the tasks
      // database chosen in Settings (the button shows on row hover).
      const tail = span("todo-notion");
      if (isUser(ns) && m && m.id) {
        if (ns.notion_task_url) {
          const a = iconLink("notion-open", "Added to Notion — open the task", ns.notion_task_url);
          a.classList.add("added");
          tail.append(a);
        } else if (settings && settings.notionTasksDatabaseID) {
          tail.append(taskToNotionBtn(m, ns));
        }
      }
      item.append(cb, owner, task, tail);
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
    // Old summaries keep their bullets in key_points; edits go where they live.
    const list = summary.context && summary.context.length ? summary.context : summary.key_points;
    context.forEach((c, i) => {
      const li = document.createElement("li"); li.textContent = c;
      editable(li, m, (v) => { if (v) list[i] = v; else list.splice(i, 1); });
      ul.append(li);
    });
    s.append(h, ul); box.append(s);
    sep();
  }

  // 3) Dynamic topic sections — whatever was actually discussed.
  const sections = (summary.sections || []).filter((sec) => sec && sec.title && sec.bullets && sec.bullets.length);
  for (const sec of sections) {
    const s = document.createElement("section");
    const h = document.createElement("h3"); h.textContent = sec.title;
    editable(h, m, (v) => { if (v) sec.title = v; });
    const ul = document.createElement("ul");
    sec.bullets.forEach((b, i) => {
      const li = document.createElement("li"); li.textContent = b;
      editable(li, m, (v) => { if (v) sec.bullets[i] = v; else sec.bullets.splice(i, 1); });
      ul.append(li);
    });
    s.append(h, ul); box.append(s);
  }
  // Old summaries have no sections — keep their paragraph so nothing is lost.
  if (!sections.length && summary.summary) {
    const s = document.createElement("section");
    const h = document.createElement("h3"); h.textContent = "Summary";
    const p = document.createElement("p"); p.textContent = summary.summary;
    editable(p, m, (v) => { if (v) summary.summary = v; });
    s.append(h, p); box.append(s);
  }

  const links = div("links");
  const notion = (m && m.notionPageURL) || state.notionURL || null;
  if (notion) links.append(linkA("Open in Notion", notion, "notion-open")); // Notion only if exported
  links.append(linkA("Open in CRM", crmURL(m || { id: state.meetingId }), "crm-open"));
  box.append(links);
}

// --- Owner pill editing ----------------------------------------------------
// Reassign a next step to another participant when the summary got it wrong.

// Candidate owners: the user (blue pill), then every other name we know of —
// the other steps' owners, the transcript's identified speakers, and the
// known attendees resolved by enrich-meeting.
function ownerCandidates(m, summary) {
  const steps = summary.next_steps || [];
  const userStep = steps.find((s) => s.is_user === true && s.owner && s.owner !== "You");
  const emailName = session && session.email
    ? session.email.split("@")[0].replace(/^\w/, (c) => c.toUpperCase())
    : null;
  const user = (userStep && userStep.owner) || emailName || "You";

  const seen = new Set([user.toLowerCase(), "you", "participant"]); // no generic placeholder
  const others = [];
  const add = (name) => {
    const n = String(name || "").trim();
    if (!n || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    others.push(n);
  };
  for (const s of steps) if (s.is_user !== true) add(s.owner);
  for (const u of (m.transcript && m.transcript.utterances) || []) {
    if (u.speaker !== "You") add(u.speaker);
  }
  for (const p of m.participants || []) if (p && !p.is_self) add(p.name);
  return { user, others };
}

function openOwnerMenu(pillEl, m, summary, ns) {
  const wasOurs = openMenu && openMenu._btn === pillEl;
  closeMenu();
  if (wasOurs) return; // second click toggles off

  const { user, others } = ownerCandidates(m, summary);
  const menu = div("owner-menu");
  menu._btn = pillEl;

  const opt = (label, isUser) => {
    const b = document.createElement("button");
    b.type = "button";
    if (label === ns.owner) b.classList.add("current");
    const pill = span("owner-pill " + (isUser ? "user" : "other"));
    pill.textContent = label;
    b.append(pill);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      applyOwner(m, ns, label, isUser);
    });
    if (!isUser && isDiarized(label)) {
      // "Participant N" is a voice, not a person: rename it here (the whole
      // transcript follows) and this step goes to the renamed person.
      const row = div("opt");
      const pencil = iconBtn("edit", `Rename ${label}`, (e) => {
        e.preventDefault();
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = `${label} is…`;
        let done = false;
        const finish = (save) => {
          if (done) return; done = true;
          const v = input.value.trim();
          closeMenu();
          if (save && v) { renameParticipant(m, label, v); applyOwner(m, ns, v, false); }
        };
        input.addEventListener("click", (ev) => ev.stopPropagation());
        input.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") finish(true);
          else if (ev.key === "Escape") finish(false);
        });
        input.addEventListener("blur", () => finish(true));
        row.replaceChildren(input);
        input.focus();
      });
      pencil.classList.add("rename");
      row.append(b, pencil);
      menu.append(row);
      return;
    }
    menu.append(b);
  };
  opt(user, true);
  for (const n of others) opt(n, false);

  // Free entry for a name that isn't in any list.
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Other name…";
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && input.value.trim()) {
      const name = input.value.trim();
      closeMenu();
      applyOwner(m, ns, name, name.toLowerCase() === user.toLowerCase());
    } else if (e.key === "Escape") closeMenu();
  });
  menu.append(input);

  document.body.append(menu);
  const r = pillEl.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
  menu.style.top = (r.bottom + 4 + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + "px";
  openMenu = menu;
}

async function applyOwner(m, ns, owner, isUser) {
  if (ns.owner === owner && ns.is_user === isUser) return;
  ns.owner = owner;
  ns.is_user = isUser;
  render(); // repaint — also re-sorts the list (the user's items first)
  await persistSummaryEdit(m);
}

// --- Editing the notes -------------------------------------------------------
// The summary is the user's: every line of it can be edited in place. The
// element commits on blur (Enter commits too, Escape restores), the change
// lands in the summary object through `apply`, and the meeting is saved —
// locally and on the server — so it never snaps back to the AI's version.
function editable(el, m, apply) {
  if (!m || !m.id) return;
  el.contentEditable = "plaintext-only";
  el.spellcheck = false;
  el.dataset.placeholder = "(empty — removes this line)";
  let original = el.textContent;
  el.addEventListener("focus", () => { original = el.textContent; });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    else if (e.key === "Escape") { el.textContent = original; el.blur(); }
  });
  el.addEventListener("blur", () => {
    const v = el.textContent.replace(/\s+/g, " ").trim();
    if (v === original.trim()) { el.textContent = original; return; }
    apply(v);
    if (!v) render();      // a removed line: repaint the list
    else el.textContent = v;
    persistSummaryEdit(m);
  });
}

// Persist in-place edits of a meeting's notes — summary (edited text,
// reassigned owner, ticked step, notion_task_url) and/or transcript (a
// renamed participant): the local cache when the meeting is in it, the
// merged remote entry, and the durable Supabase row. Best effort.
function persistMeetingEdit(m, { summary = true, transcript = false } = {}) {
  // `m` is the merged view of a row; the cached entries it was built from
  // (local + remote) get the same fields, so the next repaint agrees.
  for (const entry of [meetings.find((x) => x.id === m.id), remoteMeetings.find((x) => x.id === m.id)]) {
    if (!entry) continue;
    if (summary) entry.summary = m.summary;
    if (transcript) entry.transcript = m.transcript;
  }
  if (meetings.some((x) => x.id === m.id)) {
    chrome.runtime.sendMessage({ type: "WN_MEETING_UPSERT", meeting: { ...m } }).catch(() => {});
  }
  const patch = {};
  if (summary) patch.summary = m.summary;
  let text;
  if (transcript && m.transcript && Array.isArray(m.transcript.utterances)) {
    patch.transcript = m.transcript;
    text = m.transcript.utterances.map((u) => `${u.speaker}: ${u.text}`).join("\n");
  }
  return sb.updateMeetingContent(m.id, patch, text).catch(() => { /* offline / local-only */ });
}
function persistSummaryEdit(m) { return persistMeetingEdit(m, { summary: true }); }

// Send ONE next step to the user's Notion tasks database (Settings → Notion).
// Success is remembered on the step itself (notion_task_url) so the button
// becomes an "open the task" link — on every device, and no double-adds.
function taskToNotionBtn(m, ns) {
  const b = iconBtn("notion-send", "Add this task to Notion", async (e) => {
    e.preventDefault();   // inside a <label>: don't toggle the checkbox
    e.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    b.replaceChildren(span("spinner"));
    try {
      const r = await sb.notionAddTask({
        task: ns.task,
        database_id: settings.notionTasksDatabaseID,
        meeting_title: m.title || null,
        meeting_date: m.startedAt || null,
      });
      ns.notion_task_url = r.url || "";
      persistSummaryEdit(m);
      render(); // repaint: the button becomes an "open the task" link
    } catch (err) {
      b.disabled = false;
      b.replaceChildren(icon("notion-send", 16));
      b.title = "Couldn't add to Notion: " + ((err && err.message) || err);
      b.classList.add("failed");
    }
  });
  return b;
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
  // "Processing…" is only real while THIS extension runs the pipeline on it.
  // A row stuck on a mid-pipeline status with nothing running (the pipeline
  // died, or another device abandoned it) is unfinished — offer Retry rather
  // than a badge that never changes.
  const midway = ["transcribing", "summarizing", "exporting"].includes(m.status);
  const runningHere = state.phase === "processing" && state.meetingId === m.id;
  const busy = midway && runningHere;
  const stuck = midway && !runningHere;
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
  } else if (stuck) {
    tag = document.createElement("span");
    tag.className = "tag stuck";
    tag.textContent = "Unfinished";
  }

  const actions = div("item-actions");
  if (!busy) {
    // Retry works on synced meetings too: the server row has the transcript,
    // so a call whose summary failed can be finished from any device.
    if (m.status === "recorded" || m.status === "failed" || stuck)
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
  if (openMenu) { openMenu.remove(); openMenu = null; }
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

async function startRecording(arg) {
  // Calendar context: explicit from a Today row's Record button, else the
  // Today call matching the tab we're on (a plain Start Recording still links
  // the meeting to its event, company and contacts). The bottom-bar button
  // passes its click event here — that is not a context.
  let ctx = arg && arg.calendar ? arg : null;
  if (!ctx) {
    const u = upcomingForCurrentCall();
    if (u) ctx = { title: u.title, calendar: calendarContext(u) };
  }
  // 1) Silent path via the service worker (tabCapture -> offscreen).
  const r = await chrome.runtime
    .sendMessage({ type: "WN_RECORD_TAB", title: ctx ? ctx.title : undefined, calendar: ctx ? ctx.calendar : undefined })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (r?.ok) return;
  if (!r?.needsPickerFallback) {
    return recorderHint(r?.error || "Couldn't capture the call tab.");
  }

  // 2) Fallback: capture via the standard share dialog — but only when THIS
  //    document can safely host the recording. A full-tab dashboard has no
  //    call to point at, and the NATIVE side panel dies whenever the user
  //    closes it (which used to kill the recording mid-call): both delegate.
  if (isTabPage) {
    return recorderHint("Open the panel from the call tab, then try again.");
  }
  if (!isEmbedded) {
    // Native side panel → hand the capture to the panel iframe docked INSIDE
    // the Meet tab. That host survives this panel closing and tab switches;
    // closing the call's tab itself is covered by the crash journal.
    const d = await chrome.runtime.sendMessage({ type: "WN_FALLBACK_TO_TAB" }).catch(() => null);
    if (d && d.ok) {
      recorderHint("Continue from the call tab: click 'Start Recording' in the panel that just opened over the call.", false);
    } else {
      recorderHint((d && d.error) || "Couldn't reach the call tab — open your call and record from its panel.");
    }
    return;
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
    title: (ctx && ctx.title) || r.title || `Meeting ${new Date().toLocaleString()}`,
    startedAt: new Date().toISOString(),
    calendar: (ctx && ctx.calendar) || null,
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
  // (Stopping the share from the browser bar ends the audio track; the
  // recorder itself watches for that and finishes the meeting.)
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

// --- Import a transcript file -------------------------------------------
// For calls this extension never recorded (captured elsewhere, or an audio
// upload that Storage refused). The parsed transcript goes through the same
// pipeline as a recording: meeting row → CRM → summary → Notion.
//
// Splitting a pasted transcript by speaker is guesswork, so the guess is shown
// before anything is created: who the parser found, how much each of them said,
// and which one is the user — that last one decides whose next steps the
// summary puts first, and only the user can answer it.
let pendingImport = null; // { transcript, file, youLabel }

$("btn-import").addEventListener("click", () => {
  importError(null);
  $("import-file").click();
});

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // let the same file be picked again after a failure
  if (!file) return;
  importError(null);

  let transcript;
  try {
    transcript = parseTranscript(await file.text());
  } catch (err) {
    return importError("Couldn't read that file (" + (err?.message || err) + ").");
  }
  if (transcript.utterances.length === 0) return importError("That file has no readable transcript.");

  // Pre-select the user when the file already says "You" — nothing to correct.
  const you = transcript.speakers.find((sp) => sp.name === "You");
  pendingImport = { transcript, file, youLabel: you ? "You" : null };
  renderImportPreview();
});

function importError(msg) {
  const box = $("import-error");
  box.textContent = "";
  box.classList.toggle("hidden", !msg);
  if (msg) box.append(icon("alert", 14), document.createTextNode(" " + msg));
}

function renderImportPreview() {
  const box = $("import-preview");
  box.textContent = "";
  box.classList.toggle("hidden", !pendingImport);
  if (!pendingImport) return;

  const { transcript, youLabel } = pendingImport;
  const head = div("import-head");
  head.append(text(`${transcript.utterances.length} turns · ${transcript.speakers.length} speaker${transcript.speakers.length > 1 ? "s" : ""}`));
  const hint = div("hint");
  hint.textContent = youLabel
    ? "Tap a name to change who you are."
    : "Which one is you? Tap your name so your action items land on you.";

  const chips = div("speaker-chips");
  for (const sp of transcript.speakers) {
    const isYou = sp.name === youLabel;
    const chip = btn("", "speaker-chip" + (isYou ? " you" : ""), () => {
      pendingImport.youLabel = isYou ? null : sp.name;
      renderImportPreview();
    });
    chip.append(text(isYou ? `${sp.name} — you` : sp.name), span("chip-count"));
    chip.lastChild.textContent = String(sp.turns);
    chips.append(chip);
  }

  const actions = div("row");
  actions.append(
    btn("Import", "primary", startImport),
    btn("Cancel", "ghost", () => { pendingImport = null; renderImportPreview(); }),
  );
  box.append(head, chips, hint, actions);
}

async function startImport() {
  if (!pendingImport) return;
  const { file, youLabel } = pendingImport;
  // Relabelling happens here, once, so the stored transcript, the CRM row and
  // the summary all agree on who said what.
  const transcript = youLabel && youLabel !== "You"
    ? renameSpeakers(pendingImport.transcript, { [youLabel]: "You" })
    : pendingImport.transcript;

  // The file's own date is the closest thing to when the call happened; a
  // generic filename leaves the title to the AI headline.
  const at = new Date(file.lastModified || Date.now()).toISOString();
  const named = titleFromFilename(file.name);
  const meeting = {
    id: crypto.randomUUID(),
    title: named || `Meeting ${new Date(at).toLocaleString()}`,
    startedAt: at,
    endedAt: at,
    calendar: null,
  };

  // Show the imported transcript straight away — the Summary tab spins next
  // to it until the notes land.
  liveUtterances = transcript.utterances.map((u) => ({
    channel: u.speaker === "You" ? 0 : 1, speaker: u.speaker, text: u.text,
  }));
  interim = {};
  viewingId = null;
  activeTab = "transcript";
  pendingImport = null;
  renderImportPreview();

  const r = await chrome.runtime.sendMessage({ type: "WN_IMPORT", meeting, transcript }).catch(() => null);
  if (!r?.ok) importError(r?.error || "Couldn't start the import.");
}

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
