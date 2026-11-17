// Build-time configuration for the Winday Meet Chrome extension.
//
// IMPORTANT: no third-party API secrets live here. Deepgram, Gemini and Notion
// keys are stored server-side as Supabase Edge Function secrets (shared with the
// macOS app and the Winday CRM). The extension only knows the Supabase URL +
// publishable ("anon") key — both safe to ship, since access is gated by
// Supabase Auth + Row-Level Security.
//
// This points at the SAME Supabase project as the macOS Winday Notetaker and the
// Winday CRM ("WInday App"), so recordings, transcripts and notes land in the
// same database, the same account and the same Notion.
export const CONFIG = {
  supabaseURL: "https://gagfovgnuttmngnhqzwd.supabase.co",
  supabaseAnonKey: "sb_publishable_pkIHh7RHiAubkwA-De9RMg_g74nhbN_",

  // Winday Data — a SEPARATE app with its own accounts (not this Supabase
  // project). The panel sends a call's next steps to the user's Tasks list
  // there, through an OAuth connection limited to Tasks (lib/winday-data.js).
  windayDataURL: "https://data.winday.app",

  // Non-secret model defaults (overridable in Options).
  deepgramModel: "nova-3",
  geminiModel: "gemini-2.5-flash",
};
