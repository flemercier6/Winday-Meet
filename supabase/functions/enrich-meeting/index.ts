// enrich-meeting — after a recording, work out WHO was in the call, WHICH
// COMPANY it was with, and link both to the CRM. Every source is best-effort:
//
//   1. The calendar event's attendees (Calendar API) — gives EMAILS, which we
//      match to CRM contacts (→ meeting_contacts rows) and, by domain, to CRM
//      companies (alex@modjo.ai → Modjo).
//   2. The Google Meet REST API conference record — gives the ACTUAL
//      participants (display names, including people who joined uninvited).
//      Requires the meetings.space.readonly scope; if the stored Google grant
//      predates that scope this step is skipped with meet_api:"reconnect".
//   3. The call's TITLE — a company name ("Kick-off Modjo"), a company domain
//      label ("modjo x bulldozer"), or the first name of a contact the CRM
//      knows unambiguously ("Frédéric / Matthieu" → Matthieu Bagur → Mooncard).
//
// Results land in meetings.metadata:
//   participants: [{ name, email?, contact_id?, invited?, joined?, is_self? }]
//   calendar.company_id / company_name / company_logo_url (the linked company)
//   company_source: how the company was found (kept for support)
// The summarize function uses the participant names to identify who is
// speaking in the transcript. Failures here never fail the pipeline — the
// caller ignores errors.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

// Generic mailbox providers never map to a "company" by domain.
const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.fr", "yahoo.com",
  "yahoo.fr", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "aol.com",
  "live.com", "live.fr", "msn.com", "gmx.com", "gmx.de", "yandex.com", "hey.com",
  "orange.fr", "free.fr", "sfr.fr", "laposte.net", "wanadoo.fr",
]);

interface Participant {
  name: string;
  email?: string;
  contact_id?: string;
  invited?: boolean;
  joined?: boolean;
  is_self?: boolean;
}

interface Company {
  id: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
}

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_id: string | null;
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data.access_token as string;
}

const norm = (s: string) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
/// Words of a string, normalized — "Kick-off Modjo / Bulldozer" → [kick, off, modjo, bulldozer].
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
const nameTokens = (s: string) => words(s).filter((t) => t.length >= 3);

function normalizeDomain(d: string): string {
  return norm(d).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}
