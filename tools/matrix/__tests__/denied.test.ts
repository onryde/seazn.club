// ⛔ denied (ruling 24). The fake product's gate table is read from the
// PRODUCT's own source — each gate function's `kind === "…"` terms
// (usecases/format-gates.ts) keyed by the feature createStages requires after
// it, in createStages' order (usecases/stages.ts) — never from expectedGate,
// the copy the scenario reads. The 402 envelope the scenario expects is pinned
// against api-v1/http.ts the same way.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow, type RowKey, type StagePostBody } from "../lib/catalogue.ts";
import { RefusedCall, type StageRef, type StagesProbe } from "../lib/driver/types.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import { DENIED_CHECKS, DeniedMisuse, PAYMENT_REFUSAL, denied } from "../lib/scenarios/denied.ts";
import type { CaseSpec, ScenarioContext } from "../lib/scenarios/types.ts";
import { sportModule } from "../lib/sport-cfg.ts";
import { FakeDeniedDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string): string => readFileSync(resolve(REPO, p), "utf8");
const bodyOf = (src: string, head: string): string => {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`denied.test: ${head} not found`);
  const end = src.indexOf("\n}\n", at);
  if (end < 0) throw new Error(`denied.test: ${head} has no closing brace`);
  return src.slice(at, end);
};

/** The product's gates in createStages order: which feature each requires and
 *  which stage kinds its body names. */
function productGates(): { fn: string; key: string; kinds: string[] }[] {
  const create = bodyOf(read("apps/web/src/server/usecases/stages.ts"), "export async function createStages(");
  const gates = read("apps/web/src/server/usecases/format-gates.ts");
  return [...create.matchAll(/(stageNeeds\w+Gate)\([\s\S]*?requireFeature\(auth\.orgId, "([^"]+)"/g)].map((m) => ({
    fn: m[1] ?? "",
    key: m[2] ?? "",
    kinds: [...bodyOf(gates, `export function ${m[1] ?? ""}(`).matchAll(/kind === "([a-z_]+)"/g)].map((k) => k[1] ?? ""),
  }));
}
const GATES = productGates();
/** kind → feature_key, in the order the product checks (a kind named by two
 *  gates answers the first). The fake refuses by this table, first entry first. */
const DENY: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const g of GATES) for (const k of g.kinds) if (!m.has(k)) m.set(k, g.key);
  return m;
})();
/** The product's gate for a row: the first gate, in createStages order, one of whose kinds the row posts. */
const productGateOf = (row: RowKey): string | null => GATES.find((g) => stagesForRow(row).some((s) => g.kinds.includes(s.kind)))?.key ?? null;

/** api-v1's answer to a PaymentRequiredError, as http.ts spells it. */
const HTTP_402 = (() => {
  const m = /if \(err instanceof PaymentRequiredError\) \{[\s\S]*?return errorResponse\(requestId, (\d{3}), "([A-Z_]+)", err\.message, \{([\s\S]*?)\}\);/.exec(read("apps/web/src/server/api-v1/http.ts"));
  return { status: Number(m?.[1]), code: m?.[2] ?? "(PaymentRequiredError branch moved)", extras: m?.[3] ?? "" };
})();

const GATED = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
const UNGATED = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) === null);
const firstVariant = (sport: string): string => Object.keys(sportModule(sport).variants as object)[0] ?? "";
const spec = (row: RowKey, sport = "generic", variant = "score"): CaseSpec =>
  ({ caseId: `${row}|${sport}|${variant}|DENIED`, row, sport, variant, scenario: "DENIED", canary: false, deny: [productGateOf(row) ?? "(ungated)"] });
/** `denied` is what prepareCaseOrg applied; by default the org got what the spec asked for. */
const ctx = (s: CaseSpec, driver: FakeDeniedDriver, applied: readonly string[] = s.deny ?? []): ScenarioContext =>
  ({ driver, spec: s, orgSlug: "o", cfg: null, tag: "t", denied: applied });
const check = (out: Awaited<ReturnType<typeof denied.run>>, id: (typeof DENIED_CHECKS)[number]) => {
  const c = out.assertions.find((a) => a.id === id);
  if (c === undefined) throw new Error(`denied.test: no ${id} check`);
  return c;
};

describe("the product's gate table (the fake's source of truth)", () => {
  it("createStages checks two gates, double_elim first, each naming at least one kind (ruling 24)", () => {
    expect(GATES.map((g) => g.key)).toEqual(["formats.double_elim", "formats.advanced"]);
    for (const g of GATES) expect(g.kinds.length, g.fn).toBeGreaterThan(0);
    expect(DENY.size).toBe(new Set(GATES.flatMap((g) => g.kinds)).size);
  });
  it("the 402 the scenario expects is api-v1's PaymentRequiredError answer, and it carries feature_key", () => {
    expect(HTTP_402.code, "api-v1/http.ts PaymentRequiredError branch moved").toMatch(/^[A-Z_]+$/);
    expect(PAYMENT_REFUSAL).toEqual({ status: HTTP_402.status, code: HTTP_402.code });
    expect(HTTP_402.extras).toMatch(/\bfeature_key: err\.featureKey,/);
  });
});

