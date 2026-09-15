// Runs the post-recording pipeline through the shared Supabase backend:
// upload audio -> insert row -> transcribe -> summarize -> optionally export.
// Mirrors the macOS app's PipelineCoordinator, including its failure policy:
// once a stage's result is obtained it is never thrown away. If summarize fails
// we keep the transcript; if export fails we keep the summary. Only failures
// that leave nothing to keep reject.
//
// On the live path the audio is an ARCHIVE, not an input: the transcript was
// produced during the call, so an upload that fails (a two-hour call over the
// Storage size limit, a network drop) must never cost the user their notes.
import * as sb from "./supabase.js";

export const STAGE_LABELS = {
  uploading: "Preparing…",
  transcribing: "Transcribing…",
  summarizing: "Summarizing…",
  exporting: "Saving notes…",
  done: "Done",
};

/** Batch transcription via the provider chosen in Settings. Both functions
 *  share the same contract (write the transcript to the meeting row, return
 *  { transcript }); only the payload differs. */
function invokeTranscribe(meetingId, settings) {
  if ((settings.transcriptionProvider || "gladia") === "gladia") {
    return sb.invokeRaw("transcribe-gladia", {
      meeting_id: meetingId,
      language: settings.transcriptionLanguage,
    });
  }
  return sb.invokeRaw("transcribe", {
    meeting_id: meetingId,
    deepgram_model: settings.deepgramModel,
    deepgram_language: settings.transcriptionLanguage,
  });
}

/** Runs the batch transcription. When the call errors, the function may
 *  still have done its job: it writes the transcript to the row BEFORE it
 *  answers, and a long call can push it over the platform's CPU budget right
 *  after that write (HTTP 546). Check the row before giving up — otherwise a
 *  transcript that exists on the server would be reported as "no audio". */
async function transcribeOrRecover(m, settings) {
  try {
    const tr = await invokeTranscribe(m.id, settings);
    return tr.transcript;
  } catch (e) {
    const row = await sb.fetchMeeting(m.id).catch(() => null);
    const stored = row && row.metadata && row.metadata.transcript;
    if (stored && stored.utterances && stored.utterances.length) {
      console.warn("Winday: transcription call failed but the transcript was saved —", e?.message || e);
      return stored;
    }
    throw e;
  }
}

/** Who was in the call, and which company it was with (enrich-meeting).
 *  Best-effort: a failure here never costs the notes. The resolved company
 *  is mirrored onto the meeting so the list shows it right away. */
async function enrich(m) {
  try {
    const r = await sb.invokeRaw("enrich-meeting", { meeting_id: m.id });
    if (r && r.company && r.company.name) {
      m.calendar = {
        ...(m.calendar || {}),
        companyID: r.company.id || null,
        companyName: r.company.name,
        companyLogoURL: r.company.logo_url || null,
      };
    }
    if (r && Array.isArray(r.participants)) m.participants = r.participants;
  } catch (_) { /* best-effort */ }
}

/** "You: …" lines — how the CRM's plain `transcript` column stores a call. */
function labelled(utterances) {
  return utterances.map((u) => `${u.speaker}: ${u.text}`).join("\n");
}

function durationSeconds(m, stoppedAt) {
  return Math.max(0, Math.round(
    (new Date(stoppedAt).getTime() - new Date(m.startedAt).getTime()) / 1000,
  ));
}

function calendarMeta(cal) {
  const meta = {
    google_event_id: cal.googleEventID,
    contact_ids: cal.contactIDs || [],
  };
  if (cal.companyID) meta.company_id = cal.companyID;
  if (cal.companyName) meta.company_name = cal.companyName;
  if (cal.companyLogoURL) meta.company_logo_url = cal.companyLogoURL;
  return meta;
}

/** The `meetings` row for a call whose transcript already exists (live path and
 *  Retry both create it — Retry because a failed upload may have killed the
 *  pipeline before the row was ever written). */
