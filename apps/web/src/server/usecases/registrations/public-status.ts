import "server-only";
// Token- and ref-gated public views: status, cart, public withdraw (see ./index.ts).
import { sql } from "@/lib/db";
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import type { RegistrationSettingsRow, RegistrationRow, AnySql } from "./types";
import { hashRegistrationToken } from "./helpers";
import { loadSettings, divisionCtx, regByToken, regByRef, regByRefAndToken } from "./lookups";
import { withdrawCore } from "./withdraw";
import { waitlistPositionSql } from "./waitlist";

// ---------------------------------------------------------------------------
// Public: status / withdraw / resume payment (token-gated)
// ---------------------------------------------------------------------------

export interface PublicStatusView {
  id: string;
  status: string;
  /** Quotable reference (v3/05 §3); null on pre-v2 rows. */
  ref_code: string | null;
  display_name: string;
  division_name: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  fee_cents: number;
  amount_cents: number;
  currency: string | null;
  refunded_cents: number;
  payment_due: boolean;
  /** How this entry pays (snapshot; spec §3). */
  payment_method: "offline" | "stripe" | null;
  /** Card pendings: the pay-by deadline (spec §2). */
  expires_at: string | null;
  /** Pay CTA gate: card pending + fee due + Connect live. */
  can_pay_online: boolean;
  payment_instructions: string | null;
  /** 1-based place in the waitlist queue; null unless waitlisted (PROMPT-52). */
  position: number | null;
  created_at: string;
}

export async function publicRegistrationStatus(
  regId: string,
  token: string,
): Promise<PublicStatusView> {
  const reg = await regByToken(regId, token);
  const ctx = await divisionCtx(sql, reg.division_id);
  const settings = await loadSettings(sql, reg.division_id);
  const [div] = await sql<{ name: string; youth: boolean; player_name_display: string | null }[]>`
    select name, youth, player_name_display from divisions where id = ${reg.division_id}`;
  // RS008 review fix #3 — bring this to parity with its sibling
  // publicRegistrationStatusByRef, which has had both the youth AND consent
  // axes since RS008: display_name is a PERSON's name for individual/pair,
  // but a TEAM's own declared name for team — no personal consent applies
  // there (public.ts/public_entrants_v precedent, established throughout
  // this session).
  // Post-merge review fix (2026-08-30, free-agent gap): entrant_kind ===
  // "team" at the DIVISION level also covers a FREE AGENT — design's own
  // "one unassigned person, not a named team" case (registration-submit.ts's
  // entryDisplayName treats `entrant_kind === "team" && !free_agent` as the
  // actual team branch; a free agent falls through to the solo player's own
  // name, same as individual). Nothing stops a division from being BOTH
  // youth AND allow_free_agents (the only rule is "allow_free_agents
  // requires entrant_kind 'team'") — without the `!reg.free_agent` guard, a
  // solo minor's free-agent entry rode the team bypass below and printed
  // their real name unmasked.
  const isTeam = (settings?.entrant_kind ?? "individual") === "team" && !reg.free_agent;
  const optedOut = isTeam ? new Set<string>() : await anyOptedOutByRegistration(sql, [reg.id]);
  // Code-review fix (2026-08-30, item 2): `isTeam` above only ever bypassed
  // the CONSENT axis (optedOut stays empty for a team) — resolvePersonDisplayName
  // was still being CALLED for a team's own display_name, and the YOUTH axis
  // lives INSIDE that function, not in the isTeam guard around it. A team on
  // a youth division still fell into maskDisplayName via the youth branch,
  // e.g. "Thunder Strikers" -> "Thunder S.", even though a team's own
  // declared name carries no personal-consent OR safeguarding meaning at
  // all. Bypass the resolver call itself for a team, same as every other
  // already-correct site (maskPublicEntrantNames, public.ts's publicEntrants).
  const displayName = isTeam
    ? reg.display_name
    : resolvePersonDisplayName(
        reg.display_name,
        optedOut.has(reg.id) ? { public_name: false } : null,
        div?.player_name_display ?? null,
        div?.youth ?? false,
      );
  // Amount due follows the SNAPSHOT (reg row), not live settings — fee edits
  // never change what an in-flight registrant owes (spec issue #8).
  const paymentDue = reg.status === "pending" && reg.amount_cents > 0;
  const offline = reg.payment_method !== "stripe";
  // Queue position (PROMPT-52): the place promotion takes, `waitlistPositionSql` (registrations/waitlist.ts) - the one count every
  // surface states. It used to count by `(created_at, id)` here, which told a lapsed promotion it was first while promotion had put it
  // on the tail (registration redesign B3 T13). Read off the row in SQL, never from a JS Date (ms, where timestamptz keeps µs).
  const [posRow] = reg.status === "waitlisted"
    ? await sql<{ position: number | null }[]>`
        select ${waitlistPositionSql(sql, "r")} as position from registrations r where r.id = ${reg.id}`
    : [];
  return {
    id: reg.id,
    status: reg.status,
    ref_code: reg.ref_code,
    display_name: displayName,
    division_name: div?.name ?? "",
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    fee_cents: settings?.fee_cents ?? 0,
    amount_cents: reg.amount_cents,
    currency: reg.currency,
    refunded_cents: reg.refunded_cents,
    payment_due: paymentDue,
    payment_method: reg.payment_method,
    expires_at: reg.expires_at ? new Date(reg.expires_at).toISOString() : null,
    can_pay_online: paymentDue && !offline && ctx.charges_enabled,
    payment_instructions:
      paymentDue && offline
        ? (settings?.payment_instructions ?? ctx.payment_instructions)
        : null,
    position: posRow?.position ?? null,
    created_at: new Date(reg.created_at).toISOString(),
  };
}

