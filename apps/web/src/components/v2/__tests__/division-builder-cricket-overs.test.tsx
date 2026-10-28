// W2e Task 8c (owner D19; rule row CK-BO-2) - the division builder counts cricket overs in the CHOSEN variant's over length.
//
// The builder has no saved division: it knows the variant the organiser picked (a `sport_variants` row) and the raw values of
// the rule fields. It POSTs `{variant_key, config: <the overrides>}` and the server stores `{...variant.config, ...config}`.
// "20 overs" on The Hundred used to POST `ballsPerInnings: 120`, which the server stored beside the variant's own
// `ballsPerOver: 5`: a 24-over Hundred.
//
// Driven through the real handlers (the harness `renderIsland` the other builder tests use): the variant select's onChange,
// the rule grid's onChange, the Create button, with the transport mocked and the division POST's body read. The presets are
// the ENGINE's own (`cricket.variants`, which `sync:sports` writes to `sport_variants`), and the expected balls are the
// engine's own reading of the variant, never a number typed here.
//
// Single-sport: over lengths exist only in cricket. The page's mapping of the rows is `sportOptionsFrom` (lib/sport-options).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { MatchRuleFields } from "@/components/v2/match-rules";
import { sportOptionsFrom } from "@/lib/sport-options";
import uiEn from "@/dictionaries/en/ui.json";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

type Cfg = { ballsPerInnings: number; ballsPerOver: number };
const RAW = cricket.variants as Record<string, Record<string, unknown>>;
const engine = (variant: string): Cfg => cricket.configSchema.parse(RAW[variant]) as Cfg;
const VARIANT_ROWS = Object.keys(RAW).map((key) => ({ sport_key: "cricket", key, name: key, is_system: true, config: RAW[key]! }));
const SPORTS: SportOption[] = sportOptionsFrom([{ key: "cricket", name: "Cricket" }], VARIANT_ROWS);

function mount() {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "community",
  });
}
type H = ReturnType<typeof mount>;

