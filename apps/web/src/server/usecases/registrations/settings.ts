import "server-only";
// Organiser settings (defaults, get / put) and the public register-panel info (see ./index.ts).
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getLimit, hasFeature, requireFeature } from "@/lib/entitlements";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PutRegistrationSettings, RegistrationFormField } from "@/server/api-v1/schemas";
import { resolveLogoUrl } from "@/server/public-site/data";
import { requiresDob, requiresGender } from "../registration-eligibility";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { chessIndividualOnlyError, isChessSport } from "@/lib/chess-individual-only";
import { effectivePolicy, readCameraPolicy, type CameraPolicy } from "@/server/external-play/camera-policy";
import { onlineChessOffered } from "../external-play/online-chess-flag";
import {
  assertDivisionTakesKind,
  entrantShapeOf,
  registrationDefaultKind,
  type EntrantShapeSource,
} from "../entrant-shape";
import { divisionTakesKind } from "@/lib/division-entrant-kinds";
import type { RegistrationSettingsRow } from "./types";
import { SETTINGS_COLS, loadSettings, windowOpen } from "./lookups";

// ---------------------------------------------------------------------------
// Organiser: settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Omit<RegistrationSettingsRow, "division_id"> = {
  enabled: false,
  entrant_kind: "individual",
  opens_at: null,
  closes_at: null,
  capacity: null,
  fee_cents: 0,
  refund_lock_at: null,
  form_fields: [],
  payment_method: "offline",
  payment_instructions: null,
  approval: "auto",
  allow_free_agents: false,
  free_agent_fee_cents: null,
  place_by_at: null,
  updated_at: null,
};

export interface OrgPaymentDefaults {
  charges_enabled: boolean;
  org_payment_instructions: string | null;
  org_default_payment_method: string;
  /** The org's one preferred currency (RS001b). Read-only on the division
   *  settings surface — RS004 renders it as a chip linking to org settings,
   *  and the same-currency lock pins it to the connected account's settlement
   *  currency while connected. */
  currency: string;
}

async function orgPaymentDefaults(orgId: string): Promise<OrgPaymentDefaults> {
  const [row] = await sql<OrgPaymentDefaults[]>`
    select stripe_charges_enabled as charges_enabled,
           payment_instructions as org_payment_instructions,
           default_payment_method as org_default_payment_method,
           currency
    from organizations where id = ${orgId}`;
  if (!row) throw new HttpError(404, "organization not found");
  return row;
}

