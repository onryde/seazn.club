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
import { sql, withTenant, type Tx } from "@/lib/db";
import { EVENTS } from "@/lib/analytics-events";
import { HttpError } from "@/lib/errors";
import { captureServer } from "@/lib/posthog-server";
import {
  QUICK_MATCH_ENDS_ON_DAYS,
  QUICK_MATCH_EXPIRY_DAYS,
  QUICK_MATCH_MAX_ALIVE_PER_VISITOR,
  QUICK_MATCH_SYSTEM_ORG_ID,
  QUICK_MATCH_SYSTEM_USER_ID,
} from "@/lib/quick-match-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import type { EntrantKind } from "@seazn/engine/sport";
import { createCompetition } from "./competitions";
import { createDivision } from "./divisions";
import { createEntrants } from "./entrants";
import { hardDeleteQuickMatchCompetition } from "./quick-match-delete";
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
}

/** Every refusal's code (the third `HttpError` argument). The English message is for logs and API callers; plan 2 maps
 *  the code to copy. */
export const QUICK_MATCH_ERRORS = {
  TOO_MANY_ALIVE: "QUICK_MATCH_TOO_MANY_ALIVE",
  FORMAT_NOT_OFFERED: "QUICK_MATCH_FORMAT_NOT_OFFERED",
  SPORT_NOT_OFFERED: "QUICK_MATCH_SPORT_NOT_OFFERED",
  KIND_NOT_OFFERED: "QUICK_MATCH_KIND_NOT_OFFERED",
} as const;

const DAY_MS = 24 * 3600 * 1000;

/** The system user acting in the system org: the actor of every guest-created row (§7.1). Session-shaped, as the pad
 *  page builds its context from a link's issuer and `createFromDraft` builds a draft's. */
export function systemAuth(): AuthCtx {
  return { orgId: QUICK_MATCH_SYSTEM_ORG_ID, via: "session", userId: QUICK_MATCH_SYSTEM_USER_ID, role: "owner", keyId: null };
}

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

/**
 * Build one quick match: UNGUARDED (pre-flight A9) — no offer, kind or format check, and no early per-visitor count;
 * the locked recount in the last transaction is the only cap it applies (the race guard, B5f). Callers: the offer probe
 * and `createQuickMatch`, never a route.
 */
export async function createQuickMatchTree(
  input: Omit<CreateQuickMatch, "kind">,
  kind: EntrantKind,
  ctx: { visitorHash: string; home: SealedHomeToken; now?: Date; _failBeforeGenerateForTests?: () => void },
): Promise<CreatedQuickMatch> {
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
      // transactions, so the second recount sees the first's row. The idiom of schedule.ts's division lock.
      await tx`select pg_advisory_xact_lock(hashtext(${"qm-visitor:" + ctx.visitorHash}))`;
      if ((await alive(tx, ctx.visitorHash, now)) >= QUICK_MATCH_MAX_ALIVE_PER_VISITOR) throw tooManyAlive();
      const write = await generateStageFixturesTx(tx, auth, stage.id, {}, "record");
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
      return { id: row!.id, write, started, expiresAt };
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
 * Create a guest's quick match: what plan 2's route calls. In this order, each step answering before the next runs:
 *   0. the home token is minted, hashed and sealed BEFORE any read or write: a server without DEVICE_LINK_KEK refuses
 *      503 DEVICE_LINK_KEK_MISSING having touched nothing, as device links seal before any write (E2, A4);
 *   1. the early per-visitor count: QUICK_MATCH_MAX_ALIVE_PER_VISITOR alive already → 429 QUICK_MATCH_TOO_MANY_ALIVE,
 *      before anything is built (the locked recount inside the tree is the race guard, B5f);
 *   2. the offer: a sport × variant the probe did not prove → 422 SPORT_NOT_OFFERED; a kind the sport does not take →
 *      422 KIND_NOT_OFFERED (D2); a knockout of a variant whose bracket could stall, or of two sides → 422
 *      FORMAT_NOT_OFFERED (C23 with D10, C16);
 *   3. the tree (`createQuickMatchTree`), which builds the whole match or nothing;
 *   4. one `quick_match_created` event, carrying no name, email or token (D11).
 */
export async function createQuickMatch(
  input: CreateQuickMatch,
  ctx: { visitorHash: string; now?: Date; _failBeforeGenerateForTests?: () => void },
): Promise<CreatedQuickMatch> {
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
  if (input.format === "knockout" && (!offer.knockoutAllowed || input.sides.length <= 2)) {
    throw new HttpError(
      422,
      "a knockout is offered only for three or more sides, in a variant whose matches always produce a winner",
      QUICK_MATCH_ERRORS.FORMAT_NOT_OFFERED,
    );
  }

  const out = await createQuickMatchTree(rest, kind, {
    visitorHash: ctx.visitorHash,
    home,
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
  return out;
}
