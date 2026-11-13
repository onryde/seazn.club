import "server-only";
// The group (cart) read model behind the /r/[ref] status page (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { entryPriceCents, isTerminalRegistrationStatus, ownPaymentRefundedCents } from "@/lib/registration-status";
import { entryReferenceOf } from "@/lib/ref-code";
import { resolveVenueTz } from "@/lib/tz";
import type { RegistrationSettingsRow, RegistrationRow, RegistrationGroupRow } from "./types";
import { loadSettings, DUMMY_ACCESS_HASH, tokenMatchesHash, typedReference, GROUP_ID_RE } from "./lookups";
import { type ResolvedRefundPolicy, resolveRefundPolicy } from "./refunds";
import { effectivePoolDeadline } from "./list";
import { waitlistPositionSql } from "./waitlist";
import { competitionVenueName, settlementsByRegistration, type SettledBy } from "./status-facts";

// ---------------------------------------------------------------------------
// Group read model — /r/[ref] status page, multi-entry (RS002 W5, RS007)
// ---------------------------------------------------------------------------

export interface GroupEntryPlayerView {
  id: string;
  full_name: string;
  consent_status: "pending" | "granted" | "guardian";
  /** RS008: this roster row's linked person's own consent — `null` when the
   *  row has no `person_id` yet (a captain-entered row nobody has claimed,
   *  and this entry has never been materialised — `materialise`/
   *  `joinExistingEntrant` are the only writers of `person_id`). The status
   *  page (`entry-card.tsx`) masks by youth alone in that case, via
   *  `resolvePersonDisplayName`'s own null-is-not-opted-out contract — never
   *  blocked on a person existing yet. */
  consent: { public_name?: boolean } | null;
}