function liveMeetingRow(m, transcript, userId, audioUploadError) {
  const stoppedAt = m.endedAt || new Date().toISOString();
  const metadata = {
    transcript: {
      fullText: transcript.fullText,
      utterances: transcript.utterances,
      language: transcript.language || null,
    },
  };
  if (m.calendar) metadata.calendar = calendarMeta(m.calendar);
  // Kept for support: why this call has notes but no audio to play back.
  if (audioUploadError) metadata.audio_upload_error = audioUploadError;

  const payload = {
    id: m.id,
    user_id: userId,
    meeting_title: m.title,
    status: "summarizing",
    audio_path: m.audioPath || null,
    started_at: m.startedAt,
    stopped_at: stoppedAt,
    duration_seconds: durationSeconds(m, stoppedAt),
    transcript: labelled(transcript.utterances),
    metadata,
  };
  if (m.calendar && m.calendar.meetURL) payload.meeting_url = m.calendar.meetURL;
  return { payload, metadata };
}

/** Writes the transcript-carrying row. `ignore-duplicates` means an existing
 *  row wins, and there is one case where that row is the WRONG one: the batch
 *  pass created a transcript-less row and then failed, and we are the fallback.
 *  Fill in what it is missing rather than silently keeping the empty row. */
async function saveLiveRow(m, transcript, userId, audioUploadError, extraMetadata) {
  const { payload, metadata } = liveMeetingRow(m, transcript, userId, audioUploadError);
  if (extraMetadata) Object.assign(metadata, extraMetadata); // payload.metadata is this object
  const inserted = await sb.insertMeeting(payload);
  if (!inserted) {
    const row = await sb.fetchMeeting(m.id);
    const stored = row?.metadata?.transcript?.utterances || [];
    if (stored.length === 0) {
      await sb.patchMeeting(m.id, {
        status: "summarizing",
        transcript: payload.transcript,
        metadata: { ...(row?.metadata || {}), ...metadata },
        audio_path: row?.audio_path || payload.audio_path,
      });
    }
  }
  return { payload, metadata };
}

/** Uploads the audio, but never lets a failed upload sink a call that already
 *  has a transcript. Returns the error message when the audio was dropped. */
async function uploadArchive(blob, m, userId) {
  const audioPath = `${userId}/${m.id}.webm`;
  try {
    await sb.uploadRecording(blob, audioPath, "audio/webm");
    m.audioPath = audioPath;
    return null;
  } catch (e) {
    const msg = String(e?.body || e?.message || e);
    console.warn("Winday: audio upload failed, keeping the meeting anyway —", msg);
    return msg;
  }
}

/** The tail every path shares: summarize, then export — each keeping what the
 *  stage before it produced. Only summarize failing marks the meeting failed;
 *  a Notion failure leaves a perfectly good, readable meeting behind. */
async function summarizeAndExport(m, { settings, onStage = () => {} }) {
  onStage("summarizing");
  try {
    const sr = await sb.invokeRaw("summarize", {
      meeting_id: m.id,
      gemini_model: settings.geminiModel,
      custom_prompt: settings.summaryPrompt,
      summary_length: settings.summaryLength,
    });
    m.summary = sr.summary;
    if (!m.title || m.title.startsWith("Meeting ")) m.title = sr.summary.headline || m.title;
    m.status = "ready";
    m.errorMessage = null;
  } catch (e) {
    m.status = "failed";
    m.errorMessage = `Summary failed: ${e.message}`;
    return m;
  }

  if (settings.autoExportToNotion && (settings.notionConnected || settings.notionDatabaseID)) {
    onStage("exporting");
    m.status = "exporting";
    try {
      const ex = await sb.invokeRaw("export-notion", {
        meeting_id: m.id,
        notion_database_id: settings.notionDatabaseID,
      });
      m.notionPageURL = ex.url;
      m.status = "exported";
    } catch (e) {
      m.status = "ready";
      m.errorMessage = `Notion export failed: ${e.message}`;
    }
  }

  onStage("done");
  return m;
}

/**
 * @param {Blob} blob   the recorded audio (stereo webm/opus: L = you, R = them)
 * @param {object} meeting  { id, title, startedAt, endedAt, calendar? }
 * @param {object} opts  { settings, onStage(stageKey) }
 * @returns {Promise<object>} the finished meeting (may carry errorMessage if a
 *          late stage failed but an earlier result was preserved)
 */
