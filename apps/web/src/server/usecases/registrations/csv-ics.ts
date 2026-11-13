import "server-only";
// Files: the organiser CSV export and the registrant .ics attachment (see ./index.ts).
import { sql, withTenant } from "@/lib/db";
import { mayHoldBearerCredential } from "@/lib/types";
import { requireFeature } from "@/lib/entitlements";
import { toLocale } from "@/lib/i18n-constants";
import { icsText, foldLine } from "@/lib/public-site";
import { msgFor } from "@/lib/messages-i18n";
import { entryReferenceOf } from "@/lib/ref-code";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { RegistrationFormField } from "@/server/api-v1/schemas";
import type { RegistrationRow } from "./types";
import { divisionCtx, regByToken } from "./lookups";
import { type ListRegistrationsFilters, listRegistrations } from "./list";

/** CSV export (organiser console; gated on the `exports` entitlement, doc 10
 *  §1). Plain `exports` reaches community in **V285** ("Free plain exports",
 *  v12); pro/business have held it since V101/V112 and event_pass since V270.
 *  The Pro-only half is `exports.branded` — and not Pro-ONLY either: V306
 *  grants it to event_pass as well (`lib/pass-features.ts:34`). So a denial
 *  here means an explicit org override, never a plan tier.
 *
 * RS005 W1a replaces the old division-only, entry-flat exporter. Rows come
 * from `listRegistrations` — the SAME read model the Registrants tab uses,
 * no second query builds the entry set — scoped by `opts.divisionId` (one
 * division) or `opts.competitionId`/`opts.filters.competition_id`
 * (competition-wide; `listRegistrations` itself 400s if neither is given).
 *
 * RULING (RS005 W1a): one CSV row per PLAYER. An entry with N players emits
 * N rows with its entry columns repeated; an entry with ZERO players (a free
 * agent, or a team registered with an empty roster) emits ONE row with the
 * player columns blank — dropping it would silently hide that entry from
 * the export entirely.
 */