export interface GroupEntryView {
  id: string;
  division_id: string;
  division_name: string;
  display_name: string;
  status: RegistrationRow["status"];
  amount_cents: number;
  free_agent: boolean;
  /** RS009 — the team an organiser placed this solo sign-up on, or null
   *  while still in the pool. Null on every non-solo-sign-up entry. This is
   *  what narrows RS008's `awaitingTeamAssignment`: `free_agent` records how
   *  the entry was MADE and never flips back, so on its own it would tell a
   *  placed player they are still waiting, forever. */
  assigned_team_name: string | null;
  /** RS012 — the effective place-by date for a solo sign-up STILL in the
   *  pool (division place_by_at, else its closes_at — Stage 2's sweep own
   *  fallback, not re-derived). Null once assigned (nothing left to warn
   *  about) and null on every non-solo-sign-up entry, mirroring
   *  assigned_team_name's own null convention. */
  pool_place_by_at: string | null;
  join_code: string | null;
  /** RS007: whether the GENERIC (no player_id) claim link is valid for this
   *  entry — false for a `pair` (its fixed two-person roster leaves no room
   *  for a new joiner; only its per-slot partner link is real), true
   *  otherwise. Irrelevant when `join_code` itself is null. */
  allows_new_joiner: boolean;
  /** REVIEW FIX (#10, "a lapse timer with no way to pay"): this entry's OWN
   *  division's payment method (registration_settings.payment_method) —
   *  never `GroupStatusView.payment_method` (the cart's shared envelope
   *  column). `promoteWaitlistedRow` only overwrites that shared column
   *  when no OTHER entry in the cart is still 'pending' (see its own doc
   *  comment), so it can stay null/stale forever past a promotion whose own
   *  division genuinely charges — resolveMoneyState (register/status/
   *  view-model.ts) reads THIS field now, per entry, so it can never be
   *  fooled by a sibling's stale write. */
  payment_method: "offline" | "stripe";
  /** Polish wave P3 (W2, W12): this entry's OWN division's review mode (`registration_settings.approval`). With the entry's status and
   *  fee it says what a not-yet-confirmed entry is WAITING ON (`entryWaitingOn`): the status page names it instead of a bare
   *  "pending". A division with no settings row reviews nothing by hand, the same default the submit path uses. */
  approval: "auto" | "manual";
  /** Polish wave P5 (W12): the organiser approved this entry while its fee was still owed (`approved_at`, V513), so it waits on payment
   *  alone - with `approval` it keeps the page from saying "awaiting approval" about an entry the organiser already said yes to. */
  approved: boolean;
  /** Polish wave P3 (W6): for a WAITLISTED entry, the fee a promotion would set (the division's own `fee_cents`, what
   *  `promoteWaitlistedRow` writes); `null` for every other entry (their own `amount_cents` is the figure). A waitlisted entry's stored
   *  fee is 0 by construction, so the Subtotal could only say "Free": this is what lets it say what is not yet due. */
  fee_if_promoted_cents: number | null;
  /** Registration redesign B3 T13: a WAITLISTED entry's 1-based place in its division's queue, null for every other entry. Counted in
   *  the order promotion takes the queue (`waitlistPositionSql`, registrations/waitlist.ts), the same place the organiser list, the
   *  public status API and the confirmation mail state. */
  waitlist_position: number | null;
  /** V378/RS007: this entry's OWN pay-by deadline when it was promoted out
   *  of the waitlist — null for a never-promoted entry, whose deadline is
   *  the CART's own `GroupStatusView.expires_at` instead (see
   *  `promoteWaitlistedRow`'s doc comment for why one shared column cannot
   *  serve both). The status page resolves `promotion_expires_at ??` the
   *  cart's `expires_at`, mirroring the sweep's identical fallback. */
  promotion_expires_at: string | null;
  /** RS008: this entry's OWN division's youth/player_name_display policy —
   *  `entry-card.tsx` needs it per entry (never a cart-wide value) because a
   *  cart can span a youth division and a non-youth one at once, same reason
   *  `refund_policy`/`payment_method` are already resolved per entry rather
   *  than inherited from the cart. Threaded down (not pre-masked here)
   *  because a per-player consent opt-out must combine with it — see
   *  `GroupEntryPlayerView.consent`. */
  division_youth: boolean;
  division_player_name_display: string | null;
  /** RS008 review fix #1: the entry-card HEADING's own consent rule — a
   *  `team`'s declared name never takes the consent axis, but an
   *  `individual`/`pair`'s `display_name` IS a person's (or a pair's
   *  compound) name. Sourced from `entrantKindByDivision` below (the SAME
   *  map `allows_new_joiner` already reads), never a second lookup. */
  entrant_kind: "team" | "individual" | "pair";
  players: GroupEntryPlayerView[];
  /** V379/RS007: this entry's own resolved refund policy — so the status
   *  page can tell a registrant which side of the line they are on BEFORE
   *  they confirm a cancel. Same rule `withdrawCore`'s auto-refund uses
   *  (see `resolveRefundPolicy`) — the status page's cancel-confirm copy
   *  reads this directly rather than re-deriving it. */
  refund_policy: ResolvedRefundPolicy;
  /** Polish wave sign-off V6: everything sent back to the registrant for THIS entry (a withdrawal's or rejection's auto-refund, an
   *  organiser's Refund, a late payment's refund) - the entry's `refunded_cents`, never the cart's. The status card names it, so a
   *  rejected entry whose fee came back says so instead of reading only "Rejected". */
  refunded_cents: number;
  /** Registration redesign B4 T14: how THIS entry's fee was settled — "card", "offline" (Mark paid), "waived" (Confirm without
   *  payment), or null when nothing settled it. History, not status: it outlives a refund (`refunded_cents`) and a withdrawal.
   *  A waived entry keeps its `amount_cents`, so it must count as neither paid nor due. Derived in ./status-facts.ts (the
   *  contract T15 renders is documented at its top). */
  settled_by: SettledBy | null;
  /** Registration redesign B5 T18 (spec §6.2, §6.3): the reference to quote for THIS entry (`entryReferenceOf`, lib/ref-code.ts): the cart's
   *  `SZ-XXXX-XXXX` with the entry's place in the cart (`-2`) when the cart was sent with two or more entries, the cart's alone for a
   *  one-entry cart. Null only when the cart has no reference at all (`GroupStatusView.ref_code`). Fixed at submit: a withdrawal or a
   *  deleted sibling never changes it. The card prints it only in a 2+ cart (`cardEntryReference`, register/status/view-model.ts). */
  entry_ref: string | null;
}

/** The whole cart, for the status page (design §4 step 6; RS007 builds the
 *  endpoint). Group-level sibling of `PublicStatusView` (one entry). Every
 *  field here is token-gated (see `groupByRef`), so — unlike the token-less
 *  `PublicRefView` — names are NOT masked: whoever holds the access token is
 *  the registrant (or someone they chose to share the link with), not the
 *  general public `/r/[ref]` serves. */