export async function process(blob, meeting, opts) {
  const { settings, onStage = () => {} } = opts;
  const m = { ...meeting };

  const userId = await sb.currentUserId();
  if (!userId) throw new Error("Not authenticated.");

  // 1) Upload + create the row. Here the audio IS the input (nothing was
  //    transcribed live), so a failed upload has to reject.
  onStage("uploading");
  const audioPath = `${userId}/${m.id}.webm`;
  await sb.uploadRecording(blob, audioPath, "audio/webm");
  m.audioPath = audioPath;
  // Also on the caller's object: if a later stage throws, the meeting it
  // saves as failed must remember the audio IS up there (Retry needs it).
  meeting.audioPath = audioPath;

  const stoppedAt = m.endedAt || new Date().toISOString();
  const payload = {
    id: m.id,
    user_id: userId,
    meeting_title: m.title,
    status: "recorded",
    audio_path: audioPath,
    started_at: m.startedAt,
    stopped_at: stoppedAt,
    duration_seconds: durationSeconds(m, stoppedAt),
  };
  if (m.calendar) {
    if (m.calendar.meetURL) payload.meeting_url = m.calendar.meetURL;
    payload.metadata = { calendar: calendarMeta(m.calendar) };
  }
  await sb.insertMeeting(payload);

  if (m.calendar && (m.calendar.contactIDs || []).length > 0) {
    try {
      await sb.linkMeetingContacts(m.id, m.calendar.contactIDs, userId);
    } catch (_) {
      /* non-fatal */
    }
  }

  // 2) Transcribe (throws — no transcript yet).
  onStage("transcribing");
  m.transcript = await transcribeOrRecover(m, settings);

  // 2b) Resolve who was in the call, the company, and link CRM contacts.
  await enrich(m);

  // 3) Summarize — KEEP the transcript if this fails.
  // 4) Export to Notion — KEEP the summary if this fails.
  return summarizeAndExport(m, opts);
}

/**
 * Live-transcript path (Deepgram only — with Gladia the saved transcript
 * always comes from the batch pass): the transcript was produced in real time
 * during the call, so we skip the batch pass. Upload the audio, insert the row
 * WITH the transcript, then enrich → summarize → export.
 * @param {Blob} blob
 * @param {object} meeting
 * @param {{fullText:string, utterances:Array, language:?string}} transcript
 * @param {object} opts { settings, onStage }
 */
export async function processLive(blob, meeting, transcript, opts) {
  const { onStage = () => {} } = opts;
  const m = { ...meeting };

  const userId = await sb.currentUserId();
  if (!userId) throw new Error("Not authenticated.");

  // The transcript is already in hand, so the upload is best-effort: an
  // oversized or interrupted upload costs the audio, never the notes.
  onStage("uploading");
  const audioError = await uploadArchive(blob, m, userId);

  const { metadata } = await saveLiveRow(m, transcript, userId, audioError);
  m.transcript = metadata.transcript;

  if (m.calendar && (m.calendar.contactIDs || []).length > 0) {
    try { await sb.linkMeetingContacts(m.id, m.calendar.contactIDs, userId); } catch (_) { /* non-fatal */ }
  }

  await enrich(m);

  return summarizeAndExport(m, opts);
}

/**
 * Imported transcript: no recording of our own ever existed (the call was
 * captured elsewhere, or its audio never reached Storage). Everything after
 * the audio is identical to a recorded call — the row, the participant
 * enrichment, the summary, the CRM entry, the Notion export.
 * @param {object} meeting  { id, title, startedAt, endedAt }
 * @param {{fullText:string, utterances:Array, language:?string}} transcript
 * @param {object} opts { settings, onStage }
 */
