# Winday Meet — Chrome Extension

A **Chrome extension (Manifest V3)** that records your **Google Meet** calls,
transcribes them with **Gladia** or **Deepgram (Nova‑3)** (Settings →
*Transcription engine*), summarizes them with **Gemini (Flash)**, and pushes the
summary, next steps and priorities to the **Winday CRM** and **Notion** — all
through the same secure **Supabase** backend as the macOS
[Winday Notetaker](https://github.com/flemercier6/winday-notetaker), so no
API secret ever lives in the browser.

This is a browser‑native port of the macOS app. It shares the account, the
database, the recordings and the Notion workspace — a call recorded from either
one shows up in the same place.

---

## How it works

```
 Chrome tab (Meet)                     Supabase (shared backend)          3rd parties
┌────────────────────┐  upload .webm  ┌────────────────────────────┐
│  offscreen doc     │ ─────────────▶ │ Storage: recordings bucket │
│  • tab audio  ─┐   │                │                            │
│  • microphone ─┴─▶ │  invoke fns    │ Edge Functions (hold the   │  Deepgram Nova‑3
│  stereo webm/opus  │ ─────────────▶ │  secrets via Deno.env):    │ ─▶ transcribe
└────────────────────┘                │   • transcribe             │  Gemini Flash
        ▲                             │   • summarize              │ ─▶ summarize
        │ tab MediaStream id          │   • enrich-meeting         │  Notion API
   ┌────┴───────┐   ┌──────────┐      │   • export-notion          │ ─▶ create page
   │   docked   │   │ content  │      │ Postgres: meetings (RLS)   │
   │ panel (UI) │   │  pill    │      └────────────────────────────┘
   └────────────┘   └──────────┘
```

1. **Record** — an **offscreen document** captures the Meet **tab audio**
   (`chrome.tabCapture`, i.e. the remote participants) and your **microphone**
   (`getUserMedia`), and mixes them with the Web Audio API into a single
   **stereo** stream: **left = you**, **right = the meeting**. It records that to
   `webm/opus` with `MediaRecorder` at **48 kbps** — plenty for speech, and it
   keeps a multi‑hour call well under the Storage upload limit.
2. **Upload** — the recording is uploaded to the private Supabase `recordings`
   bucket and a `meetings` row is created (Row‑Level Security: you only ever see
   your own). When the upload fails (over the project's Storage upload limit, or
   a network drop) and a live transcript exists, the meeting is still saved,
   summarized and exported — only the playable audio is lost, and the reason is
   kept in `metadata.audio_upload_error`.
3. **Transcribe / Summarize / Export** — the extension invokes the Edge
   Functions by meeting id. Transcription goes to the engine chosen in
   Settings: **Gladia** (`transcribe-gladia` — async pre‑recorded API with
   diarization + auto language detection; the saved transcript is always this
   batch pass, the live captions are display‑only) or **Deepgram**
   (`transcribe` / `transcribe-stream`, multichannel — the same functions the
   macOS app uses). Either way **channel 0 = "You"**, **channel 1 = the
   others**. Gemini and Notion run next, all **using secrets stored
   server‑side**, then the results are written back to the meeting row.

The third‑party keys (Gladia, Deepgram, Gemini, Notion) are **never shipped to
the extension** — they live only as Supabase Edge Function secrets. The
extension only carries the **publishable** Supabase URL + anon key (safe to
distribute; access is gated by Supabase Auth + RLS).

---

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top‑right).
3. Click **Load unpacked** and select this folder.
4. Pin the **Winday Meet** icon to the toolbar.

> The icons are prebuilt. To regenerate them: `node icons/gen-icons.mjs`.

## Use

Works in **Chrome**, **Dia** and **Arc**. The panel has two display modes
(Settings → *Affichage du panneau*):

- **Native** (default) — the browser's real side panel (`chrome.sidePanel`),
  which pushes the page. Use in Chrome and Dia.
- **Docked** — an iframe docked over the right edge of the Meet page. Use in
  Arc, which never renders the native panel UI (the API pretends to succeed).

1. Join a **Google Meet** call. A small pill appears at the top of the tab —
   its **Ouvrir le panneau** button opens the docked panel. The toolbar icon
   and `⌘⇧9` do the same. **Sign in** in the panel with your Winday account
   (same credentials as the macOS app / CRM).
2. If a **🎤 Micro non activé** banner shows in the panel, click **l'activer** —
   the browser's permission prompt appears right there (no page to navigate to)
   so your side of the call gets captured. Open **Settings** (⚙) to set your
   **Notion database ID** and other preferences.
3. Start recording — two ways:
   - **Enregistrer cet appel** in the panel. If Chromium refuses silent capture
     (no prior icon/menu/shortcut gesture on that tab), the standard **share
     dialog** opens as a fallback — `getDisplayMedia`, the same API Meet uses
     for screen sharing, present in every Chromium including Arc. Pick the
     call's tab, keep *Partager l'audio* enabled, **Partager** → recording
     starts, hosted inside the panel iframe.
   - **Right‑click the call page → “Winday Meet — Enregistrer ce call”** —
     fully silent (the menu click itself authorizes the capture, no dialog).
   - **Record on a Today row** — the panel lists today's calendar calls; the
     row for the call you are on shows a **Record** button. Recording from it
     (or a plain *Start Recording* while on that call) attaches the event's
     company and contacts to the meeting.
4. The elapsed time stays visible in the panel and the pill; stop from either.
   The recording also **stops by itself** when the call is over: the call's
   tab is closed or navigates away, or you leave the call (Meet's "You left"
   screen) — after a 30‑second grace period, in case you rejoin.