export interface GroupStatusView {
  /** Review fix (RS007): genuinely nullable — unlike `PublicRefView`/
   *  `PublicCartView` above (both resolved BY `ref_code`, so a match
   *  guarantees non-null), this view is also reachable via `groupById`,
   *  which is keyed on the group's always-present DB id specifically
   *  BECAUSE a submit whose ref-mint retries were exhausted still commits
   *  the cart with `ref_code: null` (see that function's own doc comment).
   *  The two current consumers (`fillPaymentInstructions`'s `reference`
   *  param, and a bare JSX `{view.ref_code}`) already tolerate null. */
  ref_code: string | null;
  /** Registration redesign B5 T18: how many entries the cart was SENT with (`registration_groups.cart_size`, V519): every entry whatever its
   *  status now, never less after a withdrawal or a deleted division. It decides whether the page speaks of per-entry references at all
   *  (`cardEntryReference`), never a count of `entries`. */
  cart_size: number;
  contact_name: string;
  /** Registration redesign B4 T15: the address the cart's confirmation mail went to (queued at submit), for the page's "Confirmation
   *  sent to {email}." Token-gated like every field here; the token-less `PublicCartView` never carries it. */
  contact_email: string;
  currency: string;
  amount_cents: number;
  payment_method: "offline" | "stripe" | null;
  expires_at: string | null;
  refunded_cents: number;
  competition_name: string;
  /** Registration redesign B4 T14: the competition's own dates, 'YYYY-MM-DD' (`date` columns, kept as plain strings), null when
   *  unset. `ends_on` may equal `starts_on` (a one-day event). */
  competition_starts_on: string | null;
  competition_ends_on: string | null;
  /** Registration redesign B4 T14 (spec §5.2, FP1): the one venue every placed fixture of a PUBLISHED division shares, else null
   *  (no fixtures, two or more venues, or only draft schedules). `competitionVenueName`, ./status-facts.ts. */
  venue_name: string | null;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  created_at: string;
  /** RS007: whether the org's Connect account can currently take a payment —
   *  gates the status page's "pay now" CTA so it never renders a button that
   *  `resumeRegistrationCheckout` would just 503. Resolved off the first
   *  entry that still carries a fee (else the first entry), mirroring
   *  `buildCartMail`'s identical "one division is representative of the
   *  whole cart" simplification (a cart's paid divisions already agree on
   *  payment_method at submit — `assertUniformPaymentMethod`). */
  charges_enabled: boolean;
  /** RS007: the resolved offline instructions ({{reference}} left
   *  un-substituted — the page fills it in with the reference the entry due
   *  quotes: that entry's own when exactly one is due, the cart's ref_code
   *  otherwise; `offlineInstructionsReference`, status/view-model.ts),
   *  division override falling back to the org's, or null for a
   *  stripe-method cart. Same resolution order `buildCartMail`'s email
   *  uses, so the page and the confirmation email never disagree about what
   *  a registrant is told to do. */
  payment_instructions: string | null;
  /** REVIEW FIX (#13a): the org's own scheduling timezone, resolved exactly
   *  once (`resolveVenueTz`, same call already used for `refund_policy`
   *  below — no second resolution to drift from it) and always a valid IANA
   *  zone (falls back to "UTC", never null) — entry-card.tsx renders every
   *  pay-by deadline in THIS zone, with a zone label, instead of the
   *  hardcoded UTC it used to. */
  org_timezone: string;
  entries: GroupEntryView[];
}

/**
 * The whole cart by its human-quotable ref (design §4 step 6) — the
 * multi-entry status page RS007 builds on. Unlike `publicRegistrationStatusByRef`
 * (token OPTIONAL, gates only `can_withdraw`), the access token is REQUIRED
 * here: a cart can list every entry and every player in it, more than the
 * general public should ever see off a bare ref. A wrong token and a
 * nonexistent ref throw the identical generic 404 (never "ref not found" vs
 * "wrong token") and cost the same (`tokenMatchesHash` always runs, even with
 * no real hash to compare), so neither the error shape nor the response
 * timing discloses whether the ref exists.
 */
export async function groupByRef(ref: string, accessToken: string): Promise<GroupStatusView> {
  const notFound = () => new HttpError(404, "registration not found");
  const { canonical, position } = typedReference(ref);
  const [found] = await sql<RegistrationGroupRow[]>`
    select * from registration_groups where ref_code = ${canonical}`;
  // An entry number the cart was never sent with (B5 T18 review m1) is no cart at all: the same dummy-hash compare and the same 404 as an
  // unknown reference, so the number is no oracle on how many entries a cart has.
  const group = found && (position === null || position <= found.cart_size) ? found : undefined;
  return buildGroupStatusView(group, accessToken, notFound);
}