export async function importTranscript(meeting, transcript, opts) {
  const { onStage = () => {} } = opts;
  const m = { ...meeting };
  if (!transcript || !transcript.utterances || transcript.utterances.length === 0) {
    throw new Error("That file has no readable transcript.");
  }

  const userId = await sb.currentUserId();
  if (!userId) throw new Error("Not authenticated.");

  onStage("uploading");
  // Marked so the row is not mistaken for a recording whose upload failed.
  const { metadata } = await saveLiveRow(m, transcript, userId, null, { imported: true });
  m.transcript = metadata.transcript;

  await enrich(m);

  return summarizeAndExport(m, opts);
}

/** Re-run only the stages that have not produced a result yet (Retry). */
export async function retry(meeting, opts) {
  const { settings, onStage = () => {} } = opts;
  const m = { ...meeting };
  m.errorMessage = null;

  const utterances = (m.transcript && m.transcript.utterances) || [];
  // A live transcript is enough to finish a call — the audio only matters for
  // the batch transcription pass. This is what rescues a long meeting whose
  // audio upload was rejected: the notes can still be produced.
  if (!m.audioPath && utterances.length === 0) {
    throw new Error("This recording was never uploaded — record again.");
  }

  const userId = await sb.currentUserId();
  if (!userId) throw new Error("Not authenticated.");
  // The row may never have been written (the pipeline can die before the
  // insert), and an older one may predate the transcript. Fix both first.
  await ensureMeetingRow(m, utterances, userId);

  if (!(m.transcript && m.transcript.utterances && m.transcript.utterances.length)) {
    onStage("transcribing");
    m.transcript = await transcribeOrRecover(m, settings);
  }
  if (!m.summary) {
    await enrich(m);
    onStage("summarizing");
    const sr = await sb.invokeRaw("summarize", {
      meeting_id: m.id,
      gemini_model: settings.geminiModel,
      custom_prompt: settings.summaryPrompt,
      summary_length: settings.summaryLength,
    });
    m.summary = sr.summary;
    if (!m.title || m.title.startsWith("Meeting ")) m.title = sr.summary.headline || m.title;
    m.status = "ready";
  }
  if (settings.autoExportToNotion && (settings.notionConnected || settings.notionDatabaseID) && !m.notionPageURL) {
    onStage("exporting");
    const ex = await sb.invokeRaw("export-notion", {
      meeting_id: m.id,
      notion_database_id: settings.notionDatabaseID,
    });
    m.notionPageURL = ex.url;
    m.status = "exported";
  }
  onStage("done");
  m.errorMessage = null;
  return m;
}

/** Makes sure the server has this meeting, with its transcript, before the
 *  Edge Functions are asked to work on it. Idempotent. */
async function ensureMeetingRow(m, utterances, userId) {
  const row = await sb.fetchMeeting(m.id);
  if (!row) {
    // Nothing server-side: the insert never ran. Rebuild the row from what we
    // have — the live transcript when there is one, else the uploaded audio so
    // the batch transcription has something to attach to.
    if (utterances.length > 0) {
      await saveLiveRow(m, m.transcript, userId);
      return;
    }
    const stoppedAt = m.endedAt || new Date().toISOString();
    const payload = {
      id: m.id,
      user_id: userId,
      meeting_title: m.title,
      status: "recorded",
      audio_path: m.audioPath,
      started_at: m.startedAt,
      stopped_at: stoppedAt,
      duration_seconds: durationSeconds(m, stoppedAt),
    };
    if (m.calendar) {
      if (m.calendar.meetURL) payload.meeting_url = m.calendar.meetURL;
      payload.metadata = { calendar: calendarMeta(m.calendar) };
    }
    await sb.insertMeeting(payload);
    return;
  }
  const stored = row.metadata?.transcript?.utterances || [];
  if (stored.length === 0 && utterances.length > 0) {
    await sb.patchMeeting(m.id, {
      status: "summarizing",
      transcript: labelled(utterances),
      metadata: { ...(row.metadata || {}), transcript: m.transcript },
    });
  }
}

/** Export an already-summarized meeting to Notion (explicit action). */
export async function exportToNotion(meeting, settings) {
  const ex = await sb.invokeRaw("export-notion", {
    meeting_id: meeting.id,
    notion_database_id: settings.notionDatabaseID,
  });
  return ex.url;
}