export async function getRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
): Promise<RegistrationSettingsRow & OrgPaymentDefaults> {
  const org = await orgPaymentDefaults(auth.orgId);
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<EntrantShapeSource[]>`
      select sport_key, module_version, config from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const row = await loadSettings(tx, divisionId);
    // FU1 ruling 3: an unconfigured division registers its OWN default kind (the engine's effective model), never an
    // 'individual' the division may not take - chess always individual (fix round 1 m4). A stored row keeps what it
    // holds, allowed or not - the panel names it.
    const defaults = { ...DEFAULT_SETTINGS, entrant_kind: registrationDefaultKind(division) };
    return { division_id: divisionId, ...defaults, ...(row ?? {}), ...org };
  });
}

export async function putRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
  input: PutRegistrationSettings,
): Promise<RegistrationSettingsRow & OrgPaymentDefaults> {
  await requireFeature(auth.orgId, "registration.enabled");
  const [regDiv] = await sql<({ competition_id: string } & EntrantShapeSource)[]>`
    select competition_id, sport_key, module_version, config from divisions where id = ${divisionId}`;
  // FU1: the division's allowed kinds - what the save below is judged against, and where an omitted kind defaults to.
  const shape = regDiv ? entrantShapeOf(regDiv) : null;
  const org = await orgPaymentDefaults(auth.orgId);

  // Offline (cash/bank) fees are free on every plan — they fill the funnel.
  // Card collection is the paid layer (doc 16 §1.1): it needs a live Connect
  // account AND the registration.paid entitlement, and the fee must clear
  // Stripe's minimum charge (spec issue #13).
  // Zod defaults apply on the route; direct callers (tests, scripts) may omit
  // defaulted fields, so normalise exactly like the schema does.
  const method = input.payment_method ?? "offline";
  const feeCents = input.fee_cents ?? 0;
  // An omitted kind is the division's default (chess: individual, m4). An unknown division has no default; it 404s in
  // the transaction below, so this last fallback only keeps the type and is never saved.
  const entrantKind = input.entrant_kind ?? (regDiv ? registrationDefaultKind(regDiv) : "individual");
  const formFields = input.form_fields ?? [];
  const approval = input.approval ?? "auto";
  const allowFreeAgents = input.allow_free_agents ?? false;
  // `?? null`, never `|| null`: 0 is a real price ("solo sign-ups are free in
  // this paid division") and `||` would silently turn it back into "unset",
  // charging the full team fee to someone the panel told was free.
  const freeAgentFeeCents = input.free_agent_fee_cents ?? null;
  // Chess is individual-only (owner ruling 2026-10-26): no pair, no team, and
  // so no free-agent pool either. FIRST among the entrant-shape checks, so an
  // individual chess division asking for free agents hears the chess rule and
  // not "allow_free_agents requires entrant_kind 'team'" — advice that points
  // at the very option chess forbids. The division's sport is read above; an
  // unknown division falls through to the 404 inside the transaction.
  if (
    regDiv &&
    isChessSport(regDiv.sport_key) &&
    (entrantKind !== "individual" || allowFreeAgents || freeAgentFeeCents !== null)
  ) {
    throw chessIndividualOnlyError();
  }
  // FU1 ruling 2: registration takes only a kind the division itself allows (its Entrant kinds). After the chess rule, so a
  // chess division hears that rule; before the free-agent rules below, which are about a kind that must first be allowed.
  // An unknown division falls through to the 404 inside the transaction.
  if (shape) assertDivisionTakesKind(shape, entrantKind);
  // Free agents (an entry with no roster yet, RS004/V364) only make sense
  // where there IS a roster to join later — registration-submit.ts's own
  // guard already refuses a free-agent submit outside entrant_kind 'team';
  // this rejects the setting itself at save time instead of letting an
  // organiser turn on a toggle that can never take effect.
  if (allowFreeAgents && entrantKind !== "team") {
    throw new HttpError(422, "allow_free_agents requires entrant_kind 'team'");
  }
  // A price for something the division does not offer is a setting that reads
  // as a promise: the panel would show a solo sign-up fee on a division where
  // nobody can sign up solo. Same rule the toggle itself already follows.
  if (freeAgentFeeCents !== null && !allowFreeAgents) {
    throw new HttpError(
      422,
      "A solo sign-up price only applies where solo sign-ups are allowed — turn those on first",
    );
  }
  if (freeAgentFeeCents !== null && freeAgentFeeCents < 0) {
    throw new HttpError(422, "A solo sign-up price cannot be negative");
  }
  // The Stripe minimum applies to whatever is actually CHARGED, and a solo
  // sign-up is charged this instead of fee_cents — so a division can pass the
  // fee_cents check below and still mint a checkout Stripe rejects.
  //
  // F15: this message must stay distinguishable from fee_cents's own
  // "Card entry fees must be at least 1.00 (or 0 for free)" below — the two
  // guards used to throw an IDENTICAL string, so the client's
  // registration-hub-save-error.ts pattern table (matched by message text
  // alone) could not tell them apart and always routed the error onto
  // fee_cents, the wrong field, with no render site for the right one either.
  if (method === "stripe" && freeAgentFeeCents !== null && freeAgentFeeCents > 0 && freeAgentFeeCents < 100) {
    throw new HttpError(422, "Card entry fees for a solo sign-up must be at least 1.00 (or 0 for free)");
  }
  if (method === "stripe") {
    if (!org.charges_enabled) {
      throw new HttpError(
        422,
        "Connect Stripe under Settings → Connect before choosing card payments",
      );
    }
    await requireFeature(auth.orgId, "registration.paid", regDiv?.competition_id);
    if (feeCents > 0 && feeCents < 100) {
      throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
    }
  }

  // Capacity can't promise more than the plan's entrant quota (doc 10 §1) —
  // confirm would hit the wall after money changed hands.
  if (input.capacity != null) {
    const limit = await getLimit(auth.orgId, "entrants.per_division.max", regDiv?.competition_id);
    if (limit !== null && input.capacity > limit) {
      throw new HttpError(
        422,
        `Capacity exceeds your plan's entrant limit (${limit}) — raise the plan or lower the capacity`,
      );
    }
  }
  if (input.opens_at && input.closes_at && new Date(input.opens_at) >= new Date(input.closes_at)) {
    throw new HttpError(422, "closes_at must be after opens_at");
  }

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [row] = await tx<RegistrationSettingsRow[]>`
      insert into registration_settings
        (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
         fee_cents, refund_lock_at, place_by_at, form_fields,
         payment_method, payment_instructions, approval, allow_free_agents,
         free_agent_fee_cents, updated_at)
      values
        (${divisionId}, ${input.enabled}, ${entrantKind},
         ${input.opens_at ?? null}, ${input.closes_at ?? null},
         ${input.capacity ?? null}, ${feeCents},
         ${input.refund_lock_at ?? null}, ${input.place_by_at ?? null}, ${tx.json(formFields as never)},
         ${method}, ${input.payment_instructions?.trim() || null},
         ${approval}, ${allowFreeAgents}, ${freeAgentFeeCents}, now())
      on conflict (division_id) do update set
        enabled              = excluded.enabled,
        entrant_kind         = excluded.entrant_kind,
        opens_at             = excluded.opens_at,
        closes_at            = excluded.closes_at,
        capacity             = excluded.capacity,
        fee_cents            = excluded.fee_cents,
        refund_lock_at       = excluded.refund_lock_at,
        place_by_at          = excluded.place_by_at,
        form_fields          = excluded.form_fields,
        payment_method       = excluded.payment_method,
        payment_instructions = excluded.payment_instructions,
        approval             = excluded.approval,
        allow_free_agents    = excluded.allow_free_agents,
        free_agent_fee_cents = excluded.free_agent_fee_cents,
        updated_at           = now()
      returning ${sql(SETTINGS_COLS as unknown as string[])}`;
    return { ...row, ...org };
  });
}

