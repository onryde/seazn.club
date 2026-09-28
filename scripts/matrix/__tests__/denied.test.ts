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
import type { StageRef, StagesProbe } from "../lib/driver/types.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import { DENIED_CHECKS, DeniedMisuse, PAYMENT_REFUSAL, denied } from "../lib/scenarios/denied.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
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

const GATED = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
const UNGATED = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) === null);
const firstVariant = (sport: string): string => Object.keys(sportModule(sport).variants as object)[0] ?? "";
const spec = (row: RowKey, sport = "generic", variant = "score"): CaseSpec =>
  ({ caseId: `${row}|${sport}|${variant}|DENIED`, row, sport, variant, scenario: "DENIED", canary: false, deny: [productGateOf(row) ?? "(ungated)"] });
const ctx = (s: CaseSpec, driver: FakeDeniedDriver) => ({ driver, spec: s, orgSlug: "o", cfg: null, tag: "t" });
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
    const http = read("apps/web/src/server/api-v1/http.ts");
    const branch = /if \(err instanceof PaymentRequiredError\) \{[\s\S]*?return errorResponse\(requestId, (\d{3}), "([A-Z_]+)", err\.message, \{([\s\S]*?)\}\);/.exec(http);
    expect(branch, "api-v1/http.ts PaymentRequiredError branch moved").not.toBeNull();
    expect(PAYMENT_REFUSAL).toEqual({ status: Number(branch?.[1]), code: branch?.[2] });
    expect(branch?.[3]).toMatch(/\bfeature_key: err\.featureKey,/);
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
  it("declares a mandated refusal naming the gate, refuses one for an ungated row, and opts out of the fixture invariants", () => {
    expect(denied.key).toBe("DENIED");
    expect(denied.canaryCheck).toBeNull();
    expect(denied.evaluatesInvariants).toBe(false);
    expect(denied.mandatedRefusal?.(spec("ladder"))).toBe(`denied: ${DENY.get("ladder") ?? "(none)"} (ruling 24)`);
    expect(denied.mandatedRefusal?.(spec("page_playoff_only"))).toBe(`denied: ${DENY.get("page_playoff") ?? "(none)"} (ruling 24)`);
    expect(() => denied.mandatedRefusal?.(spec("league"))).toThrow(DeniedMisuse);
  });
});
