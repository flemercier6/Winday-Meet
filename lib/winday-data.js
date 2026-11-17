// Winday Data link — runs in the SERVICE WORKER only (chrome.identity).
//
// Winday Meet signs in to the Winday CRM's Supabase project; Winday Data is a
// different app with its own accounts. To put a call's next steps on the
// user's Tasks list there, the extension connects to Winday Data the way an AI
// assistant does — OAuth 2.1 with PKCE and dynamic client registration — but
// asks for scope "tasks": the consent screen then grants the user's workspaces
// and their Tasks list only, none of their ad data.
//
//   connect()          register this install once, open Winday Data's consent
//                      screen (launchWebAuthFlow), keep the tokens
//   listWorkspaces()   GET  /api/public/tasks/workspaces
//   createTask(body)   POST /api/public/tasks/create
//
// Tokens live in chrome.storage.local; the access token lasts an hour and is
// refreshed with the rotating refresh token. A refused refresh means the
// connection was revoked or expired: the extension forgets it and asks the
// user to connect again.
import { CONFIG } from "../config.js";

const BASE = CONFIG.windayDataURL.replace(/\/+$/, "");
const KEY = "wn_winday_data";
const SCOPE = "tasks";

export class WindayDataError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function load() {
  return (await chrome.storage.local.get(KEY))[KEY] || {};
}
async function save(patch) {
  const next = { ...(await load()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
async function forgetTokens() {
  const { clientId, redirectUri } = await load();
  await chrome.storage.local.set({ [KEY]: { clientId, redirectUri } });
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}
async function pkcePair() {
  const verifier = randomString(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

async function readJson(resp) {
  const text = await resp.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return { message: text };
  }
}

/** This install's OAuth client: registered once per redirect URI (each install has its own extension id). */
async function clientFor(redirectUri) {
  const saved = await load();
  if (saved.clientId && saved.redirectUri === redirectUri) return saved.clientId;
  const resp = await fetch(`${BASE}/api/public/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Winday Meet",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
      client_uri: "https://winday.app",
    }),
  });
  const body = await readJson(resp);
  if (!resp.ok || !body.client_id) {
    throw new WindayDataError("register_failed", body.error_description || "Winday Data could not register the extension.", resp.status);
  }
  await save({ clientId: body.client_id, redirectUri });
  return body.client_id;
}

function keepTokens(token) {
  return save({
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in || 3600) * 1000,
    scope: token.scope || SCOPE,
    connectedAt: Date.now(),
  });
}

/** Whether a Winday Data connection is held (it may still turn out revoked). */
export async function isConnected() {
  const s = await load();
  return !!(s.accessToken && s.refreshToken);
}

/** Open Winday Data's consent screen and keep the tokens it grants. Needs a user gesture upstream. */
export async function connect() {
  const redirectUri = chrome.identity.getRedirectURL("winday-data");
  const clientId = await clientFor(redirectUri);
  const { verifier, challenge } = await pkcePair();
  const state = randomString(16);

  const url = new URL(`${BASE}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);

  let back;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  } catch (e) {
    throw new WindayDataError("cancelled", "Connection to Winday Data was cancelled.");
  }
  const params = new URL(back).searchParams;
  if (params.get("error")) {
    throw new WindayDataError("denied", "Winday Data access was not granted.");
  }
  if (params.get("state") !== state || !params.get("code")) {
    throw new WindayDataError("bad_redirect", "Winday Data sent back an unexpected answer.");
  }

  const resp = await fetch(`${BASE}/api/public/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.get("code"),
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    }),
  });
  const token = await readJson(resp);
  if (!resp.ok || !token.access_token) {
    throw new WindayDataError("token_failed", token.error_description || "Winday Data refused the connection.", resp.status);
  }
  await keepTokens(token);
}

/** Forget the connection on this device (the user revokes it for good in Winday Data ▸ Settings). */
export async function disconnect() {
  await forgetTokens();
}

// One refresh at a time: two calls finding the token stale at once would
// both spend the same rotating refresh token, and the second would be taken
// for a replay — which revokes the whole connection.
let refreshing = null;

async function accessToken() {
  const s = await load();
  if (!s.accessToken || !s.refreshToken) {
    throw new WindayDataError("not_connected", "Connect Winday Data first.");
  }
  if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
  if (!refreshing) {
    refreshing = (async () => {
      const resp = await fetch(`${BASE}/api/public/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: s.refreshToken,
          client_id: s.clientId,
        }),
      });
      const token = await readJson(resp);
      if (!resp.ok || !token.access_token) {
        if (resp.status === 400 || resp.status === 401) {
          await forgetTokens();
          throw new WindayDataError("not_connected", "Your Winday Data connection ended — connect it again.", resp.status);
        }
        throw new WindayDataError("refresh_failed", "Winday Data could not be reached.", resp.status);
      }
      await keepTokens(token);
      return token.access_token;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function call(path, init = {}) {
  const token = await accessToken();
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  const body = await readJson(resp);
  if (resp.status === 401) {
    await forgetTokens();
    throw new WindayDataError("not_connected", "Your Winday Data connection ended — connect it again.", 401);
  }
  if (!resp.ok) {
    throw new WindayDataError(body.error || "request_failed", body.message || "Winday Data could not do this.", resp.status);
  }
  return body;
}

/** {tasks_enabled, workspaces: [{id, name, role, can_add_tasks}]} */
export function listWorkspaces() {
  return call("/api/public/tasks/workspaces");
}

/** {task, workspace} — body: {workspace_id, title, description?} */
export function createTask(body) {
  return call("/api/public/tasks/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
