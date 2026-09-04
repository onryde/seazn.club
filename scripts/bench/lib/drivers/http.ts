// The registration HTTP driver (B03r task 4, design §3) — implements
// Organiser/Captain/Player over B01's `request()` (../http.ts). One
// cookie-jar `Session` per person: the caller (a later `register.ts`) mints
// a `Session` per organiser/captain/player and passes it to the matching
// factory below, exactly the way it already signs each of them in with
// `signIn()`. This file never writes a second HTTP client — every call goes
// through `request()`/`BenchHttpError` from `../http.ts`.
import { BenchHttpError, request, type Session } from "../http.ts";
import type {
  Captain,
  ConsentInput,
  EntryOutcome,
  EntryOutcomeStatus,
  JoinEntry,
  Organiser,
  OrganiserAction,
  PayableEntry,
  Player,
  RegistrationBlockConfig,
  RegistrationDivisionTarget,
  RegistrationEntry,
  RegistrationPlayer,
} from "./types.ts";

/** Thrown by `pay()` on this driver — hosted Stripe Checkout is a real
 *  browser page (`checkout.stripe.com`), not a JSON endpoint. The browser
 *  driver (a later task) is the one Captain implementation that can drive
 *  it. */
export class PaidEntryNeedsBrowser extends Error {
  constructor(entry: PayableEntry) {
    super(
      `pay(): registration ${entry.registrationId} needs hosted Stripe Checkout, a real browser page — the HTTP driver cannot drive it. Use the browser driver.`,
    );
    this.name = "PaidEntryNeedsBrowser";
  }
}

function toWirePlayer(p: RegistrationPlayer) {
  return {
    full_name: p.fullName,
    dob: p.dob ?? null,
    gender: p.gender ?? null,
    email: p.email ?? null,
    squad_number: p.squadNumber ?? null,
    is_captain: p.isCaptain,
  };
}

// ---------------------------------------------------------------------------
// Organiser
// ---------------------------------------------------------------------------

/** `apps/web/src/components/use-registration-hub-config.ts:87-100` fires
 *  these two calls in PARALLEL from the real hub panel — a division is
 *  "configured" only once BOTH land. A driver that issued only the PUT (or
 *  only the PATCH) would leave the division half-configured and nothing
 *  would notice: the PUT alone never sets `category`/`age_min`/`age_max`
 *  (those are `PatchDivision` fields, not `PutRegistrationSettings` ones),
 *  and the PATCH alone never opens registration at all
 *  (`PutRegistrationSettings.enabled`). Both calls are therefore mandatory,
 *  not "send whichever one is non-empty". */
async function configureRegistration(
  base: string,
  session: Session,
  divisionId: string,
  block: RegistrationBlockConfig,
): Promise<void> {
  const patchBody = {
    category: block.category,
    age_min: block.ageMin ?? null,
    age_max: block.ageMax ?? null,
  };
  const putBody = {
    enabled: true,
    entrant_kind: block.entrantKind,
    fee_cents: block.feeCents,
    approval: block.approval,
    capacity: block.capacity ?? null,
  };
  await Promise.all([
    request(base, session, `/api/v1/divisions/${divisionId}`, { method: "PATCH", body: patchBody }),
    request(base, session, `/api/v1/divisions/${divisionId}/registration-settings`, {
      method: "PUT",
      body: putBody,
    }),
  ]);
}

/** All four `OrganiserActionKind`s hit the SAME URL shape
 *  (`/api/v1/registrations/{id}/{action}`) except `assign_free_agent`,
 *  which posts to `/assign` with a body (`AssignSoloSignUp`,
 *  api-v1/schemas.ts) rather than to a verb named after the pack action.
 *  `promote` sends the SAME id as both the URL `{id}` and the body's
 *  `registration_id` — deliberately: the URL id only needs to resolve WHICH
 *  DIVISION to promote within (`promoteFromWaitlist`, registration-
 *  approval.ts), and every registration belongs to exactly one, so a
 *  registration is always a valid "which division" pointer for itself. The
 *  body's `registration_id` then names the exact target this action
 *  intends, rather than falling back to "oldest waitlisted" — the pack
 *  always names a specific entry (`PackRegistrationOrganiserAction.target`),
 *  never "whichever is oldest". `approve`/`reject` take no body at all
 *  (their routes never call `req.json()`). */
