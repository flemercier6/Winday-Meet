// The offscreen recording host: consumes tabCapture stream ids (the SILENT
// capture path) and runs the shared recording engine. Living outside any tab,
// it survives tab closes and service-worker suspensions for the whole
// multi-minute pipeline. It has NO chrome.storage access — the background
// hands it session + settings in each message, and every persistable change
// goes back through the WN_* report protocol.
//
// Retry / export of PAST meetings also run here (pure fetch work).
import * as pipeline from "./lib/pipeline.js";
import { createRecorder, acquireMic, configureSession, report, recoverFromJournal } from "./lib/capture.js";

let recorder = null;

// Liveness beacon for non-recording work (retry/export/recovery): while any of
// it runs, hold a "wn-recorder" port so the service worker's crash-recovery
// sweep knows a host is alive and doesn't fire a duplicate recovery.
let working = 0;
let workPort = null;
function connectWorkPort() {
  if (working <= 0 || workPort) return;
  try {
    workPort = chrome.runtime.connect({ name: "wn-recorder" });
    workPort.onDisconnect.addListener(() => {
      workPort = null;
      if (working > 0) setTimeout(connectWorkPort, 500); // SW restarted
    });
  } catch (_) { /* extension context going away */ }
}
function holdWorkPort() { working++; connectWorkPort(); }
function releaseWorkPort() {
  working = Math.max(0, working - 1);
  if (working === 0 && workPort) { try { workPort.disconnect(); } catch (_) {} workPort = null; }
}
async function withWorkPort(fn) {
  holdWorkPort();
  try { return await fn(); } finally { releaseWorkPort(); }
}

// A recovery already in flight must not be started twice (the boot sweep can
// re-fire after a service-worker restart while we're still uploading).
let recovering = false;
async function recover({ session, settings }) {
  if (recovering) return;
  recovering = true;
  try {
    const did = await withWorkPort(() => recoverFromJournal(session, settings));
    if (!did) {
      report({ type: "WN_REC_FAILED", error: "The recording was interrupted before anything could be saved." });
    }
  } finally {
    recovering = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  switch (msg.type) {
    case "START":
      startRecording(msg).catch((e) => {
        if (recorder) recorder.failNow(e);
        else report({ type: "WN_REC_FAILED", error: String(e?.message || e) });
      });
      break;
    case "STOP":
      recorder?.stop(false);
      break;
    case "CANCEL":
      recorder?.stop(true);
      break;
    case "RETRY":
      withWorkPort(() => retryMeeting(msg)).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
    case "IMPORT":
      importMeeting(msg).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
    case "EXPORT":
      withWorkPort(() => exportMeeting(msg)).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
    case "RECOVER":
      recover(msg).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
  }
});

async function startRecording({ streamId, inPerson, meeting, session, settings }) {
  if (inPerson) {
    // An in-person meeting: no call tab, only the room's microphone, tuned
    // for voices around a table (capture.js, MIC_PROFILES.room). Recorded
    // here, so it survives the panel closing and any tab switch.
    const micStream = await acquireMic("room");
    if (!micStream) {
      throw new Error("Allow the microphone to record an in-person meeting — use the banner in the panel, then try again.");
    }
    recorder = createRecorder();
    await recorder.start({ micStream, inPerson: true, meeting, session, settings });
    return;
  }
  // Tab audio (the remote participants) minted by chrome.tabCapture.
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: false,
  });
  const micStream = await acquireMic();

  recorder = createRecorder();
  await recorder.start({
    tabStream,
    micStream,
    monitorTab: true, // tabCapture silences the tab; keep the call audible
    meeting,
    session,
    settings,
  });
}

async function retryMeeting({ meeting, session, settings }) {
  if (!meeting) throw new Error("Meeting not found.");
  configureSession(session);
  try {
    const result = await pipeline.retry(meeting, {
      settings,
      onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
    });
    report({ type: "WN_MEETING_UPSERT", meeting: result });
    report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
  } catch (e) {
    const failed = { ...meeting, status: "failed", errorMessage: String(e?.message || e) };
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  }
}

async function importMeeting({ meeting, transcript, session, settings }) {
  if (!meeting) throw new Error("Nothing to import.");
  configureSession(session);
  try {
    const result = await pipeline.importTranscript(meeting, transcript, {
      settings,
      onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
    });
    report({ type: "WN_MEETING_UPSERT", meeting: result });
    if (result.errorMessage) report({ type: "WN_REC_FAILED", error: result.errorMessage });
    else report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
  } catch (e) {
    // The transcript is the user's only copy of the call — keep it locally even
    // when the import could not reach the backend.
    const failed = { ...meeting, transcript, status: "failed", errorMessage: String(e?.message || e) };
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  }
}

async function exportMeeting({ meeting, session, settings }) {
  if (!meeting || !meeting.summary) throw new Error("Nothing to export yet.");
  configureSession(session);
  report({ type: "WN_REC_STAGE", stage: "exporting" });
  try {
    const url = await pipeline.exportToNotion(meeting, settings);
    const updated = { ...meeting, notionPageURL: url, status: "exported", errorMessage: null };
    report({ type: "WN_MEETING_UPSERT", meeting: updated });
    report({ type: "WN_REC_DONE", notionURL: url, meetingId: meeting.id });
  } catch (e) {
    report({ type: "WN_REC_FAILED", error: String(e?.message || e) });
  }
}
