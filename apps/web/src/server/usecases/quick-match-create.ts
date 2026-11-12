import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.1-7.3; plan 1 Task 5): create a quick
// match, or nothing.
//
// A guest has no account, so a quick match is a private competition in the ONE system org, built by the standard use
// cases under a session-shaped context for the system user (`systemAuth`), as `createFromDraft` builds a draft's. The
// tree is competition → division → one stage (league with legs = plays per pair, or knockout) → name-only entrants
// seeded 1..N in entry order → the generated fixtures → the division started and the competition live → the
// `quick_matches` row that holds everything guest-specific.
//
// Two layers (pre-flight A9):
//   - `createQuickMatchTree` is UNGUARDED: no offer, kind or format check. Its only callers are the offer probe
//     (`__tests__/_quick-match-probe.ts`, which must not go through the offer it produces) and `createQuickMatch`.
//   - `createQuickMatch` is GUARDED, and what a route calls: the home token sealed first, the per-visitor cap, the probe's
//     offer (`offerFor`: sport × variant, the sport's kinds, the knockout offer), then the tree and the one analytics
//     event (D11).
//
// The two-commit shape is §7.3's recorded deviation: the competition, division, stage and entrants are created by the
// standard use cases, each in its own transaction (`withTenant` never nests), and the fixtures, the start, the status
// and the `quick_matches` row commit together in one LAST transaction. Any failure after the competition exists
// hard-deletes it (`hardDeleteQuickMatchCompetition`) before rethrowing, so a caller sees the whole match or nothing; a
// process crash between the commits leaves a private, unlisted competition with no `quick_matches` row, which plan 3's
// sweep removes (pre-flight D1).
//
// The link mail (plan 3 Task 1; spec §7.6, C19): a create with an email queues one `quick_match_link` mail in that LAST
// transaction, so the row and its mail commit together or not at all, and returns the row's id for the route to make the
// first attempt after the commit. Its link is `<baseUrl>/q/<token>`: the mail body is the one place besides the address bar
// the token goes, never a log line, an event or `meta`.
import { sql, withTenant, type Tx } from "@/lib/db";
import { EVENTS } from "@/lib/analytics-events";
import { quickMatchLinkEmail } from "@/lib/email";
import { HttpError } from "@/lib/errors";
import { captureServer } from "@/lib/posthog-server";
import { systemAuth } from "@/lib/quick-match-auth";
import {
  QUICK_MATCH_ENDS_ON_DAYS,
  QUICK_MATCH_ERRORS,
  QUICK_MATCH_EXPIRY_DAYS,
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MAX_ALIVE_PER_VISITOR,
  QUICK_MATCH_SYSTEM_ORG_ID,
  QUICK_MATCH_SYSTEM_USER_ID,
} from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { enqueueEmail, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { log } from "@/server/logger";
import type { EntrantKind } from "@seazn/engine/sport";
import { createCompetition } from "./competitions";
import { createDivision } from "./divisions";
import { createEntrants } from "./entrants";
import { hardDeleteQuickMatchCompetition, QUICK_MATCH_OUTBOX_REF_TYPE } from "./quick-match-delete";
import { quickMatchPreview, quickMatchStageInput } from "./quick-match-preview";
import { offerFor } from "./quick-match-sports";
import { hashHomeToken, mintHomeToken, sealHomeToken } from "./quick-match-tokens";
import { afterScheduleWrite, startDivisionInTx } from "./schedule";
import { afterGenerateCommit, createStages, generateStageFixturesTx } from "./stages";

export interface CreatedQuickMatch {
  /** The `quick_matches` row's id. */
  id: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** The home-page token, in the clear: returned once, to the creator. Stored only as its hash and its sealed envelope. */
  token: string;
  /** The number the Start button showed (C17): `quickMatchPreview(...).matchCount`, the generated non-bye fixtures. */
  matchCount: number;
  expiresAt: Date;
  /** The link mail's outbox row (plan 3 Task 1), queued in the create's last transaction when the guest typed an email;
   *  null without one. The route makes its first attempt after the commit (`dispatchNow`). */
  outboxRowId: string | null;
}

/** What `createQuickMatch` answers: the match, and whether its link mail was dropped because `mailAllowed` said no. */
export interface CreatedGuestQuickMatch extends CreatedQuickMatch {
  /** True when the guest typed an email and `ctx.mailAllowed` refused it (branch review B m3): the match was made with NO
   *  address stored and no mail queued. False without an email, and when the mail was queued. */
  emailLimited: boolean;
}

/** Every refusal's code. Defined in the import-free lib/quick-match-constants.ts, so device links can throw one without
 *  this file's graph; re-exported here, the path its earlier callers use. */
export { QUICK_MATCH_ERRORS };

/** What `hashVisitorKey` returns (quick-match-tokens.ts): sha256 hex, 64 lowercase characters. The cap counts rows by
 *  this value, so anything else (an empty string, a raw cookie, a typo'd caller) would count against a visitor nobody is. */
const VISITOR_HASH_SHAPE = /^[0-9a-f]{64}$/;

const DAY_MS = 24 * 3600 * 1000;

/** The system user acting in the system org (§7.1). Defined in the import-light lib/quick-match-auth.ts, so device links
 *  can import it without this file's graph; re-exported here, the path its earlier callers use. */
export { systemAuth };

export interface SealedHomeToken {
  token: string;
  hash: string;
  enc: Buffer;
}

/** Mint, hash and seal a home token. Throws 503 DEVICE_LINK_KEK_MISSING on a server without the key, touching
 *  nothing: callers seal BEFORE any read or write, as device links do (E2). */
export function sealNewHomeToken(): SealedHomeToken {
  const token = mintHomeToken();
  return { token, hash: hashHomeToken(token), enc: sealHomeToken(token) };
}

/** Alive quick matches for one visitor: unsaved and unexpired (§7.2). One count, read twice by the create: early on
 *  the pool, and again under the visitor's lock in the last transaction. */
async function alive(db: typeof sql | Tx, visitorHash: string, now: Date): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from quick_matches
    where visitor_hash = ${visitorHash} and saved_by_user_id is null and expires_at > ${now}`;
  return row!.n;
}

function tooManyAlive(): HttpError {
  return new HttpError(
    429,
    `a visitor may hold at most ${QUICK_MATCH_MAX_ALIVE_PER_VISITOR} unsaved quick matches`,
    QUICK_MATCH_ERRORS.TOO_MANY_ALIVE,
  );
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** An email with no base URL to build its link from (plan 3 Amend T1 [B2]): a programmer error, never a silent create
 *  that mails nothing. Thrown before anything is minted or written. */
function baseUrlMissing(): HttpError {
  return new HttpError(
    500,
    "a quick match create with an email needs a baseUrl for the link mail",
    QUICK_MATCH_ERRORS.BASE_URL_MISSING,
  );
}

/**
 * Build one quick match: UNGUARDED (pre-flight A9) — no offer, kind or format check, and no early per-visitor count;
 * the locked recount in the last transaction is the only cap it applies (the race guard, B5f). Callers: the offer probe
 * and `createQuickMatch`, never a route.
 */
export async function createQuickMatchTree(
  input: Omit<CreateQuickMatch, "kind">,
  kind: EntrantKind,
  ctx: { visitorHash: string; home: SealedHomeToken; baseUrl?: string; now?: Date; _failBeforeGenerateForTests?: () => void },
): Promise<CreatedQuickMatch> {
  if (input.email !== null && !ctx.baseUrl) throw baseUrlMissing();
  const auth = systemAuth();
  const now = ctx.now ?? new Date();
  const { name, sport_key, variant_key, format, sides, plays } = input;

  // 1. The competition: private (the API defaults to public), never showcased, no slug (the generated one dedupes on
  //    collision, §7.1 point 2), from today to a year out (C21).
  const competition = await createCompetition(auth, {
    name,
    visibility: "private",
    branding: {},
    starts_on: isoDate(now),
    ends_on: isoDate(new Date(now.getTime() + QUICK_MATCH_ENDS_ON_DAYS * DAY_MS)),
  });

  try {
    // 2. The division takes exactly the one kind the guest chose (D2); one stage, the preview's own input (A8); the
    //    sides as name-only entrants of that kind, seeded 1..N in the order entered (C20, C22).
    const division = await createDivision(auth, competition.id, {
      name,
      sport_key,
      variant_key,
      config: { entrants: { kinds: [kind], defaultKind: kind } },
    });
    const [stage] = await createStages(auth, division.id, { seq: 1, ...quickMatchStageInput({ format, plays, name }) });
    if (!stage) throw new Error("quick match: createStages returned no stage");
    await createEntrants(
      auth,
      division.id,
      sides.map((display_name, i) => ({ kind, display_name, seed: i + 1, members: [] })),
    );

    // 3. The fixtures, the start, the status and the row commit together, or not at all.
    const committed = await withTenant(auth.orgId, async (tx) => {
      ctx._failBeforeGenerateForTests?.();
      // The race guard (B5f): two creates for one visitor both pass the early count; the lock serializes their last
      // transactions, so the second recount sees the first's row. The idiom of schedule/'s division lock.
      await tx`select pg_advisory_xact_lock(hashtext(${"qm-visitor:" + ctx.visitorHash}))`;
      if ((await alive(tx, ctx.visitorHash, now)) >= QUICK_MATCH_MAX_ALIVE_PER_VISITOR) throw tooManyAlive();
      const write = await generateStageFixturesTx(tx, auth, stage.id, {}, "record");
      // No frozen-competition check before the start, though it is the caller's job (`startDivision` asks
      // `frozenCompetitionIds` first): a competition is frozen only when its org is over `competitions.max_active`, and
      // the system org's `max_active` is null, unlimited (Task 1's override, ruling D6), so nothing in it can be frozen.
      const started = await startDivisionInTx(tx, auth, division.id, stage.id, {});
      // `startDivisionInTx` promotes only `published` → `live`, and a guest competition is never published.
      await tx`update competitions set status = 'live' where id = ${competition.id}`;
      const expiresAt = new Date(now.getTime() + QUICK_MATCH_EXPIRY_DAYS * DAY_MS);
      const [row] = await tx<{ id: string }[]>`
        insert into quick_matches
          (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, email, locale, last_activity_at, expires_at)
        values (${auth.orgId}, ${competition.id}, ${name}, ${format}, ${ctx.home.hash}, ${ctx.home.enc}, ${ctx.visitorHash},
                ${input.email}, ${input.locale}, ${now}, ${expiresAt})
        returning id`;
      // The link mail (§7.6), in this transaction: the system org's own row (the tenant insert policy refuses an org-less
      // one), in the setup form's language, worthless once the outbox's bound or the match's expiry has passed.
      const outboxRowId =
        input.email === null
          ? null
          : await enqueueEmail(tx, {
              kind: "quick_match_link",
              refType: QUICK_MATCH_OUTBOX_REF_TYPE,
              refId: row!.id,
              orgId: auth.orgId,
              to: input.email,
              // Not transactional (controller ruling 2026-11-08): the link is on the guest's screen already; a suppressed
              // address (a bounce, a complaint) is not mailed.
              transactional: false,
              expiresAt: expiryWithin(expiresAt),
              ...(await quickMatchLinkEmail(
                { name, link: `${ctx.baseUrl}${routes.quickMatch(ctx.home.token)}`, expiresAt },
                await recipientLocale(tx, { pick: input.locale, userId: null, orgDefault: null }),
              )),
            });
      return { id: row!.id, write, started, expiresAt, outboxRowId };
    });

    // After the commit: the work `generateStageFixtures` and `startDivision` each do for themselves. The organizer
    // analytics they fire carry the system org, which `captureServer` drops (D11); the competition promotion's
    // lifecycle event is not fired at all, since the status was set here rather than promoted.
    await afterGenerateCommit(auth, stage.id, committed.write);
    afterScheduleWrite(division.id, competition.id, "start", committed.started.fixtureIds);

    // 4. The number the Start button showed (A8, C17).
    const { matchCount } = quickMatchPreview({ format, sides: sides.length, plays });
    return {
      id: committed.id,
      competitionId: competition.id,
      divisionId: division.id,
      stageId: stage.id,
      token: ctx.home.token,
      matchCount,
      expiresAt: committed.expiresAt,
      outboxRowId: committed.outboxRowId,
    };
  } catch (err) {
    // 5. Or nothing. A compensation that fails itself must not replace the refusal the caller is owed: it is logged,
    //    and the orphan (private, unlisted, no `quick_matches` row) is the sweep's (pre-flight D1).
    await hardDeleteQuickMatchCompetition(competition.id).catch((cleanupErr: unknown) => {
      log.error({ err: cleanupErr, competitionId: competition.id }, "quick match: compensation delete failed after a failed create");
    });
    throw err;
  }
}

/**
 * Create a guest's quick match: what plan 2's route calls. In this order, each step answering before the next runs
 * (a `visitorHash` that is not a visitor key's sha256 hex is refused 400 QUICK_MATCH_VISITOR_INVALID before any of them, and
 * an email with no `baseUrl` throws 500 QUICK_MATCH_BASE_URL_MISSING, a programmer error, plan 3 Amend T1 [B2]):
 *   0. the home token is minted, hashed and sealed BEFORE any read or write: a server without DEVICE_LINK_KEK refuses
 *      503 DEVICE_LINK_KEK_MISSING having touched nothing, as device links seal before any write (E2, A4);
 *   1. the early per-visitor count: QUICK_MATCH_MAX_ALIVE_PER_VISITOR alive already → 429 QUICK_MATCH_TOO_MANY_ALIVE,
 *      before anything is built (the locked recount inside the tree is the race guard, B5f);
 *   2. the offer: a sport × variant the probe did not prove → 422 SPORT_NOT_OFFERED; a kind the sport does not take →
 *      422 KIND_NOT_OFFERED (D2); a knockout of two sides (C16), or of a variant where a bracket match can end level →
 *      422 FORMAT_NOT_OFFERED. C23 as amended (owner ruling 2026-11-07): a knockout is offered only where a bracket match
 *      cannot end level, decided by the engine's `bracketMayEndLevel` on the variant's cfg ⊕ the knockout stage's
 *      defaults (`offer.knockoutAllowed`, quick-match-sports.ts); the probe checks the same question on real fixtures;
 *   3. with an email only, `ctx.mailAllowed(email)` (the route's mail limits): asked only once every refusal above has
 *      passed, so a refused create spends no mail bucket. A no costs the MAIL, never the match (branch review B m3,
 *      controller ruling 2026-11-08): the tree is built with no email, so no address is stored and no mail queued, and the
 *      answer says `emailLimited`. Anything it throws is the create's failure. REQUIRED (branch-fix A review m6): an
 *      optional gate defaulted to "every mail allowed", so a caller that forgot it mailed with no limit at all;
 *   4. the tree (`createQuickMatchTree`), which builds the whole match or nothing, and with an email queues its link mail;
 *   5. one `quick_match_created` event, carrying no name, email or token (D11); and, when step 3 said no, one info line
 *      naming the match (review m9: how often a guest loses the link mail is countable), with no address and no token.
 *
 * Known gap (recorded): the tree's locked recount (the race guard, B5f) can still refuse TOO_MANY_ALIVE after step 3 spent
 * the mail buckets, when two creates for one visitor race past the early count. Rare, and bounded by the alive cap.
 */
export async function createQuickMatch(
  input: CreateQuickMatch,
  ctx: {
    visitorHash: string;
    baseUrl?: string;
    now?: Date;
    mailAllowed: (email: string) => Promise<boolean>;
    _failBeforeGenerateForTests?: () => void;
  },
): Promise<CreatedGuestQuickMatch> {
  if (!VISITOR_HASH_SHAPE.test(ctx.visitorHash)) {
    throw new HttpError(400, "visitorHash must be a visitor key's sha256 hex", QUICK_MATCH_ERRORS.VISITOR_INVALID);
  }
  if (input.email !== null && !ctx.baseUrl) throw baseUrlMissing();
  const home = sealNewHomeToken();
  const now = ctx.now ?? new Date();

  if ((await alive(sql, ctx.visitorHash, now)) >= QUICK_MATCH_MAX_ALIVE_PER_VISITOR) throw tooManyAlive();

  const { kind, ...rest } = input;
  const offer = await offerFor(input.sport_key, input.variant_key);
  if (!offer.offered) {
    throw new HttpError(
      422,
      `${input.sport_key}/${input.variant_key} is not offered for quick matches`,
      QUICK_MATCH_ERRORS.SPORT_NOT_OFFERED,
    );
  }
  if (!offer.kinds.includes(kind)) {
    throw new HttpError(422, `${input.sport_key} does not take '${kind}' sides`, QUICK_MATCH_ERRORS.KIND_NOT_OFFERED);
  }
  if (input.format === "knockout" && (!offer.knockoutAllowed || input.sides.length < QUICK_MATCH_KNOCKOUT_MIN_SIDES)) {
    throw new HttpError(
      422,
      "a knockout is offered only for three or more sides, in a variant whose matches always produce a winner",
      QUICK_MATCH_ERRORS.FORMAT_NOT_OFFERED,
    );
  }

  const emailLimited = rest.email !== null && !(await ctx.mailAllowed(rest.email));
  const out = await createQuickMatchTree(emailLimited ? { ...rest, email: null } : rest, kind, {
    visitorHash: ctx.visitorHash,
    home,
    baseUrl: ctx.baseUrl,
    now,
    _failBeforeGenerateForTests: ctx._failBeforeGenerateForTests,
  });

  await captureServer({
    event: EVENTS.QUICK_MATCH_CREATED,
    distinctId: QUICK_MATCH_SYSTEM_USER_ID,
    orgId: QUICK_MATCH_SYSTEM_ORG_ID,
    properties: {
      quick_match_id: out.id,
      sport_key: input.sport_key,
      variant_key: input.variant_key,
      kind,
      format: input.format,
      sides: input.sides.length,
      plays: input.plays,
    },
  });
  if (emailLimited) {
    log.info(
      { event: "quick_match_mail_skipped", quick_match_id: out.id, sport_key: input.sport_key },
      "quick match created without its link mail: a mail limit said no",
    );
  }
  return { ...out, emailLimited };
}