/** Registrant withdraw (token). Frees the spot, auto-promotes the oldest
 *  waitlisted, auto-refunds before refund_lock_at (doc 16 §1.1). */
export async function withdrawRegistrationPublic(
  regId: string,
  token: string,
): Promise<PublicStatusView> {
  const reg = await regByToken(regId, token);
  await withdrawCore(reg, null, "registrant");
  return publicRegistrationStatus(regId, token);
}

// ---------------------------------------------------------------------------
// Reference-number lookups — /r/[ref] (v3/05 §3, PROMPT-34)
// ---------------------------------------------------------------------------

/** What /r/[ref] shows the world: never more than the success screen, and
 *  the name honours the division's public name display (v3/11 gap 8). */
export interface PublicRefView {
  ref_code: string;
  status: string;
  display_name: string;
  division_name: string;
  division_slug: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  /** True when the ?token= the viewer presented matches — unlocks withdraw. */
  can_withdraw: boolean;
}

/**
 * RS008 — batched "does ANY roster player on this registration have an
 * explicit consent opt-out" check, keyed by registration id, for the
 * PERSON-shaped public reads below (`publicRegistrationStatus`,
 * `publicRegistrationStatusByRef`, `publicCartByRef`) — a multi-entry cart
 * costs ONE query here, not one per entry. INNER JOINs persons on purpose: a
 * row with no `person_id` yet (unclaimed, never materialised) has no consent
 * object to check and can never contribute an opt-out, so it is correctly
 * invisible to this query rather than needing an explicit null-check.
 * Delegates the actual "stricter wins across several people sharing one
 * display_name" rule to `anyOptedOut` (lib/name-display.ts) — never
 * re-implements it.
 *
 * Exported (RS008 review fix #6): `registration-submit.ts`'s
 * `previewJoinEntry` reuses this SAME function for its own join-page
 * heading mask, rather than a parallel local query — this file already
 * flows one way into that one (module topology comment, registration-submit.ts),
 * never the reverse.
 *
 * Takes the sql/tx client as an explicit first parameter (code-review fix,
 * 2026-08-30): `exports.ts`'s `buildAdmitTicketsDoc` needs to run this same
 * query from inside its own `withTenant` transaction and used to carry a
 * byte-for-byte duplicate differing only in that one parameter — the exact
 * "two lookup paths drift" defect class this codebase has hit before.
 * Deduped: `exports.ts` now imports and calls this function directly.
 */