5. When you stop, the extension uploads, transcribes, summarizes and (if
   enabled) exports to Notion. Progress and the result stay visible in the
   panel, and the meeting appears in the Winday CRM.
6. The notes are yours: every line of the summary can be edited in place
   (headline, next steps, context, sections), the next‑step checkboxes stay
   ticked, and a diarized **Participant N** can be renamed (from the
   transcript label or the owner menu) — the whole transcript and the next
   steps follow. Everything is saved with the meeting, on every device.

### Which company was that call with?

`enrich-meeting` links each meeting to a CRM company, most reliable signal
first: the company already matched from the calendar event; a participant's
e‑mail domain (`alex@modjo.ai` → Modjo); a participant who is a CRM contact
(their company); the call's title (a company name or domain label); and
finally a contact named in the title when the CRM knows exactly one person by
that first name (`Frédéric / Matthieu` → Matthieu Bagur → Mooncard). The
result lands in `metadata.calendar.company_*` (where the CRM reads it) with
`metadata.company_source` saying which rule fired.

### Importing a transcript you already have

The **import** button next to *Recordings* takes a transcript file and turns it
into a real meeting — same row in the CRM, same AI notes, same Notion export.
Use it for a call this extension never recorded, or one whose audio never made
it to Storage. Accepted: `.txt`, `.md`, `.vtt`, `.srt`, and the parser is
deliberately tolerant — `Name: what they said`, a speaker on its own line above
their lines, `Name  00:12` as Meet and Teams export it, leading timestamps,
VTT/SRT cue scaffolding.

Splitting a pasted transcript by speaker is guesswork, so the guess is shown
before anything is created: who the parser found and how many turns each of
them took, with one tap to say **which one is you** (that decides whose action
items the summary puts first). The parser reads the file twice — once to work
out the cast, once to split it — because judging each line on its own shape
turns every short reply ("Ok parfait") into a bogus speaker.

The file's own date becomes the meeting's date, and its name the title — call
it `transcript.txt` and the AI headline is used instead.

### Notes & limitations (v1)

- **Capture authorization**: Chromium only allows *silent* tab capture on a tab
  where the extension was invoked (toolbar icon, right‑click menu item, `⌘⇧9` —
  opening the panel with one of those counts). Without that grant, the panel
  falls back to the share dialog and records inside its own iframe.
- **Fallback recordings live in the panel document** (docked iframe or native
  side panel). The docked ✕ only *hides* the iframe (recording continues), and
  the native side panel is opened **window‑scoped**, so switching tabs no
  longer closes it. The silent path (offscreen document) survives tab closes
  outright.
- **Crash recovery**: while recording, the audio chunks + live transcript are
  journaled to IndexedDB. If the recording host dies anyway (native panel
  closed mid‑call, call tab closed during a fallback recording, browser or
  extension restart), the capture stops there but nothing is lost: the
  offscreen document detects it, uploads the journaled audio and runs the
  full transcribe → summarize → export pipeline on everything captured up to
  that moment.
- **Microphone permission**: granted inline from the panel's banner (no
  navigation needed — `chrome.runtime.openOptionsPage()` used to be the only
  path and can silently no‑op on some Chromium forks, which left users stuck).
  Without it, the call is still recorded (participants only); your voice just
  won't be on the "You" channel. Settings' own "Autoriser le microphone" button
  still works too, for the case where you're already there.
- **Opening Settings** always opens a plain tab (focusing one already open
  instead of duplicating) rather than relying on
  `chrome.runtime.openOptionsPage()`, for the same reason.
- **You still hear the call** while recording: captured tab audio is routed back
  to your speakers.
- **Calendar arming** (auto‑pre‑filling the company/contacts from Google
  Calendar, as the macOS app does) is not wired into the UI yet — the meeting is
  still created in the CRM, just without the pre‑resolved company link. The
  `upcoming-meetings` function is available server‑side for a follow‑up.

---

## Backend

The `supabase/` folder mirrors the shared backend for reference. **These
functions are already deployed** to the Winday CRM's Supabase project
(`gagfovgnuttmngnhqzwd`) and are used as‑is by both the macOS app and this
extension — you do **not** need to redeploy anything to use the extension. The
required secrets (`GLADIA_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`,
`NOTION_TOKEN`) live there as Edge Function secrets — set them in the dashboard
under *Project Settings → Edge Functions → Secrets*.

The Gladia path adds two functions, deployed alongside the Deepgram ones (which
are untouched, so the macOS app keeps working unchanged):

- `transcribe-gladia` — batch transcription (Gladia v2 pre‑recorded, async
  init + poll), diarization + auto language detection with code‑switching.
- `transcribe-stream-gladia` — live relay (Gladia v2 live), deployed with
  `verify_jwt=false` like `transcribe-stream` (the user JWT is validated inside
  the function — browsers can't set headers on a WebSocket).

## Project layout

```
manifest.json          MV3 manifest
config.js              publishable Supabase URL + anon key + model defaults
background.js          service worker: offscreen lifecycle + message routing + state
offscreen.html/.js     capture (tab + mic → stereo) + upload + pipeline
content/content.js     meet.google.com: status pill + docks the panel iframe
sidepanel/             the panel UI (docked iframe / full‑tab dashboard)
lib/capture.js         shared recording engine (offscreen + panel fallback)
options/               settings: mic permission, Notion db, models, prompt
lib/supabase.js        auth / storage / Edge Function REST client
lib/pipeline.js        upload → transcribe → summarize → export orchestration
lib/transcript-import.js  parses a pasted-in transcript file into utterances
lib/store.js           chrome.storage: session, settings, meetings cache
icons/                 prebuilt PNG icons (+ generator)
supabase/              shared Edge Functions (reference; already deployed)
```