/**
 * The whole cart by its DB id (RS006 §C) — the shape the post-submit status
 * page actually navigates to (`?rid=<group_id>&token=...`), matching the
 * SAME convention `buildCartMail`'s statusUrl and
 * `createRegistrationCheckout`'s Stripe success/cancel URLs already mint.
 * Keyed on `id` rather than `ref_code` deliberately: `ref_code` is nullable
 * on the schema (a submit whose ref-mint retries were exhausted still
 * commits the cart — see `submitRegistrationGroup`), so a status link built
 * right after submit needs the ALWAYS-present primary key, not the
 * sometimes-absent human-quotable one. Same token-gate contract as
 * `groupByRef` (see that function's own doc comment for the three security
 * claims): a wrong token and a nonexistent id are indistinguishable, and a
 * malformed id string 404s cleanly rather than reaching the DB as invalid
 * `uuid` input syntax.
 */
export async function groupById(id: string, accessToken: string): Promise<GroupStatusView> {
  const notFound = () => new HttpError(404, "registration not found");
  if (!GROUP_ID_RE.test(id)) throw notFound();
  const [group] = await sql<RegistrationGroupRow[]>`
    select * from registration_groups where id = ${id}`;
  return buildGroupStatusView(group, accessToken, notFound);
}

/** Shared by `groupByRef`/`groupById` once each has resolved its own
 *  candidate row (or none) by its own key — token-checks it and, on success,
 *  assembles the full `GroupStatusView` (competition/org context, entries,
 *  players). Kept as ONE function so the token-gate's timing/shape
 *  guarantees (see `groupByRef`'s doc comment) and the entries/players
 *  assembly can never drift between the two lookup paths. */
