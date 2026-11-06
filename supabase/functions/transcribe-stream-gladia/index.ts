// transcribe-stream-gladia — live transcription relay for the Chrome
// extension, Gladia edition (the Deepgram one is `transcribe-stream`).
//
// A browser can't hold the Gladia key, so the extension opens a WebSocket HERE;
// we initiate a Gladia live session server-side (POST /v2/live with the key)
// and proxy both directions:
//   browser  --(PCM audio)-->  this function  --(audio)-->  Gladia live WS
//   browser  <--(messages)--  this function  <--(JSON)--   Gladia live WS
//
// Auth: browsers can't set headers on a WebSocket, so the Supabase user JWT is
// passed as the `token` query param (validated below) and the anon key as
// `apikey` (authorizes the gateway — same pattern Supabase Realtime uses).
// Deployed with verify_jwt=false because the check happens here, not at the
// gateway. The GLADIA_API_KEY secret is the same one `transcribe-gladia` uses.
//
// Notes vs the Deepgram relay:
//  - a Gladia session URL is one-shot (token in the URL): every relay
//    connection creates a fresh session, which is exactly what the client's
//    reconnect logic expects;
//  - no KeepAlive message is needed — the client streams PCM continuously,
//    silence included;
//  - the client ends a session with {"type":"stop_recording"} (forwarded
//    through, like every other client message);
//  - Gladia live only takes 8 or 16 kHz now: audio at any other rate (the
//    extension sends 48 kHz) is down-sampled HERE to 16 kHz (resample.ts), so
//    every installed extension keeps working without an update. Gladia's
//    timestamps are in seconds, so the client's timing is unaffected.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PcmDownsampler, targetRate } from "./resample.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GLADIA_API_KEY = Deno.env.get("GLADIA_API_KEY") ?? "";

Deno.serve(async (req) => {
  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }
  if (!GLADIA_API_KEY) return new Response("GLADIA_API_KEY is not set.", { status: 500 });

  const url = new URL(req.url);
  const q = url.searchParams;

  // Authenticate the Supabase user before upgrading.
  const token = q.get("token") ?? "";
  const { data: { user } } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (!user) return new Response("Unauthorized", { status: 401 });

  // Session parameters from the client's audio pipeline. "multi"/unset =
  // auto-detect with code-switching; a specific code pins one language.
  const inRate = Number(q.get("sample_rate") || "48000");
  const channels = Number(q.get("channels") || "2");
  // Rate the Gladia session is opened at, and the converter feeding it.
  const sampleRate = targetRate(inRate);
  const resampler = sampleRate !== inRate ? new PcmDownsampler(inRate, sampleRate, channels) : null;
  const reqLang = q.get("language") || "multi";
  const lang = reqLang !== "multi" ? reqLang : null;

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  client.binaryType = "arraybuffer";

  let gladia: WebSocket | null = null;
  let gladiaReady = false;
  const pending: (ArrayBuffer | string)[] = [];
  let clientPing: number | undefined;
  let connectTimeout: number | undefined;

  const closeBoth = () => {
    clearInterval(clientPing);
    clearTimeout(connectTimeout);
    try { gladia && gladia.readyState <= 1 && gladia.close(); } catch (_) { /* noop */ }
    try { client.readyState <= 1 && client.close(); } catch (_) { /* noop */ }
  };

  client.onopen = async () => {
    // Heartbeat so the extension can tell a healthy-but-quiet stream from a
    // half-dead one (its watchdog reconnects after 15s of total silence).
    clientPing = setInterval(() => {
      try { client.readyState === 1 && client.send(JSON.stringify({ type: "wn-ping" })); } catch (_) { /* noop */ }
    }, 5000);
    // If the Gladia session never comes up, give up so the client retries.
    connectTimeout = setTimeout(() => {
      if (!gladiaReady) { console.log("[gladia] connect timeout"); closeBoth(); }
    }, 10000);

    // 1) Initiate the live session (returns a one-shot wss URL).
    let sessionUrl = "";
    try {
      const initResp = await fetch("https://api.gladia.io/v2/live", {
        method: "POST",
        headers: { "x-gladia-key": GLADIA_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          encoding: "wav/pcm",
          bit_depth: 16,
          sample_rate: sampleRate,
          channels,
          language_config: {
            languages: lang ? [lang] : [],   // [] = auto-detect any language
            code_switching: !lang,           // allow mid-call language changes when auto
          },
        }),
      });
      if (!initResp.ok) {
        console.log(`[gladia] init ${initResp.status}: ${await initResp.text()}`);
        closeBoth();
        return;
      }
      const init = await initResp.json();
      sessionUrl = init?.url ?? "";
    } catch (e) {
      console.log(`[gladia] init error ${String(e)}`);
      closeBoth();
      return;
    }
    if (!sessionUrl) { console.log("[gladia] init returned no session URL"); closeBoth(); return; }

    // 2) Connect and start proxying.
    gladia = new WebSocket(sessionUrl);
    gladia.binaryType = "arraybuffer";
    gladia.onopen = () => {
      gladiaReady = true;
      clearTimeout(connectTimeout);
      console.log(`[gladia] open lang=${reqLang} sr=${sampleRate} (in ${inRate}) ch=${channels} user=${user.id}`);
      for (const m of pending) { try { gladia!.send(m as ArrayBuffer); } catch (_) { /* noop */ } }
      pending.length = 0;
    };
    // Forward Gladia's JSON messages straight through to the browser.
    gladia.onmessage = (e) => { try { client.readyState === 1 && client.send(e.data); } catch (_) { /* noop */ } };
    // Log WHY Gladia dropped (close code + reason) so early stops are diagnosable.
    gladia.onclose = (ev: CloseEvent) => {
      console.log(`[gladia] close code=${ev.code} reason=${ev.reason || "(none)"} clean=${ev.wasClean}`);
      closeBoth();
    };
    gladia.onerror = (ev) => {
      console.log(`[gladia] error ${((ev as ErrorEvent)?.message) || "(unknown)"}`);
      closeBoth();
    };
  };

  client.onmessage = (e) => {
    let data = e.data as ArrayBuffer | string;
    // Audio frames are converted to the session rate; control messages
    // (stop_recording) pass through as-is.
    if (resampler && typeof data !== "string") {
      try { data = resampler.process(data); } catch (err) {
        console.log(`[gladia] resample error ${String(err)}`);
        return;
      }
      if ((data as ArrayBuffer).byteLength === 0) return;
    }
    if (!gladiaReady || !gladia) { pending.push(data); return; }
    try { gladia.send(data as ArrayBuffer); } catch (_) { /* noop */ }
  };
  client.onclose = () => {
    clearInterval(clientPing);
    clearTimeout(connectTimeout);
    // Tell Gladia the recording is over so it flushes the last words, then close.
    try {
      if (gladia && gladia.readyState === 1) {
        gladia.send(JSON.stringify({ type: "stop_recording" }));
        setTimeout(() => { try { gladia?.close(); } catch (_) { /* noop */ } }, 500);
      } else { gladia?.close(); }
    } catch (_) { /* noop */ }
  };
  client.onerror = closeBoth;

  return response;
});
