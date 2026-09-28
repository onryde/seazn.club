// ⛔ denied (ruling 24): the case org carries an org_entitlement_overrides
// deny for the row's gate. Three assertions: the refusal is named (402
// PAYMENT_REQUIRED + the gate's feature_key); nothing was created; and a PUT
// replacing working stages with the gated body keeps them (false premise 8:
// replaceStages deletes before createStages gates — a red here routes to W9).
//
// PAYMENT_REQUIRED is a generic code (observed.ts GENERIC_ERROR_CODES), so
// isNamedRefusal answers no for it: the feature_key is what names the gate.
import { stagesForRow } from "../catalogue.ts";
import { RefusedCall, type StagesProbe } from "../driver/types.ts";
import { expectedGate, type FormatGate } from "../format-gates-copy.ts";
import { assertion, type Item } from "./assertions.ts";
import type { CaseSpec, Scenario, ScenarioContext, ScenarioOutput } from "./types.ts";

export const DENIED_CHECKS = ["denied-refused-named", "denied-nothing-created", "denied-put-keeps-stages"] as const;

/** What api-v1 answers a PaymentRequiredError with (server/api-v1/http.ts;
 *  text-pinned by denied.test.ts). */
export const PAYMENT_REFUSAL = Object.freeze({ status: 402, code: "PAYMENT_REQUIRED" } as const);

/** The stage graph the PUT probe replaces: the builder's own league body,
 *  which no gate reads (denied.test.ts runs it through the product's table). */
const WORKING_ROW = "league";

/** The harness asked for a denied case it cannot mean. Thrown before any call. */
export class DeniedMisuse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeniedMisuse";
  }
}

const gateOf = (spec: CaseSpec): FormatGate => {
  const g = expectedGate(stagesForRow(spec.row));
  if (g === null) throw new DeniedMisuse(`denied: ${spec.row} is not a gated row — no denied case exists for it`);
  return g;
};

const namedItems = (what: string, got: StagesProbe | null, want: string): Item[] => [
  { ok: got?.status === PAYMENT_REFUSAL.status, note: `${what}: status ${got?.status ?? "none (accepted)"}, want ${PAYMENT_REFUSAL.status}` },
  { ok: got?.code === PAYMENT_REFUSAL.code, note: `${what}: code ${got?.code ?? "none"}, want ${PAYMENT_REFUSAL.code}` },
  { ok: got?.featureKey === want, note: `${what}: feature_key ${got?.featureKey ?? "none"}, want ${want}` },
];

export const denied: Scenario = {
  key: "DENIED",
  entrantCount: 0,
  canaryCheck: null,
  evaluatesInvariants: false,
  mandatedRefusal: (spec) => `denied: ${gateOf(spec)} (ruling 24)`,
  async run(ctx: ScenarioContext): Promise<ScenarioOutput> {
    // Both refusals come before any call.
    const want = gateOf(ctx.spec);
    // An org that was never denied accepts the POST, and that would read as a
    // product that forgot its paywall.
    if (!(ctx.spec.deny ?? []).includes(want)) {
      throw new DeniedMisuse(`denied: case ${ctx.spec.caseId} carries no deny for ${want} (deny: ${(ctx.spec.deny ?? []).join(", ") || "none"}) — its org was never denied`);
    }
    const gated = stagesForRow(ctx.spec.row);
    const slug = `m-${ctx.tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60).replace(/-+$/, "");
    const competition = await ctx.driver.createCompetition({ name: `Matrix ${ctx.spec.caseId}`, slug });
    const division = await ctx.driver.createDivision(competition.id, { name: "Matrix denied", slug: "d", sportKey: ctx.spec.sport, variantKey: ctx.spec.variant });
    let post: StagesProbe | null = null;
    try {
      await ctx.driver.postStages(division.id, gated);
    } catch (e) {
      if (!(e instanceof RefusedCall)) throw e;
      post = { status: e.status, code: e.code, featureKey: e.featureKey };
    }
    // Read back from the product, never from the refusal: a gate that fires
    // after an insert refuses AND leaves a stage behind.
    const after = await ctx.driver.listStages(division.id);
    // The PUT probe: a division with a working stage, replaced by the gated body.
    const second = await ctx.driver.createDivision(competition.id, { name: "Matrix denied put", slug: "d2", sportKey: ctx.spec.sport, variantKey: ctx.spec.variant });
    const kept = await ctx.driver.postStages(second.id, stagesForRow(WORKING_ROW));
    const put = await ctx.driver.replaceStagesProbe(second.id, gated);
    const afterPut = await ctx.driver.listStages(second.id);
    const accepted = put.status >= 200 && put.status < 300;
    const assertions = [
      assertion("denied-refused-named", namedItems("POST stages", post, want)),
      assertion("denied-nothing-created", [{ ok: after.length === 0, note: `${after.length} stage(s) exist after the refused POST` }]),
      assertion("denied-put-keeps-stages", [
        ...namedItems("PUT stages", accepted ? null : put, want),
        // Without this a working POST that built nothing leaves no stage to
        // lose, and the per-stage items below pass over zero stages.
        { ok: kept.length > 0, note: `the working ${WORKING_ROW} body built no stage — nothing for the PUT to keep` },
        ...kept.map((s) => ({ ok: afterPut.some((x) => x.id === s.id && x.kind === s.kind), note: `${s.kind} stage ${s.id} gone after the refused PUT` })),
        { ok: afterPut.length === kept.length, note: `${afterPut.length} stage(s) after the refused PUT, want the ${kept.length} kept` },
      ]),
    ];
    return {
      observed: { caseId: ctx.spec.caseId, facts: [], stages: [], withdrawal: null, configEdit: null },
      assertions,
      events: 0,
      notes: [`gate ${want}: POST ${post?.status ?? "accepted"}, PUT ${put.status}, stages kept ${afterPut.length}/${kept.length}`],
    };
  },
};
