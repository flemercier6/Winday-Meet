// Thin Supabase REST client for the extension: email+password auth, Storage
// upload, PostgREST inserts and Edge Function invocation. Mirrors the macOS
// app's SupabaseClient. No third-party secrets ever pass through here — the
// Edge Functions hold Deepgram/Gemini/Notion keys server-side.
//
// IMPORTANT: this module keeps the auth session IN MEMORY and does NOT touch
// chrome.storage. Extension pages / the service worker load the session from
// chrome.storage (store.js) and hand it in via `useSession()`; the offscreen
// document — which has no chrome.storage access — is given the session over a
// message. Persistence is the caller's job (via the optional onRefresh hook),
// so the same client works in every context.
import { CONFIG } from "../config.js";

const BASE = CONFIG.supabaseURL.replace(/\/+$/, "");
const ANON = CONFIG.supabaseAnonKey;

let _session = null;
let _onRefresh = null;
let _getLatest = null;

/** Configure the active session, an optional persistence hook for refreshes,
 *  and an optional loader for the NEWEST persisted session — used to recover
 *  when another context already rotated our refresh token. */
export function useSession(session, onRefresh, getLatest) {
  _session = session || null;
  _onRefresh = onRefresh || null;
  _getLatest = getLatest || null;
}
export function activeSession() {
  return _session;
}

export class HttpError extends Error {
  constructor(status, body) {
    super(`Request failed (HTTP ${status}): ${body}`);
    this.status = status;
    this.body = body;
  }
}

function endpoint(path) {
  return BASE + path;
}

async function check(resp) {
  if (resp.ok) return resp;
  const text = await resp.text();
  let message = text;
  try {
    const obj = JSON.parse(text);
    message = obj.error || obj.msg || obj.message || text;
  } catch (_) {
    /* keep raw text */
  }
  throw new HttpError(resp.status, message);
}

// --- Auth ----------------------------------------------------------------

function sessionFromToken(token) {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    userId: token.user?.id,
    email: token.user?.email ?? null,
  };
}

export async function signIn(email, password) {
  const resp = await fetch(endpoint("/auth/v1/token?grant_type=password"), {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  await check(resp);
  const token = await resp.json();
  if (!token.access_token) throw new HttpError(200, "Sign-in failed — check your email and password.");
  _session = sessionFromToken(token);
  return _session;
}

export async function signUp(email, password) {
  const resp = await fetch(endpoint("/auth/v1/signup"), {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  await check(resp);
  const token = await resp.json();
  if (!token.access_token) {
    throw new HttpError(
      200,
      "Account created, but email confirmation is on. Confirm via the email, then sign in.",
    );
  }
  _session = sessionFromToken(token);
  return _session;
}

export function signOut() {
  _session = null;
}

/** True when an error means the session is DEAD (revoked refresh token) and
 *  only a fresh sign-in can help. Callers use it to show a sign-in prompt
 *  instead of a raw error. */
export function isSessionDead(e) {
  return !!(e && e.sessionDead);
}

function deadTokenError(e) {
  return e instanceof HttpError && e.status === 400 && /refresh token/i.test(String(e.body || e.message || ""));
}

// The refresh token was revoked server-side: drop the session NOW (stops every
// timer in this context from hammering the auth endpoint), tell the service
// worker so it signs the whole extension out cleanly, and raise a typed error.
function giveUpDeadSession() {
  _session = null;
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "WN_SESSION_DEAD" }).catch(() => {});
    }
  } catch (_) { /* non-extension context (tests) */ }
  const err = new HttpError(401, "Your Winday session has expired — please sign in again.");
  err.sessionDead = true;
  return err;
}

/** Returns a valid access token, refreshing if it is within 60s of expiry. */
async function accessToken() {
  if (!_session) throw new HttpError(401, "You need to sign in first.");
  if (_session.expiresAt - Date.now() > 60_000) return _session.accessToken;

  const staleRt = _session.refreshToken;
  try {
    return await refreshWith(staleRt);
  } catch (e) {
    // Refresh tokens rotate on use, so if another context (panel, options,
    // service worker) refreshed first, ours is now "Already Used". Adopt the
    // newest persisted session and retry once before giving up.
    if (e instanceof HttpError && e.status === 400 && _getLatest) {
      const latest = await Promise.resolve()
        .then(() => _getLatest())
        .catch(() => null);
      if (latest && latest.accessToken) {
        _session = latest;
        if (latest.expiresAt - Date.now() > 60_000) return latest.accessToken;
        if (latest.refreshToken && latest.refreshToken !== staleRt) {
          try {
            return await refreshWith(latest.refreshToken);
          } catch (e2) {
            if (deadTokenError(e2)) throw giveUpDeadSession();
            throw e2;
          }
        }
      }
    }
    if (deadTokenError(e)) throw giveUpDeadSession();
    throw e;
  }
}

