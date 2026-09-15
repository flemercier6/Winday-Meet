// Shared recording engine, used by BOTH recording hosts:
//   - the offscreen document — silent tabCapture path (survives tab close);
//   - the panel iframe embedded in the Meet tab — getDisplayMedia fallback,
//     used when Chromium refuses silent capture (no activeTab grant). That
//     API is the same one Meet itself uses for screen sharing, so it exists
//     in every Chromium — including Arc, which lacks the extension picker.
//
// The engine mixes the meeting audio (RIGHT channel) with the microphone
// (LEFT channel) into a stereo webm/opus MediaRecorder, then runs the
// upload → transcribe → summarize → export pipeline, reporting progress with
// the WN_* runtime protocol that the service worker mirrors to every surface.
import * as pipeline from "./pipeline.js";
import * as sb from "./supabase.js";

export function report(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** Configure the REST client's session; token refreshes are relayed to the
 *  service worker, which owns chrome.storage persistence. If our refresh token
 *  was already rotated by another context, the freshest session is fetched
 *  back from the service worker (this may run in the offscreen document,
 *  which has no chrome.storage of its own). */
export function configureSession(session) {
  sb.useSession(
    session,
    (s) => report({ type: "WN_SESSION_REFRESHED", session: s }),
    () => chrome.runtime.sendMessage({ type: "WN_GET_SESSION" }).then((r) => (r && r.session) || null).catch(() => null),
  );
}

/** Microphone (your side) — best-effort; callers record meeting-only without it. */
export async function acquireMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    report({ type: "WN_MIC_GRANTED" });
    return s;
  } catch (_) {
    return null;
  }
}

/** One-shot mic permission probe, for an "Allow microphone" button: shows
 *  the browser's permission prompt right where the user is (no navigation to a
 *  separate settings page needed — that page-hop is what got users stuck when
 *  chrome.runtime.openOptionsPage() no-ops on some Chromium forks), releases
 *  the device immediately, and reports success so every open surface can drop
 *  the "mic not enabled" banner. Rejects with the browser's denial reason. */
export async function requestMicPermission() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  report({ type: "WN_MIC_GRANTED" });
}

// Opus bitrate for the recording. The transcript is produced live, so this
// file is an archive — speech at 48 kbps stereo stays perfectly intelligible
// while keeping a long call small enough to upload: the browser default
// (~128 kbps) put a 2h meeting at ~90 MB, over the Storage upload limit, and
// the whole call was rejected.
export const AUDIO_BITRATE = 48000;

export function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "audio/webm";
}

// --- Crash-recovery journal ------------------------------------------------
// A recording host can die mid-call: the native side panel gets closed, the
// call's tab is closed while the docked iframe records, the browser or the
// extension restarts. Everything needed to still deliver the meeting is
// journaled to IndexedDB AS IT HAPPENS — the audio chunks (1/s), the meeting +
// settings, and the live FINAL utterances. The service worker notices the
// death (the host's "wn-recorder" port vanishes while the state still says
// recording/processing) and has the offscreen document run
// recoverFromJournal(), which uploads and processes what was captured.
const J_DB = "wn-recovery";

function jOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(J_DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("chunks")) d.createObjectStore("chunks");
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
let jDbPromise = null;
function jDb() {
  if (!jDbPromise) jDbPromise = jOpen().catch((e) => { jDbPromise = null; throw e; });
  return jDbPromise;
}
function jReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function jPut(storeName, key, value) {
  const db = await jDb();
  await jReq(db.transaction(storeName, "readwrite").objectStore(storeName).put(value, key));
}
async function jGet(storeName, key) {
  const db = await jDb();
  return jReq(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
}
async function jChunks() {
  // Chunks in capture order (numeric keys).
  const db = await jDb();
  const store = db.transaction("chunks", "readonly").objectStore("chunks");
  const [keys, values] = await Promise.all([jReq(store.getAllKeys()), jReq(store.getAll())]);
  return keys
    .map((k, i) => ({ k, v: values[i] }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.v)
    .filter(Boolean);
}
export async function journalClear() {
  try {
    const db = await jDb();
    const tx = db.transaction(["chunks", "meta"], "readwrite");
    tx.objectStore("chunks").clear();
    tx.objectStore("meta").clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* recovery data is best-effort */ }
}

/** Live finals journaled by an in-flight recording — lets a (re)opened panel
 *  rebuild the on-screen transcript it wasn't there to accumulate. */
export async function journalPeekUtterances() {
  try {
    const meta = await jGet("meta", "current");
    return (meta && meta.utterances) || [];
  } catch (_) { return []; }
}

// Drop "You" utterances that echo a time-overlapping participant (the mic
// picking the call back up through the speakers). Mirrors the batch pass.
function dedupeEcho(utts) {
  const toks = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const parts = utts.filter((u) => u.speaker !== "You");
  const isEcho = (you) => {
    const yt = toks(you.text);
    if (!yt.length) return false;
    for (const p of parts) {
      if (p.end < you.start - 2 || p.start > you.end + 2) continue;
      const pt = new Set(toks(p.text));
      if (yt.filter((w) => pt.has(w)).length / yt.length >= 0.7) return true;
    }
    return false;
  };
  return utts.filter((u) => u.speaker !== "You" || !isEcho(u));
}

/** Shared pipeline tail for a finished (or recovered) recording: pick the
 *  authoritative transcript per provider, run the pipeline, emit the results.
 *  Deepgram: the live transcript is authoritative; the batch pass is only a
 *  fallback when streaming produced nothing. Gladia: the saved transcript
 *  ALWAYS comes from the batch pass — its async pre-recorded mode has full
 *  diarization and the best accuracy, while its live mode has neither. */
async function processRecording(blob, m, transcript, settings, emitFn) {
  const opts = { settings, onStage: (stage) => emitFn({ type: "WN_REC_STAGE", stage }) };
  const provider = (settings && settings.transcriptionProvider) || "gladia";
  const hasLive = transcript.utterances.length > 0;

  let result;
  if (provider !== "gladia" && hasLive) {
    result = await pipeline.processLive(blob, m, transcript, opts);
  } else {
    // Gladia's batch pass diarizes far better than its live captions, so it
    // wins whenever the audio makes it up. But it needs that audio: a long
    // call over the Storage limit, or a dropped upload, would otherwise take
    // the whole meeting down. The live transcript is the safety net.
    try {
      result = await pipeline.process(blob, m, opts);
    } catch (e) {
      if (!hasLive) throw e;
      console.warn("Winday: batch transcription failed, finishing from the live transcript —", e?.message || e);
      result = await pipeline.processLive(blob, m, transcript, opts);
    }
  }
  emitFn({ type: "WN_MEETING_UPSERT", meeting: result });
  if (result.errorMessage) emitFn({ type: "WN_REC_FAILED", error: result.errorMessage });
  else emitFn({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
  return result;
}

/** Rebuilds and processes the meeting a dead recording host left in the
 *  journal. Returns false when there is nothing (usable) to recover. Runs in
 *  the offscreen document, triggered by the service worker. */
export async function recoverFromJournal(session, fallbackSettings) {
  let meta = null;
  let chunks = [];
  try {
    meta = await jGet("meta", "current");
    chunks = await jChunks();
  } catch (_) { /* no journal — nothing to do */ }
  if (!meta || !meta.meeting || chunks.length === 0) {
    await journalClear();
    return false;
  }

  configureSession(session);
  const settings = meta.settings || fallbackSettings || {};
  const m = { ...meta.meeting };
  // The recorder emits one chunk per second — captured length ≈ chunk count.
  const startMs = new Date(m.startedAt || Date.now()).getTime();
  m.endedAt = new Date(startMs + chunks.length * 1000).toISOString();
  m.status = "recorded";
  report({ type: "WN_MEETING_UPSERT", meeting: m });

  const blob = new Blob(chunks, { type: "audio/webm" });
  const utts = dedupeEcho(
    (meta.utterances || []).slice().sort((a, b) => (a.start || 0) - (b.start || 0)),
  );
  const transcript = {
    fullText: utts.map((u) => u.text).join(" "),
    utterances: utts,
    language: meta.language || null,
  };
  try {
    await processRecording(blob, m, transcript, settings, report);
  } catch (e) {
    const failed = { ...m, status: "failed", errorMessage: String(e?.message || e) };
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  } finally {
    await journalClear();
  }
  return true;
}

/** One recording session: start(streams) -> stop()/cancel() -> pipeline.
 *  Alongside the MediaRecorder it streams the live audio to the transcription
 *  provider (Deepgram or Gladia, via the matching relay function) for an
 *  on-screen transcript, and meters the mix for the sound visualizer.
 *  Deepgram: the streamed FINAL utterances become the saved transcript; the
 *  batch pass is only a fallback when streaming produced nothing.
 *  Gladia: the live stream is display-only and the saved transcript ALWAYS
 *  comes from the batch pass (Gladia live has no diarization; the async
 *  pre-recorded pass is its most accurate mode). */
export function createRecorder() {
  let mediaRecorder = null;
  let chunks = [];
  let audioContext = null;
  let streams = [];
  let meeting = null;
  let settings = null;
  let cancelled = false;

  // Live layer.
  let onEvent = null;          // local sink (used when the panel hosts recording)
  let ws = null;               // WebSocket to transcribe-stream (current attempt)
  let wsOpen = false;
  let outbox = [];             // audio frames queued while no WS is open (gap only)
  let worklet = null;          // AudioWorkletNode pumping PCM
  let analyser = null;         // for the visualizer
  let meterTimer = null;
  let liveUtterances = [];     // accumulated FINAL utterances -> saved transcript
  let dgLanguage = null;
  const provider = () => (settings && settings.transcriptionProvider) || "gladia";
  // Crash journal (see module docs above): serialized best-effort writes.
  let jQueue = Promise.resolve();
  const jRun = (fn) => { jQueue = jQueue.then(fn).catch(() => {}); };
  let jSeq = 0;
  let jMeta = null;
  // Liveness beacon: held for the whole recording + pipeline so the service
  // worker can tell "host is alive" from "host died — recover from journal".
  let recPort = null;
  let recPortActive = false;
  function connectRecorderPort() {
    if (!recPortActive || recPort) return;
    try {
      recPort = chrome.runtime.connect({ name: "wn-recorder" });
      recPort.onDisconnect.addListener(() => {
        recPort = null;
        // The SW restarting drops ports; reconnect while we're still working.
        if (recPortActive) setTimeout(connectRecorderPort, 500);
      });
    } catch (_) { /* extension context going away */ }
  }
  function releaseRecorderPort() {
    recPortActive = false;
    if (recPort) { try { recPort.disconnect(); } catch (_) {} recPort = null; }
  }
  function journalUtterances() {
    if (!jMeta) return;
    jMeta.utterances = liveUtterances.slice();
    jMeta.language = dgLanguage;
    jMeta.updatedAt = Date.now();
    const snapshot = jMeta;
    jRun(() => jPut("meta", "current", snapshot));
  }
  // Reconnect: a live Deepgram socket can drop mid-call (edge-function recycle,
  // network blip, Deepgram rotation). Without this the transcript would stop for
  // the rest of the call. We reopen while recording is active; only un-sent gap
  // audio sits in the outbox, so nothing already transcribed is replayed.
  let streamMerger = null;     // kept so a reopen can re-tap the bus
  let streamClosed = false;    // true once we intentionally stop streaming
  let reconnectTimer = null;
  let reconnectDelay = 0;      // ms, exponential backoff; reset when data flows
  let sessionStartTime = 0;    // audioContext time at the first connect
  let connEpochOffset = 0;     // seconds added to DG timestamps -> absolute across reopens
  // Half-dead detection: an edge worker can be recycled WITHOUT a close frame
  // (e.g. a secrets update restarts every function), so onclose never fires and
  // audio silently goes nowhere. The relay heartbeats every 5s; if nothing at
  // all arrives for STALL_MS while we're recording, kill the socket and reopen.
  let lastWsMsgAt = 0;
  let watchdogTimer = null;
  const STALL_MS = 15000;
  const OUTBOX_CAP = 250;      // ~10s of ~43ms frames
  const FRAME_SECONDS = 2048 / 48000; // ~0.0427s per PCM frame

  // report() reaches other contexts (SW + any open panel) over runtime
  // messaging; onEvent also delivers to THIS context (a context can't receive
  // its own runtime messages, so the panel host needs the local copy).
  function emit(msg) {
    report(msg);
    if (onEvent) { try { onEvent(msg); } catch (_) {} }
  }

  async function start(opts) {
    // opts: { tabStream, micStream, monitorTab, meeting, session, settings, onEvent? }
    configureSession(opts.session);
    settings = opts.settings;
    onEvent = opts.onEvent || null;
    meeting = { ...opts.meeting, status: "recording" };
    liveUtterances = [];
    dgLanguage = null;
    // Arm the crash journal + liveness beacon before any audio flows.
    jSeq = 0;
    jMeta = {
      meeting: { ...opts.meeting },
      settings: { ...opts.settings },
      startedAt: opts.meeting.startedAt,
      utterances: [],
      language: null,
      updatedAt: Date.now(),
    };
    const startMeta = jMeta;
    jRun(async () => { await journalClear(); await jPut("meta", "current", startMeta); });
    recPortActive = true;
    connectRecorderPort();
    emit({ type: "WN_MEETING_UPSERT", meeting });

    streams = [opts.tabStream, opts.micStream].filter(Boolean);
    // Pinned to 48 kHz: the graph resamples its inputs, so whatever rate the
    // Mac's audio device runs at (96 kHz with some interfaces), the PCM sent
    // to the live relay is one the providers accept. Gladia's live API takes
    // only 8/16/32/44.1/48 kHz and rejected the device rate with a 400 — the
    // relay then closed, the client reconnected every few seconds, and no
    // live caption ever showed up.
    audioContext = new AudioContext({ sampleRate: 48000 });
    const merger = audioContext.createChannelMerger(2);
    if (opts.micStream) {
      audioContext.createMediaStreamSource(opts.micStream).connect(merger, 0, 0);
    }
    const tabSource = audioContext.createMediaStreamSource(opts.tabStream);
    tabSource.connect(merger, 0, 1);
    if (opts.monitorTab) {
      // tabCapture silences the tab's own playback; route it to the speakers
      // so the call stays audible. (getDisplayMedia keeps local playback —
      // routing it again would double the audio.)
      tabSource.connect(audioContext.destination);
    }
    const dest = audioContext.createMediaStreamDestination();
    merger.connect(dest);
    streams.push(dest.stream);

    chunks = [];
    cancelled = false;
    mediaRecorder = new MediaRecorder(dest.stream, {
      mimeType: pickMimeType(),
      audioBitsPerSecond: AUDIO_BITRATE,
    });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        const seq = ++jSeq;
        jRun(() => jPut("chunks", seq, e.data));
      }
    };
    mediaRecorder.onstop = () => finalize();
    mediaRecorder.start(1000);
    emit({ type: "WN_REC_STARTED" });

    // The call's tab going away (closed, or the share stopped from the
    // browser bar) ends its audio track. Finish the meeting right there
    // instead of recording silence until someone remembers to press Stop.
    const tabTrack = opts.tabStream.getAudioTracks()[0];
    if (tabTrack) {
      tabTrack.addEventListener("ended", () => {
        if (mediaRecorder && mediaRecorder.state === "recording") stop(false);
      });
    }

    // Live transcript + visualizer — best-effort. Any failure leaves recording
    // untouched; finalize() falls back to the batch transcription.
    startMetering(merger);
    startStreaming(merger).catch((e) => emit({ type: "WN_TRANSCRIPT_ERROR", error: String(e?.message || e) }));
  }

  // --- Live streaming -----------------------------------------------------

  async function startStreaming(merger) {
    streamMerger = merger;
    streamClosed = false;
    outbox = [];
    reconnectDelay = 0;
    connEpochOffset = 0;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    sessionStartTime = audioContext.currentTime;

    // The worklet pumps continuously for the whole recording; frames go straight
    // to the open socket, or wait in the outbox during a reconnect gap.
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL("lib/pcm-worklet.js"));
    worklet = new AudioWorkletNode(audioContext, "pcm-extractor", {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit",
    });
    worklet.port.onmessage = (e) => {
      const buf = e.data;
      if (ws && wsOpen && ws.readyState === WebSocket.OPEN) { try { ws.send(buf); } catch (_) {} }
      else if (outbox.length < OUTBOX_CAP) outbox.push(buf); // gap audio; drop past ~10s
    };
    merger.connect(worklet);

    // Watchdog for half-dead sockets (see STALL_MS above).
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (streamClosed || !ws || !wsOpen) return;
      if (Date.now() - lastWsMsgAt <= STALL_MS) return;
      const dead = ws;
      ws = null; wsOpen = false;
      try { dead.onclose = null; dead.onmessage = null; dead.close(); } catch (_) {}
      scheduleReconnect();
    }, 5000);

    await openStream();
  }

  // Open (or reopen) the relay socket. Safe to call repeatedly; stale sockets are
  // ignored via the `sock !== ws` guards.
  async function openStream() {
    if (streamClosed || !audioContext) return;
    // Absolute-time offset so DG timestamps stay monotonic across reopens (the
    // buffered gap audio is the most recent ~outbox seconds).
    connEpochOffset = Math.max(0, (audioContext.currentTime - sessionStartTime) - outbox.length * FRAME_SECONDS);

    let url;
    try {
      const isGladia = provider() === "gladia";
      const params = {
        sample_rate: Math.round(audioContext.sampleRate),
        channels: 2,
        language: (settings && settings.transcriptionLanguage) || "multi",
      };
      if (!isGladia) params.model = (settings && settings.deepgramModel) || "nova-3";
      url = await sb.functionWsURL(isGladia ? "transcribe-stream-gladia" : "transcribe-stream", params);
    } catch (_) { scheduleReconnect(); return; }
    if (streamClosed) return;

    const sock = new WebSocket(url);
    ws = sock;
    sock.binaryType = "arraybuffer";
    wsOpen = false;
    sock.onopen = () => {
      if (sock !== ws) { try { sock.close(); } catch (_) {} return; }
      wsOpen = true;
      lastWsMsgAt = Date.now();
      const buffered = outbox; outbox = [];
      for (const b of buffered) { try { sock.send(b); } catch (_) {} }
    };
    sock.onmessage = (e) => {
      if (sock !== ws) return;
      reconnectDelay = 0; // data is flowing — reset backoff
      lastWsMsgAt = Date.now(); // any message (results or heartbeat) feeds the watchdog
      try {
        const msg = JSON.parse(e.data);
        if (provider() === "gladia") handleGladia(msg);
        else handleDg(msg);
      } catch (_) {}
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (sock !== ws) return;
      wsOpen = false;
      if (!streamClosed) scheduleReconnect();
    };
  }

  // Reopen while the recorder is still capturing, with capped exponential backoff.
  function scheduleReconnect() {
    if (streamClosed) return;
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;
    clearTimeout(reconnectTimer);
    reconnectDelay = Math.min(reconnectDelay ? reconnectDelay * 2 : 500, 5000);
    reconnectTimer = setTimeout(() => { openStream().catch(() => {}); }, reconnectDelay);
  }

  // Deepgram live result -> transcript event (+ accumulate finals).
  function handleDg(msg) {
    if (!msg || !msg.channel) return;
    const alt = msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    const chIndex = Array.isArray(msg.channel_index) ? (msg.channel_index[0] || 0) : 0;
    const isFinal = !!msg.is_final;
    const spk = alt.words && alt.words[0] && typeof alt.words[0].speaker === "number" ? alt.words[0].speaker : 0;
    const speaker = chIndex === 0 ? "You" : `Participant ${spk + 1}`;
    // Offset by the current connection's epoch so timestamps stay monotonic even
    // after a reconnect (each DG socket numbers its own audio from 0).
    const start = connEpochOffset + (msg.start ?? 0);
    const end = start + (msg.duration ?? 0);
    if (msg.channel.detected_language && !dgLanguage) dgLanguage = msg.channel.detected_language;
    emit({ type: "WN_TRANSCRIPT", channel: chIndex, speaker, text, isFinal, start, end });
    if (isFinal) { liveUtterances.push({ speaker, text, start, end }); journalUtterances(); }
  }

  // Gladia live message -> transcript event (+ accumulate finals). The relay
  // forwards Gladia's messages verbatim; only "transcript" ones carry text.
  // Live Gladia has no diarization, so channel 1 is a single "Participant 1"
  // on screen — the batch pass rebuilds proper speakers for the saved version.
  function handleGladia(msg) {
    if (!msg || msg.type !== "transcript" || !msg.data) return;
    const u = msg.data.utterance || {};
    const text = (u.text || "").trim();
    if (!text) return;
    const chIndex = typeof u.channel === "number" ? u.channel : 0;
    const isFinal = !!msg.data.is_final;
    const speaker = chIndex === 0 ? "You" : "Participant 1";
    // Offset by the current connection's epoch so timestamps stay monotonic even
    // after a reconnect (each Gladia session numbers its own audio from 0).
    const start = connEpochOffset + (u.start ?? 0);
    const end = connEpochOffset + (u.end ?? u.start ?? 0);
    if (u.language && !dgLanguage) dgLanguage = u.language;
    emit({ type: "WN_TRANSCRIPT", channel: chIndex, speaker, text, isFinal, start, end });
    if (isFinal) { liveUtterances.push({ speaker, text, start, end }); journalUtterances(); }
  }

  // --- Visualizer metering ------------------------------------------------

  function startMetering(merger) {
    try {
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;
      merger.connect(analyser);
      const bins = analyser.frequencyBinCount; // 64
      const data = new Uint8Array(bins);
      const BARS = 24;
      const per = Math.max(1, Math.floor(bins / BARS));
      meterTimer = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const bars = new Array(BARS);
        for (let i = 0; i < BARS; i++) {
          let sum = 0;
          for (let j = 0; j < per; j++) sum += data[i * per + j] || 0;
          bars[i] = Math.round((sum / per) / 255 * 100) / 100; // 0..1
        }
        emit({ type: "WN_REC_LEVEL", bars });
      }, 60);
    } catch (_) { /* visualizer is optional */ }
  }

  // Stop feeding audio to the live layer (but keep the WS briefly for the tail).
  function stopStreamingInput() {
    streamClosed = true; // no more reconnects
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearInterval(watchdogTimer); watchdogTimer = null;
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    if (worklet) { try { worklet.port.onmessage = null; worklet.disconnect(); } catch (_) {} worklet = null; }
  }

  function buildTranscript() {
    const utts = dedupeEcho(liveUtterances.slice().sort((a, b) => a.start - b.start));
    return { fullText: utts.map((u) => u.text).join(" "), utterances: utts, language: dgLanguage };
  }

  function stop(isCancel) {
    cancelled = !!isCancel;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop(); // -> onstop -> finalize
    } else {
      teardown();
    }
  }

  function isActive() {
    return !!mediaRecorder && mediaRecorder.state !== "inactive";
  }

  function teardown() {
    stopStreamingInput();
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    wsOpen = false;
    outbox = [];
    analyser = null;
    for (const s of streams) {
      try { s.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }
    streams = [];
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    mediaRecorder = null;
  }

  async function finalize() {
    const localChunks = chunks;
    chunks = [];
    const m = meeting;
    meeting = null;
    const wasCancelled = cancelled;
    cancelled = false;

    // Stop sending audio; ask the provider to flush its buffered tail, then give
    // the last finals a moment to arrive before we tear the WebSocket down.
    stopStreamingInput();
    if (!wasCancelled && ws && ws.readyState === WebSocket.OPEN) {
      const flush = provider() === "gladia" ? { type: "stop_recording" } : { type: "Finalize" };
      try { ws.send(JSON.stringify(flush)); } catch (_) {}
      await new Promise((r) => setTimeout(r, 700));
    }
    teardown();

    if (wasCancelled || !m) {
      if (m) emit({ type: "WN_MEETING_REMOVE", id: m.id });
      jMeta = null;
      jRun(() => journalClear());
      releaseRecorderPort();
      return;
    }

    const blob = new Blob(localChunks, { type: "audio/webm" });
    m.endedAt = new Date().toISOString();
    m.status = "recorded";
    emit({ type: "WN_MEETING_UPSERT", meeting: m });

    if (blob.size === 0) {
      const failed = { ...m, status: "failed", errorMessage: "The recording was empty — no audio was captured." };
      emit({ type: "WN_MEETING_UPSERT", meeting: failed });
      emit({ type: "WN_REC_FAILED", error: failed.errorMessage });
      jMeta = null;
      jRun(() => journalClear());
      releaseRecorderPort();
      return;
    }

    const transcript = buildTranscript();
    // Persist the live transcript BEFORE the pipeline runs. Everything after
    // this point can fail (upload, summarize, the browser closing), and without
    // this the call's only copy of what was said lived in the panel's memory —
    // Retry then had nothing to work with.
    if (transcript.utterances.length > 0) {
      m.transcript = transcript;
      emit({ type: "WN_MEETING_UPSERT", meeting: m });
    }

    try {
      await processRecording(blob, m, transcript, settings, emit);
    } catch (e) {
      const failed = { ...m, status: "failed", errorMessage: String(e?.message || e) };
      emit({ type: "WN_MEETING_UPSERT", meeting: failed });
      emit({ type: "WN_REC_FAILED", error: failed.errorMessage });
    } finally {
      // The pipeline ran to completion (done OR failed-with-state): the journal
      // has served its purpose. A host death BEFORE this point leaves it in
      // place for the offscreen recovery pass.
      jMeta = null;
      jRun(() => journalClear());
      releaseRecorderPort();
    }
  }

  /** Abort a start() that failed before the recorder began. */
  function failNow(e) {
    teardown();
    jMeta = null;
    jRun(() => journalClear());
    releaseRecorderPort();
    const err = String(e?.message || e);
    if (meeting) {
      const failed = { ...meeting, status: "failed", errorMessage: err };
      meeting = null;
      emit({ type: "WN_MEETING_UPSERT", meeting: failed });
    }
    emit({ type: "WN_REC_FAILED", error: err });
  }

  return { start, stop, isActive, failNow };
}
