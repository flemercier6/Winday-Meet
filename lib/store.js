// Thin wrapper over chrome.storage.local for the three pieces of state the
// extension persists: the Supabase auth session, the user's settings, and the
// local list of recorded meetings (a cache — the durable copy lives in Postgres,
// written by the Edge Functions). Shared by the background worker, the offscreen
// document, the popup and the options page.
import { CONFIG } from "../config.js";

const KEYS = {
  session: "wn_session",
  settings: "wn_settings",
  meetings: "wn_meetings",
  micGranted: "wn_mic_granted",
  sentTasks: "wn_sent_tasks",
  lastTaskWorkspace: "wn_last_task_workspace",
};

async function get(key) {
  const obj = await chrome.storage.local.get(key);
  return obj[key];
}
async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// --- Session -------------------------------------------------------------

export async function getSession() {
  return (await get(KEYS.session)) ?? null;
}
export async function setSession(session) {
  if (session) await set(KEYS.session, session);
  else await chrome.storage.local.remove(KEYS.session);
}

// --- Settings ------------------------------------------------------------

export const DEFAULT_SUMMARY_PROMPT =
  "You are an expert sales/meeting assistant for Winday CRM. Analyze the " +
  "following meeting transcript and produce structured, action-oriented " +
  'notes. The speaker labelled "You" is the app\'s user; "Participant 1/2/…" ' +
  "are the other attendees. Be concise and factual.";

export function defaultSettings() {
  return {
    // Legacy fallback: a manually pasted Notion database id (used only when the
    // user hasn't connected Notion via OAuth). Preferred path is notionConnected.
    notionDatabaseID: "",
    // Cached mirror of the server-side Notion OAuth connection, so the recorder
    // knows whether to auto-export without a round-trip. Set by the options page
    // on connect/disconnect; the server is the source of truth.
    notionConnected: false,
    // Notion database that receives the user's next steps (the per-item Notion
    // button in the summary). Empty = feature off, no button shown.
    notionTasksDatabaseID: "",
    // "gladia" or "deepgram" — which transcription engine the pipeline uses.
    transcriptionProvider: CONFIG.transcriptionProvider,
    deepgramModel: CONFIG.deepgramModel,
    geminiModel: CONFIG.geminiModel,
    autoExportToNotion: true,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    summaryLength: "medium",
    // Transcription language for either engine. "multi" = auto-detect (Gladia:
    // any language + code-switching; Deepgram: Nova-3 real-time code-switching
    // EN/FR/ES/DE/HI/RU/PT/JA/IT/NL); or a language code to pin one.
    transcriptionLanguage: "multi",
    // Appearance: "system" follows the OS, or force "light" / "dark".
    theme: "system",
    // "native": the browser's real side panel (Chrome, Dia — pushes the page).
    // "docked": an iframe docked over the Meet page (Arc, which never renders
    // the native panel UI even though the API pretends to succeed).
    panelMode: "native",
  };
}

export async function getSettings() {
  const saved = (await get(KEYS.settings)) ?? {};
  return { ...defaultSettings(), ...saved };
}
export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set(KEYS.settings, next);
  return next;
}

// --- Meetings (local cache) ---------------------------------------------

// The cache now carries each call's transcript (so Retry survives a failed
// upload), and chrome.storage.local is capped at 10 MB. Only the most recent
// calls are worth keeping locally — the durable copy is in Postgres and the
// list view merges the server's history back in.
const MAX_CACHED_MEETINGS = 25;

export async function getMeetings() {
  return (await get(KEYS.meetings)) ?? [];
}
export async function saveMeetings(list) {
  await set(KEYS.meetings, list.slice(0, MAX_CACHED_MEETINGS));
}
/** Insert or update a meeting by id, newest first, and persist. */
export async function upsertMeeting(meeting) {
  const list = await getMeetings();
  const idx = list.findIndex((m) => m.id === meeting.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...meeting };
  else list.unshift(meeting);
  await saveMeetings(list);
  return list;
}
export async function removeMeeting(id) {
  const list = (await getMeetings()).filter((m) => m.id !== id);
  await saveMeetings(list);
  return list;
}

// --- Microphone permission flag -----------------------------------------

export async function getMicGranted() {
  return (await get(KEYS.micGranted)) === true;
}
export async function setMicGranted(v) {
  await set(KEYS.micGranted, v === true);
}

// --- Next steps sent to Winday Data as tasks ----------------------------
// Which of a call's next steps already went to a workspace's Tasks list, so
// the panel shows them as sent — and a second click is a choice, not an
// accident. Keyed by meeting id and the step's text; the last 500 are kept.

const MAX_SENT = 500;

/** A next step's key: its meeting, and its text as the summary wrote it. */
export function sentTaskKey(meetingId, task) {
  return `${meetingId || "?"}::${String(task || "").replace(/\s+/g, " ").trim()}`;
}

/** {key: {workspaceId, workspaceName, taskId, at}} */
export async function getSentTasks() {
  return (await get(KEYS.sentTasks)) ?? {};
}
export async function markTaskSent(key, entry) {
  const all = await getSentTasks();
  all[key] = { ...entry, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_SENT) {
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX_SENT)) delete all[k];
  }
  await set(KEYS.sentTasks, all);
  return all[key];
}

/** The workspace the last task went to: offered first next time. */
export async function getLastTaskWorkspace() {
  return (await get(KEYS.lastTaskWorkspace)) ?? null;
}
export async function setLastTaskWorkspace(id) {
  await set(KEYS.lastTaskWorkspace, id);
}
