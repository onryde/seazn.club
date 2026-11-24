// Online Chess covers Swiss and knockout only (spec 2026-11-23-online-chess-credits-design.md §3 decision 9, §7.6 "Format", P16;
// plan Task 8). The refusal lives at BOTH ends, or one covers for the other: the online switch (a division holding a refused
// stage cannot turn online play on) and every door that adds or changes a stage of an online division (`createStages` and
// `replaceStages`, which share `insertStageBatch`). REAL doors against a REAL database (skipped without DATABASE_URL).
//
// Where the expected verdicts come from — never from the leaf's lists or the gate:
//   * P16 types them: swiss, knockout, double_elim, page_playoff and stepladder are allowed; league, group and ladder are refused;
//     americano (the pair-minting kind) is refused too (controller ruling: not in the allowed list). The registry the sweep
//     loops is `StageKind` (the API's own enum, the nine kinds `stages_kind_check` allows): the partition is asserted against it,
//     and the count judged equals its length, and is above zero.
//   * the refusal's body is `{ kind }`, the kind that was refused.
//
// Legacy: online + league divisions exist on staging (test data). The gates refuse only on CHANGE (turning online play on, adding or
// changing a stage), so a legacy division stays readable and its unrelated saves keep working.
//
// single-sport: Online Chess is boardgame only (`supportsOnlinePlay`); every other sport cannot turn online play on at all.
//
// Mutant table (each run once by hand; results in the commit message):
//   F1 the switch gate removed (patch.ts)                       -> the switch sweep's four refused kinds
//   F2 the add gate removed (insertStageBatch)                  -> the add sweep's three refused kinds, the replace refusal
//   F3 the allow-list read as the refused list (americano slips) -> the americano cells
//   F4 the add gate asked of a division that is not online      -> "a division that is not online takes every kind"
//   F5 the switch gate asked of a re-send of a stored lichess   -> the legacy division's unrelated saves
//   F6 the add gate asked of a frozen package                    -> "once a round has opened the format is not asked
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql } from "@/lib/db";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { StageKind } from "@/server/api-v1/schemas/common";
import { patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { createStages, previewReplaceStages, replaceStages } from "@/server/usecases/stages";
import {
  CLOCK, freezeGrandfathered, liveOf, ocCompetition, ocDivision, ocOrg, packagesOf, refusal, seedStageKind, stageKindsOf, suffix, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

/** P16, typed from the spec. */
const SPEC_ALLOWED = ["swiss", "knockout", "double_elim", "page_playoff", "stepladder"] as const;
/** P16's three, and americano (refused for chess by the pair-minting rule; not in the allowed list). */
const SPEC_REFUSED = ["league", "group", "ladder", "americano"] as const;
const ALLOWED: ReadonlySet<string> = new Set(SPEC_ALLOWED);

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const ON = { variant: "classical", onlinePlay: "lichess", clock: CLOCK };
const switchOn = (o: Org, id: string) => patchDivision(o.auth, id, { config: ON });
const storedOnline = async (id: string) => (await sql<{ m: string | null }[]>`select config->>'onlinePlay' as m from divisions where id = ${id}`)[0]!.m;

/** A progression a stepladder or page playoff takes (the product refuses either with none): the top of the previous stage's table. */
const fromTable = (to: number) => ({
  sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to }] }],
  placement: "rank_order",
  timing: "on_complete",
});
const SWISS_FIRST = { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } };

/** The stage batch that writes ONE stage of `kind` through the real door: the kinds that only seed from a table follow a Swiss. */
function batchFor(kind: string): unknown {
  if (kind === "swiss") return [SWISS_FIRST];
  if (kind === "stepladder") return [SWISS_FIRST, { seq: 2, kind, name: "Ladder finals", config: {}, progression: fromTable(3) }];
  if (kind === "page_playoff") return [SWISS_FIRST, { seq: 2, kind, name: "Playoffs", config: {}, progression: fromTable(4) }];
  if (kind === "group") return [{ seq: 1, kind, name: "Groups", config: { legs: 1, pools: { count: 2 } } }];
  return [{ seq: 1, kind, name: `T8 ${kind}`, config: {} }];
}

/** The shape every kind's refusal must have: 422, the code, the kind that was refused. */
const formatRefusal = (kind: string) => ({ status: 422, code: ONLINE_PACKAGE_CODES.formatNotSupported, extra: { kind } });