export async function anyOptedOutByRegistration(db: AnySql, regIds: string[]): Promise<Set<string>> {
  if (regIds.length === 0) return new Set();
  const rows = await db<{ registration_id: string; consent: { public_name?: boolean } | null }[]>`
    select rp.registration_id, p.consent
    from registration_players rp
    join persons p on p.id = rp.person_id
    where rp.registration_id in ${db(regIds)}`;
  const consentsByReg = new Map<string, ({ public_name?: boolean } | null)[]>();
  for (const r of rows) {
    const list = consentsByReg.get(r.registration_id) ?? [];
    list.push(r.consent);
    consentsByReg.set(r.registration_id, list);
  }
  const optedOut = new Set<string>();
  for (const [regId, consents] of consentsByReg) {
    if (anyOptedOut(consents)) optedOut.add(regId);
  }
  return optedOut;
}

export async function publicRegistrationStatusByRef(
  ref: string,
  token?: string | null,
): Promise<PublicRefView> {
  const reg = await regByRef(ref);
  const ctx = await divisionCtx(sql, reg.division_id);
  const [div] = await sql<
    { name: string; slug: string; youth: boolean; player_name_display: string | null }[]
  >`
    select name, slug, youth, player_name_display from divisions
    where id = ${reg.division_id}`;
  // RS008: display_name is a PERSON's name for individual/pair, but a TEAM's
  // own declared name for team — no personal consent applies there, same
  // `kind === "team"` bypass public.ts's publicEntrants already established.
  const settings = await loadSettings(sql, reg.division_id);
  // Post-merge review fix (2026-08-30, free-agent gap): same as
  // publicRegistrationStatus above — entrant_kind === "team" at the division
  // level also covers a FREE AGENT (one unassigned person, not a named
  // team; registration-submit.ts's entryDisplayName draws this same
  // distinction). Without `!reg.free_agent`, a free-agent entry on a
  // youth+allow_free_agents division rides the team bypass and prints the
  // real person's name unmasked.
  const isTeam = (settings?.entrant_kind ?? "individual") === "team" && !reg.free_agent;
  // A team entry's roster can still carry an opted-out member — never
  // queried for one, so `optedOut` is always empty and the mask stays
  // youth-only, exactly like the pre-RS008 behaviour.
  const optedOut = isTeam ? new Set<string>() : await anyOptedOutByRegistration(sql, [reg.id]);
  // Code-review fix (2026-08-30, item 2): same gap as publicRegistrationStatus
  // above — `isTeam` only bypassed the consent axis; the youth axis lives
  // inside resolvePersonDisplayName itself, so a team on a youth division
  // still got masked. Bypass the resolver call entirely for a team.
  const displayName = isTeam
    ? reg.display_name
    : resolvePersonDisplayName(
        reg.display_name,
        optedOut.has(reg.id) ? { public_name: false } : null,
        div?.player_name_display ?? null,
        div?.youth ?? false,
      );
  // access_token_hash already rode the join in regByRef — no separate fetch
  // needed (it lives on the cart now, V364).
  const canWithdraw =
    !!token && reg.status !== "withdrawn" && hashRegistrationToken(token) === reg.access_token_hash;
  return {
    ref_code: reg.ref_code!,
    status: reg.status,
    display_name: displayName,
    division_name: div?.name ?? "",
    division_slug: div?.slug ?? "",
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    created_at: new Date(reg.created_at).toISOString(),
    can_withdraw: canWithdraw,
  };
}

