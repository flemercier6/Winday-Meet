// Audio that never reached Storage. When a recording's pipeline fails before
// its audio is safely uploaded (network drop, Storage refusing a file, the
// backend down), the audio used to vanish with the recorder's memory — and
// Retry could only say "record again". It is now kept here, per meeting, until
// a Retry uploads it or the meeting is deleted.
//
// IndexedDB (extension origin), shared by every extension page that records
// or retries: the offscreen document, the panel, the service worker.
// Best-effort throughout: a failure here never blocks a recording.

const DB = "wn-unsent";
const STORE = "audio";
const MAX_KEPT = 3; // newest failed recordings kept (~25 MB per hour of audio)

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no IndexedDB")); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Keeps a failed recording's audio: segments = [{ index, offset, blob }]. */
export async function stashAudio(meetingId, segments) {
  if (!meetingId || !Array.isArray(segments) || segments.length === 0) return false;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put({
      meetingId,
      savedAt: Date.now(),
      segments: segments.map((s) => ({ index: s.index, offset: s.offset, blob: s.blob })),
    }, meetingId);
    await done(tx);

    // Bound the footprint: drop the oldest beyond MAX_KEPT.
    const tx2 = db.transaction(STORE, "readwrite");
    const all = await req(tx2.objectStore(STORE).getAll());
    const stale = (all || [])
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(MAX_KEPT);
    for (const s of stale) tx2.objectStore(STORE).delete(s.meetingId);
    await done(tx2);
    return true;
  } catch (e) {
    console.warn("Winday: could not keep the unsent audio —", e?.message || e);
    return false;
  }
}

/** The kept audio of a meeting ([{ index, offset, blob }]), or null. */
export async function takeAudio(meetingId) {
  if (!meetingId) return null;
  try {
    const db = await open();
    const rec = await req(db.transaction(STORE, "readonly").objectStore(STORE).get(meetingId));
    const segs = rec && Array.isArray(rec.segments) ? rec.segments.filter((s) => s && s.blob && s.blob.size > 0) : [];
    return segs.length ? segs : null;
  } catch (_) {
    return null;
  }
}

/** Forgets a meeting's kept audio (uploaded at last, or meeting deleted). */
export async function dropAudio(meetingId) {
  if (!meetingId) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(meetingId);
    await done(tx);
  } catch (_) { /* best-effort */ }
}
