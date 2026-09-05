// The registration layer's runner + funnel oracle (B03r tasks 5+6, design
// §3 entry modes, §4 organiser action order, §5.2 funnel oracle). Sits on
// top of `drivers/types.ts`'s `Organiser`/`Captain`/`Player` interfaces
// (already built, B03r task 4) — this file owns resolving a pack's
// `PackRegistrationBlock`/`PackRegistrationEntry`/refs into the concrete,
// wire-ready shapes those interfaces take, exactly as `drivers/types.ts`'s
// own header comment says it would.
//
// Two corrections from `B03r-repins-2026-09-03.md`, both load-bearing here:
//
//   FP6 — `paid_cents` must NEVER sum `registration_groups.amount_cents`
//   (a submit-time snapshot the payment path never writes — see
//   `evaluateFunnel`'s own doc comment). Summing it would read GREEN
//   HARDEST when payment is broken.
//
//   C2 — `gateRosterEligibility` ("ELIGIBILITY_VIOLATION") is reachable
//   only from entrant creation (`usecases/entrants.ts:203`) and fixture
//   generation (`usecases/fixtures.ts:360`) — both B04 territory, neither
//   reachable from approve/reject/promote/assign. So `FunnelResult` can
//   only ever prove the PUBLIC-SUBMIT half of design §5.2's eligibility
//   gate; `organiserForceEligibilityProven` is permanently `false` in this
//   file, and a report consuming it must render that as "unproven", never
//   as passed. Asserting a branch nothing can reach is exactly the
//   vacuous-gate class this repo keeps shipping.
import type {
  Captain,
  ConsentInput,
  EntryOutcomeStatus,
  JoinEntry,
  Organiser,
  OrganiserActionKind,
  Player,
  RegistrationContact,
  RegistrationDivisionTarget,
  RegistrationEntry,
  RegistrationPlayer,
} from "./drivers/types.ts";
import type { PackPerson, PackRegistrationBlock, PackRegistrationEntry } from "./pack-schema.ts";

// ---------------------------------------------------------------------------
// Mode resolution (design §3, B03r task 5)
// ---------------------------------------------------------------------------

/** `divisions[].entry` / the CLI's resolved per-division mode. */
export type EntryMode = "admin" | "registration-api" | "registration-ui";

/** The `--entry` CLI flag's own vocabulary — deliberately narrower than
 *  `EntryMode`: a caller says "registration" (the intent), never
 *  "registration-api" directly, because which concrete mode that resolves
 *  to depends on the suite (see `resolveEntryMode` below). */
export type CliEntryFlag = "admin" | "registration";

/**
 * B16's suite-13 pack key (`bench-prompts/B16-pack-club-open.md` §1: "Pack
 * `scripts/bench/packs/club-open.json`" — a pack's own `suite` field
 * matches its filename, `pack-schema.ts`'s header comment). This is the ONE
 * suite key `--entry registration` does not resolve to `registration-api`
 * (design §3: "resolves to `registration-api` for suites 1–12 and leaves
 * suite 13 on `registration-ui`").
 *
 * Suite 13 does not exist yet — B16 builds it. Declared here, not guessed
 * at call sites, so the moment `club-open.json` lands this resolver is
 * already correct for it; nothing in B16 needs to touch this file.
 */
export const SUITE_13_KEY = "club-open";

/**
 * `--entry` overrides EVERY division of EVERY selected suite (design §3),
 * regardless of what the pack itself declared:
 *
 *  - no flag (`cliEntry === undefined`): the division's own declared
 *    `entry` wins, untouched.
 *  - `--entry admin`: every division becomes `"admin"` — suite 13
 *    INCLUDED. Design names no exception for this direction (only the
 *    `registration` direction gets one), so a suite-13 division forced to
 *    `admin` is intended, not a bug.
 *  - `--entry registration`: `"registration-api"` for every suite except
 *    suite 13 (`SUITE_13_KEY`), which stays `"registration-ui"` — design's
 *    one named exception, and the only reason this function needs
 *    `suiteKey` as an input at all.
 *
 * `declaredEntry` is intentionally unused on the `admin`/`registration`
 * branches: the CLI flag is a full override, not a merge with the pack's
 * own declaration.
 */
export function resolveEntryMode(declaredEntry: EntryMode, suiteKey: string, cliEntry: CliEntryFlag | undefined): EntryMode {
  if (cliEntry === undefined) return declaredEntry;
  if (cliEntry === "admin") return "admin";
  return suiteKey === SUITE_13_KEY ? "registration-ui" : "registration-api";
}

