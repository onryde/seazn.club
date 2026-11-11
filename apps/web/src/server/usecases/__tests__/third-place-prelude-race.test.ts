// W4 app B, T18 fix m-1: `patchKnockoutStage` decides whether the sealed stream-setup counts are owed from a read made OUTSIDE the
// division lock (does the root stage hold lines?). A Generate that lands between that read and the locked write used to leave the
// attachment check running on zero sealed counts, so a Play-off switch redrew the bracket over stream setup. The locked read now
// decides: the gap hook below runs a REAL Generate and a real stream code exactly between the two transactions (the withTenant gap
// pattern), and the patch must refuse by name, as it does when the setup was there from the start.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const gap = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>), fired: 0, calls: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    withTenant: async (...a: Parameters<typeof actual.withTenant>) => {
      const out = await actual.withTenant(...a);
      // After the FIRST withTenant a patch opens (its unlocked prelude read) and before the second: the one-shot hook.
      if (gap.hook !== null) {
        gap.calls++;
        const h = gap.hook;
        gap.hook = null;
        gap.fired++;
        await h();
      }
      return out;
    },
  };
});
vi.mock("@/lib/stripe", async (io) => ({
  ...(await io<typeof import("@/lib/stripe")>()),
  getStripe: vi.fn(() => {
    throw new Error("this suite makes no Stripe call");
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { HttpError } from "@/lib/errors";
import { engineBracketRows } from "@/lib/__tests__/engine-bracket-rows";
import { declaredVariant } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { rowsOf } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, patchKnockoutStage } from "../stages";
import { seedOrg } from "./_seed";
import { attachStageSetup } from "./_stage-setup-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A division of four seeded entrants and one root knockout stage with NO lines yet. */
async function ungenerated() {
  const { auth } = await seedOrg("pro");
  const sport = { key: "badminton", variant: declaredVariant("badminton", "bwf") };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "M1 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  await createEntrants(auth, div.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never);
  const [stage] = await createStages(auth, div.id, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
  return { auth, stageId: stage!.id };
}

describe.skipIf(!HAS_DB)("W4 B5b T18 fix m-1: the third-place change decides on the locked read", () => {
  it("lines and a stream code written between the unlocked prelude and the lock: the Play-off switch refuses KO_REDRAW_WOULD_CLEAR_SETUP, the bracket is not redrawn", async () => {
    const r = await ungenerated();
    expect(await rowsOf(r.stageId), "premise: the prelude sees no lines").toHaveLength(0);
    gap.fired = 0;
    gap.hook = async () => {
      await generateStageFixtures(r.auth, r.stageId);
      const semi = (await rowsOf(r.stageId)).find((x) => x.round_no === 1 && x.home_entrant_id && x.away_entrant_id)!;
      await attachStageSetup(r.auth, "stream_code", semi.id);
    };
    const err = await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" }).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(gap.fired, "anti-vacuity: the gap hook ran exactly once").toBe(1);
    expect(err, "a named refusal, not a redraw over the stream setup").toBeInstanceOf(HttpError);
    expect((err as { code?: string }).code).toBe("KO_REDRAW_WOULD_CLEAR_SETUP");
    expect((await rowsOf(r.stageId)).map((x) => x.ext_key).sort(), "the bracket the Generate drew stands, no -3p line").toEqual(
      engineBracketRows(4, false).map((x) => x.ext_key).sort(),
    );
  }, 180_000);

  it("control: the same switch with NO setup written in the gap still succeeds, on the fresh read (the retry is not a refusal)", async () => {
    const r = await ungenerated();
    gap.fired = 0;
    gap.hook = async () => {
      await generateStageFixtures(r.auth, r.stageId);
    };
    const out = await patchKnockoutStage(r.auth, r.stageId, { thirdPlace: "playoff" });
    expect(gap.fired).toBe(1);
    expect(out).toMatchObject({ thirdPlace: "playoff", regenerated: true });
    expect((await rowsOf(r.stageId)).map((x) => x.ext_key).sort()).toEqual(engineBracketRows(4, true).map((x) => x.ext_key).sort());
  }, 180_000);
});