export async function exportRegistrationsCsv(
  auth: AuthCtx,
  opts: {
    divisionId?: string | null;
    competitionId?: string | null;
    status?: string | null;
    filters?: ListRegistrationsFilters;
  },
): Promise<string> {
  await requireFeature(auth.orgId, "exports");
  const divisionId = opts.divisionId ?? null;
  const filters: ListRegistrationsFilters = opts.competitionId
    ? { ...(opts.filters ?? {}), competition_id: opts.competitionId }
    : (opts.filters ?? {});
  const rows = await listRegistrations(auth, divisionId, opts.status ?? null, filters);

  // The field-key scope is the DIVISIONS THE EXPORT COVERS, not the divisions
  // that happen to appear in `rows`. Deriving it from the rows makes the header
  // depend on the filter: `?status=rejected` with no matches emitted a header
  // with no question columns at all, and a competition-wide export's column set
  // shifted as the filter changed — so two exports of the same competition
  // could not be fed to the same importer. The old division-only exporter read
  // the division's own form_fields and could not express this bug.
  const scopeDivisionIds = divisionId
    ? [divisionId]
    : await withTenant(auth.orgId, (tx) =>
        tx<{ id: string }[]>`
          select d.id from divisions d
          where d.competition_id = ${filters.competition_id ?? null}
        `.then((ds) => ds.map((d) => d.id)),
      );
  const divisionIds = scopeDivisionIds.length > 0
    ? scopeDivisionIds
    : [...new Set(rows.map((r) => r.division_id))];
  const regIds = rows.map((r) => r.id);
  type PlayerCsvRow = {
    registration_id: string;
    full_name: string;
    dob: string | null;
    gender: string | null;
    consent_status: string;
    squad_number: number | null;
    is_captain: boolean;
  };
  const { fieldKeys, playersByReg } = await withTenant(auth.orgId, async (tx) => {
    // Form field keys: the union of every IN-SCOPE division's settings, so a
    // competition-wide export is not shaped like any single division's form.
    const fieldKeySet = new Set<string>();
    if (divisionIds.length > 0) {
      const settingsRows = await tx<{ form_fields: RegistrationFormField[] }[]>`
        select form_fields from registration_settings where division_id in ${tx(divisionIds)}`;
      for (const s of settingsRows) for (const f of s.form_fields ?? []) fieldKeySet.add(f.key);
    }
    const players =
      regIds.length > 0
        ? await tx<PlayerCsvRow[]>`
            select registration_id, full_name, dob, gender, consent_status, squad_number, is_captain
            from registration_players
            where registration_id in ${tx(regIds)}
            order by is_captain desc, created_at`
        : [];
    const playersByReg = new Map<string, PlayerCsvRow[]>();
    for (const p of players) {
      const list = playersByReg.get(p.registration_id) ?? [];
      list.push(p);
      playersByReg.set(p.registration_id, list);
    }
    return { fieldKeys: [...fieldKeySet].sort(), playersByReg };
  });

  const esc = (v: unknown): string => {
    let s = v === null || v === undefined ? "" : String(v);
    // CSV/formula injection (RS005 F1 finding 3, OWASP's standard
    // mitigation): Excel/LibreOffice evaluate a cell as a formula when it
    // starts with =, +, -, @, or (some parsers, after stripping leading
    // whitespace) TAB/CR — and this exporter's sink is registrant-controlled
    // (contact_name, per-player full_name), so a name like
    // `=cmd|'/c calc'!A1` or `@SUM(1+1)` was written raw and evaluated on
    // open. Prepending a bare apostrophe forces every spreadsheet reader to
    // treat the cell as literal text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    // `\r` joins the quoting trigger, not just `,`/`"`/`\n`: unquoted, a
    // lone CR inside a value reads as a row break to a universal-newline CSV
    // reader and silently splits one row into two.
    return /["\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // Per-player DOB and GENDER are editor-only (RS005 whole-branch review).
  // The owner's ruling deliberately allows a VIEWER to export — that is the
  // point of a read-only seat that can still do the federation paperwork — but
  // it weighed the join code, not this: dob/gender appear on NO UI surface for
  // ANY role, so the export is the only path to them, and much of it is
  // minor-attendee personal data leaving the platform as a file.
  //
  // The columns are OMITTED, not blanked. A blank column in a file headed
  // `player_dob` reads as "we hold no date of birth", which is a different and
  // false statement — and a spreadsheet built against that header would
  // silently gain two empty columns depending on who exported it.
  const maySeePlayerPersonalData = mayHoldBearerCredential(auth.role);
  const playerHeader = maySeePlayerPersonalData
    ? ["player_name", "player_dob", "player_gender", "player_consent_status", "squad_number", "is_captain"]
    : ["player_name", "player_consent_status", "squad_number", "is_captain"];

  // `id` + `registration_id` (RS005 F1 finding 5): main's exporter emitted
  // one row per REGISTRATION under the column name `id`. RS005 W1a widened
  // this to one row per PLAYER — a deliberate ruling (see this function's
  // own doc comment above) kept as-is here, not reverted — but renamed the
  // identifier column to `registration_id` and dropped `id` outright, with
  // no response schema in openapi.ts for any drift gate to catch it. `id`
  // is restored here, first column, byte-identical to `registration_id` on
  // every row: an integration reading the OLD column name still finds the
  // registration's id (now simply repeated once per player row) rather
  // than losing it. See openapi.ts's summary for both export routes for the
  // documented shape.
  //
  // `entry_reference` (B5 T19, spec §6.3) is LAST, after the form's own question columns: appended, so every column an importer
  // already reads keeps its name and its place. `ref_code` stays the CART's reference; this is the one to match a bank transfer
  // against — `SZ-XXXX-XXXX-<n>` for an entry of a cart sent with 2+ entries, the bare reference otherwise (`entryReferenceOf`, the
  // one reading of those columns), blank when the cart has no reference at all. English snake_case like every header here: this
  // file's headers are machine column keys, not copy, and are not localised.
  const header = [
    "id", "registration_id", "ref_code", "division", "status", "kind", "display_name",
    "contact_name", "contact_email", "amount_cents", "currency", "refunded_cents",
    "payment_method", "waitlist_position", "created_at",
    ...playerHeader,
    ...fieldKeys,
    "entry_reference",
  ];
  const lines: string[] = [];
  for (const r of rows) {
    const entryCols = [
      r.id, r.id, r.ref_code, r.division_name, r.status, r.entrant_kind, r.display_name,
      r.contact_name, r.contact_email, r.amount_cents, r.currency, r.refunded_cents,
      r.payment_method, r.waitlist_position, new Date(r.created_at).toISOString(),
    ];
    const answerCols = fieldKeys.map((k) => (r.answers as Record<string, unknown>)[k] ?? "");
    const entryReference = entryReferenceOf(r) ?? "";
    const players = playersByReg.get(r.id) ?? [];
    if (players.length === 0) {
      // One blank cell per player column, whichever set is in force — derived
      // from playerHeader so the two can never fall out of step.
      lines.push([...entryCols, ...playerHeader.map(() => ""), ...answerCols, entryReference].map(esc).join(","));
    } else {
      for (const p of players) {
        const playerCols = maySeePlayerPersonalData
          ? [p.full_name, p.dob, p.gender, p.consent_status, p.squad_number, p.is_captain]
          : [p.full_name, p.consent_status, p.squad_number, p.is_captain];
        lines.push([...entryCols, ...playerCols, ...answerCols, entryReference].map(esc).join(","));
      }
    }
  }
  return [header.join(","), ...lines].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// .ics confirmation attachment (doc 16 §1.1 / PROMPT-20a item 3)
// ---------------------------------------------------------------------------

/** `reg.status` → the (currently unwired elsewhere) `reg.status.*` label
 *  vocabulary, reused here for the ICS DESCRIPTION (B2). "rejected" has no
 *  key yet, so it falls through to the raw status word below — the same
 *  fallback the pre-B2 code effectively had for every status. */
const REG_ICS_STATUS_KEY: Partial<Record<RegistrationRow["status"], Parameters<typeof msgFor>[1]>> = {
  pending: "reg.status.pending",
  paid: "reg.status.paid",
  confirmed: "reg.status.confirmed",
  waitlisted: "reg.status.waitlisted",
  withdrawn: "reg.status.withdrawn",
  expired: "reg.status.expired",
};

/**
 * Confirmation .ics for the competition dates (doc 16 §1.1 / PROMPT-20a item
 * 3). A LOCAL builder, not buildIcs (public-site.ts) — buildIcs's IcsEvent
 * shape can't carry this event's multi-day span, its lack of a STATUS line,
 * or its registration-specific PRODID without either collapsing the span to
 * one day or double-suffixing the UID (review finding; each PRESERVED
 * behaviour is pinned by its own test in registrations.test.ts). Reuses
 * buildIcs's own foldLine + icsText so the two VCALENDAR emitters don't
 * drift on RFC 5545 mechanics (line folding, TEXT escaping).
 */
export async function registrationIcs(regId: string, token: string): Promise<string> {
  const reg = await regByToken(regId, token);
  const ctx = await divisionCtx(sql, reg.division_id);
  const [div] = await sql<{ name: string }[]>`
    select name from divisions where id = ${reg.division_id}`;
  // This attachment is addressed to ONE specific person, unlike
  // calendar.ics's division-wide feed (which has no single "whose locale"
  // and resolves org.default_locale instead) — so it resolves the
  // registrant's OWN locale, the same signal every other post-signup email
  // in this file reads (the cart's pick, `reg.locale`).
  const locale = toLocale(reg.locale);
  const lookup = (
    k: Parameters<typeof msgFor>[1],
    v?: Record<string, string | number>,
  ) => msgFor(locale, k, v);

  const start = (ctx.starts_on ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  // DTEND is exclusive for all-day events.
  const endDate = ctx.ends_on ?? ctx.starts_on ?? new Date().toISOString().slice(0, 10);
  const end = new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString().slice(0, 10).replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const statusKey = REG_ICS_STATUS_KEY[reg.status];
  const description = lookup("calendar.registrationDescription", {
    name: reg.display_name,
    status: statusKey ? lookup(statusKey) : reg.status,
  });

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//seazn.club//registration//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:registration-${reg.id}@seazn.club`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${icsText(`${ctx.comp_name} — ${div?.name ?? ""}`)}`,
    `DESCRIPTION:${icsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