async function refreshWith(refreshToken) {
  const resp = await fetch(endpoint("/auth/v1/token?grant_type=refresh_token"), {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  await check(resp);
  const token = await resp.json();
  _session = sessionFromToken(token);
  if (_onRefresh) {
    try { await _onRefresh(_session); } catch (_) {}
  }
  return _session.accessToken;
}

/** Exchange the CURRENT (bridged) session for a brand-new one owned by this
 *  device: the extension-session function returns a one-time magiclink hash
 *  for the same user, verified here into an independent refresh-token family.
 *  Without this, the extension shares the CRM web app's tokens and dies with
 *  "Invalid Refresh Token: Already Used" whenever the CRM rotates them. */
export async function exchangeForOwnSession() {
  const { token_hash } = await invokeRaw("extension-session", {});
  if (!token_hash) throw new HttpError(500, "No session link returned.");
  const resp = await fetch(endpoint("/auth/v1/verify"), {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash }),
  });
  await check(resp);
  const token = await resp.json();
  if (!token.access_token) throw new HttpError(200, "Could not create the device session.");
  _session = sessionFromToken(token);
  return _session;
}

export function currentUserId() {
  return _session?.userId ?? null;
}

// --- Storage -------------------------------------------------------------

/** Uploads a Blob to the private `recordings` bucket at `path`. */
export async function uploadRecording(blob, path, contentType = "application/octet-stream") {
  const token = await accessToken();
  const resp = await fetch(endpoint(`/storage/v1/object/recordings/${path}`), {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: blob,
  });
  if (resp.ok) return;

  // Storage refuses anything above the project's upload limit before it reads
  // the body — a long call is exactly what trips it. Type the error so the
  // pipeline can keep the meeting instead of losing it with the audio.
  const text = await resp.text();
  if (resp.status === 413 || /maximum allowed size|payload too large|entity too large/i.test(text)) {
    const mb = Math.round(blob.size / (1024 * 1024));
    const err = new HttpError(
      resp.status,
      `The recording is too large for storage (${mb} MB) — raise the Storage upload limit.`,
    );
    err.tooLarge = true;
    throw err;
  }
  let message = text;
  try {
    const obj = JSON.parse(text);
    message = obj.error || obj.msg || obj.message || text;
  } catch (_) {
    /* keep raw text */
  }
  throw new HttpError(resp.status, message);
}

/** True when an upload failed because the file exceeds the storage limit. */
export function isTooLarge(e) {
  return !!(e && e.tooLarge);
}

// --- PostgREST -----------------------------------------------------------