function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  return at > 0 ? normalizeDomain(email.slice(at + 1)) : null;
}
/// "modjo.ai" → "modjo"; "ext.accorinvest.com" → "accorinvest".
function domainLabel(domain: string | null): string | null {
  if (!domain) return null;
  const parts = normalizeDomain(domain).split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? null;
  return parts[parts.length - 2];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { meeting_id } = await req.json();
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: meeting, error: mErr } = await admin
      .from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).single();
    if (mErr || !meeting) return json({ error: "Meeting not found" }, 404);

    const cal = meeting.metadata?.calendar ?? null;
    const meetCode = (meeting.meeting_url ?? "")
      .match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] ?? null;

    // The CRM's companies + contacts, once (RLS-scoped to the user).
    const [{ data: companyRows }, { data: contactRows }] = await Promise.all([
      userClient.from("companies").select("id, name, domain, logo_url"),
      userClient.from("contacts").select("id, first_name, last_name, email, company_id"),
    ]);
    const companies: Company[] = (companyRows ?? []).map((c: any) => ({
      id: c.id, name: c.name ?? "", domain: c.domain ?? null, logo_url: c.logo_url ?? null,
    }));
    const contacts: Contact[] = (contactRows ?? []) as Contact[];
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const companyByDomain = new Map<string, Company>();
    for (const c of companies) if (c.domain) companyByDomain.set(normalizeDomain(c.domain), c);
    const contactByEmail = new Map<string, Contact>();
    for (const c of contacts) if (c.email) contactByEmail.set(norm(c.email), c);

    // The user's own identity — never "the company we met", never a
    // participant to look up.
    const selfEmail = norm(user.email ?? "");
    const selfDomain = selfEmail ? domainOf(selfEmail) : null;
    let selfFirstName = "";
    try {
      const { data: u } = await admin.auth.admin.getUserById(user.id);
      const meta = (u?.user as any)?.user_metadata ?? {};
      selfFirstName = norm(String(meta.first_name || meta.full_name || "").split(/\s+/)[0] || "");
    } catch { /* optional */ }

    // Google access — only needed when there is a calendar event or a Meet
    // code to look up. Without it the title-based matching still runs.
    let accessToken: string | null = null;
    let google = "not needed";
    if (cal?.google_event_id || meetCode) {
      const { data: account } = await admin
        .from("calendar_accounts").select("*")
        .eq("user_id", user.id).eq("provider", "google").maybeSingle();
      if (!account) google = "not connected";
      else {
        try {
          accessToken = await refreshAccessToken(account.refresh_token);
          google = "ok";
        } catch (_e) {
          google = "reconnect required";
        }
      }
    }

    const participants: Participant[] = [];

    /// Find who a Meet display name refers to among the invited attendees:
    /// exact (normalized) name match first, then name-tokens ↔ email-local-part
    /// matching ("Gabriel Hardy-Françon" ↔ gabriel@…, "Frederic Lemercier" ↔
    /// lemercier.fred@…). Without this, the same person shows up twice — once
    /// as their invite email, once as their Meet display name.
    const findForName = (name: string): Participant | undefined => {
      const n = norm(name);
      const exact = participants.find((p) => norm(p.name) === n);
      if (exact) return exact;
      const toks = nameTokens(name);
      let best: Participant | undefined;
      let bestScore = 0;
      for (const p of participants) {
        if (!p.email) continue;
        const localParts = words(p.email.split("@")[0]);
        const score = toks.filter((t) =>
          localParts.some((l) => l === t || l.startsWith(t) || t.startsWith(l))).length;
        if (score > bestScore) { best = p; bestScore = score; }
      }
      return bestScore > 0 ? best : undefined;
    };

    // 1) Invited attendees, from the calendar event (emails!).
    if (accessToken && cal?.google_event_id) {
      const evResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(cal.google_event_id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (evResp.ok) {
        const event = await evResp.json();
        for (const a of event.attendees ?? []) {
          if (a.resource || !a.email) continue;
          const email = norm(a.email);
          const existing = participants.find((p) => p.email === email);
          if (existing) {
            existing.invited = true;
            existing.is_self = existing.is_self || !!a.self;
            continue;
          }
          participants.push({
            name: a.displayName || email,
            email,
            invited: true,
            is_self: !!a.self || (!!selfEmail && email === selfEmail),
          });
        }
      }
    }

    // 2) Actual participants, from the Meet REST API conference record.
    let meetApi = "unavailable";
    if (accessToken && meetCode) {
      const filter = encodeURIComponent(`space.meeting_code = "${meetCode}"`);
      const recResp = await fetch(
        `https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (recResp.status === 403) {
        meetApi = "reconnect";   // token predates the meetings.space.readonly scope
      } else if (recResp.ok) {
        const records = (await recResp.json()).conferenceRecords ?? [];
        // Pick the record overlapping this recording (fall back to the latest).
        const startedAt = new Date(meeting.started_at ?? meeting.created_at).getTime();
        const pick = records.find((r: any) => {
          const s = new Date(r.startTime).getTime();
          const e = r.endTime ? new Date(r.endTime).getTime() : Date.now();
          return startedAt >= s - 10 * 60_000 && startedAt <= e + 10 * 60_000;
        }) ?? records[0];
        if (pick) {
          const pResp = await fetch(
            `https://meet.googleapis.com/v2/${pick.name}/participants?pageSize=100`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (pResp.ok) {
            meetApi = "ok";
            for (const p of (await pResp.json()).participants ?? []) {
              const name = p.signedinUser?.displayName
                ?? p.anonymousUser?.displayName
                ?? p.phoneUser?.displayName;
              if (!name) continue;
              const existing = findForName(name);
              if (existing) {
                existing.joined = true;
                // Upgrade an email-as-name entry to the real display name.
                if (!existing.name || existing.name === existing.email) existing.name = name;
              } else {
                participants.push({ name, joined: true });
              }
            }
          }
        } else {
          meetApi = "no_record";
        }
      }
    }

    // 3) Participants ↔ CRM contacts: by email, else by full name (a Meet
    //    display name "Matthieu Bagur" IS a contact even without an invite).
    const contactByFullName = new Map<string, Contact[]>();
    for (const c of contacts) {
      const full = words(`${c.first_name ?? ""} ${c.last_name ?? ""}`).join(" ");
      if (!full) continue;
      if (!contactByFullName.has(full)) contactByFullName.set(full, []);
      contactByFullName.get(full)!.push(c);
    }
    for (const p of participants) {
      if (p.is_self) continue;
      if (p.email && contactByEmail.has(p.email)) { p.contact_id = contactByEmail.get(p.email)!.id; continue; }
      const byName = contactByFullName.get(words(p.name).join(" "));
      if (byName && byName.length === 1) {
        p.contact_id = byName[0].id;
        if (!p.email && byName[0].email) p.email = norm(byName[0].email);
      }
    }

    // 4) The company this call was with — most reliable signal first.
    let company: Company | null = null;
    let companySource: string | null = null;
    const isSelfCompany = (c: Company) =>
      (!!selfDomain && !GENERIC_DOMAINS.has(selfDomain) && !!c.domain && normalizeDomain(c.domain) === selfDomain);

    // 4a) Already linked (the calendar match made when the recording started).
    if (cal?.company_id) {
      company = companyById.get(cal.company_id) ??
        { id: cal.company_id, name: cal.company_name ?? "", domain: null, logo_url: cal.company_logo_url ?? null };
      companySource = meeting.metadata?.company_source ?? "calendar";
    }
    // 4b) A participant's email domain (alex@modjo.ai → Modjo).
    if (!company) {
      for (const p of participants) {
        if (p.is_self || !p.email) continue;
        const dom = domainOf(p.email);
        if (!dom || GENERIC_DOMAINS.has(dom)) continue;
        const c = companyByDomain.get(dom);
        if (c && !isSelfCompany(c)) { company = c; companySource = "participant_domain"; break; }
      }
    }
    // 4c) A participant who is a CRM contact, and that contact's company.
    if (!company) {
      for (const p of participants) {
        if (p.is_self || !p.contact_id) continue;
        const ct = contacts.find((c) => c.id === p.contact_id);
        const c = ct?.company_id ? companyById.get(ct.company_id) : undefined;
        if (c && !isSelfCompany(c)) { company = c; companySource = "participant_contact"; break; }
      }
    }
    // 4d) The title: a company name or domain label, whole words only.
    //     Short names (< 4 chars: "Ami") are too easy to hit by accident and
    //     are skipped; among several hits the longest match wins.
    const title = String(meeting.meeting_title ?? "");
    const titleWords = words(title);
    const padded = ` ${titleWords.join(" ")} `;
    if (!company && titleWords.length) {
      let best: { c: Company; len: number } | null = null;
      for (const c of companies) {
        if (isSelfCompany(c)) continue;
        const cands = [words(c.name).join(" "), domainLabel(c.domain) ?? ""]
          .filter((x) => x.length >= 4);
        for (const cand of cands) {
          if (!padded.includes(` ${cand} `)) continue;
          if (!best || cand.length > best.len) best = { c, len: cand.length };
        }
      }
      if (best) { company = best.c; companySource = "title_company"; }
    }
    // 4e) The title names a contact ("Frédéric / Matthieu", "Point Matthieu
    //     Bagur"): full name, else a first name only ONE contact carries.
    if (!company && titleWords.length) {
      const byFirst = new Map<string, Contact[]>();
      for (const c of contacts) {
        const f = norm(c.first_name ?? "");
        if (!f || !c.company_id) continue;
        if (!byFirst.has(f)) byFirst.set(f, []);
        byFirst.get(f)!.push(c);
      }
      let hit: Contact | null = null;
      // Full names first ("matthieu bagur" as consecutive title words).
      for (const [full, list] of contactByFullName) {
        if (list.length !== 1 || !list[0].company_id) continue;
        if (full.includes(" ") && padded.includes(` ${full} `)) { hit = list[0]; break; }
      }
      if (!hit) {
        for (const w of titleWords) {
          if (w.length < 3 || w === selfFirstName) continue;
          const list = byFirst.get(w);
          if (list && list.length === 1) { hit = list[0]; break; }
        }
      }
      if (hit) {
        const c = companyById.get(hit.company_id!);
        if (c && !isSelfCompany(c)) {
          company = c;
          companySource = "title_contact";
          // That person was in the call: surface them for the summary too.
          const name = `${hit.first_name ?? ""} ${hit.last_name ?? ""}`.trim();
          if (!participants.some((p) => p.contact_id === hit!.id)) {
            participants.push({ name, email: hit.email ? norm(hit.email) : undefined, contact_id: hit.id });
          }
        }
      }
    }

    // 5) Link the matched contacts to the meeting (idempotent).
    const ids = [...new Set(participants.map((p) => p.contact_id).filter(Boolean) as string[])];
    if (ids.length) {
      const { data: existing } = await userClient
        .from("meeting_contacts").select("contact_id").eq("meeting_id", meeting_id);
      const already = new Set((existing ?? []).map((r: any) => r.contact_id));
      const rows = ids.filter((id) => !already.has(id))
        .map((id) => ({ meeting_id, contact_id: id, user_id: user.id }));
      if (rows.length) await userClient.from("meeting_contacts").insert(rows);
    }

    // 6) Persist. The company lives where the CRM already reads it
    //    (metadata.calendar.company_*), alongside the participants.
    const metadata: Record<string, unknown> = { ...(meeting.metadata ?? {}), participants };
    if (company) {
      metadata.calendar = {
        ...(cal ?? {}),
        company_id: company.id,
        company_name: company.name,
        company_logo_url: company.logo_url ?? null,
      };
      metadata.company_source = companySource;
    }
    await admin.from("meetings").update({ metadata }).eq("id", meeting_id).eq("user_id", user.id);

    return json({
      participants,
      company: company
        ? { id: company.id, name: company.name, logo_url: company.logo_url ?? null, source: companySource }
        : null,
      meet_api: meetApi,
      google,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}