/** Self-withdraw from /r/[ref] — the ref is a LOOKUP, NOT auth: the email
 *  token is still required (v3/05 §4). RS006 follow-up (data-integrity fix):
 *  a cart can hold more than one entry, and this used to always resolve+act
 *  on the OLDEST one (`regByRef`'s deterministic pick) regardless of what the
 *  registrant meant to withdraw — a multi-entry cart rendered one
 *  undifferentiated Withdraw control that silently withdrew the wrong row.
 *  The caller now names the target entry explicitly; `regByRefAndToken`
 *  verifies it belongs to the ref's OWN group before `withdrawCore` ever
 *  runs, so a valid token can never be paired with a foreign registration id
 *  to withdraw someone else's entry. Returns the whole cart (the same shape
 *  the page renders) so every entry's post-withdraw status is visible, not
 *  just the one just acted on. */
export async function withdrawRegistrationByRef(
  ref: string,
  entryId: string,
  token: string,
): Promise<PublicCartView> {
  const reg = await regByRefAndToken(ref, entryId, token);
  await withdrawCore(reg, null, "registrant");
  return publicCartByRef(ref, token);
}

/** One entry as /r/[ref] shows it to the general public — masked per THIS
 *  entry's own division policy (see `PublicCartView`). */
export interface PublicCartEntryView {
  id: string;
  status: RegistrationRow["status"];
  display_name: string;
  division_name: string;
  /** True when the viewer's token is valid for this cart AND this specific
   *  entry isn't already withdrawn — RS006 follow-up: withdraw acts on ONE
   *  named entry now (`withdrawRegistrationByRef` takes an explicit entry
   *  id), so each entry states its OWN eligibility instead of the whole
   *  cart inheriting one entry's (that mismatch — one flag, evaluated
   *  against only the oldest entry, driving a single cart-wide control —
   *  was the data-integrity bug: nothing told the registrant WHICH entry a
   *  click would act on). Mirrors the single-entry sibling's predicate
   *  (`PublicRefView.can_withdraw`) exactly, just evaluated per row. */
  can_withdraw: boolean;
}

/**
 * What /r/[ref] shows the world for the WHOLE cart (RS006 — the owner's
 * ruling, recorded here: a multi-entry cart shows every entry, not just the
 * oldest, now that RS002/RS003 make multi-entry carts real). The group-level
 * sibling of `PublicRefView`, same "never more than the success screen"
 * contract — NOT `GroupStatusView` (`groupByRef`/`groupById`), which is
 * token-GATED and deliberately unmasked for that reason. This is reachable
 * by anyone with a bare ref code, so contact info, amounts/fees/currency,
 * payment method and the access token are never on this shape, and every
 * entry's `display_name` is masked through `resolvePersonDisplayName` for
 * ITS OWN division AND its own roster's consent (RS008) — a cart can span a
 * youth division and a non-youth one at once, so one mask for the whole cart
 * would be wrong in either direction. A `team` entry's own name is never
 * personal, so it skips the consent axis entirely (`entrantKindByDivision`
 * below) — same bypass `public.ts`'s `publicEntrants` already established.
 */
export interface PublicCartView {
  ref_code: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  /** True when the viewer's ?token= matches this cart's access token. RS006
   *  follow-up: no longer tied to any one entry's status — it used to mirror
   *  the OLDEST entry's (the exact bug: a cart-wide flag standing in for a
   *  per-entry fact). That check now lives per entry, see
   *  `PublicCartEntryView.can_withdraw`; this only gates whether the viewer
   *  has write access to the cart AT ALL. */
  can_withdraw: boolean;
  entries: PublicCartEntryView[];
}

