// transcribe-gladia — uploads a recorded meeting's audio to Gladia (v2
// pre-recorded, async) and stores the transcript. Same contract and same DB
// writes as `transcribe` (the Deepgram version); the extension picks one or the
// other via its "Transcription engine" setting, so both can coexist for A/B
// testing without touching the macOS app's flow.
//
// The recording is stereo: channel 0 is the user's mic, channel 1 the meeting
// audio. Gladia transcribes each channel separately when the source keeps them,
// and its diarization splits multiple remote participants. If the channels
// don't survive (mono source / downmix), we fall back to diarization-only
// labels — no "You" in that case, just Participant 1..N.
//
// Language: `language` pins one; "multi"/unset lets Gladia auto-detect with
// code-switching enabled (the language can change mid-call).
//
// The Gladia API key lives ONLY here, as the `GLADIA_API_KEY` secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GLADIA_API_KEY = Deno.env.get("GLADIA_API_KEY") ?? "";

const GLADIA_BASE = "https://api.gladia.io/v2/pre-recorded";
// Gladia is async (init → poll). Meetings of ~1h typically transcribe in well
// under 2 minutes; cap the wait comfortably below the edge-function wall limit.
const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 340_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    if (!GLADIA_API_KEY) return json({ error: "GLADIA_API_KEY secret is not set." }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { meeting_id, language: reqLanguage } = await req.json();
    const lang = reqLanguage && reqLanguage !== "multi" ? reqLanguage : null;

    const { data: meeting, error: mErr } = await admin
      .from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).single();
    if (mErr || !meeting) return json({ error: "Meeting not found" }, 404);
    if (!meeting.audio_path) return json({ error: "Meeting has no audio_path" }, 400);

    const { data: signed, error: sErr } = await admin.storage
      .from("recordings").createSignedUrl(meeting.audio_path, 600);
    if (sErr || !signed) return json({ error: "Could not sign audio URL" }, 500);

    // Kick off the async transcription.
    const initResp = await fetch(GLADIA_BASE, {
      method: "POST",
      headers: { "x-gladia-key": GLADIA_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: signed.signedUrl,
        diarization: true,
        language_config: {
          languages: lang ? [lang] : [],   // [] = auto-detect any language
          code_switching: !lang,           // allow mid-call language changes when auto
        },
      }),
    });
    if (!initResp.ok) return json({ error: `Gladia init ${initResp.status}: ${await initResp.text()}` }, 502);
    const init = await initResp.json();
    const resultUrl = init?.result_url || (init?.id ? `${GLADIA_BASE}/${init.id}` : null);
    if (!resultUrl) return json({ error: "Gladia init returned no result URL." }, 502);

    // Poll until done.
    const deadline = Date.now() + POLL_DEADLINE_MS;
    let result: any = null;
    while (Date.now() < deadline) {
      const pollResp = await fetch(resultUrl, { headers: { "x-gladia-key": GLADIA_API_KEY } });
      if (!pollResp.ok) return json({ error: `Gladia poll ${pollResp.status}: ${await pollResp.text()}` }, 502);
      const body = await pollResp.json();
      if (body?.status === "done") { result = body; break; }
      if (body?.status === "error") {
        return json({ error: `Gladia transcription failed: ${body?.error_code ?? "unknown error"}` }, 502);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!result) return json({ error: "Gladia transcription timed out — try again for long recordings." }, 504);

    const transcription = result?.result?.transcription ?? {};
    const raw = (transcription.utterances ?? []).slice().sort(
      (a: any, b: any) => (a.start ?? 0) - (b.start ?? 0));

    // Speaker labels. Preferred: channel 0 = "You", channel 1 = the meeting,
    // whose speakers (diarization) become Participant 1, 2, … in order of first
    // appearance. Fallback (channels not preserved): diarization-only labels.
    const hasChannels = raw.some((u: any) => (u.channel ?? 0) > 0);
    const partIndex = new Map<string, number>();
    const participantLabel = (key: string) => {
      if (!partIndex.has(key)) partIndex.set(key, partIndex.size + 1);
      return `Participant ${partIndex.get(key)}`;
    };
    const mapped = raw.map((u: any) => {
      const ch = u.channel ?? 0;
      let speaker: string;
      if (hasChannels && ch === 0) speaker = "You";
      else {
        const key = typeof u.speaker === "number" ? `s${u.speaker}` : `c${ch}`;
        speaker = participantLabel(key);
      }
      return { speaker, text: (u.text ?? "").trim(), start: u.start ?? 0, end: u.end ?? 0 };
    }).filter((u: any) => u.text.length > 0);

    // Echo suppression (only meaningful when we have a "You" channel): when the
    // call plays through speakers, the mic picks the remote voices back up, so
    // participants' words also appear (garbled) on the "You" channel. Drop "You"
    // utterances whose words are near-duplicates (≥70% token overlap) of a
    // time-overlapping participant utterance. Mirrors the Deepgram function.
    //
    // Tokenised ONCE per utterance and compared only inside a sliding ±2s
    // window over the time-sorted participant turns: the naive pairwise
    // version re-tokenised every participant turn for every "You" turn, and a
    // one-hour call (~1,500 turns each side) blew the edge runtime's CPU
    // budget — the transcript was written, then the function was killed
    // before it could answer (HTTP 546).
    const utterances = suppressEcho(mapped);

    // An empty transcription means the audio itself is silent/broken (e.g. the
    // recording died mid-meeting). Surface that as a hard failure instead of
    // letting summarize fail downstream with a confusing "no transcript" error.
    if (utterances.length === 0) {
      const msg = "No speech was detected in the recording — the audio file appears to be empty or corrupted.";
      await admin.from("meetings").update({ status: "failed", last_error: msg })
        .eq("id", meeting_id).eq("user_id", user.id);
      return json({ error: msg }, 422);
    }

    const fullText = utterances.map((u: any) => u.text).join(" ");
    const language = (transcription.languages ?? [])[0] ?? lang ?? null;

    // Structured payload the app + CRM UI consume.
    const transcript = { fullText, utterances, language };
    // Human-readable transcript for the CRM's TEXT column.
    const labelled = utterances.map((u: any) => `${u.speaker}: ${u.text}`).join("\n");

    const metadata = {
      ...(meeting.metadata ?? {}),
      transcript,
      language,
      transcription_provider: "gladia",   // A/B marker: which engine made this transcript
    };

    await admin.from("meetings").update({
      transcript: labelled,
      metadata,
      status: "summarizing",
      last_error: null,
    }).eq("id", meeting_id).eq("user_id", user.id);

    return json({ transcript });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

/// Token set of an utterance: lower-case, accents stripped, punctuation out.
function tokenSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean),
  );
}