describe.skipIf(!HAS_DB)("the registry's stage kinds, and which of them Online Chess takes (P16)", () => {
  it("the spec's allowed and refused kinds partition the registry exactly", () => {
    const registry = [...StageKind.options];
    expect(registry.length, "the registry holds kinds").toBeGreaterThan(0);
    expect([...SPEC_ALLOWED, ...SPEC_REFUSED].sort()).toEqual([...registry].sort());
  });
});

describe.skipIf(!HAS_DB)("the online switch: a division holding a stage turns online play on, or answers ONLINE_FORMAT_NOT_SUPPORTED", () => {
  it("every stage kind in the registry: the allowed turn it on and get an unpaid row; the refused answer the kind, and nothing is written", async () => {
    const o = await ocOrg();
    const c = await ocCompetition(o);
    let checked = 0;
    for (const kind of StageKind.options) {
      const d = await ocDivision(o, c, { online: false });
      await seedStageKind(o.orgId, d.id, kind, kind === "swiss" ? { rounds: 3 } : {});
      if (ALLOWED.has(kind)) {
        await switchOn(o, d.id);
        expect(await storedOnline(d.id), `${kind}: online play is on`).toBe("lichess");
        expect(await packagesOf(d.id), `${kind}: one unpaid row`).toHaveLength(1);
      } else {
        const err = await refusal(switchOn(o, d.id));
        expect({ status: err.status, code: err.code, extra: err.extra }, `${kind}`).toEqual(formatRefusal(kind));
        expect(await storedOnline(d.id), `${kind}: the division stays off`).not.toBe("lichess");
        expect(await packagesOf(d.id), `${kind}: no package row`).toEqual([]);
      }
      checked += 1;
    }
    expect(checked, "kinds judged").toBeGreaterThan(0);
    expect(checked, "every kind of the registry").toBe(StageKind.options.length);
  });

  it("the first refused kind is named, and removing it lets the second attempt through (the sequence)", async () => {
    const o = await ocOrg();
    const c = await ocCompetition(o);
    const d = await ocDivision(o, c, { online: false });
    await seedStageKind(o.orgId, d.id, "swiss", { rounds: 3 });
    const group = await seedStageKind(o.orgId, d.id, "group");
    await seedStageKind(o.orgId, d.id, "league");
    const first = await refusal(switchOn(o, d.id));
    expect(first.extra, "seq order: the group, not the league").toEqual({ kind: "group" });
    await sql`delete from stages where id = ${group}`;
    const second = await refusal(switchOn(o, d.id));
    expect(second.extra, "the league is the next").toEqual({ kind: "league" });
    await sql`delete from stages where division_id = ${d.id} and kind = 'league'`;
    await switchOn(o, d.id);
    expect(await storedOnline(d.id)).toBe("lichess");
    expect(await stageKindsOf(d.id)).toEqual(["swiss"]);
  });
});

