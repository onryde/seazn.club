// W3 Task 11 (SW-H2, RB3-3; X-SW-16) — the builder's Swiss round count. Rulebook-W3-swiss.md §3.1's audit probe: the old
// default of 5 "dead-ends in 15.5% of events" on a field of 6 (5 exceeds its safe maximum of 3). The default is now 3, the
// owner's band for a field of up to 8 (§3.2); the box takes any count from 1; and a guidance line under it names the
// field's recommendation and hard maximum for the builder's one entrant count. Since Match Day C9 that is the Format
// step's plan (default 16, the owner-approved mock's "16 pairs on 2 courts in 4 hours"), which the example draw also
// uses, so changing the plan's entrants moves the line.
//
// Expected numbers are §3.2's table typed here (16 → 4 recommended, at most 15; 20 → 5, at most 19; 5 → 2, at most 5),
// never read off `swissRoundsGuidance`. Every Swiss template the builder offers is swept.
//
// C9 fix round 1 (I2): the box opened at 3 while the line under it said "For 16 entrants: 4 rounds recommended". It now
// opens at the plan's own recommendation - `swissRoundsDefault`, the helper Settings opens a new Swiss at
// (division-settings.tsx) - and follows the plan until the organiser types in it. The default plan (16) is a case where
// the old 3 and the right answer (4) differ.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import uiEn from "@/dictionaries/en/ui.json";
import { swissRoundsDefault } from "@/lib/swiss-rounds";

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

const EN = uiEn as Record<string, string>;
const SPORTS: SportOption[] = [
  { key: "badminton", name: "Badminton", variants: [{ key: "bwf", name: "BWF", system: true }] },
];
const SWISS_TEMPLATES = ["swiss", "swiss_playoff", "swiss_knockout"] as const;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

function mount() {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
  });
}
type H = ReturnType<typeof mount>;
const pickFormat = (h: H, label: string) => {
  const labelEl = h.tree().find((e) => e.type === "label" && walk(e).some((x) => x.type === "span" && textOf(x) === label));
  if (!labelEl) throw new Error(`no template option labelled ${JSON.stringify(label)}`);
  const radio = walk(labelEl).find((e) => e.type === "input" && propsOf(e).type === "radio");
  (propsOf(radio!).onChange as () => void)();
};
/** The Rounds box: the number input inside the label whose caption is "Rounds". */
const roundsBox = (h: H) => {
  const label = h.tree().find((e) => e.type === "label" && walk(e).some((x) => x.type === "span" && textOf(x) === EN["wizard.rounds"]));
  return label ? walk(label).find((e) => e.type === "input") : undefined;
};
const guidance = (h: H): string | null => {
  const el = h.tree().find((e) => propsOf(e)["data-testid"] === "builder-swiss-rounds-guidance");
  return el ? textOf(el) : null;
};
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockResolvedValue({ phases: [] });
});