async function postREST(path, body, prefer) {
  const token = await accessToken();
  const resp = await fetch(endpoint(path), {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  await check(resp);
  return resp;
}

/** Inserts a meeting row (idempotent: an existing id is left untouched).
 *  Returns false when a row was already there and this payload was ignored —
 *  the caller then knows the row it wanted is NOT the row that exists. */
export async function insertMeeting(payload) {
  const resp = await postREST(
    "/rest/v1/meetings?on_conflict=id",
    payload,
    "resolution=ignore-duplicates,return=representation",
  );
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) ? rows.length > 0 : true;
}

/** Persists user edits to a meeting's content — the structured summary
 *  (edited text, reassigned owner, ticked next step) and/or the transcript
 *  (a renamed participant). jsonb PATCH replaces the whole column, so the
 *  current metadata is read first and the given keys merged in (RLS scopes
 *  both to the owner). `transcriptText` is the plain "Speaker: …" column the
 *  CRM shows — sent along whenever the transcript changed. */
export async function updateMeetingContent(id, metadataPatch, transcriptText) {
  const token = await accessToken();
  const readResp = await fetch(
    endpoint(`/rest/v1/meetings?id=eq.${encodeURIComponent(id)}&select=metadata`),
    { headers: { apikey: ANON, Authorization: `Bearer ${token}` } },
  );
  await check(readResp);
  const rows = await readResp.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(404, "Meeting not found.");
  const metadata = { ...(rows[0].metadata || {}), ...metadataPatch };
  const body = { metadata };
  if (typeof transcriptText === "string") body.transcript = transcriptText;
  const resp = await fetch(endpoint(`/rest/v1/meetings?id=eq.${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  await check(resp);
}

/** Persists an edited structured summary (e.g. a reassigned next-step owner). */
export function updateMeetingSummary(id, summary) {
  return updateMeetingContent(id, { summary });
}

/** Patches columns on a meeting row (RLS: only the owner's row can match). */
export async function patchMeeting(id, patch) {
  const token = await accessToken();
  const resp = await fetch(endpoint(`/rest/v1/meetings?id=eq.${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  await check(resp);
}

/** Renames a meeting. */
export function renameMeeting(id, title) {
  return patchMeeting(id, { meeting_title: title });
}

/** One meeting row by id, or null when it was never created. */
export async function fetchMeeting(id) {
  const token = await accessToken();
  const resp = await fetch(
    endpoint(`/rest/v1/meetings?select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
    { headers: { apikey: ANON, Authorization: `Bearer ${token}` } },
  );
  await check(resp);
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Deletes a meeting row (RLS: only the owner's row can match). */
export async function deleteMeeting(id) {
  const token = await accessToken();
  const resp = await fetch(endpoint(`/rest/v1/meetings?id=eq.${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, Prefer: "return=minimal" },
  });
  await check(resp);
}

/** The user's recorded meetings, newest first (RLS restricts to auth.uid()).
 *  Maps DB rows to the shape the panel UI uses so history from the macOS app /
 *  other devices shows up alongside locally-recorded calls. */
export async function listMeetings(limit = 50) {
  const token = await accessToken();
  const cols = "id,meeting_title,status,started_at,stopped_at,duration_seconds,audio_path,last_error,metadata";
  const resp = await fetch(
    endpoint(`/rest/v1/meetings?select=${cols}&order=started_at.desc.nullslast&limit=${limit}`),
    { headers: { apikey: ANON, Authorization: `Bearer ${token}` } },
  );
  await check(resp);
  const rows = await resp.json();
  return (Array.isArray(rows) ? rows : []).map(mapMeetingRow);
}

function mapMeetingRow(r) {
  const md = r.metadata || {};
  const cal = md.calendar || null;
  return {
    id: r.id,
    title: r.meeting_title || "Untitled",
    status: r.status || "recorded",
    startedAt: r.started_at || null,
    endedAt: r.stopped_at || null,
    summary: md.summary || null,
    transcript: md.transcript || null,
    participants: md.participants || null, // known attendees (enrich-meeting)
    // Carried so Retry knows what is already in place: without audioPath a
    // remote meeting looked like it had never been uploaded.
    audioPath: r.audio_path || null,
    errorMessage: r.last_error || null,
    notionPageURL: md.notion_page_url || null,
    calendar: cal ? { companyName: cal.company_name || null } : null,
    remote: true,
  };
}

/** One meeting in the shape the panel uses, or null. */
export async function getMeeting(id) {
  const row = await fetchMeeting(id);
  return row ? mapMeetingRow(row) : null;
}

/** Links a meeting to CRM contacts (idempotent). */
export async function linkMeetingContacts(meetingID, contactIDs, userId) {
  if (!contactIDs || contactIDs.length === 0) return;
  const rows = contactIDs.map((cid) => ({ meeting_id: meetingID, contact_id: cid, user_id: userId }));
  await postREST(
    "/rest/v1/meeting_contacts?on_conflict=meeting_id,contact_id",
    rows,
    "resolution=ignore-duplicates,return=minimal",
  );
}

// --- Edge Functions ------------------------------------------------------

export async function invokeRaw(name, body) {
  const token = await accessToken();
  const resp = await fetch(endpoint(`/functions/v1/${name}`), {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await check(resp);
  return resp.json();
}

/** Builds a wss:// URL for a WebSocket Edge Function. Browsers can't set WS
 *  headers, so the (fresh) user JWT rides as `token` and the anon key as
 *  `apikey` — the same query-auth pattern Supabase Realtime uses. */
export async function functionWsURL(name, params = {}) {
  const token = await accessToken();
  const u = new URL(`${BASE.replace(/^http/, "ws")}/functions/v1/${name}`);
  u.searchParams.set("apikey", ANON);
  u.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

/** Fetches the signed-in user's imminent calendar calls (best-effort). */
export async function fetchUpcomingMeetings(withinMinutes = 15) {
  return invokeRaw("upcoming-meetings", { within_minutes: withinMinutes });
}

// --- Notion OAuth (per-user public integration) --------------------------
// The notion-oauth function routes on ?action=. Tokens stay server-side; the
// client only ever sees connection status + the authorize URL to open.

async function notionCall(action, method, body) {
  const token = await accessToken();
  const resp = await fetch(endpoint(`/functions/v1/notion-oauth?action=${action}`), {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  await check(resp);
  return resp.json();
}

/** { connected, workspace_name, workspace_icon, database_url } */
export function notionStatus() { return notionCall("status", "GET"); }
/** { url } — the Notion authorize URL to open in a tab. */
export function notionStart() { return notionCall("start", "POST"); }
/** Removes the stored connection. */
export function notionDisconnect() { return notionCall("disconnect", "POST"); }
/** { connected, databases: [{id,title,url}] } — for the tasks-database picker. */
export function notionDatabases() { return notionCall("databases", "POST"); }
/** Creates one to-do page in the chosen tasks database. -> { url } */
export function notionAddTask(payload) { return notionCall("add-task", "POST", payload); }
