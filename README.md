# Winday Meet — Chrome Extension

A **Chrome extension (Manifest V3)** that records your **Google Meet** calls,
transcribes them with **Deepgram (Nova‑3)**, summarizes them with **Gemini
(Flash)**, and pushes the summary, next steps and priorities to the **Winday
CRM** and **Notion** — all through the same secure **Supabase** backend as the
macOS [Winday Notetaker](https://github.com/flemercier6/winday-notetaker), so no
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
   `webm/opus` with `MediaRecorder`.
2. **Upload** — the recording is uploaded to the private Supabase `recordings`
   bucket and a `meetings` row is created (Row‑Level Security: you only ever see
   your own).
3. **Transcribe / Summarize / Export** — the extension invokes the same Edge
   Functions the macOS app uses, by meeting id. They call Deepgram
   (`multichannel=true`, so **channel 0 = "You"**, **channel 1 = the others**),
   Gemini and Notion **using secrets stored server‑side**, then write the
   results back to the meeting row.

The third‑party keys (Deepgram, Gemini, Notion) are **never shipped to the
extension** — they live only as Supabase Edge Function secrets. The extension
only carries the **publishable** Supabase URL + anon key (safe to distribute;
access is gated by Supabase Auth + RLS).

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
4. The elapsed time stays visible in the panel and the pill; stop from either.
5. When you stop, the extension uploads, transcribes, summarizes and (if
   enabled) exports to Notion. Progress and the result stay visible in the
   panel, and the meeting appears in the Winday CRM.

### Notes & limitations (v1)

- **Capture authorization**: Chromium only allows *silent* tab capture on a tab
  where the extension was invoked (toolbar icon, right‑click menu item, `⌘⇧9` —
  opening the panel with one of those counts). Without that grant, the panel
  falls back to the share dialog and records inside its own iframe.
- **Fallback recordings live in the Meet tab**: the panel's ✕ only *hides* the
  iframe (recording continues), but closing the call's tab before "Notes
  prêtes" aborts an in‑flight fallback recording/pipeline. The silent path
  (offscreen document) survives tab closes.
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

### Next steps → Winday Data tasks

Hover a **next step** in a call's summary: a button with Winday's mark appears
on the right. It puts the step on your **Tasks** list in a **Winday Data**
workspace you pick — the task's title is the step, its description names the
call, its date, the company, the owner and the CRM meeting link, so the AI that
later works the task knows where it came from. A step already sent keeps its
mark, ticked, with the workspace it went to.

Winday Data is a separate app with its own accounts. The first click asks you
to **Connect Winday Data**: its consent screen opens (OAuth with PKCE, the
same server AI assistants connect to) and grants the extension **your
workspaces and your Tasks list only** — scope `tasks`, none of your ad data.
Revoke it any time in Winday Data ▸ Settings ▸ Winday MCP, or with
*Disconnect Winday Data* at the bottom of the menu. The connection lives in
the service worker (`lib/winday-data.js`, needs the `identity` permission).

---

## Backend

The `supabase/` folder mirrors the shared backend for reference. **These
functions are already deployed** to the Winday CRM's Supabase project
(`gagfovgnuttmngnhqzwd`) and are used as‑is by both the macOS app and this
extension — you do **not** need to redeploy anything to use the extension. The
required secrets (`DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `NOTION_TOKEN`) already
live there as Edge Function secrets.

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
lib/store.js           chrome.storage: session, settings, meetings cache, steps sent
lib/winday-data.js     Winday Data OAuth link + Tasks API (service worker only)
icons/                 prebuilt PNG icons (+ generator)
supabase/              shared Edge Functions (reference; already deployed)
```