describe("division builder — Swiss rounds default, minimum and guidance (X-SW-16)", () => {
  it("premise: the helper's answer for the default plan is §3.2's (16 → 4), and it is NOT the old 3", () => {
    expect(swissRoundsDefault(16)).toBe(4);
    expect(swissRoundsDefault(16)).not.toBe(3);
  });

  it("every Swiss format opens at the plan's recommendation (16 entrants → 4, which the line names too), accepts 1, caps at 15", () => {
    let checked = 0;
    for (const template of SWISS_TEMPLATES) {
      const h = mount();
      pickFormat(h, EN[`format.template.${template}.label`]!);
      const box = roundsBox(h);
      expect(box, `${template}: the Rounds box`).toBeDefined();
      expect(String(propsOf(box!).value), template).toBe(String(swissRoundsDefault(16)));
      expect(String(propsOf(box!).value), template).toBe("4");
      expect(propsOf(box!).min, template).toBe(1);
      expect(propsOf(box!).max, template).toBe(15);
      expect(guidance(h), template).toBe(fill(EN["swiss.rounds.guidance.other"]!, { n: 16, count: 4, hardMax: 15 }));
      // The line DESCRIBES the box and is not part of its name: outside the label (formats.spec.ts finds the box by
      // its exact label "Rounds"), wired by aria-describedby.
      const label = h.tree().find((e) => e.type === "label" && walk(e).includes(box!));
      expect(walk(label!).some((e) => propsOf(e)["data-testid"] === "builder-swiss-rounds-guidance"), template).toBe(false);
      const line = h.tree().find((e) => propsOf(e)["data-testid"] === "builder-swiss-rounds-guidance");
      expect(propsOf(box!)["aria-describedby"], template).toBe(propsOf(line!).id);
      checked++;
    }
    expect(checked, "anti-vacuity: every Swiss template").toBe(SWISS_TEMPLATES.length);
  });

  it("a non-Swiss format shows no Rounds box and no guidance", () => {
    const h = mount();
    pickFormat(h, EN["format.template.league.label"]!);
    expect(roundsBox(h)).toBeUndefined();
    expect(guidance(h)).toBeNull();
  });

  it("the default reaches the request: the example draw is asked for the plan's 4 Swiss rounds, for its 16 entrants", async () => {
    const h = mount();
    pickFormat(h, EN["format.template.swiss.label"]!);
    const show = h.tree().find((e) => e.type === "button" && textOf(e) === EN["wizard.showExample"]);
    (propsOf(show!).onClick as () => void)();
    await flush();
    expect(apiV1Mock).toHaveBeenCalledTimes(1);
    const body = (apiV1Mock.mock.calls[0]![1] as { json: { count: number; stages: { kind: string; config: { rounds?: number } }[] } }).json;
    expect(body.count).toBe(16);
    expect(body.stages.find((s) => s.kind === "swiss")?.config.rounds).toBe(swissRoundsDefault(16));
  });

  it("the line follows the plan's entrant count (20 → 5 recommended, at most 19; 5 → 2, at most 5)", async () => {
    const h = mount();
    pickFormat(h, EN["format.template.swiss.label"]!);
    const show = h.tree().find((e) => e.type === "button" && textOf(e) === EN["wizard.showExample"]);
    (propsOf(show!).onClick as () => void)();
    await flush();
    const entrants = () =>
      h.tree().find((e) => e.type === "input" && propsOf(e).type === "number" && propsOf(e).max === 64 && propsOf(e).min === 2);
    for (const [n, count, hardMax] of [
      [20, 5, 19],
      [5, 2, 5],
    ] as const) {
      (propsOf(entrants()!).onChange as (e: { target: { value: string } }) => void)({ target: { value: String(n) } });
      expect(guidance(h), `field ${n}`).toBe(fill(EN["swiss.rounds.guidance.other"]!, { n, count, hardMax }));
      // I2: the untouched box follows the plan with the line, at the same recommendation.
      expect(String(propsOf(roundsBox(h)!).value), `field ${n}`).toBe(String(count));
    }
  });

  it("I2: once the organiser types in the box it stops following the plan - and the typed count is what Create sends", async () => {
    const h = mount();
    pickFormat(h, EN["format.template.swiss.label"]!);
    const entrants = () =>
      h.tree().find((e) => e.type === "input" && propsOf(e).type === "number" && propsOf(e).max === 64 && propsOf(e).min === 2);
    const type = (el: unknown, value: string) => (propsOf(el as never).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    type(roundsBox(h), "7");
    expect(String(propsOf(roundsBox(h)!).value)).toBe("7");
    // A second plan change: 20 entrants recommends 5, but the touched box keeps 7.
    type(entrants(), "20");
    expect(guidance(h)).toBe(fill(EN["swiss.rounds.guidance.other"]!, { n: 20, count: 5, hardMax: 19 }));
    expect(String(propsOf(roundsBox(h)!).value)).toBe("7");
    const show = h.tree().find((e) => e.type === "button" && textOf(e) === EN["wizard.showExample"]);
    (propsOf(show!).onClick as () => void)();
    await flush();
    const body = (apiV1Mock.mock.calls.at(-1)![1] as { json: { count: number; stages: { kind: string; config: { rounds?: number } }[] } }).json;
    expect(body.count).toBe(20);
    expect(body.stages.find((s) => s.kind === "swiss")?.config.rounds).toBe(7);
  });

  it("m3: the plan's Entrants box keeps what is typed - \"1\" then \"12\" reads 12, not 22 - and an emptied box reads as 2 until blur writes it back", () => {
    const h = mount();
    pickFormat(h, EN["format.template.swiss.label"]!);
    const entrants = () =>
      h.tree().find((e) => e.type === "input" && propsOf(e).type === "number" && propsOf(e).max === 64 && propsOf(e).min === 2)!;
    const type = (value: string) => (propsOf(entrants()).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    type("");
    expect(String(propsOf(entrants()).value)).toBe("");
    type("1");
    // Mid-typing: the box shows the "1", the estimates read the floor of 2 (the line is for a field of 2).
    expect(String(propsOf(entrants()).value)).toBe("1");
    expect(guidance(h)).toBe(fill(EN["swiss.rounds.guidance.one"] ?? EN["swiss.rounds.guidance.other"]!, { n: 2, count: 1, hardMax: 1 }));
    type("12");
    expect(String(propsOf(entrants()).value)).toBe("12");
    expect(guidance(h)).toBe(fill(EN["swiss.rounds.guidance.other"]!, { n: 12, count: 4, hardMax: 11 }));
    // Blur writes the clamped value back: 99 → 64, and an emptied box → 2.
    type("99");
    (propsOf(entrants()).onBlur as () => void)();
    expect(String(propsOf(entrants()).value)).toBe("64");
    type("");
    (propsOf(entrants()).onBlur as () => void)();
    expect(String(propsOf(entrants()).value)).toBe("2");
  });
});
