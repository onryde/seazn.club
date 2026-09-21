// A challenger's reach is measured in LIVE rungs — owner ruling, 2026-09-21.
//
// `config.ladder_order` is written once from the field and never pruned (a
// withdrawal is a status flip, and an entrant can be un-withdrawn), so the
// stored array keeps every departed player's rung. Counting those rungs
// against a challenger silently SHORTENS everyone's reach whenever somebody
// above them leaves — a rule change nobody announced and nobody can see on
// screen, because the published ladder still lists the departed with a
// "withdrawn" badge. The live reading keeps the ladder the same size for the
// people still climbing. The accepted cost runs the other way: a burst of
// withdrawals lets a challenger reach further than she could yesterday,
// which is at least visible and explicable ("three people above you left").
//
// Every number below is derived from `DEFAULT_LADDER_CHALLENGE_RANGE`, the
// one place the default lives, so moving that constant moves this suite with
// it instead of leaving it asserting yesterday's rule. The rig deliberately
// does NOT set `challengeRange`, so the default is what is under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { DEFAULT_LADDER_CHALLENGE_RANGE, createStages, issueChallenge } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const RANGE = DEFAULT_LADDER_CHALLENGE_RANGE;
/** Long enough to hold the furthest case below (`RANGE + 3` rungs above the
 *  top) with a rung to spare. */
const RUNGS = RANGE + 5;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** A ladder of `RUNGS` entrants seeded 1..n and NO `challengeRange` in
 *  config — the default is the rule under test. The order is seated by a real
 *  first challenge (that is how a live ladder gets its array) between the two
 *  adjacent players at the very bottom, who take no part in any case below. */