describe.skipIf(!HAS_DB)("an online division cannot gain a refused stage (createStages)", () => {
  it("every stage kind in the registry: the allowed are written; the refused answer the kind (americano: the chess rule), and nothing is written", async () => {
    const o = await ocOrg();
    const c = await ocCompetition(o);
    let checked = 0;
    for (const kind of StageKind.options) {
      const d = await ocDivision(o, c);
      if (ALLOWED.has(kind)) {
        await createStages(o.auth, d.id, batchFor(kind) as never);
        const stored = await stageKindsOf(d.id);
        expect(stored, `${kind}: written`).toContain(kind);
      } else {
        const err = await refusal(createStages(o.auth, d.id, batchFor(kind) as never));
        if (kind === "americano") {
          // Chess refuses the pair-minting kind before the online gate is asked: its own code, a different door.
          expect({ status: err.status, code: err.code }, kind).toEqual({ status: 422, code: "CHESS_INDIVIDUAL_ONLY" });
        } else {
          expect({ status: err.status, code: err.code, extra: err.extra }, kind).toEqual(formatRefusal(kind));
        }
        expect(await stageKindsOf(d.id), `${kind}: nothing written`).toEqual([]);
      }
      checked += 1;
    }
    expect(checked, "kinds judged").toBeGreaterThan(0);
    expect(checked, "every kind of the registry").toBe(StageKind.options.length);
  });

  it("one refused stage in a batch refuses the whole batch: the allowed stage beside it is not written either", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o));
    const err = await refusal(createStages(o.auth, d.id, [SWISS_FIRST, { seq: 2, kind: "league", name: "League", config: {} }] as never));
    expect({ status: err.status, code: err.code, extra: err.extra }).toEqual(formatRefusal("league"));
    expect(await stageKindsOf(d.id), "the swiss was rolled back with it").toEqual([]);
    await createStages(o.auth, d.id, [SWISS_FIRST] as never); // the same division takes the allowed stage on the next call
    expect(await stageKindsOf(d.id)).toEqual(["swiss"]);
  });

  it("a division that is not online takes every kind: the gate asks the division, not the kind", async () => {
    const o = await ocOrg();
    const c = await ocCompetition(o);
    let checked = 0;
    for (const kind of ["league", "group", "ladder"] as const) {
      const d = await ocDivision(o, c, { online: false });
      await createStages(o.auth, d.id, batchFor(kind) as never);
      expect(await stageKindsOf(d.id), kind).toEqual([kind]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("the Format dialog's replace (replaceStages) and its dry-run preview ask the same question", () => {
  it("an online division with a Swiss: replaced by a league is refused and the Swiss stands; replaced by a knockout it goes through", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o));
    await createStages(o.auth, d.id, batchFor("swiss") as never);

    const err = await refusal(replaceStages(o.auth, d.id, batchFor("league") as never));
    expect({ status: err.status, code: err.code, extra: err.extra }).toEqual(formatRefusal("league"));
    expect(await stageKindsOf(d.id), "the delete rolled back with the refusal").toEqual(["swiss"]);

    // The preview is the same path rolled back: the refusal is raised at Save, before a confirm is asked.
    const preview = await refusal(previewReplaceStages(o.auth, d.id, batchFor("group") as never));
    expect({ status: preview.status, code: preview.code, extra: preview.extra }).toEqual(formatRefusal("group"));
    expect(await stageKindsOf(d.id)).toEqual(["swiss"]);

    await replaceStages(o.auth, d.id, batchFor("knockout") as never);
    expect(await stageKindsOf(d.id)).toEqual(["knockout"]);
  });
});

describe.skipIf(!HAS_DB)("a legacy online division holding a league: readable, its unrelated saves keep working, only a CHANGE is refused", () => {
  it("rename, a re-sent config (stored lichess), a re-sent size and a camera change are saved; adding a league is refused; adding a Swiss is not", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o));
    await seedStageKind(o.orgId, d.id, "league"); // the legacy stage: online play was already on when it was written
    expect(await storedOnline(d.id), "premise: the division plays online").toBe("lichess");
    expect(await stageKindsOf(d.id), "premise: it holds a league").toEqual(["league"]);
    const row = await liveOf(d.id);

    const renamed = await patchDivision(o.auth, d.id, { name: `Legacy ${suffix()}` });
    expect(renamed.name).toMatch(/^Legacy /);
    await switchOn(o, d.id); // every Entrants and format save re-sends the whole config
    await patchDivision(o.auth, d.id, { config: ON, online_size: 16 }); // and a re-send of the stored size
    await patchDivision(o.auth, d.id, { camera_policy: "optional" });
    expect(await liveOf(d.id), "none of them touched the package").toMatchObject({ id: row.id, size: 16, paid_at: null });
    expect(await stageKindsOf(d.id), "the stored league is untouched").toEqual(["league"]);

    const added = await refusal(createStages(o.auth, d.id, [{ seq: 2, kind: "league", name: "More league", config: {} }] as never));
    expect(added.extra).toEqual({ kind: "league" });
    await createStages(o.auth, d.id, [{ seq: 2, kind: "swiss", name: "Swiss", config: { rounds: 3 } }] as never);
    expect(await stageKindsOf(d.id), "an allowed kind is added beside it").toEqual(["league", "swiss"]);
  });
});

describe.skipIf(!HAS_DB)("once a round has opened (the package is frozen) the format is not asked (all three gates are before round 1)", () => {
  it("a frozen online division takes a league batch; the same batch is refused the moment before it froze", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o));
    const err = await refusal(createStages(o.auth, d.id, [{ seq: 1, kind: "league", name: "League", config: {} }] as never));
    expect(err.extra, "premise: refused while unfrozen").toEqual({ kind: "league" });
    await freezeGrandfathered((await liveOf(d.id)).id);
    await createStages(o.auth, d.id, [{ seq: 1, kind: "league", name: "League", config: {} }] as never);
    expect(await stageKindsOf(d.id)).toEqual(["league"]);
  });
});