// ---------------------------------------------------------------------------
// Public: register panel info
// ---------------------------------------------------------------------------

export interface PublicDivisionInfo {
  division_id: string;
  name: string;
  slug: string;
  sport_key: string;
  // Needlessly widened to `string` before RS006; the row this is built from
  // (RegistrationSettingsRow, via the `rs.*` select above) already carries
  // the narrow union, and the wire contract (PublicRegistrationDivision,
  // schemas.ts) already declares it as the EntrantKind enum — tightened
  // here too so a client-side exhaustive switch (RS006's division-card.tsx)
  // doesn't need a defensive `string` fallback for a value that can only
  // ever be one of these three.
  entrant_kind: "team" | "individual" | "pair";
  fee_cents: number;
  /** RS009 — what ONE person pays to enter this team division alone. null =
   *  no separate price, charge `fee_cents`. The public stepper needs it to
   *  QUOTE what the server will actually charge: without it, a solo line was
   *  priced at the per-team fee on screen and at the solo fee in Stripe. */
  free_agent_fee_cents: number | null;
  currency: string;
  /** How the entry fee is collected (spec §3). */
  payment_method: "offline" | "stripe";
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  remaining: number | null;
  /** Spots already taken — drives the masthead capacity meter (v3/05 §2). */
  taken: number;
  open: boolean;
  /** 'window' | 'full' | 'payments_unavailable' | 'entry_kind_unavailable' | null */
  closed_reason: string | null;
  /** V364 first-class columns (RS006 W1), alongside the derived booleans
   *  below — the ENTRIES step badges these directly and runs the SAME
   *  category/age-band predicates (@/lib/registration-rules) to grey a
   *  self-ineligible division, rather than forking new rules client-side. */
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  /** RS007/V380 — the age-band cutoff override (default 1 January when
   *  null). Threaded onto the wire so the ENTRIES step's client-side self-
   *  check (`ageBandEligibilityIssues`, @/lib/registration-rules) evaluates
   *  the SAME cutoff the server enforces at submit — before this field
   *  existed here, the client silently defaulted to 1 January for every
   *  division, and would disagree with the server for any division with a
   *  real cutoff (the exact "two cutoffs disagree" defect V380 exists to
   *  kill, resurfaced client-side). */
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  /** Team-only; drives the ENTRIES step's free-agent option. */
  allow_free_agents: boolean;
  requires_dob: boolean;
  requires_gender: boolean;
  /** Youth division (v3/11 gap 8): the form always adds guardian consent. */
  youth: boolean;
  /** Queue length behind a full division (PROMPT-52) — public. */
  waitlisted: number;
  form_fields: RegistrationFormField[];
  /** RS007/V380 — the retired jsonb "custom rule" note, now a first-class
   *  `divisions` column the ENTRIES step renders as an organiser notice
   *  (design: "manual, shown as a warning" — components/public-site/
   *  register/division-card.tsx). Organiser-authored free text: render as
   *  TEXT, never as HTML/markdown. */
  eligibility_note: string | null;
  /** T16 (spec §5.4): the division plays online on Lichess — stated before signup, and only while the club is offered
   *  online chess (the same condition under which submit demands the Lichess link). */
  online_play: boolean;
  /** T16: the camera requirement a player signs up to — the division's own setting, else the competition's; `off`
   *  whenever `online_play` is false (no online play ⇒ no camera to require). A stage may still set its own. */
  camera_policy: CameraPolicy;
}