async function buildGroupStatusView(
  group: RegistrationGroupRow | undefined,
  accessToken: string,
  notFound: () => HttpError,
): Promise<GroupStatusView> {
  const tokenOk = tokenMatchesHash(accessToken, group?.access_token_hash ?? DUMMY_ACCESS_HASH);
  if (!group || !tokenOk) throw notFound();

  const [comp] = await sql<
    {
      comp_name: string; comp_slug: string; org_slug: string; org_name: string;
      starts_on: string | null; ends_on: string | null; charges_enabled: boolean; org_payment_instructions: string | null;
      org_timezone: string | null;
    }[]
  >`
    select c.name as comp_name, c.slug as comp_slug, o.slug as org_slug, o.name as org_name,
           c.starts_on, c.ends_on, o.stripe_charges_enabled as charges_enabled,
           o.payment_instructions as org_payment_instructions, o.timezone as org_timezone
    from competitions c join organizations o on o.id = c.org_id
    where c.id = ${group.competition_id}`;
  // RS007: same org-only governing clock resolveRefundPolicy's own doc
  // comment requires — resolved ONCE for the whole group (never per
  // division), since `starts_on` is this ONE competition's field.
  const refundTz = resolveVenueTz(null, comp?.org_timezone ?? null);

  const entries = await sql<
    (Omit<
      GroupEntryView,
      | "players"
      | "refund_policy"
      | "promotion_expires_at"
      | "allows_new_joiner"
      | "payment_method"
      | "pool_place_by_at"
      | "approval"
      | "fee_if_promoted_cents"
      | "settled_by"
      | "entry_ref"
    > & {
      /** V519: read to make `entry_ref`, then destructured OUT below (the view carries the reference, not the number). */
      cart_position: number;
      refunded_cents: number;
      late_refunded_cents: number;
      promotion_expires_at: Date | null;
      /** V387/H1 — read to resolve THIS entry's refund policy, then
       *  destructured OUT below so it never reaches the public view: a
       *  Stripe intent id is not something a status page hands to whoever
       *  holds the link. */
      entry_payment_intent_id: string | null;
    })[]
  >`
    select r.id, r.division_id, d.name as division_name, r.display_name, r.status, r.cart_position,
           r.amount_cents, r.refunded_cents, r.late_refunded_cents, r.free_agent, r.join_code, r.promotion_expires_at,
           r.payment_intent_id as entry_payment_intent_id, r.approved_at is not null as approved,
           d.youth as division_youth, d.player_name_display as division_player_name_display,
           ${waitlistPositionSql(sql, "r")} as waitlist_position,
           -- RS009: the team an organiser placed this solo sign-up on, or
           -- null while they are still in the pool. free_agent records how
           -- the entry was MADE and never flips back, so it cannot answer
           -- this on its own -- which is exactly what RS008 handed over in
           -- awaitingTeamAssignment's doc comment.
           (select tgt.display_name from registration_players rp
             join registrations tgt on tgt.id = rp.registration_id
             where rp.assigned_from_registration_id = r.id) as assigned_team_name
    from registrations r join divisions d on d.id = r.division_id
    where r.group_id = ${group.id}
    order by r.created_at, r.id`;

  // refund_lock_at, entrant_kind and payment_method are all DIVISION
  // settings (registration_settings), so a cart spanning more than one
  // division can genuinely have one entry refundable and another not
  // (V379/RS007), one entry a team and another a pair, or (REVIEW FIX #10)
  // one entry billed via Stripe and another offline. Batched by distinct
  // division_id, the same way `players` batches by entries.map(id) below —
  // one query, not one per entry. Moved ABOVE the payment-instructions block
  // below (it used to run after) so that block can resolve off the SAME
  // division-sourced map instead of the cart's own (sometimes stale/null)
  // `payment_method` column — see paymentMethodByDivision's own comment.
  const divisionIds = [...new Set(entries.map((e) => e.division_id))];
  const settingsRows =
    divisionIds.length > 0
      ? await sql<
          {
            division_id: string;
            refund_lock_at: Date | null;
            entrant_kind: RegistrationSettingsRow["entrant_kind"];
            payment_method: RegistrationSettingsRow["payment_method"];
            place_by_at: Date | null;
            closes_at: Date | null;
            approval: RegistrationSettingsRow["approval"];
            fee_cents: number;
            free_agent_fee_cents: number | null;
          }[]
        >`
          select division_id, refund_lock_at, entrant_kind, payment_method, place_by_at, closes_at, approval, fee_cents,
                 free_agent_fee_cents
          from registration_settings
          where division_id in ${sql(divisionIds)}`
      : [];
  const refundLockByDivision = new Map(settingsRows.map((s) => [s.division_id, s.refund_lock_at]));
  // RS012 stage 3b: the SAME `coalesce(place_by_at, closes_at)` fallback
  // Stage 2's own sweep pass already uses (this file's pool-deadline pass) —
  // not re-derived, so the status page's "by when" line can never disagree
  // with the deadline that actually enforces it.
  const poolPlaceByDivision = new Map(
    settingsRows.map((s) => [
      s.division_id,
      // RS012 `/code-review high` finding 2 — the ONE `effectivePoolDeadline`
      // copy (beside rosterCapExpr, this file). Both inputs here are
      // Date | null (settingsRows' own column types), so the cast just
      // narrows the helper's broader Date | string | null return back to
      // what this Map's downstream `.toISOString()` reader needs.
      effectivePoolDeadline(s.place_by_at, s.closes_at) as Date | null,
    ]),
  );
  // A pair's roster is fixed at exactly two (registration-submit.ts's own
  // structural check + rosterIssues at submit) — its join_code only ever
  // lets the PARTNER claim their already-typed-in slot; `joinTeamEntry`
  // 422s a pair's insert-a-new-person path outright. Unknown (a division
  // whose settings row is somehow missing) fails toward showing the link
  // rather than hiding a legitimate one — a UX dead end the join route's own
  // "defense in depth" 422 already catches safely, never a money/auth risk.
  const entrantKindByDivision = new Map(settingsRows.map((s) => [s.division_id, s.entrant_kind]));
  // REVIEW FIX (#10): the DIVISION's own payment method — never
  // GroupStatusView.payment_method (group.payment_method, the cart's shared
  // envelope column). promoteWaitlistedRow only writes that shared column
  // when no OTHER entry in the cart is still 'pending' (see its own doc
  // comment), so it can stay null/stale forever past a promotion whose own
  // division genuinely charges. resolveMoneyState (view-model.ts) reads
  // this per entry now. Falls back to 'offline' only when the settings row
  // itself is missing — same convention promoteWaitlistedRow's own `method`
  // already uses.
  const paymentMethodByDivision = new Map(settingsRows.map((s) => [s.division_id, s.payment_method]));
  // Polish wave P3: the DIVISION's review mode and fee, per entry, for the same reason as the method above: a cart can span divisions.
  const approvalByDivision = new Map(settingsRows.map((s) => [s.division_id, s.approval]));
  const priceByDivision = new Map(settingsRows.map((s) => [s.division_id, s]));

  // RS007: the resolved offline payment instructions — mirrors
  // buildCartMail's own "first entry that still carries a fee is
  // representative of the whole cart" rule exactly, so the status page and
  // the confirmation email never disagree. Division override, else the
  // org's own (already fetched above, no extra query for that half).
  //
  // REVIEW FIX (#10): gated on the representative entry's own DIVISION
  // method (paymentMethodByDivision) rather than group.payment_method —
  // same fix, same reason, as resolveMoneyState's own: the cart's shared
  // column can be null/stale past exactly the promotion this resolves
  // instructions for.
  let paymentInstructions: string | null = null;
  if (entries.length > 0) {
    const firstPaid = entries.find((e) => e.amount_cents > 0) ?? entries[0]!;
    if ((paymentMethodByDivision.get(firstPaid.division_id) ?? "offline") === "offline") {
      const repSettings = await loadSettings(sql, firstPaid.division_id);
      paymentInstructions = repSettings?.payment_instructions ?? comp?.org_payment_instructions ?? null;
    }
  }

  // RS008: LEFT JOIN persons (never inner) — a captain-entered row nobody
  // has claimed, on an entry that has never been materialised, has no
  // `person_id` yet at all (materialise()/joinExistingEntrant are the only
  // writers of it). That row still belongs on the roster list; it just has
  // nothing to mask by consent — `person_consent` reads null, and
  // `resolvePersonDisplayName` already treats null as "not opted out",
  // masking by division youth policy alone.
  const players =
    entries.length > 0
      ? await sql<
          (Omit<GroupEntryPlayerView, "consent"> & {
            registration_id: string;
            person_consent: { public_name?: boolean } | null;
          })[]
        >`
          select rp.id, rp.registration_id, rp.full_name, rp.consent_status,
                 p.consent as person_consent
          from registration_players rp
          left join persons p on p.id = rp.person_id
          where rp.registration_id in ${sql(entries.map((e) => e.id))}
          order by rp.created_at`
      : [];
  // Registration redesign B4 T14: the venue line and each entry's settlement (./status-facts.ts), two independent reads.
  const [venueName, settledByEntry] = await Promise.all([
    competitionVenueName(group.competition_id),
    settlementsByRegistration(group.competition_id, entries.map((e) => e.id)),
  ]);

  const playersByEntry = new Map<string, GroupEntryPlayerView[]>();
  for (const p of players) {
    const list = playersByEntry.get(p.registration_id) ?? [];
    list.push({
      id: p.id,
      full_name: p.full_name,
      consent_status: p.consent_status,
      consent: p.person_consent,
    });
    playersByEntry.set(p.registration_id, list);
  }

  return {
    // Review fix (RS007): was `group.ref_code!` — see GroupStatusView's own
    // doc comment for why that was a lie (groupById reaches rows where this
    // is genuinely null).
    ref_code: group.ref_code,
    cart_size: group.cart_size,
    contact_name: group.contact_name,
    contact_email: group.contact_email,
    currency: group.currency,
    amount_cents: group.amount_cents,
    payment_method: group.payment_method,
    expires_at: group.expires_at ? new Date(group.expires_at).toISOString() : null,
    refunded_cents: group.refunded_cents,
    competition_name: comp?.comp_name ?? "",
    competition_starts_on: comp?.starts_on ?? null,
    competition_ends_on: comp?.ends_on ?? null,
    venue_name: venueName,
    competition_slug: comp?.comp_slug ?? "",
    org_slug: comp?.org_slug ?? "",
    org_name: comp?.org_name ?? "",
    created_at: new Date(group.created_at).toISOString(),
    charges_enabled: comp?.charges_enabled ?? false,
    payment_instructions: paymentInstructions,
    org_timezone: refundTz,
    entries: entries.map(({ cart_position, refunded_cents, late_refunded_cents, promotion_expires_at, entry_payment_intent_id, ...e }) => ({
      ...e,
      // B5 T18: the cart's STORED size (`group.cart_size`), never `entries.length`: this list may be short of what the cart was sent with.
      entry_ref: entryReferenceOf({ ref_code: group.ref_code, cart_position, cart_size: group.cart_size }),
      refunded_cents,
      promotion_expires_at: promotion_expires_at ? new Date(promotion_expires_at).toISOString() : null,
      allows_new_joiner: entrantKindByDivision.get(e.division_id) !== "pair",
      // Unknown (a division whose settings row is somehow missing) fails
      // toward "individual" — the masked side of the bypass — matching this
      // review's own "a privacy control fails CLOSED, not open" rule (#8),
      // not the "fails toward showing a legitimate link" bias
      // allows_new_joiner uses just above (a UX dead end vs. a privacy leak
      // are not the same risk, and do not share a default).
      //
      // Post-visual-check fix (free-agent gap, RS008.1): a free agent's
      // division-level entrant_kind is "team" (allow_free_agents requires
      // it), but they are one real person, not a team — entryDisplayName
      // (view-model.ts) treats "team" as the unmasked-name bypass, so
      // without this guard a free agent on a youth division rides that
      // bypass and prints their raw name right above their own masked
      // roster row.
      entrant_kind: e.free_agent ? "individual" : (entrantKindByDivision.get(e.division_id) ?? "individual"),
      payment_method: paymentMethodByDivision.get(e.division_id) ?? "offline",
      approval: approvalByDivision.get(e.division_id) ?? "auto",
      // A waitlisted entry only: a promotion sets the entry's fee to what IT costs on its division (`promoteWaitlistedRow`, a solo
      // sign-up's own price - final review m3). Unknown (no settings row) reads as no fee to quote.
      fee_if_promoted_cents: e.status === "waitlisted" ? entryPriceCents(priceByDivision.get(e.division_id), e.free_agent) : null,
      // RS012 stage 3b, widened by a later `/code-review high` finding:
      // awaitingTeamAssignment (view-model.ts) ALSO requires the entry not
      // be in a terminal status (withdrawn/rejected/expired) — added there
      // after the walkthrough caught a withdrawn entry still reading as
      // "waiting". This field originally omitted that third check (masked
      // only because its one consumer, poolPlaceByDate, re-derives via the
      // guarded predicate and discards it for terminal entries) — matched
      // here now so a future direct consumer of this raw field (export,
      // admin view, a new API surface) can never show a live refund-by date
      // on an already-withdrawn/rejected/expired solo sign-up. Inlined
      // rather than imported: this is a plain data-assembly function with no
      // dependency on the view-model file, matching this codebase's
      // layering direction.
      pool_place_by_at:
        e.free_agent && !e.assigned_team_name && !isTerminalRegistrationStatus(e.status)
          ? (poolPlaceByDivision.get(e.division_id)?.toISOString() ?? null)
          : null,
      players: playersByEntry.get(e.id) ?? [],
      settled_by: settledByEntry.get(e.id) ?? null,
      refund_policy: resolveRefundPolicy(
        refundLockByDivision.get(e.division_id) ?? null,
        comp?.starts_on ?? null,
        refundTz,
        // REVIEW FIX (money-path defect #1): group.payment_intent_id is the
        // CART's charge — every entry in a multi-entry cart shares one, but
        // only the entries actually named in the checkout session that
        // produced it were ever charged. A promoted-but-unpaid sibling
        // ('pending', never itself billed) must never inherit a PAID
        // sibling's payment_intent_id here — that reads as "refundable" and
        // withdrawCore below would run a REAL Stripe refund against money
        // this entry's registrant never paid. 'paid'/'confirmed' are the
        // only statuses a Stripe checkout webhook (confirmPaidRegistration)
        // ever leaves an entry in — see the block comment there.
        // V387/H1: the ENTRY's own intent (read side twin of withdrawCore's
        // fix). The cart's is last-writer-wins and, on a cart paid in two
        // sessions, belongs to a sibling — so using it here would show a
        // registrant "you will be refunded automatically" for a charge that
        // is not theirs. Null reads as not-automatically-refundable, which
        // is the honest answer when we cannot name this entry's charge.
        e.status === "paid" || e.status === "confirmed" ? entry_payment_intent_id : null,
        e.amount_cents,
        // Polish wave P5 (carry b), the read twin of withdrawCore's: what was sent back of THIS payment, not the history.
        ownPaymentRefundedCents({ refunded_cents, late_refunded_cents }),
      ),
    })),
  };
}
