// Per-stage match rules, T7 (design 2026-09-17 §D3; brief 2026-09-24) — the
// public division page is where a spectator reads a division's format: the
// sport, the preset chip ("Short (11 points)"), then one chip per stage. A
// stage that plays different rules (prod: a Swiss stage at 1 game to 15 over a
// best-of-3 `short` division) now says so on its own chip; a stage that plays
// the division's format keeps the bare name, and the preset chip is unchanged.
//
// The page is an async server component: it is called with its data door
// mocked and its returned tree rendered (node vitest has no DOM). Every
// expected string is resolved from the dictionary the page uses, never retyped.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import { resolveLatestModule } from "@/server/engine-db";
import DivisionHomePage from "../page";

/** The prod Swiss stage's stored rules, exactly. */
const SWISS_RULES = { bestOf: 1, setTo: 15, cap: 21, finalSetTo: 15, winBy: 2 };

const badminton = resolveLatestModule("badminton");
/** The `short` preset the way a division row carries it — read off the module. */
const SHORT = badminton.configSchema.parse(badminton.variants.short) as Record<string, unknown>;

const stage = (id: string, seq: number, name: string, rules: unknown) => ({
  id,
  division_id: "d1",
  seq,
  kind: "league",
  name,
  status: "active",
  qualify_count: null,
  qualify_per_group: false,
  next_stage_name: null,
  swiss_rounds: null,
  points_rule: null,
  has_rank_overrides: false,
  rules,
});

const divisionData = (locale: string, stages: unknown[]) => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: locale },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Badminton 2026",
    slug: "badminton-2026",
    description: null,
    starts_on: null,
    ends_on: null,
    branding: {},
    status: "active",
    visibility: "public",
  },
  division: {
    id: "d1",
    competition_id: "c1",
    name: "Boys Singles",
    slug: "boys-singles",
    description: null,
    sport_key: "badminton",
    variant_key: "short",
    status: "active",
    module_version: badminton.version,
    tiebreakers: null,
    sport_name: null,
    entrant_count: 0,
    config: SHORT,
  },
  stages,
  pools: [],
  fixtures: [],
  standings: [],
  entrants: [],
  tz: "UTC",
});

/** Every element anywhere in a server component's returned tree. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

/** The stage chips' markup, keyed by stage id, and the preset chip's text. */
async function chips(locale: string, stages: unknown[]) {
  getPublicDivision.mockResolvedValue(divisionData(locale, stages));
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "badminton-2026", divisionSlug: "boys-singles" }),
  });
  const all = elements(root);
  const stageChips = new Map(
    all
      .filter((el) => typeof (el.props as { "data-stage-id"?: unknown })["data-stage-id"] === "string")
      .map((el) => [
        (el.props as { "data-stage-id": string })["data-stage-id"],
        renderToStaticMarkup(el).replace(/<[^>]+>/g, ""),
      ]),
  );
  return { stageChips, html: all.map((el) => renderToStaticMarkup(el)).join("") };
}

describe("public division page — a stage chip names the rules its stage plays when they differ (T7)", () => {
  it("the Swiss chip says 1 game · 15 points (cap 21); the League chip beside it is the bare name", async () => {
    const en = await getDictionary("en", "public");
    // The load-bearing difference: the division's own number is not 15.
    expect(SHORT.setTo).not.toBe(SWISS_RULES.setTo);
    const line = t(en, "format.rules.oneGamePointsCap", { points: SWISS_RULES.setTo, cap: SWISS_RULES.cap });
    const { stageChips, html } = await chips("en", [
      stage("s-swiss", 1, "Swiss", SWISS_RULES),
      stage("s-league", 2, "League", null),
    ]);
    expect(stageChips.get("s-swiss")).toBe(`Swiss · ${line}`);
    expect(stageChips.get("s-league")).toBe("League");
    // The preset chip is the division's, untouched (brief: no copy change for
    // a division without overrides — and none for the division line here).
    expect(html).toContain(`>${msgFor("en", "variant.badminton.short")}<`);
  });

  it("EMPTY: stored rules that restate the division's own values are no different format — bare name", async () => {
    const { stageChips } = await chips("en", [
      stage("s-restate", 1, "Swiss", { bestOf: SHORT.bestOf, setTo: SHORT.setTo }),
      stage("s-none", 2, "League", undefined),
    ]);
    expect(stageChips.get("s-restate")).toBe("Swiss");
    expect(stageChips.get("s-none")).toBe("League");
  });

  it("in the ORG's locale, like every other word on this ISR page", async () => {
    const [en, es] = await Promise.all([getDictionary("en", "public"), getDictionary("es", "public")]);
    const params = { points: SWISS_RULES.setTo, cap: SWISS_RULES.cap };
    expect(t(es, "format.rules.oneGamePointsCap", params), "the premise").not.toBe(
      t(en, "format.rules.oneGamePointsCap", params),
    );
    const { stageChips } = await chips("es", [stage("s-swiss", 1, "Swiss", SWISS_RULES)]);
    expect(stageChips.get("s-swiss")).toBe(`Swiss · ${t(es, "format.rules.oneGamePointsCap", params)}`);
  });
});
