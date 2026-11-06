// Audio segments of a meeting — shared shape between the extension and the
// batch transcription functions (same file in `transcribe` and
// `transcribe-gladia`; keep them identical).
//
// Long calls are recorded as a chain of standalone webm files (the extension
// starts a fresh recorder every hour, or sooner when a file nears 40 MB) so
// that no single upload exceeds the Storage limit and no single file exceeds
// the transcription provider's duration cap. The list lives in
// `meetings.metadata.audio_segments`:
//   [{ path: "<uid>/<id>.webm", offset: 0 }, { path: "<uid>/<id>.s1.webm", offset: 3600.2 }, …]
// `offset` = seconds from the start of the call. A meeting without the list
// (every call before this change, every macOS recording) is one segment at
// `audio_path`.

export type Segment = { path: string; offset: number };
export type Utt = { speaker: string; text: string; start: number; end: number };

export function audioSegments(meeting: { audio_path?: string | null; metadata?: any }): Segment[] {
  const list = meeting?.metadata?.audio_segments;
  if (Array.isArray(list)) {
    const segs = list
      .filter((s: any) => s && typeof s.path === "string" && s.path.length > 0)
      .map((s: any) => ({ path: s.path, offset: Number.isFinite(Number(s.offset)) ? Number(s.offset) : 0 }))
      .sort((a: Segment, b: Segment) => a.offset - b.offset);
    if (segs.length > 0) return segs;
  }
  return meeting?.audio_path ? [{ path: meeting.audio_path, offset: 0 }] : [];
}

/** Shifts each segment's timestamps by its offset and merges them in time
 *  order. `results` is in segment order; failed segments are left out by the
 *  caller (they become `gaps`). */
export function mergeSegmentUtterances<T extends { start?: number; end?: number }>(
  results: Array<{ offset: number; utterances: T[] }>,
): T[] {
  const all: T[] = [];
  for (const r of results) {
    for (const u of r.utterances) {
      all.push({ ...u, start: (u.start ?? 0) + r.offset, end: (u.end ?? u.start ?? 0) + r.offset });
    }
  }
  return all.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}