export interface PublicRegistrationInfoResult {
  competition: {
    id: string;
    name: string;
    slug: string;
    starts_on: string | null;
    ends_on: string | null;
  };
  org: { name: string; slug: string; logo_url: string | null };
  divisions: PublicDivisionInfo[];
}

/** The public register panel (superuser read; public/unlisted comps only). */
export async function publicRegistrationInfo(
  orgSlug: string,
  compSlug: string,
): Promise<PublicRegistrationInfoResult> {
  const [comp] = await sql<
    {
      id: string; name: string; slug: string; org_id: string; charges_enabled: boolean;
      starts_on: string | null; ends_on: string | null;
      org_name: string; logo_storage_path: string | null; logo_url: string | null;
      currency: string;
    }[]
  >`
    select c.id, c.name, c.slug, c.org_id, o.stripe_charges_enabled as charges_enabled,
           c.starts_on, c.ends_on,
           o.name as org_name, o.logo_storage_path, o.logo_url, o.currency
    from competitions c join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${compSlug}
      and c.visibility in ('public','unlisted') and o.status = 'active'`;
  if (!comp) throw new HttpError(404, "competition not found");

  const rows = await sql<
    (RegistrationSettingsRow & {
      name: string;
      slug: string;
      sport_key: string;
      // V364 first-class columns: `age_min`/`age_max` also drive
      // `requires_dob` below (a category-only division needs no DOB).
      // `category` drives `requires_gender` the same way, and both ship on
      // the wire (RS006 W1: the ENTRIES step badges category/age and greys
      // a self-ineligible division, so the client needs the raw values, not
      // just the derived booleans).
      category: string | null;
      age_min: number | null;
      age_max: number | null;
      age_cutoff_month: number | null;
      age_cutoff_day: number | null;
      youth: boolean;
      active: number;
      waitlisted: number;
      eligibility_note: string | null;
      config: unknown;
      module_version: string;
      division_camera_policy: unknown;
      competition_camera_policy: unknown;
    })[]
  >`
    select rs.*, d.name, d.slug, d.sport_key, d.category, d.age_min, d.age_max, d.youth,
           d.age_cutoff_month, d.age_cutoff_day,
           d.eligibility_note,
           d.config, d.module_version, d.camera_policy as division_camera_policy, c.camera_policy as competition_camera_policy,
           -- RS012 ruling 1: capacity/active counts TEAM entries only — a
           -- solo sign-up ("free agent") never occupies a team slot, here or
           -- at the submit-time gate this display must agree with
           -- (registration-submit.ts).
           (select count(*)::int from registrations r
             where r.division_id = rs.division_id
               and r.status in ${sql([...SPOT_HOLDERS])}
               and r.free_agent = false) as active,
           (select count(*)::int from registrations r
             where r.division_id = rs.division_id
               and r.status = 'waitlisted') as waitlisted
    from registration_settings rs
    join divisions d on d.id = rs.division_id
    join competitions c on c.id = d.competition_id
    where d.competition_id = ${comp.id} and rs.enabled
    order by d.name`;

  // Card intake also depends on the paid entitlement (P2-10): an org that
  // dropped to community (lost dispute, canceled sub, past_due grace expiry —
  // Task 9 resolves the last as community at read time) can still have OPEN
  // Stripe-fee divisions with Connect live. Scope by competition so an Event
  // Pass keeps THAT comp's paid intake open.
  const paidEntitled = await hasFeature(comp.org_id, "registration.paid", comp.id);

  // T16: online play is stated only while the club is offered online chess — asked once, and only when a division
  // could play online at all (a club with no online division asks PostHog nothing).
  const couldPlayOnline = rows.some(divisionPlaysOnline);
  const offered = couldPlayOnline && (await onlineChessOffered({ orgId: comp.org_id, userId: null }));
  const onlinePlay = (r: (typeof rows)[number]) => offered && divisionPlaysOnline(r);

  const now = new Date();
  const divisions: PublicDivisionInfo[] = rows.map((r) => {
    const remaining =
      r.capacity === null ? null : Math.max(0, r.capacity - r.active);
    // A card division can't take submissions when Connect is broken OR the
    // paid entitlement is gone — closing it with an honest reason beats
    // accepting money we can't keep (spec #9, P2-10).
    const paymentsBroken =
      r.payment_method === "stripe" && r.fee_cents > 0 &&
      (!comp.charges_enabled || !paidEntitled);
    // FU1 ruling 3: a stored kind the division does not take (a row saved before the check, or Entrant kinds narrowed
    // since) never opens to the public - submit would refuse every entry. Named first: it outlasts the window and payments.
    const kindTaken = divisionTakesKind(entrantShapeOf(r).kinds, r.entrant_kind);
    const open = kindTaken && windowOpen(r, now) && !paymentsBroken;
    let reason: string | null = open
      ? null
      : !kindTaken
        ? "entry_kind_unavailable"
        : paymentsBroken
          ? "payments_unavailable"
          : "window";
    if (open && remaining === 0) reason = "full"; // still open — joins the waitlist
    return {
      division_id: r.division_id,
      name: r.name,
      slug: r.slug,
      sport_key: r.sport_key,
      entrant_kind: r.entrant_kind,
      fee_cents: r.fee_cents,
      free_agent_fee_cents: r.free_agent_fee_cents,
      // Org-level (RS001b): every division on this panel quotes the same
      // currency, which is what makes a multi-division cart payable in one
      // Stripe session.
      currency: comp.currency,
      payment_method: r.payment_method,
      opens_at: r.opens_at ? new Date(r.opens_at).toISOString() : null,
      closes_at: r.closes_at ? new Date(r.closes_at).toISOString() : null,
      capacity: r.capacity,
      remaining,
      taken: r.active,
      open,
      closed_reason: reason,
      // V364 first-class columns (RS006 W1): raw values, so the ENTRIES step
      // can badge category/age and grey a self-ineligible division using the
      // SAME evaluation the server ships (@/lib/registration-rules), instead
      // of forking its own rules client-side.
      category: r.category,
      age_min: r.age_min,
      age_max: r.age_max,
      age_cutoff_month: r.age_cutoff_month,
      age_cutoff_day: r.age_cutoff_day,
      // Team-only (registration-eligibility's putRegistrationSettings rejects
      // `true` on a non-team division) — drives the ENTRIES step's free-agent
      // option (design §4 step 2).
      allow_free_agents: r.allow_free_agents,
      // V364/V380: a division requires a DOB when either first-class age
      // column is set.
      requires_dob: requiresDob({
        age_min: r.age_min,
        age_max: r.age_max,
      }),
      // Same idea as requires_dob, for gender (RS006 WHO step): a
      // mens/womens/mixed category, OR a free-text eligibility_note, which
      // after V380 is the only surviving channel for a restriction the
      // category enum cannot express. Passing the note is not optional: the
      // join-page preview (registration-submit.ts) already does, so omitting
      // it here would make the SAME division collect gender on one public
      // surface and not the other.
      requires_gender: requiresGender({ category: r.category, eligibility_note: r.eligibility_note }),
      youth: r.youth,
      waitlisted: r.waitlisted,
      form_fields: r.form_fields ?? [],
      eligibility_note: r.eligibility_note,
      online_play: onlinePlay(r),
      camera_policy: onlinePlay(r)
        ? effectivePolicy({
            stage: null,
            division: readCameraPolicy(r.division_camera_policy),
            competition: readCameraPolicy(r.competition_camera_policy),
          })
        : "off",
    };
  });
  return {
    competition: {
      id: comp.id,
      name: comp.name,
      slug: comp.slug,
      starts_on: comp.starts_on,
      ends_on: comp.ends_on,
    },
    org: {
      name: comp.org_name,
      slug: orgSlug,
      logo_url: resolveLogoUrl(comp.logo_storage_path, comp.logo_url),
    },
    divisions,
  };
}