/// Drops "You" turns that echo a time-overlapping participant turn (≥70% of
/// the "You" tokens present in it). Linear in practice: one tokenisation per
/// turn, and only turns within ±2s are compared.
function suppressEcho(utts: Array<{ speaker: string; text: string; start: number; end: number }>) {
  const WINDOW = 2;
  const parts = utts.filter((u) => u.speaker !== "You")
    .map((u) => ({ start: u.start, end: u.end, toks: tokenSet(u.text) }));
  // Sorted by start; a pointer skips participant turns that ended too early
  // for ANY later "You" turn (utts are start-sorted, so this only advances).
  let from = 0;
  return utts.filter((u) => {
    if (u.speaker !== "You") return true;
    const yt = [...tokenSet(u.text)];
    if (yt.length === 0) return true;
    while (from < parts.length && parts[from].end < u.start - WINDOW) {
      // Participant turns are start-sorted, not end-sorted: only skip while
      // the run of early-ending turns is contiguous from the front.
      from++;
    }
    for (let i = from; i < parts.length; i++) {
      const p = parts[i];
      if (p.start > u.end + WINDOW) break;
      if (p.end < u.start - WINDOW) continue;
      let hits = 0;
      for (const w of yt) if (p.toks.has(w)) hits++;
      if (hits / yt.length >= 0.7) return false;
    }
    return true;
  });
}
