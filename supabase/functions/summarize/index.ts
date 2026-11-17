// summarize — sends a meeting's transcript to Gemini (Flash) and stores the
// structured summary (headline, summary, key points, next steps).
//
// Gemini's free/standard tiers return 429 (RESOURCE_EXHAUSTED) under load. We
// retry with exponential backoff and fall back to alternate Flash models so a
// transient rate-limit never loses the meeting.
//
// Backend: writes to the Winday CRM's existing `meetings` table. The plain
// `summary` TEXT column gets the human-readable summary; the full structured
// object (key points, next steps, …) is kept in `metadata.summary` (jsonb).
//
// In-person meetings (`recording_mode: "in_person"`, in the request or the
// row's metadata) were recorded by ONE microphone in the room: every voice,
// the user's included, is a diarized "Participant N". The model is told so,
// asked which label is the user (speaker_map → "You", only when confident) and
// who the others are — from the attendee list, or names the conversation
// itself makes plain. Those mappings are checked here before the transcript
// is relabelled. Calls are unchanged.
//
// The Gemini API key lives ONLY here, as the `GEMINI_API_KEY` secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

// Summary shape: next steps (a to-do list — no AI-assigned priorities, the
// user judges urgency), a short "meeting context" bullet list, then DYNAMIC
// topic sections reflecting what was actually discussed. `summary` (plain
// paragraph) is kept for the CRM's text column.
const responseSchema = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    summary: { type: "STRING" },
    next_steps: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          task: { type: "STRING" },
          owner: { type: "STRING" },
          is_user: { type: "BOOLEAN" },
        },
        required: ["task", "owner", "is_user"],
      },
    },
    context: { type: "ARRAY", items: { type: "STRING" } },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          bullets: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["title", "bullets"],
      },
    },
    // Identified speakers: which "Participant N" is which known participant.
    // Only confident mappings; [] when unsure.
    speaker_map: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          from: { type: "STRING" },
          to: { type: "STRING" },
        },
        required: ["from", "to"],
      },
    },
  },
  required: ["headline", "summary", "next_steps", "context", "sections", "speaker_map"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let persistFail: ((msg: string) => Promise<void>) | null = null;
  try {
    if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY secret is not set." }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { meeting_id, gemini_model, custom_prompt, summary_length, recording_mode } = await req.json();
    // Default to the PINNED model: the "-latest" alias pool saturates (503
    // "high demand") on the free tier while the pinned pool keeps serving.
    const primary = (gemini_model && gemini_model !== "gemini-flash-latest")
      ? gemini_model
      : "gemini-2.5-flash";

    // Persist failures on the meeting row so the CRM (and debugging) can see
    // WHY a summary failed, not just that it did.
    const failMeeting = async (msg: string) => {
      await admin.from("meetings").update({ last_error: msg })
        .eq("id", meeting_id).eq("user_id", user.id);
    };
    persistFail = failMeeting;

    const { data: meeting, error: mErr } = await admin
      .from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).single();
    if (mErr || !meeting) return json({ error: "Meeting not found" }, 404);

    const utterances = meeting.metadata?.transcript?.utterances;
    if (!utterances?.length) {
      const msg = "Meeting has no transcript yet";
      await failMeeting(msg);
      return json({ error: msg }, 400);
    }

    const labelled = utterances.map((u: any) => `${u.speaker}: ${u.text}`).join("\n");
    const inPerson = recording_mode === "in_person" || meeting.metadata?.recording_mode === "in_person";
    // In person, the user's voice is unknown until someone says which it is —
    // the user in the extension ("That's me"), or the model below.
    const findUser = inPerson && !utterances.some((u: any) => u.speaker === "You");
    const diarizedLabels = [...new Set(
      utterances.map((u: any) => String(u.speaker)).filter((sp: string) => /^Participant \d+$/.test(sp)),
    )];

    // The user's first name — next steps are labelled with real names, never
    // "You" (metadata first, else the email prefix, else the literal "You").
    let userName = "You";
    try {
      const { data: u } = await admin.auth.admin.getUserById(user.id);
      const meta = (u?.user as any)?.user_metadata ?? {};
      userName = String(meta.first_name || meta.full_name || "").trim().split(/\s+/)[0] ||
        (user.email ? user.email.split("@")[0].replace(/^\w/, (c: string) => c.toUpperCase()) : "You");
    } catch { /* keep "You" */ }

    // Known participants (from enrich-meeting) → let the model identify who the
    // diarized "Participant N" voices actually are, from conversational cues.
    const participants: any[] = meeting.metadata?.participants ?? [];
    const candidateNames = [...new Set(
      participants.filter((p) => !p.is_self && p.name).map((p) => String(p.name)),
    )];
    const speakerInstruction = inPerson
      ? `\n\nSPEAKERS (in-person meeting): the labels ${diarizedLabels.join(", ") || "Participant 1, 2, …"} ` +
        `are voices told apart by diarization from one room microphone; a label may occasionally ` +
        `cover two people or one person may have two labels.` +
        (findUser
          ? ` One of these voices is the user, ${userName}. If the conversation makes it clear which ` +
            `label is ${userName} (they introduce themselves, are addressed as ${userName}, or speak ` +
            `for the user's side as only they could), add {"from": "<that label>", "to": "You"} to ` +
            `speaker_map. At most one label maps to "You", and only when you are confident.`
          : ` The user's own lines are already labelled "You".`) +
        ` For the other labels, map a label to a person's name when the conversation makes it plain ` +
        `(introductions, being addressed by name)` +
        (candidateNames.length ? ` — the attendees are ${candidateNames.join(", ")}: prefer these exact names` : ``) +
        `. Never invent a name the transcript or the attendee list does not contain. Leave a label ` +
        `out of speaker_map when unsure.`
      : candidateNames.length
      ? `\n\nKnown participants in this call (besides the user): ${candidateNames.join(", ")}. ` +
        `Using conversational cues (introductions, people addressing each other by name), fill ` +
        `speaker_map with entries mapping diarized labels (e.g. "Participant 1") to one of these ` +
        `exact names — ONLY when you are confident. Leave speaker_map empty otherwise. Never ` +
        `invent names that are not in the list, and never map "You".`
      : `\n\nReturn an empty speaker_map.`;

    // Output structure — ALWAYS enforced, even with a custom user prompt.
    const structureInstruction =
      `\n\nOUTPUT STRUCTURE (mandatory):` +
      `\n- next_steps: the meeting's action items as a to-do list. "task" is short and ` +
      `imperative, WITHOUT the owner's name inside it. "owner" is the person's FIRST NAME: ` +
      `use exactly "${userName}" for the user (the speaker labelled "You"` +
      (findUser ? `, or the label you map to "You" in speaker_map` : ``) +
      `); for others use ` +
      `their first name from the known list or conversational cues, else their diarized ` +
      `label (e.g. "Participant 2"). "is_user" is true only for the user's own items. ` +
      `Order: ALL the user's items first, then the other participants'. Do NOT assign ` +
      `priorities or due dates — the user judges urgency themselves.` +
      `\n- context: 2–5 short bullets giving the meeting's context (who/why/goal/situation).` +
      `\n- sections: the topics ACTUALLY discussed, one entry per major topic (0–6), each ` +
      `with a specific title and 2–6 factual bullets (decisions, numbers, positions). Only ` +
      `real topics — never pad with generic sections.` +
      `\n- summary: a 2–3 sentence plain recap (for the CRM record).` +
      `\n- Write everything in the same language as the transcript.`;

    // User-customizable instruction (Settings → Summary) sets tone/role only.
    const defaultInstruction =
      `You are an expert sales/meeting assistant for Winday CRM. Analyze the following ` +
      `meeting transcript and produce structured, action-oriented notes. The speaker ` +
      `labelled "You" is the app's user; "Participant 1/2/…" are the other attendees. ` +
      `Be concise and factual.`;
    const baseInstruction = (typeof custom_prompt === "string" && custom_prompt.trim())
      ? custom_prompt.trim()
      : defaultInstruction;

    const lengthInstruction = ({
      short: `\n\nLength: SHORT — only the most critical next steps, 2–3 context bullets, ` +
             `at most 2 sections.`,
      medium: ``,
      long: `\n\nLength: LONG — exhaustive next steps and up to 6 detailed sections.`,
    } as Record<string, string>)[summary_length ?? "medium"] ?? "";

    // Said after the (possibly custom) base instruction, so it holds whatever
    // that one says about a "You" speaker.
    const modeInstruction = inPerson
      ? `\n\nIMPORTANT — this was an IN-PERSON meeting, recorded by a single microphone in the room ` +
        `(not an online call). Every voice was told apart by diarization` +
        (findUser
          ? `, the user's included: no line is labelled "You" yet, and the user is one of the ` +
            `"Participant N" voices. Ignore any instruction above that says the user is the speaker ` +
            `labelled "You".`
          : `; the user has already marked their own lines as "You".`) +
        ` Diarization in a room is imperfect: rely on what is said more than on the labels.`
      : ``;

    const prompt = `${baseInstruction}${modeInstruction}${structureInstruction}${lengthInstruction}${speakerInstruction}` +
      `\n\nMeeting title: ${meeting.meeting_title}\n\nTRANSCRIPT:\n${labelled}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
        responseSchema,
        // Explicit ceiling: leaves ample room for a long summary while making
        // MAX_TOKENS truncation detectable instead of producing broken JSON.
        maxOutputTokens: 65536,
      },
    };

    const data = await generateWithRetry(primary, body);
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p?.text ?? "").join("") || null;
    if (!text) {
      const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? "no candidates";
      const msg = `Gemini returned no content (${reason})`;
      await failMeeting(msg);
      return json({ error: msg }, 502);
    }
    let summary: any;
    try {
      summary = JSON.parse(extractJSON(text));
    } catch {
      const msg = `Gemini returned invalid JSON (finishReason: ${candidate?.finishReason ?? "?"})`;
      await failMeeting(msg);
      return json({ error: msg }, 502);
    }

    // Normalize next steps regardless of what the model returned: clean items
    // only, the USER'S items first, and never any AI-assigned priority.
    if (Array.isArray(summary.next_steps)) {
      const steps = summary.next_steps
        .filter((s: any) => s && s.task)
        .map((s: any) => ({
          task: String(s.task),
          owner: String(s.owner ?? "").trim() || (s.is_user === true ? userName : "Participant"),
          is_user: s.is_user === true,
        }));
      summary.next_steps = [...steps.filter((s: any) => s.is_user), ...steps.filter((s: any) => !s.is_user)];
    }

    // Apply confident speaker identifications to the transcript: relabel the
    // diarized "Participant N" utterances with the identified names.
    const speakerMap = new Map<string, string>();
    if (inPerson) {
      // Checked, not trusted: a label that exists, a target that is "You" (once,
      // while the user is still unknown), an attendee, or a name the
      // transcript itself contains — never a name the model made up.
      const plainName = (n: string) => /^[\p{L}][\p{L}' .-]{0,39}$/u.test(n) && !/^participant \d+$/i.test(n);
      // As a whole word of what was said: "Al" is not in "also".
      const escaped = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const spoken = (n: string) =>
        new RegExp(`(^|[^\\p{L}])${escaped(n)}([^\\p{L}]|$)`, "iu").test(labelled);
      let userTaken = !findUser;
      for (const m of summary.speaker_map ?? []) {
        const from = String(m?.from ?? "").trim();
        const to = String(m?.to ?? "").trim();
        if (!diarizedLabels.includes(from) || speakerMap.has(from) || !to) continue;
        if (to === "You") {
          if (userTaken) continue;
          userTaken = true;
          speakerMap.set(from, "You");
        } else if (candidateNames.includes(to) || (plainName(to) && spoken(to))) {
          speakerMap.set(from, to);
        }
      }
    } else {
      for (const m of summary.speaker_map ?? []) {
        if (m?.from && m?.to && m.from !== "You" && candidateNames.includes(m.to)) {
          speakerMap.set(m.from, m.to);
        }
      }
    }
    // The voice identified as the user's: its next steps are the user's own;
    // a voice given a name: its steps carry the name.
    const userLabel = [...speakerMap].find(([, to]) => to === "You")?.[0];
    if (inPerson && speakerMap.size && Array.isArray(summary.next_steps)) {
      for (const st of summary.next_steps) {
        const to = speakerMap.get(st.owner);
        if (!to) continue;
        if (to === "You") { st.owner = userName; st.is_user = true; }
        else st.owner = to.split(/\s+/)[0];
      }
    }
    if (userLabel && Array.isArray(summary.next_steps)) {
      summary.next_steps = [
        ...summary.next_steps.filter((x: any) => x.is_user),
        ...summary.next_steps.filter((x: any) => !x.is_user),
      ];
    }
    const metadata = { ...(meeting.metadata ?? {}), summary };
    let transcriptText = labelled;
    if (speakerMap.size) {
      const renamed = utterances.map((u: any) => ({
        ...u,
        speaker: speakerMap.get(u.speaker) ?? u.speaker,
      }));
      metadata.transcript = { ...(meeting.metadata?.transcript ?? {}), utterances: renamed };
      transcriptText = renamed.map((u: any) => `${u.speaker}: ${u.text}`).join("\n");
    }

    // Keep meeting_title as recorded (the calendar event's name) — the AI
    // headline lives in metadata.summary.headline for display purposes.
    await admin.from("meetings").update({
      summary: summary.summary ?? "",
      transcript: transcriptText,
      metadata,
      status: "ready",
      last_error: null,
    }).eq("id", meeting_id).eq("user_id", user.id);

    return json({ summary });
  } catch (e) {
    const msg = String(e);
    try { await persistFail?.(msg); } catch { /* best effort */ }
    return json({ error: msg }, 502);
  }
});

/// Gemini occasionally wraps its JSON in markdown fences or leading prose even
/// in JSON mode; extract the outermost object so parsing survives it.
function extractJSON(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/// Calls Gemini with backoff on 429/500/503, then falls back to alternate Flash
/// models. Total worst-case wait ~10s, safely under the function time limit.
async function generateWithRetry(primary: string, body: unknown): Promise<any> {
  // gemini-2.0-flash is intentionally NOT a fallback: its free-tier quota is 0
  // (guaranteed 429). flash-lite runs on separate capacity and often survives
  // "high demand" windows that take down 2.5-flash.
  const fallbacks = ["gemini-2.5-flash", "gemini-2.5-flash-lite"].filter((m) => m !== primary);
  const plan: Array<{ model: string; delay: number }> = [
    { model: primary, delay: 0 },
    ...fallbacks.map((m) => ({ model: m, delay: 1000 })),
    { model: primary, delay: 8000 },
    ...fallbacks.map((m) => ({ model: m, delay: 4000 })),
    { model: primary, delay: 15000 },
  ];

  let lastErr = "unknown error";
  const startedAt = Date.now();
  for (const step of plan) {
    // Long transcripts make each Gemini call slow; stop launching new attempts
    // when there's no time left before the edge-function wall clock kills us.
    if (Date.now() - startedAt > 90_000 && lastErr !== "unknown error") break;
    if (step.delay) await sleep(step.delay);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${step.model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (resp.ok) return await resp.json();

    const status = resp.status;
    lastErr = `${status}: ${(await resp.text()).slice(0, 300)}`;
    // Only worth retrying on rate-limit / transient server errors.
    if (![429, 500, 503].includes(status)) break;
  }
  throw new Error(`Gemini failed after retries — ${lastErr}`);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}