async function act(base: string, session: Session, action: OrganiserAction): Promise<void> {
  switch (action.action) {
    case "approve":
      await request(base, session, `/api/v1/registrations/${action.registrationId}/approve`, { method: "POST" });
      return;
    case "reject":
      await request(base, session, `/api/v1/registrations/${action.registrationId}/reject`, { method: "POST" });
      return;
    case "promote":
      await request(base, session, `/api/v1/registrations/${action.registrationId}/promote`, {
        method: "POST",
        body: { registration_id: action.registrationId },
      });
      return;
    case "assign_free_agent":
      if (!action.targetRegistrationId) {
        throw new Error(
          `act(): "assign_free_agent" on registration ${action.registrationId} needs targetRegistrationId (the team entry to assign onto)`,
        );
      }
      await request(base, session, `/api/v1/registrations/${action.registrationId}/assign`, {
        method: "POST",
        body: { target_registration_id: action.targetRegistrationId },
      });
      return;
  }
}

export function httpOrganiser(base: string, session: Session): Organiser {
  return {
    configureRegistration: (divisionId, block) => configureRegistration(base, session, divisionId, block),
    act: (action) => act(base, session, action),
  };
}

// ---------------------------------------------------------------------------
// Captain
// ---------------------------------------------------------------------------

/** The exact two error codes design §5.2 requires a rejected offender to hit
 *  — "ELIGIBILITY" from public submit (registration-submit.ts:325-327) and
 *  "ELIGIBILITY_VIOLATION" from the organiser-side roster gate
 *  (`gateRosterEligibility`, registration-eligibility.ts:342). Matched by
 *  EXACT equality, never a substring — a code like
 *  "SOME_ELIGIBILITY_ADJACENT_RULE" contains "ELIGIBILITY" but is not this
 *  family, and `.includes()` would misclassify it as a rejection this
 *  entry never actually got. */
const ELIGIBILITY_ERROR_CODES = new Set(["ELIGIBILITY", "ELIGIBILITY_VIOLATION"]);

function eligibilityCodeOf(err: BenchHttpError): string | undefined {
  const body = err.body as { error?: { code?: unknown } } | undefined;
  const code = body?.error?.code;
  return typeof code === "string" ? code : undefined;
}

/** Derived from `RegistrationStatus`'s own submit-time vocabulary
 *  (registration-submit.ts:739,850-851 — only "waitlisted", "pending" and
 *  "confirmed" are ever assigned at submit time; "paid"/"withdrawn"/
 *  "expired"/"rejected" only happen later, never as an `enter()` result).
 *  "confirmed" is this task's `EntryOutcome`'s "approved" — the wire has no
 *  status literally spelled "approved". An unrecognised value throws rather
 *  than silently guessing, so a future submit-time status this map hasn't
 *  seen fails loudly instead of mis-scoring the funnel oracle. */
function mapSubmitStatus(status: string): EntryOutcomeStatus {
  switch (status) {
    case "waitlisted":
      return "waitlisted";
    case "confirmed":
      return "approved";
    case "pending":
      return "pending";
    default:
      throw new Error(`enter(): unrecognised submit-time registration status "${status}" — outcome mapping has no case for it`);
  }
}

interface SubmitResponseShape {
  entries: Array<{ registration_id: string; status: string }>;
}

/**
 * Builds the exact wire body `enter()` POSTs to public submit — extracted
 * into its own export so a test can parse it THROUGH the real
 * `PublicRegisterGroupRequest` schema (`register.test.ts`) without
 * re-deriving this mapping: a hand-typed expectation of the wire shape
 * would just restate whatever bug the mapping itself has. `enter()` below
 * is the only OTHER caller — nothing here changes what goes over the wire.
 */