// ---------------------------------------------------------------------------
// Deterministic synthetic email (mirrors seed.ts's officialInviteEmail —
// PackPerson carries no email field, same gap PackOfficial has, same fix)
// ---------------------------------------------------------------------------

/**
 * `PackPerson` (pack-schema.ts) has no `email` field, but public submit's
 * `contact.email` is required. Mirrors `officialInviteEmail`
 * (`seed.ts:805-808`) exactly — a deterministic, collision-free address per
 * entry per run, never a real credential. Keyed on the ENTRY's `extKey`
 * rather than the captain's person `ref`: one person can captain divisions
 * in more than one entry (design §5 "a few persons play two divisions"),
 * and each entry is its own cart with its own contact.
 */
export function captainEmail(entryExtKey: string, runTag: string): string {
  const safe = entryExtKey.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `bench-captain-${safe}-${runTag}@example.com`;
}

function toRegistrationPlayer(person: PackPerson, isCaptain: boolean): RegistrationPlayer {
  return {
    fullName: person.fullName,
    dob: person.dob ?? null,
    gender: person.gender ?? null,
    isCaptain,
  };
}

/** Mirrors `isMinor`/`ageAt` (apps/web/src/lib/registration-rules.ts:56-68)
 *  IDENTICALLY to `validate-pack.ts`'s own `isMinorAt` — this file cannot
 *  import `apps/web` from PRODUCTION code either (same constraint,
 *  `validate-pack.ts:153`'s comment). Whole years between `dob` and `now`,
 *  decremented if `now` falls before the birthday; a missing dob is never
 *  passed here (callers guard it), unlike `validate-pack.ts`'s version
 *  which tolerates one because it also runs over roster members that may
 *  have none. */
function isMinorAt(dob: string, now: Date): boolean {
  const born = new Date(`${dob}T00:00:00Z`);
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age < 18;
}

/**
 * Resolves one `PackRegistrationEntry` + the division's `PackRegistrationBlock`
 * into a wire-ready `RegistrationEntry` for `Captain.enter()`.
 *
 * KNOWN GAP (recorded, not silently guessed): `PackRegistrationEntry` has
 * no `freeAgent` field — design §5's suite-13 table needs one ("6 pairs + 2
 * free agents") but B02's pre-freeze reservation never declared it. Every
 * entry built here is therefore `freeAgent: false`; a pack wanting a real
 * free-agent entry needs a PackSchema addition, which is a B16-owned
 * escalation, not this task's to invent. `answers` is likewise never set —
 * no pack field carries division custom-question answers either.
 *
 * LIVE-CRASH FIX (B03r-repins-2026-09-03.md dispatch, "fix a live-only
 * crash in the registration runner"): this function used to set
 * `registeringSelf: true` unconditionally for every individual entry with
 * no guardian fields ever set, and `contact.dob` could be null. Against a
 * real server that is a guaranteed 400 (`PublicRegisterGroupRequest`'s
 * superRefine 400s ANY self-registering entry lacking `contact.dob`) or a
 * 422 (registration-submit.ts 422s a self-registering MINOR with no
 * guardian consent/name) — caught only by a live run, never by a unit
 * suite that never called this function at all.
 *
 * `now` is a required parameter, never `new Date()` called in here directly
 * — same reason `validatePack` computes it ONCE and threads it down
 * (`checkJoinConsentMatchesMinority`'s own doc comment): every entry in one
 * run is judged against the same instant, and a test can pin an exact date
 * instead of racing the wall clock.
 */