function pickVariant(h: H, from: string, to: string): void {
  const select = h.tree().find((e) => e.type === "select" && propsOf(e).value === from);
  if (!select) throw new Error(`no variant select showing ${from}`);
  (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: to } });
}
/** The organiser types `overs` into the rule grid: the grid's own onChange, as RuleFieldControl calls it. */
function typeOvers(h: H, overs: string): void {
  const grid = h.tree().find((e) => e.type === MatchRuleFields);
  if (!grid) throw new Error("no rule grid on screen");
  const onChange = propsOf(grid).onChange as (next: Record<string, string>) => void;
  onChange({ ...(propsOf(grid).values as Record<string, string>), overs });
}
function button(h: H, label: string) {
  const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  return el;
}
/** Name -> Scheduling tab -> Create; the division POST's body. */
async function create(h: H): Promise<{ variant_key: string; config: Record<string, unknown> }> {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation(async (url: string) => (url.endsWith("/divisions") ? { id: "d1", slug: "open" } : {}));
  const nameInput = h.tree().find((e) => e.type === "input" && propsOf(e).placeholder === uiEn["wizard.divisionNamePlaceholder"]);
  if (!nameInput) throw new Error("name input not found");
  (propsOf(nameInput).onChange as (e: unknown) => void)({ target: { value: "Open" } });
  (propsOf(button(h, uiEn["wizard.tab.scheduling"])).onClick as () => void)();
  (propsOf(button(h, uiEn["wizard.create"])).onClick as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const post = apiV1Mock.mock.calls.find(([url]) => String(url).endsWith("/divisions"));
  if (!post) throw new Error("the division was never POSTed");
  return (post[1] as { json: { variant_key: string; config: Record<string, unknown> } }).json;
}

describe("CK-BO-2 the division builder writes overs in the chosen variant's over length", () => {
  it("CK-BO-2 premises: the engine's variants disagree on the over length, and the page's mapper carries each preset to the builder", () => {
    expect(engine("hundred").ballsPerOver).not.toBe(engine("t20").ballsPerOver);
    const variants = SPORTS[0]!.variants;
    expect(variants.map((v) => v.key).sort()).toEqual(Object.keys(RAW).sort());
    for (const v of variants) expect(v.config, `${v.key}: the preset reaches the builder`).toEqual(RAW[v.key]);
  });

  it("CK-BO-2 The Hundred picked, 20 overs typed: the POST carries the Hundred's 100 balls, not 120", async () => {
    const h = mount();
    pickVariant(h, "t20", "hundred");
    typeOvers(h, "20");
    const body = await create(h);
    expect(body.variant_key).toBe("hundred");
    expect(body.config).toEqual({ ballsPerInnings: 20 * engine("hundred").ballsPerOver });
    expect(body.config.ballsPerInnings, "the engine reads it as 20 overs of five").toBe(engine("hundred").ballsPerInnings);
    expect(body.config.ballsPerInnings, "not the six-ball answer").not.toBe(20 * 6);
    // what the server stores is `{...variant.config, ...config}`: the engine reads that as 20 overs
    const stored = cricket.configSchema.parse({ ...RAW.hundred, ...body.config }) as Cfg;
    expect(stored.ballsPerInnings / stored.ballsPerOver).toBe(20);
  });

  it("CK-BO-2 the positive pair: the same 20 overs on T20 is 20 six-ball overs", async () => {
    const h = mount();
    typeOvers(h, "20");
    const body = await create(h);
    expect(body.variant_key).toBe("t20");
    expect(body.config).toEqual({ ballsPerInnings: 20 * engine("t20").ballsPerOver });
    const stored = cricket.configSchema.parse({ ...RAW.t20, ...body.config }) as Cfg;
    expect(stored.ballsPerInnings / stored.ballsPerOver).toBe(20);
  });

  it("CK-BO-2 the sequence: overs typed on T20, then the variant changed to The Hundred and back - the count is read in the variant picked at Create", async () => {
    const onHundred = mount();
    typeOvers(onHundred, "10");
    pickVariant(onHundred, "t20", "hundred");
    expect((await create(onHundred)).config).toEqual({ ballsPerInnings: 10 * engine("hundred").ballsPerOver });
    // a Create leaves the builder busy, so the return trip is a builder of its own
    const back = mount();
    typeOvers(back, "10");
    pickVariant(back, "t20", "hundred");
    pickVariant(back, "hundred", "t20");
    expect((await create(back)).config).toEqual({ ballsPerInnings: 10 * engine("t20").ballsPerOver });
  });

  it("CK-BO-2 nothing typed: no override is sent (a blank field keeps the variant's own innings)", async () => {
    const h = mount();
    pickVariant(h, "t20", "hundred");
    const body = await create(h);
    expect(body.config).toEqual({});
  });
});

describe("CK-BO-2 the new-division page hands the builder each variant's preset", () => {
  it("CK-BO-2 sportOptionsFrom: variants of other sports are not mixed in, the order is kept, and a row without a preset has none", () => {
    const rows = [
      { sport_key: "cricket", key: "t20", name: "T20", is_system: true, config: RAW.t20! },
      { sport_key: "football", key: "11", name: "11", is_system: true, config: { halfMinutes: 45 } },
      { sport_key: "cricket", key: "mine", name: "Mine", is_system: false, config: null },
    ];
    const options = sportOptionsFrom([{ key: "cricket", name: "Cricket" }, { key: "football", name: "Football" }], rows);
    expect(options.map((o) => [o.key, o.variants.map((v) => v.key)])).toEqual([["cricket", ["t20", "mine"]], ["football", ["11"]]]);
    expect(options[0]!.variants[0]).toEqual({ key: "t20", name: "T20", system: true, config: RAW.t20 });
    expect(options[0]!.variants[1]!.system).toBe(false);
    expect(options[0]!.variants[1]!.config, "a null preset is none, never {}").toBeUndefined();
  });

  it("CK-BO-2 the page selects the preset's `config` column and maps its rows through sportOptionsFrom (the inert-seam guard)", () => {
    const page = readFileSync(new URL("../../../app/o/[orgSlug]/c/[compSlug]/d/new/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/select sport_key, key, name, is_system, config from sport_variants/);
    expect(page).toContain("sportOptionsFrom(");
  });
});