export function toWireSubmitBody(entry: RegistrationEntry, division: RegistrationDivisionTarget): unknown {
  return {
    contact: {
      name: entry.contact.name,
      email: entry.contact.email,
      dob: entry.contact.dob ?? null,
      gender: entry.contact.gender ?? null,
      guardian_name: entry.contact.guardianName ?? null,
      guardian_consent: entry.contact.guardianConsent ?? false,
    },
    privacy_consent: entry.privacyConsent,
    media_consent: entry.mediaConsent,
    entries: [
      {
        division_id: division.divisionId,
        entrant_kind: entry.entrantKind,
        team_name: entry.teamName ?? undefined,
        partner_name: entry.partnerName ?? undefined,
        free_agent: entry.freeAgent,
        players: entry.players?.map(toWirePlayer),
        answers: entry.answers,
        registering_self: entry.registeringSelf,
        self_player_index: entry.selfPlayerIndex,
      },
    ],
    website: entry.website ?? "",
  };
}

async function enter(
  base: string,
  session: Session,
  entry: RegistrationEntry,
  division: RegistrationDivisionTarget,
): Promise<EntryOutcome> {
  const path = `/api/v1/public/orgs/${division.orgSlug}/competitions/${division.competitionSlug}/register`;
  const body = toWireSubmitBody(entry, division);
  try {
    const data = await request<SubmitResponseShape>(base, session, path, { method: "POST", body });
    const result = data.entries[0];
    return { status: mapSubmitStatus(result.status), ref: result.registration_id };
  } catch (err) {
    if (err instanceof BenchHttpError && err.status === 422) {
      const code = eligibilityCodeOf(err);
      if (code !== undefined && ELIGIBILITY_ERROR_CODES.has(code)) {
        return { status: "rejected_eligibility", ref: "" };
      }
    }
    // B03r live-crash fix (`B03r-repins-2026-09-03.md`, register.ts's own
    // header comment): a 4xx this driver has no SPECIFIC mapping for used to
    // rethrow past `runRegistrationDivision`'s `Promise.all`, aborting every
    // OTHER captain's entry in the same division over ONE bad request.
    // Widening — the eligibility mapping above stays exact-match-only and
    // runs FIRST, unchanged — to design §5.3's rule: "unexpected 4xx/5xx ->
    // red, response body attached". A 4xx becomes a funnel-visible outcome
    // (the funnel oracle reports it as a finding); a 5xx (or anything that
    // is not a `BenchHttpError` at all — a network failure, say) is still a
    // hard error, because there is no wire response to attach and nothing a
    // report row could usefully say about it.
    if (err instanceof BenchHttpError && err.status >= 400 && err.status < 500) {
      return { status: "unexpected_error", ref: "", errorDetail: { httpStatus: err.status, body: err.body } };
    }
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- unconditional throw; kept async to match the Captain interface's Promise<void> shape.
async function pay(_base: string, _session: Session, entry: PayableEntry): Promise<void> {
  throw new PaidEntryNeedsBrowser(entry);
}

export function httpCaptain(base: string, session: Session): Captain {
  return {
    enter: (entry, division) => enter(base, session, entry, division),
    pay: (entry) => pay(base, session, entry),
  };
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/** `join_code` is a BODY field (`PublicJoinRequest.join_code`), not a query
 *  parameter — see this file's sibling test for the full finding. The
 *  route's GET preview (`joinPreviewUrl`, join-form.tsx) is the only place
 *  `join_code` travels on the query string; POST reads it from
 *  `req.json()`. */
async function join(
  base: string,
  session: Session,
  entry: JoinEntry,
  joinCode: string,
  consent: ConsentInput,
): Promise<void> {
  const path = `/api/v1/public/orgs/${entry.orgSlug}/competitions/${entry.competitionSlug}/register/join`;
  const body = {
    join_code: joinCode,
    player_id: entry.playerId ?? undefined,
    player: toWirePlayer(entry.player),
    guardian_name: consent.guardianName ?? null,
    guardian_consent: consent.guardianConsent ?? false,
    privacy_consent: consent.privacyConsent,
    media_consent: consent.mediaConsent,
  };
  await request(base, session, path, { method: "POST", body });
}

export function httpPlayer(base: string, session: Session): Player {
  return {
    join: (entry, joinCode, consent) => join(base, session, entry, joinCode, consent),
  };
}
