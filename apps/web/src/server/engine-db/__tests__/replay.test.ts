// The reconstruction must reproduce what the ORIGINAL append returned, not
// what the fixture looks like NOW. The two differ the moment one more event
// lands, which is the whole reason this is a fold-to-seq and not a
// `match_states` read — that table holds only the current state.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendEvent } from "@/server/engine-db";
import { replayOutcomeFor } from "@/server/engine-db/replay";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { declaredVariant, seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("replayOutcomeFor", () => {
  it("returns the answer the original append gave, not the current state", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;

    await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    const original = await appendEvent(auth.orgId, fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 1 },
      idempotencyKey: key,
    });
    expect(original.status, "the keyed write must actually decide the fixture").toBe("decided");

    // The later event has to move the FOLD, not merely the fixture row.
    // `core.finalize` was the first choice here and it is NOT good enough: it
    // adds no score, and `fixtureStatusFromFold` still answers "decided" off
    // the outcome, so folding the whole ledger produced a byte-identical
    // result and a mutant that removed the seq filter SURVIVED (measured
    // 2026-09-22). A void does move it: it erases the deciding event, so the
    // outcome goes back to null and the status to "in_play".
    const undone = await appendEvent(auth.orgId, fixtureId, 2, {
      type: "core.void",
      payload: { event_id: original.event.id },
      voids: original.event.id,
    });
    expect(undone.outcome, "the rig must actually erase the decision").toBeNull();
    expect(undone.status).toBe("in_play");

    const replayed = await replayOutcomeFor(auth.orgId, fixtureId, key);
    expect(replayed).not.toBeNull();
    expect(replayed!.seq).toBe(original.seq);
    // The headline: the ORIGINAL answer, while the fixture NOW reads in_play
    // with no outcome at all. A reconstruction that folds the whole ledger
    // says "in_play" here, and one that reads `match_states` says the same.
    expect(replayed!.status).toBe("decided");
    // Derived from the original append's OWN return value, never a table typed
    // into this test: a change to the summary shape moves both together.
    expect(replayed!.state_summary).toEqual(original.summary);
    expect(replayed!.outcome).toEqual(original.outcome);
    // Fix A — and the row it wrote, so a retrying pad learns the id a void
    // written elsewhere will name. The original append's own id, not a typed
    // value; the void above proves a later row exists that it must not pick.
    expect(replayed!.event_id).toBe(original.event.id);
    expect(replayed!.event_id).not.toBe(undone.event.id);
  });

  it("X-BR-2: replay of a held knockout fixture reports needs_decision (the stage kind reaches the replay)", async () => {
    // A chess double forfeit folds to no_result (chess.md §7) — a level outcome, which a knockout HOLDS
    // (ruling 79). Not a draw, so the tie-break overlay never opens: the hold is reached directly.
    const s = await seedBracket({ sport: "boardgame", variant: declaredVariant("boardgame", "classical"), stageKind: "knockout", entrants: 2 });
    const fixtureId = s.fixtureIds[0]!;
    const key = `idem-${randomUUID()}`;
    await appendEvent(s.auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    const original = await appendEvent(s.auth.orgId, fixtureId, 1, {
      type: "boardgame.result",
      payload: { winner: null, method: "double_forfeit" },
      idempotencyKey: key,
    });
    expect(original.outcome).toEqual({ kind: "no_result" });
    expect(original.status, "the keyed write must actually hold the fixture").toBe("needs_decision");
    // Move the fold (a void erases the result), so a replay that folded the whole ledger would say in_play.
    const undone = await appendEvent(s.auth.orgId, fixtureId, 2, {
      type: "core.void",
      payload: { event_id: original.event.id },
      voids: original.event.id,
    });
    expect(undone.status).toBe("in_play");
    const replayed = await replayOutcomeFor(s.auth.orgId, fixtureId, key);
    expect(replayed!.status).toBe("needs_decision");
    expect(replayed!.outcome).toEqual(original.outcome);
  });

  it("reports `finalized` for a replayed core.finalize", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;
    await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 1 },
    });
    const original = await appendEvent(auth.orgId, fixtureId, 2, {
      type: "core.finalize",
      payload: {},
      idempotencyKey: key,
    });

    const replayed = await replayOutcomeFor(auth.orgId, fixtureId, key);
    // `fixtureStatusFromFold` alone can NEVER say "finalized" — only
    // `nextStatus` can, and only because it is told the candidate's TYPE. A
    // reconstruction that folds without passing the type reports "decided"
    // here. The pair of tests brackets the rule from both sides.
    expect(original.status).toBe("finalized");
    expect(replayed!.status).toBe("finalized");
  });

  it("returns null for a key this fixture never recorded", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    // The negative's POSITIVE pair is every test above: this fixture has a
    // ledger and a working reconstruction, so a null here is "no such key",
    // not "nothing works".
    expect(await replayOutcomeFor(auth.orgId, fixtureId, `idem-${randomUUID()}`)).toBeNull();
  });

  it("does not answer with ANOTHER fixture's event carrying the same key", async () => {
    const { auth } = await seedOrg();
    const a = await startedDivisionWithFixture(auth);
    const b = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;
    await appendEvent(auth.orgId, a.fixtureId, 0, {
      type: "core.start",
      payload: {},
      idempotencyKey: key,
    });
    // The index permits this (it is scoped per fixture), so the LOOKUP has to
    // be scoped too. A query on idempotency_key alone would hand fixture b
    // fixture a's outcome — a wrong score, silently.
    expect(await replayOutcomeFor(auth.orgId, b.fixtureId, key)).toBeNull();
  });
});