export function buildRegistrationEntry(
  entry: PackRegistrationEntry,
  block: PackRegistrationBlock,
  personsByRef: ReadonlyMap<string, PackPerson>,
  runTag: string,
  now: Date,
): RegistrationEntry {
  const captain = personsByRef.get(entry.captain);
  if (captain === undefined) {
    throw new Error(`buildRegistrationEntry(): entry "${entry.extKey}" captain ref "${entry.captain}" not found in pack.persons`);
  }
  const roster = entry.roster.map((ref) => {
    const person = personsByRef.get(ref);
    if (person === undefined) {
      throw new Error(`buildRegistrationEntry(): entry "${entry.extKey}" roster ref "${ref}" not found in pack.persons`);
    }
    return person;
  });

  const contact: RegistrationContact = {
    name: captain.fullName,
    email: captainEmail(entry.extKey, runTag),
    dob: captain.dob ?? null,
    gender: captain.gender ?? null,
  };

  if (block.entrantKind === "individual") {
    // A single-player entry: the captain IS the entrant. `registeringSelf`
    // lets the server default `selfPlayerIndex` to 0 (`RegistrationEntry`'s
    // own doc comment) rather than this file re-deriving that default.
    //
    // Guardian fields (LIVE-CRASH FIX, see this function's own doc comment
    // above): a missing dob is treated as adult, never as its own
    // violation here — same convention `isMinorAt`'s callers use elsewhere
    // in this codebase (`joinTeamEntry`'s guardian gate itself does the
    // same, registration-submit.ts:1215) — because the OFFLINE stage-0
    // check (`validate-pack.ts`'s widened `checkRegistrationRequiresDobGender`)
    // is what is supposed to catch a missing dob before this ever runs; a
    // pack that slipped past stage-0 anyway still gets an honest (if
    // dob-less) request here rather than this function inventing a value.
    const minor = captain.dob != null && isMinorAt(captain.dob, now);
    return {
      contact: minor ? { ...contact, guardianConsent: true, guardianName: `${captain.fullName}'s guardian` } : contact,
      privacyConsent: true,
      entrantKind: "individual",
      players: [toRegistrationPlayer(captain, true)],
      registeringSelf: true,
    };
  }

  const allPersons = [captain, ...roster];
  return {
    contact,
    privacyConsent: true,
    entrantKind: block.entrantKind,
    teamName: block.entrantKind === "team" ? `Team ${entry.extKey}` : undefined,
    partnerName: block.entrantKind === "pair" ? roster[0]?.fullName : undefined,
    freeAgent: false,
    // `registeringSelf` deliberately left UNSET here (LIVE-CRASH FIX
    // dispatch, "consider whether registeringSelf should be unconditionally
    // true at all"): `entry.captain` means "the person entering this
    // team/pair", not "the contact wants to be linked as one of the
    // roster's own player rows" — `PackRegistrationEntry` has no field
    // expressing that second, DIFFERENT intent for team/pair kinds. An
    // individual entry's sole player IS the contact by construction (no
    // such ambiguity is possible); a team/pair's roster is not. Claiming
    // registeringSelf:true here without a pack field to back it would (a)
    // require a dob the pack never promised for this kind and (b) silently
    // link the contact to a player row the pack never asked for.
    players: allPersons.map((person) => toRegistrationPlayer(person, person.ref === entry.captain)),
  };
}

// ---------------------------------------------------------------------------
// Organiser action ordering (design §4: "organiser actions in pack order",
// D4 "promote re-runs pay() for the promoted captain")
// ---------------------------------------------------------------------------

/** `PackRegistrationBlock.organiser`'s own element type — `pack-schema.ts`
 *  exports no separate type alias for it (same situation
 *  `validate-pack.ts` hits for `PackRegistrationJoin`; indexed off the
 *  block type there for the identical reason). */
export type PackOrganiserAction = PackRegistrationBlock["organiser"][number];

/** Everything `applyOrganiserActions` needs to act on ONE pack entry,
 *  resolved from its `extKey` by the caller (`runRegistrationDivision`).
 *  `captain` is optional because only `"promote"` ever re-runs `pay()`;
 *  every other action kind ignores it. */
export interface OrganiserActionContext {
  readonly registrationId: string;
  readonly captain?: Captain;
}

export interface ApplyOrganiserActionsInput {
  readonly organiser: Organiser;
  readonly actions: readonly PackOrganiserAction[];
  readonly contextByExtKey: ReadonlyMap<string, OrganiserActionContext>;
  /** The division's fee — `promote` only re-runs `pay()` when there is
   *  something to pay (mirrors stage-0 rule 4, `pay:true` requires
   *  `feeCents > 0`; a free division's promoted entry owes nothing). */
  readonly feeCents: number;
  /** "assign_free_agent" target discovery (design D4: report-only in v1).
   *  Returns candidate team registration ids for one free-agent entry; the
   *  first is used. Omitted (the default) or throwing, or resolving to no
   *  candidates, all take the SAME path: the action is skipped and a
   *  warning is reported via `onFreeAgentWarning` — never thrown, because
   *  this action is never gated. */
  readonly listAssignTargets?: (freeAgentRegistrationId: string) => Promise<readonly string[]>;
  readonly onFreeAgentWarning?: (message: string) => void;
}