async function ladder(): Promise<{ auth: AuthCtx; stageId: string; ids: string[] }> {
  const { auth } = await seedOrg("pro");
  await setOrgPlan(auth.orgId, "pro");
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Reach " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: RUNGS }, (_, i) => ({
      kind: "individual" as const,
      display_name: `R${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "ladder" as never,
    name: "Club ladder",
    config: {},
  });
  const ids = entrants.map((e) => e.id);
  // Seat the array: the bottom two rungs challenge each other, one step
  // apart, which is in range under every reading of the rule.
  const out = await issueChallenge(auth, stage!.id, {
    challenger_id: ids[RUNGS - 1]!,
    opponent_id: ids[RUNGS - 2]!,
  });
  expect(out.ladder_order, "the rig did not seat the whole field").toHaveLength(RUNGS);
  expect(out.ladder_order, "the ladder is not in seed order").toEqual(ids);
  return { auth, stageId: stage!.id, ids };
}

async function challengeError(
  auth: AuthCtx,
  stageId: string,
  challenger: string,
  opponent: string,
): Promise<HttpError> {
  const err = await issueChallenge(auth, stageId, {
    challenger_id: challenger,
    opponent_id: opponent,
  }).catch((e: unknown) => e);
  expect(err, "the challenge was ALLOWED").toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe.skipIf(!HAS_DB)("ladder reach is measured in live rungs", () => {
  it("the boundary with nobody gone: exactly RANGE up is allowed, RANGE + 1 is not", async () => {
    // The rule's own edge, with no withdrawals in play at all — so a change
    // that widened or narrowed the comparison itself (`>` vs `>=`) is caught
    // here rather than hiding behind the live/raw difference below.
    const { auth, stageId, ids } = await ladder();
    const top = ids[0]!;

    const ok = await issueChallenge(auth, stageId, { challenger_id: ids[RANGE]!, opponent_id: top });
    expect(ok.fixture_id, "a challenge exactly RANGE places up was refused").toBeTruthy();

    const err = await challengeError(auth, stageId, ids[RANGE + 1]!, top);
    expect(err.status).toBe(422);
    expect(err.code).toBe("LADDER_CHALLENGE_OUT_OF_RANGE");
  });

  it("a challenge that is legal ONLY under live counting now SUCCEEDS", async () => {
    // The witness for the whole ruling. Two players between the challenger
    // and her target have withdrawn: the raw distance is RANGE + 2, which is
    // out of range under the old reading, and the live distance is exactly
    // RANGE, which is in range under the new one. A test whose right answer
    // matched the wrong reading's answer could not see this change at all.
    const { auth, stageId, ids } = await ladder();
    const top = ids[0]!;
    const challenger = ids[RANGE + 2]!;
    await withdrawEntrantCascade(auth, ids[1]!);
    await withdrawEntrantCascade(auth, ids[2]!);

    // The stored order still carries both departed rungs — this is read-time
    // filtering, not a prune, and if it ever became a prune the distances
    // below would be right for the wrong reason.
    const [row] = await sql<{ config: { ladder_order: string[] } }[]>`
      select config from stages where id = ${stageId}`;
    expect(row!.config.ladder_order).toEqual(ids);

    const out = await issueChallenge(auth, stageId, { challenger_id: challenger, opponent_id: top });
    expect(out.fixture_id, "a live-legal challenge was refused").toBeTruthy();
    // …and the ladder itself is untouched by the challenge.
    expect(out.ladder_order).toEqual(ids);
  });

  it("one rung further is still out of range, counted live", async () => {
    // The other side of the same boundary, in the same departed-rung state:
    // live distance RANGE + 1. Without this, "count live" could be read as
    // "stop counting" and every challenge would pass.
    const { auth, stageId, ids } = await ladder();
    await withdrawEntrantCascade(auth, ids[1]!);
    await withdrawEntrantCascade(auth, ids[2]!);

    const err = await challengeError(auth, stageId, ids[RANGE + 3]!, ids[0]!);
    expect(err.status).toBe(422);
    expect(err.code).toBe("LADDER_CHALLENGE_OUT_OF_RANGE");
    // The number the client renders is the configured reach, unchanged by
    // the ruling: what moved is what counts as a place, not how many.
    expect(err.extra).toEqual({ range: RANGE });
  });

  it("a DEPARTED opponent gets the withdrawn refusal, not an out-of-range one", async () => {
    // Precedence. The departed guard runs before the reach check, so a
    // player who challenges someone who has left is told THAT — at a
    // distance which is also out of range under either reading, so the two
    // refusals are genuinely competing for this call and the wrong order
    // would show a customer the wrong reason.
    const { auth, stageId, ids } = await ladder();
    const departedTop = ids[0]!;
    await withdrawEntrantCascade(auth, departedTop);

    const err = await challengeError(auth, stageId, ids[RUNGS - 1]!, departedTop);
    expect(err.status).toBe(422);
    expect(err.code).toBe("LADDER_ENTRANT_WITHDRAWN");
  });

  it("a departed CHALLENGER is refused as withdrawn even when her target is in reach", async () => {
    // The other direction of the same precedence, and the case that proves
    // the live filter cannot be what refuses her: one rung apart is in range
    // under every reading.
    const { auth, stageId, ids } = await ladder();
    await withdrawEntrantCascade(auth, ids[1]!);

    const err = await challengeError(auth, stageId, ids[1]!, ids[0]!);
    expect(err.status).toBe(422);
    expect(err.code).toBe("LADDER_ENTRANT_WITHDRAWN");
  });

  it("a player who is not on the ladder is FOREIGN, not withdrawn and not out of range", async () => {
    // The foreign check keeps reading the RAW order: "is this player on the
    // ladder at all" is a different question from "is she still playing",
    // and each refusal owns its own code and its own four-locale sentence.
    const { auth, stageId, ids } = await ladder();
    const stranger = randomUUID();

    const err = await challengeError(auth, stageId, ids[1]!, stranger);
    expect(err.status).toBe(422);
    expect(err.code).toBe("LADDER_ENTRANT_FOREIGN");
  });

  it("challenging DOWNWARD is still refused, and departed rungs do not change that", async () => {
    // Filtering preserves relative order, so "upward" reads the same over
    // the live array as over the raw one. This pins that it still reads the
    // same after two rungs in between have gone.
    const { auth, stageId, ids } = await ladder();
    await withdrawEntrantCascade(auth, ids[1]!);
    await withdrawEntrantCascade(auth, ids[2]!);

    const err = await challengeError(auth, stageId, ids[0]!, ids[RANGE]!);
    expect(err.status).toBe(422);
    expect(err.code).toBe("LADDER_CHALLENGE_NOT_UPWARD");
  });
});