describe("DENIED scenario", () => {
  it("sweeps the seven gated rows (false premise 7), and the scenario's gate is the product's for each", () => {
    expect(GATED.length).toBe(7);
    for (const r of GATED) expect(expectedGate(stagesForRow(r)), r).toBe(productGateOf(r));
  });
  it("gate-first product: all three checks pass on every gated row in every sport, each over ≥1 item", async () => {
    // The gate is sport-independent (format-gates.ts reads kind and config
    // only), so the probe plans generic; this proves the scenario has no sport
    // branch either.
    let n = 0;
    for (const row of GATED) for (const sport of SPORT_KEYS) {
      const out = await denied.run(ctx(spec(row, sport, firstVariant(sport)), new FakeDeniedDriver(DENY, { deleteFirst: false })));
      expect(out.assertions.map((a) => a.id)).toEqual([...DENIED_CHECKS]);
      for (const a of out.assertions) {
        expect(a.verdict, `${row}|${sport} ${a.id}: ${a.reason}`).toBe("pass");
        expect(a.checked).toBeGreaterThan(0);
      }
      n++;
    }
    expect(SPORT_KEYS.length).toBeGreaterThan(0);
    expect(n).toBe(7 * SPORT_KEYS.length);
  });
  it("reads back after the refused POST: the call sequence", async () => {
    const d = new FakeDeniedDriver(DENY, { deleteFirst: false });
    await denied.run(ctx(spec("ladder"), d));
    expect(d.calls).toEqual(["createCompetition", "createDivision", "postStages", "listStages", "createDivision", "postStages", "replaceStagesProbe", "listStages"]);
  });
  it("delete-first product (today's replaceStages, stages.ts:543 before :373): ONLY denied-put-keeps-stages fails, naming the lost stage", async () => {
    let n = 0;
    for (const row of GATED) {
      const out = await denied.run(ctx(spec(row), new FakeDeniedDriver(DENY, { deleteFirst: true })));
      const put = check(out, "denied-put-keeps-stages");
      expect(put.verdict, row).toBe("fail");
      expect(put.evidence.join(" ")).toMatch(/league stage .* gone after the refused PUT/);
      expect(out.assertions.filter((a) => a.verdict === "fail").map((a) => a.id)).toEqual(["denied-put-keeps-stages"]);
      n++;
    }
    expect(n).toBe(7);
  });
  it("a product that does NOT refuse the gated row reds denied-refused-named and denied-nothing-created (the witness the other way)", async () => {
    const out = await denied.run(ctx(spec("double_elim"), new FakeDeniedDriver(new Map(), { deleteFirst: false })));
    expect(check(out, "denied-refused-named").verdict).toBe("fail");
    expect(check(out, "denied-refused-named").evidence.join(" ")).toContain("none (accepted)");
    expect(check(out, "denied-nothing-created").verdict).toBe("fail");
  });
  it("a refusal naming the WRONG feature reds denied-refused-named, and says which one it wanted", async () => {
    const wrong = new Map([...DENY].map(([k]) => [k, "formats.other"]));
    const out = await denied.run(ctx(spec("double_elim"), new FakeDeniedDriver(wrong, { deleteFirst: false })));
    const named = check(out, "denied-refused-named");
    expect(named.verdict).toBe("fail");
    expect(named.evidence.join(" ")).toContain("want formats.double_elim");
  });
  // Fix round 1 (I-1): one witness per named item. The product refuses
  // gate-first, so both divisions keep their stages. Each witness changes
  // exactly ONE thing about one refusal, and only that item may fail.
  describe("each named-refusal item has its own witness: one field wrong, everything else right", () => {
    /** The gate-first product, with `skew` spread over the POST refusal and/or the PUT's answer. */
    class Skewed extends FakeDeniedDriver {
      readonly skew: { post?: Partial<StagesProbe>; put?: Partial<StagesProbe> };
      constructor(skew: { post?: Partial<StagesProbe>; put?: Partial<StagesProbe> }) {
        super(DENY, { deleteFirst: false });
        this.skew = skew;
      }
      override postStages(d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
        return super.postStages(d, stages).catch((e: unknown) => {
          if (!(e instanceof RefusedCall) || this.skew.post === undefined) throw e;
          const p = { status: e.status, code: e.code, featureKey: e.featureKey, ...this.skew.post };
          throw new RefusedCall(e.method, e.path, p.status, p.code, "skewed", p.featureKey);
        });
      }
      override async replaceStagesProbe(d: string, stages: readonly StagePostBody[]): Promise<StagesProbe> {
        return { ...(await super.replaceStagesProbe(d, stages)), ...this.skew.put };
      }
    }
    // One row per gate: the items are row-independent (the sweep above covers
    // every gated row), and each gate's own key must be the one wanted.
    const ROWS: RowKey[] = GATES.map((g) => GATED.find((r) => productGateOf(r) === g.key)).filter((r): r is RowKey => r !== undefined);
    const otherKey = (want: string): string => GATES.find((g) => g.key !== want)?.key ?? "(none)";
    const cases = (want: string) => [
      { name: "POST status", skew: { post: { status: 403 } }, id: "denied-refused-named", evidence: [`POST stages: status 403, want ${HTTP_402.status}`] },
      { name: "POST code", skew: { post: { code: "UPGRADE_REQUIRED" } }, id: "denied-refused-named", evidence: [`POST stages: code UPGRADE_REQUIRED, want ${HTTP_402.code}`] },
      { name: "POST feature_key", skew: { post: { featureKey: otherKey(want) } }, id: "denied-refused-named", evidence: [`POST stages: feature_key ${otherKey(want)}, want ${want}`] },
      { name: "PUT status", skew: { put: { status: 403 } }, id: "denied-put-keeps-stages", evidence: [`PUT stages: status 403, want ${HTTP_402.status}`] },
      { name: "PUT code", skew: { put: { code: "FORMAT_LOCKED" } }, id: "denied-put-keeps-stages", evidence: [`PUT stages: code FORMAT_LOCKED, want ${HTTP_402.code}`] },
      { name: "PUT feature_key", skew: { put: { featureKey: otherKey(want) } }, id: "denied-put-keeps-stages", evidence: [`PUT stages: feature_key ${otherKey(want)}, want ${want}`] },
      // A W9 fix that gates before the delete but answers another refusal: the stages stay, the answer is wrong.
      { name: "PUT 409 FORMAT_LOCKED", skew: { put: { status: 409, code: "FORMAT_LOCKED", featureKey: null } }, id: "denied-put-keeps-stages", evidence: [`PUT stages: status 409, want ${HTTP_402.status}`, `PUT stages: code FORMAT_LOCKED, want ${HTTP_402.code}`, `PUT stages: feature_key none, want ${want}`] },
    ] as const;

    it("the witnesses are built from the product's two gates, each wanting its own key", () => {
      expect(ROWS).toEqual(GATED.filter((r) => ROWS.includes(r)));
      expect(ROWS.map((r) => productGateOf(r))).toEqual(["formats.double_elim", "formats.advanced"]);
      expect(ROWS.map((r) => otherKey(productGateOf(r) ?? ""))).toEqual(["formats.advanced", "formats.double_elim"]);
    });
    it("the unskewed product passes all three checks (the baseline every witness departs from)", async () => {
      for (const row of ROWS) {
        const out = await denied.run(ctx(spec(row), new Skewed({})));
        expect(out.assertions.filter((a) => a.verdict !== "pass").map((a) => a.id), row).toEqual([]);
      }
    });
    const TABLE = ROWS.flatMap((row) => cases(productGateOf(row) ?? "(ungated)").map((c) => ({ row, ...c })));
    it("the witness table holds seven witnesses per gate (a table of none would pass vacuously)", () => {
      expect(TABLE.length).toBe(ROWS.length * 7);
      expect(TABLE.length).toBeGreaterThan(0);
    });
    it.each(TABLE.map((t) => [`${t.row}: ${t.name}`, t] as const))("%s — fails ONLY its own check, with ONLY its own note as evidence", async (_label, t) => {
      const out = await denied.run(ctx(spec(t.row), new Skewed(t.skew)));
      expect(out.assertions.filter((a) => a.verdict === "fail").map((a) => a.id)).toEqual([t.id]);
      expect(check(out, t.id).evidence).toEqual([...t.evidence]);
    });
  });
  it("a product that refuses AFTER inserting reds denied-nothing-created: the read-back is judged, not the refusal", async () => {
    class GatesLate extends FakeDeniedDriver {
      override postStages(d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
        this.byDivision.set(d, stages.map((s, k) => ({ id: `${d}-late${k + 1}`, seq: s.seq, kind: s.kind, config: {}, status: "pending" })));
        return super.postStages(d, stages);
      }
    }
    const out = await denied.run(ctx(spec("double_elim"), new GatesLate(DENY, { deleteFirst: false })));
    expect(check(out, "denied-refused-named").verdict).toBe("pass");
    expect(check(out, "denied-nothing-created").verdict).toBe("fail");
    expect(check(out, "denied-nothing-created").evidence).toEqual(["1 stage(s) exist after the refused POST"]);
  });
  it("the kept-stage items cannot pass vacuously: a working POST that built no stage reds denied-put-keeps-stages", async () => {
    class BuildsNothing extends FakeDeniedDriver {
      override postStages(d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
        return d === "d2" ? super.postStages(d, stages).then(() => { this.byDivision.set(d, []); return []; }) : super.postStages(d, stages);
      }
    }
    const put = check(await denied.run(ctx(spec("double_elim"), new BuildsNothing(DENY, { deleteFirst: false }))), "denied-put-keeps-stages");
    expect(put.verdict).toBe("fail");
    expect(put.evidence.join(" ")).toMatch(/built no stage/);
  });
  it("a refused PUT that keeps the league but ALSO leaves a gated stage behind reds denied-put-keeps-stages", async () => {
    class HalfApplies extends FakeDeniedDriver {
      override async replaceStagesProbe(d: string, stages: readonly StagePostBody[]): Promise<StagesProbe> {
        const out = await super.replaceStagesProbe(d, stages);
        this.byDivision.set(d, [...(this.byDivision.get(d) ?? []), { id: `${d}-x`, seq: 9, kind: stages[0]?.kind ?? "", config: {}, status: "pending" }]);
        return out;
      }
    }
    const put = check(await denied.run(ctx(spec("double_elim"), new HalfApplies(DENY, { deleteFirst: false }))), "denied-put-keeps-stages");
    expect(put.verdict).toBe("fail");
    expect(put.evidence.join(" ")).toMatch(/2 stage\(s\) after the refused PUT, want the 1 kept/);
  });
  it("every ungated row is a misuse, refused by name before any call", async () => {
    let n = 0;
    for (const row of UNGATED) {
      const d = new FakeDeniedDriver(DENY, { deleteFirst: false });
      await expect(denied.run(ctx(spec(row), d))).rejects.toThrow(new RegExp(`${row} is not a gated row`));
      await expect(denied.run(ctx(spec(row), d))).rejects.toBeInstanceOf(DeniedMisuse);
      expect(d.callCount).toBe(0);
      n++;
    }
    expect(n).toBe(ROW_KEYS.length - 7);
    expect(n).toBeGreaterThan(0);
  });
  it("a case whose org carries no deny for its gate is refused by name before any call (an accepted POST would read as a product miss)", async () => {
    let n = 0;
    for (const deny of [undefined, [], ["formats.advanced"]]) {
      const d = new FakeDeniedDriver(DENY, { deleteFirst: false });
      await expect(denied.run(ctx({ ...spec("double_elim"), deny }, d))).rejects.toThrow(/carries no deny for formats\.double_elim/);
      expect(d.callCount).toBe(0);
      n++;
    }
    expect(n).toBe(3);
  });
  // Fix round 1 (m-1): the guard reads the deny prepareCaseOrg APPLIED. A hop
  // that dropped it (the spec still asking) must be named, never read as a
  // product that forgot its paywall.
  it("the spec asks for the deny but the org was never denied: refused by name before any call, naming both sets", async () => {
    let n = 0;
    for (const applied of [[], ["formats.advanced"]]) {
      const d = new FakeDeniedDriver(DENY, { deleteFirst: false });
      const s = spec("double_elim");
      expect(s.deny).toEqual(["formats.double_elim"]);
      const err = await denied.run(ctx(s, d, applied)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeniedMisuse);
      expect((err as Error).message).toMatch(/carries no deny for formats\.double_elim \(applied: [^)]*; asked: formats\.double_elim\)/);
      expect(d.callCount).toBe(0);
      n++;
    }
    expect(n).toBe(2);
  });
  it("the applied deny is what counts: applied but not asked still runs (the org IS denied)", async () => {
    const out = await denied.run(ctx({ ...spec("double_elim"), deny: [] }, new FakeDeniedDriver(DENY, { deleteFirst: false }), ["formats.double_elim"]));
    expect(out.assertions.map((a) => a.verdict)).toEqual(["pass", "pass", "pass"]);
  });
  it("declares a mandated refusal naming the gate, refuses one for an ungated row, and opts out of the fixture invariants", () => {
    expect(denied.key).toBe("DENIED");
    expect(denied.canaryCheck).toBeNull();
    expect(denied.evaluatesInvariants).toBe(false);
    expect(denied.mandatedRefusal?.(spec("ladder"))).toBe(`denied: ${DENY.get("ladder") ?? "(none)"} (ruling 24)`);
    expect(denied.mandatedRefusal?.(spec("page_playoff_only"))).toBe(`denied: ${DENY.get("page_playoff") ?? "(none)"} (ruling 24)`);
    expect(() => denied.mandatedRefusal?.(spec("league"))).toThrow(DeniedMisuse);
  });
});