/**
 * Applies `actions` STRICTLY IN PACK ORDER — a single `for` loop, one
 * `await` at a time, never `Promise.all`. This is the `_RULES.md` rule
 * made concrete: "parallel ACROSS captains, strictly sequential WITHIN a
 * division's organiser action list." A pack that lists `approve, reject,
 * promote` in that order means exactly that order happened live; scoring
 * it with unordered concurrency could let a slow `approve` land after a
 * fast `promote`'s `pay()`, which is not what the pack recorded.
 *
 * `"promote"` additionally re-runs `pay()` for the SAME entry's own
 * captain, immediately after its own `act()` call resolves — "the fee a
 * promoted-from-waitlist entry owes was never charged while it sat on the
 * waitlist" (design D4). This is why `pay()` for a promoted entry always
 * appears directly after that entry's `"promote"` `act()` call in the
 * observed order, never batched separately.
 */
export async function applyOrganiserActions(input: ApplyOrganiserActionsInput): Promise<void> {
  const { organiser, actions, contextByExtKey, feeCents, listAssignTargets, onFreeAgentWarning } = input;
  for (const action of actions) {
    const ctx = contextByExtKey.get(action.target);
    if (ctx === undefined) {
      throw new Error(`applyOrganiserActions(): action "${action.action}" targets unresolved entry "${action.target}"`);
    }
    // An entry whose submit produced no row (an eligibility rejection, or any
    // unexpected 4xx) carries `registrationId: ""` — see `FunnelEntryOutcome`.
    // Passing that on is not a no-op: the browser organiser builds a selector
    // from it and spends the full 30s locator budget waiting for
    // `[data-registration-id=""]`, then reports a Playwright timeout that says
    // nothing about WHY the entry has no id. Refuse here instead, and name the
    // entry — the pack asked the organiser to act on something that was never
    // created, which is a pack/product disagreement, not a UI problem.
    if (ctx.registrationId === "") {
      throw new Error(
        `applyOrganiserActions(): action "${action.action}" targets entry "${action.target}", which has NO registration id — ` +
          `its submit produced no row (rejected at submit, or an unexpected 4xx). Nothing can be ${action.action}d.`,
      );
    }
    const kind: OrganiserActionKind = action.action;

    if (kind === "assign_free_agent") {
      let targetRegistrationId: string | undefined;
      if (listAssignTargets === undefined) {
        onFreeAgentWarning?.(`assign_free_agent on "${action.target}" skipped — no target resolver wired (report-only, design D4)`);
      } else {
        try {
          const candidates = await listAssignTargets(ctx.registrationId);
          targetRegistrationId = candidates[0];
          if (targetRegistrationId === undefined) {
            onFreeAgentWarning?.(`assign_free_agent on "${action.target}" skipped — no candidate team returned`);
          }
        } catch (err) {
          onFreeAgentWarning?.(
            `assign_free_agent on "${action.target}" failed to resolve a target: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (targetRegistrationId === undefined) continue; // report-only: never gate, never throw
      await organiser.act({ action: "assign_free_agent", registrationId: ctx.registrationId, targetRegistrationId });
      continue;
    }

    await organiser.act({ action: kind, registrationId: ctx.registrationId });

    if (kind === "promote" && feeCents > 0) {
      if (ctx.captain === undefined) {
        throw new Error(`applyOrganiserActions(): "promote" on "${action.target}" has no captain in context — cannot re-run pay()`);
      }
      await ctx.captain.pay({ registrationId: ctx.registrationId });
    }
  }
}

// ---------------------------------------------------------------------------
// The funnel oracle (design §5.2, corrected by B03r-repins-2026-09-03.md
// FP6 and C2 — read the header comment above before touching this section)
// ---------------------------------------------------------------------------

/** One entry's submit-time result, as `Captain.enter()` returned it
 *  (`EntryOutcome`) — captured by the runner immediately after `enter()`,
 *  keyed by the pack's own `extKey`. `registrationId` is `""` for
 *  `rejected_eligibility` AND for `"unexpected_error"` (`EntryOutcome.ref`'s
 *  own doc comment: an eligibility rejection happens BEFORE any row is
 *  inserted, and an unexpected 4xx never gets one either). `errorDetail`
 *  mirrors `EntryOutcome.errorDetail` — present only for
 *  `"unexpected_error"`. */
export interface FunnelEntryOutcome {
  readonly extKey: string;
  readonly registrationId: string;
  readonly submitStatus: EntryOutcomeStatus;
  readonly errorDetail?: { readonly httpStatus: number; readonly body: unknown };
}

/**
 * One row of `GET /api/v1/divisions/{id}/registrations`
 * (`listRegistrations` / `RegistrationListRow`,
 * `apps/web/src/server/usecases/registrations.ts:5515`), narrowed to
 * exactly what the oracle needs — read back AFTER every organiser action in
 * the division has run, so it reflects the FINAL state.
 *
 * `amountCents`/`paymentIntentId` are the ENTRY's own columns
 * (`registrations.amount_cents`, `registrations.payment_intent_id` —
 * exposed on the list row as `entry_payment_intent_id`, registrations.ts:
 * 467-477) — NEVER `registration_groups.amount_cents`. That column is a
 * submit-time cart snapshot `confirmPaidRegistration`
 * (`usecases/registrations.ts:2762`) never writes to on payment — only
 * `registrations.status`, `charged_at` and `payment_intent_id` change, plus
 * the group's OWN `payment_intent_id` (`:2894-2905`). Summing the group's
 * snapshot would count money that was never paid, and would read GREENEST
 * exactly when payment is broken (B03r-repins-2026-09-03.md, FP6).
 */
export interface FunnelRow {
  readonly registrationId: string;
  readonly status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" | "expired" | "rejected";
  readonly amountCents: number;
  readonly paymentIntentId: string | null;
}

export interface FunnelFinding {
  readonly code: string;
  readonly extKey: string;
  readonly message: string;
}

export interface FunnelResult {
  readonly ok: boolean;
  readonly findings: readonly FunnelFinding[];
  readonly entrants: number;
  readonly waitlisted: number;
  readonly paidCents: number;
  /**
   * Correction C2 (B03r-repins-2026-09-03.md): `gateRosterEligibility`
   * ("ELIGIBILITY_VIOLATION") is reachable only from entrant creation and
   * fixture generation — both B04, neither reachable from this division's
   * organiser actions. This oracle proves ONLY the public-submit half of
   * design §5.2's eligibility gate (`funnel.eligibility_not_blocked_at_submit`
   * below). Permanently `false` in B03r — TODO(B04): once entrant creation
   * is reachable from here, drive a forced organiser action against a
   * `rejected_eligibility` offender and flip this only when that call is
   * actually observed to 422 with `"ELIGIBILITY_VIOLATION"`. A report
   * rendering this field MUST show it as "unproven", never as a pass.
   */
  readonly organiserForceEligibilityProven: false;
}

/** Which `entry.expect` values design/B03r-repins calls "offenders" — an
 *  entry the pack declares should NOT become a plain entrant. Used only to
 *  pick the finding CODE ("offender admitted" vs a generic mismatch); the
 *  underlying comparison is the same for every `expect` value. */
const OFFENDER_EXPECTS = new Set<PackRegistrationEntry["expect"]>(["rejected_eligibility", "waitlisted", "rejected_manual"]);

/** Terminal statuses design §5.2's "Σ paid" actually reaches — see
 *  `FunnelRow`'s own doc comment for the two-terminal-states note this
 *  mirrors: auto-approval divisions land on `"confirmed"` (with an
 *  `entrant_id`); manual-approval divisions stay at `"paid"` awaiting
 *  `approveRegistration`. An oracle accepting only one of the two reds
 *  every division of the other kind. */
const PAID_STATUSES = new Set<FunnelRow["status"]>(["paid", "confirmed"]);

/**
 * Classifies one entry's FINAL state into the same four-value vocabulary
 * `PackRegistrationEntry.expect` uses, so the oracle can compare like with
 * like. `rejected_eligibility` is decided from the SUBMIT-time outcome
 * alone (nothing downstream ever changes it — the row was never inserted);
 * every other value is decided from the FINAL row, because `rejected_manual`
 * and a promoted `waitlisted` entry are not known until an organiser action
 * has run.
 */
export function classifyFunnelOutcome(outcome: FunnelEntryOutcome, row: FunnelRow | undefined): PackRegistrationEntry["expect"] {
  if (outcome.submitStatus === "rejected_eligibility") return "rejected_eligibility";
  if (row === undefined) {
    throw new Error(
      `classifyFunnelOutcome(): entry "${outcome.extKey}" (registration "${outcome.registrationId}") has no final row — evaluateFunnel needs exactly one row per non-rejected entry`,
    );
  }
  switch (row.status) {
    case "rejected":
      return "rejected_manual";
    case "waitlisted":
      return "waitlisted";
    case "pending":
    case "paid":
    case "confirmed":
      return "entrant";
    default:
      throw new Error(
        `classifyFunnelOutcome(): entry "${outcome.extKey}" final status "${row.status}" has no funnel classification (withdrawn/expired are outside B03r's four-value vocabulary)`,
      );
  }
}

/**
 * The funnel oracle (design §5.2): entrant count == `expect.entrants`; each
 * offender's status == its `expect`; waitlist count == `expect.waitlisted`;
 * Σ paid == `expect.paidCents` (corrected per FP6 — see `FunnelRow`'s doc
 * comment); every `rejected_eligibility` offender blocked at public submit
 * (the organiser-force half is `organiserForceEligibilityProven: false`,
 * per C2 — never asserted here). An expected rejection that instead
 * succeeds reds as "offender admitted" (`funnel.offender_admitted`).
 *
 * Pure — no HTTP, no DB. `outcomes`/`rows` are supplied by the caller
 * (`runRegistrationDivision` in production; a fixture in tests), which is
 * what makes this function itself DB-free-testable.
 */
export function evaluateFunnel(
  divisionRef: string,
  block: PackRegistrationBlock,
  outcomes: ReadonlyMap<string, FunnelEntryOutcome>,
  rows: ReadonlyMap<string, FunnelRow>,
): FunnelResult {
  const findings: FunnelFinding[] = [];
  let entrants = 0;
  let waitlisted = 0;
  let paidCents = 0;

  for (const entry of block.entries) {
    const outcome = outcomes.get(entry.extKey);
    if (outcome === undefined) {
      findings.push({
        code: "funnel.missing_outcome",
        extKey: entry.extKey,
        message: `entry "${entry.extKey}" has no recorded submit outcome — enter() was never called, or its result was dropped before reaching the oracle`,
      });
      continue;
    }

    // LIVE-CRASH FIX (B03r-repins-2026-09-03.md dispatch): an unexpected
    // 4xx at submit has no final row to classify against (registrationId is
    // "" — `EntryOutcome.ref`'s own doc comment) and is never one of the
    // four `expect` values, so it is its OWN finding, reported here rather
    // than falling into `classifyFunnelOutcome`'s "no final row" throw
    // (which would crash the WHOLE evaluateFunnel call over one entry).
    if (outcome.submitStatus === "unexpected_error") {
      findings.push({
        code: "funnel.unexpected_error",
        extKey: entry.extKey,
        message:
          `entry "${entry.extKey}" got an unexpected HTTP ${outcome.errorDetail?.httpStatus ?? "?"} at submit — ` +
          `${JSON.stringify(outcome.errorDetail?.body)}`,
      });
      continue;
    }

    const row = outcome.registrationId ? rows.get(outcome.registrationId) : undefined;
    const actual = classifyFunnelOutcome(outcome, row);

    if (actual === "entrant") entrants += 1;
    if (actual === "waitlisted") waitlisted += 1;
    if (row !== undefined && PAID_STATUSES.has(row.status) && row.paymentIntentId !== null) {
      paidCents += row.amountCents;
    }

    if (actual !== entry.expect) {
      const offenderAdmitted = OFFENDER_EXPECTS.has(entry.expect) && actual === "entrant";
      findings.push({
        code: offenderAdmitted ? "funnel.offender_admitted" : "funnel.status_mismatch",
        extKey: entry.extKey,
        message: offenderAdmitted
          ? `entry "${entry.extKey}" was declared expect:"${entry.expect}" but the product admitted it as an entrant — offender admitted`
          : `entry "${entry.extKey}" was declared expect:"${entry.expect}" but the product's final state resolves to "${actual}"`,
      });
    }

    if (entry.expect === "rejected_eligibility" && outcome.submitStatus !== "rejected_eligibility") {
      findings.push({
        code: "funnel.eligibility_not_blocked_at_submit",
        extKey: entry.extKey,
        message: `entry "${entry.extKey}" is declared expect:"rejected_eligibility" but public submit returned status "${outcome.submitStatus}" — the eligibility gate did not block it`,
      });
    }
  }

  if (entrants !== block.expect.entrants) {
    findings.push({
      code: "funnel.entrants_mismatch",
      extKey: divisionRef,
      message: `division "${divisionRef}": expected ${block.expect.entrants} entrants, product produced ${entrants}`,
    });
  }
  if (waitlisted !== block.expect.waitlisted) {
    findings.push({
      code: "funnel.waitlisted_mismatch",
      extKey: divisionRef,
      message: `division "${divisionRef}": expected ${block.expect.waitlisted} waitlisted, product produced ${waitlisted}`,
    });
  }
  if (paidCents !== block.expect.paidCents) {
    findings.push({
      code: "funnel.paid_cents_mismatch",
      extKey: divisionRef,
      message: `division "${divisionRef}": expected paidCents ${block.expect.paidCents}, product produced ${paidCents} — summed only over entries whose final status is paid|confirmed AND carry a payment_intent_id (FP6 correction; never registration_groups.amount_cents)`,
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    entrants,
    waitlisted,
    paidCents,
    organiserForceEligibilityProven: false,
  };
}

// ---------------------------------------------------------------------------
// The per-division runner (design §4: organiser configures → captains
// enter (parallel across captains) → paid entries pay → players join +
// consent → organiser actions in pack order → funnel oracle → hand
// entrants to B04 by ext_key)
// ---------------------------------------------------------------------------

export interface DivisionRunnerInput {
  readonly divisionRef: string;
  /** The division's REAL id, already resolved from `divisionRef` by the
   *  caller (the same ref->id resolution every other bench layer does). */
  readonly divisionId: string;
  readonly target: RegistrationDivisionTarget;
  readonly block: PackRegistrationBlock;
  readonly personsByRef: ReadonlyMap<string, PackPerson>;
  /** Collision-free email suffix, same convention as `seed.ts`'s `runTag`. */
  readonly runTag: string;
  readonly organiser: Organiser;
  /** One `Captain` per pack ENTRY (not per person — a captain's own
   *  identity is the entry's contact, and one person can captain more than
   *  one entry across divisions, design §5). */
  readonly makeCaptain: (entryExtKey: string) => Captain;
  readonly makePlayer: (personRef: string) => Player;
  /**
   * Resolves a submitted entry's join code. KNOWN GAP, recorded rather than
   * guessed: no pinned endpoint hands an organiser-session caller a team
   * entry's `join_code` (`organiserRegistration`,
   * `api-v1/registration-response.ts:29`, nulls it for anyone who is not
   * `mayHoldBearerCredential`) — the product hands it to the CAPTAIN
   * themselves, out of band (confirmation email / status page). Required
   * with no default: an empty-string fallback would silently 4xx against a
   * real server, worse than forcing the caller to wire a real resolver
   * (e.g. reading the group's own status view) before this runs live.
   */
  readonly resolveJoinCode: (entryExtKey: string, registrationId: string) => Promise<string>;
  /** "assign_free_agent" target discovery — see `ApplyOrganiserActionsInput`'s
   *  own doc comment. Report-only; omit to skip every such action. */
  readonly listAssignTargets?: (freeAgentRegistrationId: string) => Promise<readonly string[]>;
  /** Reads back the division's FINAL registration rows, after every
   *  organiser action has run — the live implementation is `GET
   *  /api/v1/divisions/{id}/registrations`; a test supplies a fixture map. */
  readonly fetchFinalRows: () => Promise<ReadonlyMap<string, FunnelRow>>;
}

export interface DivisionRunnerResult {
  readonly divisionRef: string;
  /** extKey -> registration id, for exactly the entries the funnel oracle
   *  classified as `"entrant"` — B04's hand-off seam (design §5.1: "Entrants
   *  produced by registration reach B04 exactly as admin-seeded ones do,
   *  ext_key matching"). */
  readonly entrantsByExtKey: ReadonlyMap<string, string>;
  readonly funnel: FunnelResult;
  readonly freeAgentWarnings: readonly string[];
}

function consentFor(person: PackPerson, consent: "granted" | "guardian"): ConsentInput {
  if (consent === "granted") return { privacyConsent: true };
  return { privacyConsent: true, guardianConsent: true, guardianName: `${person.fullName}'s guardian` };
}

export async function runRegistrationDivision(input: DivisionRunnerInput): Promise<DivisionRunnerResult> {
  const { block, personsByRef, target, organiser, runTag } = input;
  // Computed ONCE — same convention `validatePack` uses for its own wall-
  // clock `now` (checkJoinConsentMatchesMinority's doc comment): every
  // entry in this run is judged against the same instant.
  const now = new Date();

  // 1. Organiser configures — BEFORE anyone can enter.
  await organiser.configureRegistration(input.divisionId, {
    category: block.category,
    ageMin: block.ageMin,
    ageMax: block.ageMax,
    entrantKind: block.entrantKind,
    feeCents: block.feeCents,
    paymentMethod: block.paymentMethod,
    approval: block.approval,
    capacity: block.capacity,
  });

  // 2. Captains enter — PARALLEL ACROSS CAPTAINS (_RULES.md), then pay if
  //    the pack declares this entry pays up front. `Promise.all` is correct
  //    HERE (unlike the organiser-action loop below): each entry is an
  //    independent cart, and nothing about one captain's submit depends on
  //    another's. `enter()` itself never throws for a 4xx it doesn't
  //    specifically recognise any more (drivers/http.ts's widened `enter()`)
  //    — it RETURNS an `"unexpected_error"` outcome instead, which is what
  //    keeps this `Promise.all` from aborting every OTHER captain's entry
  //    over one bad request (the B03r live-crash regression).
  const outcomes = new Map<string, FunnelEntryOutcome>();
  const captainByExtKey = new Map<string, Captain>();
  await Promise.all(
    block.entries.map(async (entry) => {
      const captain = input.makeCaptain(entry.extKey);
      captainByExtKey.set(entry.extKey, captain);
      const registrationEntry = buildRegistrationEntry(entry, block, personsByRef, runTag, now);
      const outcome = await captain.enter(registrationEntry, target);
      outcomes.set(entry.extKey, {
        extKey: entry.extKey,
        registrationId: outcome.ref,
        submitStatus: outcome.status,
        errorDetail: outcome.errorDetail,
      });
      if (entry.pay && outcome.ref) {
        await captain.pay({ registrationId: outcome.ref });
      }
    }),
  );

  // 3. Players join + consent — one join per `block.joins[]` row, parallel
  //    (independent people joining independent entries).
  await Promise.all(
    block.joins.map(async (join) => {
      const entryOutcome = outcomes.get(join.entry);
      if (entryOutcome === undefined || !entryOutcome.registrationId) {
        throw new Error(`runRegistrationDivision(): join targets entry "${join.entry}" which has no registration id (rejected at submit?)`);
      }
      const person = personsByRef.get(join.person);
      if (person === undefined) {
        throw new Error(`runRegistrationDivision(): join references unknown person "${join.person}"`);
      }
      const joinEntry: JoinEntry = {
        orgSlug: target.orgSlug,
        competitionSlug: target.competitionSlug,
        player: toRegistrationPlayer(person, false),
      };
      const joinCode = await input.resolveJoinCode(join.entry, entryOutcome.registrationId);
      const player = input.makePlayer(join.person);
      await player.join(joinEntry, joinCode, consentFor(person, join.consent));
    }),
  );

  // 4. Organiser actions — STRICTLY IN PACK ORDER (see
  //    `applyOrganiserActions`'s own doc comment for why this is a `for`
  //    loop and not a `Promise.all`).
  const contextByExtKey = new Map<string, OrganiserActionContext>(
    block.entries.map((entry) => [
      entry.extKey,
      { registrationId: outcomes.get(entry.extKey)?.registrationId ?? "", captain: captainByExtKey.get(entry.extKey) },
    ]),
  );
  const freeAgentWarnings: string[] = [];
  await applyOrganiserActions({
    organiser,
    actions: block.organiser,
    contextByExtKey,
    feeCents: block.feeCents,
    listAssignTargets: input.listAssignTargets,
    onFreeAgentWarning: (message) => freeAgentWarnings.push(message),
  });

  // 5. Funnel oracle.
  const rows = await input.fetchFinalRows();
  const funnel = evaluateFunnel(input.divisionRef, block, outcomes, rows);

  // 6. Hand entrants to B04 by ext_key.
  const entrantsByExtKey = new Map<string, string>();
  for (const entry of block.entries) {
    const outcome = outcomes.get(entry.extKey);
    if (outcome === undefined || !outcome.registrationId) continue;
    const row = rows.get(outcome.registrationId);
    if (classifyFunnelOutcome(outcome, row) === "entrant") {
      entrantsByExtKey.set(entry.extKey, outcome.registrationId);
    }
  }

  return { divisionRef: input.divisionRef, entrantsByExtKey, funnel, freeAgentWarnings };
}