export async function publicCartByRef(ref: string, token?: string | null): Promise<PublicCartView> {
  // regByRef owns the checksum/normalise/404 contract (shared with the
  // single-entry read) and hands back the oldest entry joined to the cart's
  // own columns — enough to resolve competition/org context (divisionCtx,
  // same source `publicRegistrationStatusByRef` reads) and the access-token
  // hash, without a second group lookup.
  const reg = await regByRef(ref);
  const ctx = await divisionCtx(sql, reg.division_id);

  const entries = await sql<
    {
      id: string;
      status: RegistrationRow["status"];
      display_name: string;
      division_id: string;
      division_name: string;
      youth: boolean;
      player_name_display: string | null;
      // Post-merge review fix (2026-08-30, free-agent gap): needed below so
      // the team bypass can exclude a free-agent entry (one unassigned
      // person, not a named team) from its own division's team treatment.
      free_agent: boolean;
    }[]
  >`
    select r.id, r.status, r.display_name, r.division_id, d.name as division_name,
           d.youth, d.player_name_display, r.free_agent
    from registrations r join divisions d on d.id = r.division_id
    where r.group_id = ${reg.group_id}
    order by r.created_at, r.id`;

  // access_token_hash lives on the GROUP (V364) — shared by every entry, so
  // any one of them (regByRef's oldest pick) reads it correctly regardless
  // of which entry is actually being withdrawn. Not constant-time: the
  // token is OPTIONAL here, so unlike groupByRef's required-token gate there
  // is no ref-vs-token enumeration distinction to protect (same rule
  // publicRegistrationStatusByRef's canWithdraw already applies).
  const tokenValid = !!token && hashRegistrationToken(token) === reg.access_token_hash;

  // RS008: entrant_kind per DIVISION (a cart can span more than one, same
  // reason buildGroupStatusView's own entrantKindByDivision map exists) —
  // a TEAM entry's display_name is the team's own name, never a person's,
  // so it never takes the consent axis. Batched: one query for the whole
  // cart's distinct divisions, not one per entry.
  const divisionIds = [...new Set(entries.map((e) => e.division_id))];
  const settingsRows =
    divisionIds.length > 0
      ? await sql<{ division_id: string; entrant_kind: RegistrationSettingsRow["entrant_kind"] }[]>`
          select division_id, entrant_kind from registration_settings
          where division_id in ${sql(divisionIds)}`
      : [];
  const entrantKindByDivision = new Map(settingsRows.map((s) => [s.division_id, s.entrant_kind]));
  // Post-merge review fix (2026-08-30, free-agent gap): a FREE AGENT entry
  // carries `entrant_kind: "team"` at the division level but is one
  // unassigned person, not a named team (registration-submit.ts's
  // entryDisplayName draws this same distinction) — it must still take the
  // consent axis like any individual entry, or a free agent's real name
  // rides the team bypass straight past `anyOptedOutByRegistration`.
  const nonTeamEntryIds = entries
    .filter(
      (e) => (entrantKindByDivision.get(e.division_id) ?? "individual") !== "team" || e.free_agent,
    )
    .map((e) => e.id);
  const optedOut = await anyOptedOutByRegistration(sql, nonTeamEntryIds);

  return {
    ref_code: reg.ref_code!,
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    created_at: new Date(reg.created_at).toISOString(),
    can_withdraw: tokenValid,
    entries: entries.map((e) => {
      // Code-review fix (2026-08-30, item 2): entrantKindByDivision already
      // decided which entries feed nonTeamEntryIds (the consent axis) above,
      // but this per-entry map still called resolvePersonDisplayName
      // unconditionally — a team on a youth division was still masked via
      // the youth axis living INSIDE that function, not in nonTeamEntryIds'
      // filter around it.
      // Post-merge review fix (2026-08-30, free-agent gap): same `!e.free_agent`
      // exclusion as nonTeamEntryIds above — a free agent must not take the
      // team bypass on THIS axis either, or its youth-division real name
      // renders unmasked even though the consent axis above now (correctly)
      // catches it.
      const isTeam = (entrantKindByDivision.get(e.division_id) ?? "individual") === "team" && !e.free_agent;
      return {
        id: e.id,
        status: e.status,
        display_name: isTeam
          ? e.display_name
          : resolvePersonDisplayName(
              e.display_name,
              optedOut.has(e.id) ? { public_name: false } : null,
              e.player_name_display,
              e.youth,
            ),
        division_name: e.division_name,
        // Per-entry, not inherited from the cart's (oldest-entry-derived) reg
        // row — see PublicCartEntryView.can_withdraw's doc comment for why.
        can_withdraw: tokenValid && e.status !== "withdrawn",
      };
    }),
  };
}
