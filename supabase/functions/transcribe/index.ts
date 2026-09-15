// transcribe — uploads a recorded meeting's audio to Deepgram (Nova-3) and
// stores the transcript.
//
// The recording is a stereo WAV where channel 0 is the user's mic and channel 1
// is the meeting audio. We use `multichannel=true` so Deepgram transcribes each
// channel independently (channel 0 = "You", channel 1 = the others), plus
// `diarize=true` so multiple remote participants on channel 1 are split too.
//
// Backend: this runs against the Winday CRM's own Supabase project and writes to
// its existing `meetings` table. That table stores `transcript`/`summary` as
// human-readable TEXT columns; the structured payload (utterances, language, …)
// is kept in the `metadata` jsonb column so nothing is lost.
//
// The Deepgram API key lives ONLY here, as the `DEEPGRAM_API_KEY` secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    if (!DEEPGRAM_API_KEY) return json({ error: "DEEPGRAM_API_KEY secret is not set." }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { meeting_id, deepgram_model, deepgram_language } = await req.json();
    const model = deepgram_model || "nova-3";
    // A specific language pins transcription; "multi"/unset auto-detects the
    // dominant language (pre-recorded supports detect_language for any language).
    const lang = deepgram_language && deepgram_language !== "multi" ? deepgram_language : null;

    const { data: meeting, error: mErr } = await admin
      .from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).single();
    if (mErr || !meeting) return json({ error: "Meeting not found" }, 404);
    if (!meeting.audio_path) return json({ error: "Meeting has no audio_path" }, 400);

    const { data: signed, error: sErr } = await admin.storage
      .from("recordings").createSignedUrl(meeting.audio_path, 600);
    if (sErr || !signed) return json({ error: "Could not sign audio URL" }, 500);

    const dgUrl = new URL("https://api.deepgram.com/v1/listen");
    const dgParams: Record<string, string> = {
      model,
      multichannel: "true",
      diarize: "true",
      punctuate: "true",
      numerals: "true",
      utterances: "true",
      smart_format: "true",
    };
    if (lang) dgParams.language = lang;        // pinned language
    else dgParams.detect_language = "true";    // auto-detect any language
    for (const [k, v] of Object.entries(dgParams)) dgUrl.searchParams.set(k, v);

    const dgResp = await fetch(dgUrl, {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: signed.signedUrl }),
    });
    if (!dgResp.ok) return json({ error: `Deepgram ${dgResp.status}: ${await dgResp.text()}` }, 502);

    const dg = await dgResp.json();

    // Build labelled utterances. Channel 0 = you, channel 1 = the meeting
    // (diarized into Participant 1, 2, …).
    const raw = (dg?.results?.utterances ?? []).slice().sort(
      (a: any, b: any) => (a.start ?? 0) - (b.start ?? 0));
    const mapped = raw.map((u: any) => ({
      speaker: (u.channel ?? 0) === 0 ? "You" : `Participant ${(u.speaker ?? 0) + 1}`,
      text: u.transcript ?? "",
      start: u.start ?? 0,
      end: u.end ?? 0,
    })).filter((u: any) => u.text.trim().length > 0);

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
    const language = dg?.results?.channels?.[0]?.detected_language ?? lang ?? null;

    // Structured payload the app + CRM UI consume.
    const transcript = { fullText, utterances, language };
    // Human-readable transcript for the CRM's TEXT column.
    const labelled = utterances.map((u: any) => `${u.speaker}: ${u.text}`).join("\n");

    const metadata = { ...(meeting.metadata ?? {}), transcript, language };

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
