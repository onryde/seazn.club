// #364 Task 6 — the pick-a-template demo section, driven for real.
//
// The section's whole claim is "this is a recording of an actual run", so every
// assertion here is anchored on the COMMITTED fixtures rather than on stub data
// a test handed the component: the trace it shows must be `buildScheduleTrace`'s
// own output over the recorded response, and the credits it prints must be what
// `quoteRun` charges for that board — checked against the `credits` the run
// itself reported. A demo that renders numbers a test supplied would prove
// nothing about the demo.
//
// vitest is `environment: "node"` here with no jsdom, so the island is driven
// through `_hook-harness` (see its header): clicks are `onClick()` calls, the
// replay is advanced with fake timers, and child components are read as
// unexpanded elements — `propsOf(traceEl).events`, not markup. The dict comes
// through a mocked `useDict` holding exactly what the page ships: the marketing
// catalog merged with the `board.ai.` / `board.conflict.` subset of ui.json.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiTrace } from "@/components/v2/board/ai-trace";
import { AiDiffPanel } from "@/components/v2/board/ai-diff-panel";
import { buildScheduleTrace, type TraceSource } from "@/components/v2/board/ai-trace-compose";
import { computeAiDiff } from "@/components/v2/board/ai-diff";
import { pickDictPrefixes } from "@/lib/i18n-subset";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import { quoteRun, schedulingRungWeights } from "@/lib/ai-rung";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { Dict } from "@/lib/i18n-constants";
import type { AiDemoFixture } from "@/demo/ai-templates/types";

import marketingEn from "@/dictionaries/en/marketing.json";
import marketingEs from "@/dictionaries/es/marketing.json";
import marketingFr from "@/dictionaries/fr/marketing.json";
import marketingNl from "@/dictionaries/nl/marketing.json";
import uiEn from "@/dictionaries/en/ui.json";
import clubNightJson from "@/demo/ai-templates/club-night.json";
import northsideJson from "@/demo/ai-templates/northside-open.json";
import finalsDayJson from "@/demo/ai-templates/finals-day.json";

import { AiArchitectDemo, resolveDivergentCourtNames, demoQuoteLines } from "../ai-architect-demo";

const UI_PREFIXES = ["board.ai.", "board.conflict."] as const;

/** Exactly the dict the /scheduling page hands the provider (Task 5 helper). */
const DICT: Dict = {
  ...(marketingEn as unknown as Dict),
  ...pickDictPrefixes(uiEn as unknown as Dict, UI_PREFIXES),
};

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const marketing = (await import("@/dictionaries/en/marketing.json")).default;
  const ui = (await import("@/dictionaries/en/ui.json")).default;
  const subset = (await import("@/lib/i18n-subset")).pickDictPrefixes;
  const dict = {
    ...(marketing as unknown as Record<string, unknown>),
    ...subset(ui as unknown as Record<string, unknown>, ["board.ai.", "board.conflict."]),
  };
  return { ...actual, useDict: () => dict };
});

/** All four shipped marketing catalogs — the model-name ban is a copy rule, so
 *  it is checked against every locale, not only the one the island mounts in. */
const MARKETING_DICTS: Record<string, Record<string, unknown>> = {
  en: marketingEn as unknown as Record<string, unknown>,
  es: marketingEs as unknown as Record<string, unknown>,
  fr: marketingFr as unknown as Record<string, unknown>,
  nl: marketingNl as unknown as Record<string, unknown>,
};

const msg = (key: string, vars?: Record<string, string | number>) => tRuntime(DICT, key, vars);
const tPlural = (key: string, count: number, vars?: Record<string, string | number>) =>
  pluralRuntime(DICT, key, count, "en", { n: count, ...vars });

const CLUB_NIGHT = clubNightJson as unknown as AiDemoFixture;
const NORTHSIDE = northsideJson as unknown as AiDemoFixture;
const FINALS_DAY = finalsDayJson as unknown as AiDemoFixture;

type DemoPlan = AiPlanResponse & {
  divisions?: { id: string; name: string; movable: number; rung: number }[];
  divergent_courts?: string[];
  credits: number;
};
const planOf = (fx: AiDemoFixture): DemoPlan => fx.response as DemoPlan;

/** React escapes these in text nodes, so a dictionary/model sentence is never a
 *  raw substring of the markup. */
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

/** The date the section prints, formatted identically on both sides — UTC so a
 *  server and a browser in different zones agree. */
const captureDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** Fake only the timer family the replay uses, so the dynamic `import()` of a
 *  fixture still resolves on the real macrotask queue. Faking everything makes
 *  the load hang and every assertion below vacuous. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the fixture's dynamic import settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
}

type DemoProps = Parameters<typeof AiArchitectDemo>[0];
type Island = ReturnType<typeof renderIsland<DemoProps>>;

/** The rung weights are resolved on the SERVER and handed down (#385): env
 *  overrides do not exist in a browser, so a client that called
 *  `schedulingRungWeights()` itself would price differently after hydration. */
async function mount(): Promise<Island> {
  const island = renderIsland(AiArchitectDemo, {
    locale: "en",
    weights: schedulingRungWeights(),
  } as DemoProps);
  await settle();
  return island;
}

const find = (island: Island, attr: string, value?: string): ReactElement | undefined =>
  island.tree().find((el) => {
    const v = propsOf(el)[attr];
    return value === undefined ? v !== undefined : v === value;
  });

const all = (island: Island, attr: string): ReactElement[] =>
  island.tree().filter((el) => propsOf(el)[attr] !== undefined);

async function select(island: Island, slug: string): Promise<void> {
  const card = find(island, "data-ai-template", slug);
  expect(card, `no card for ${slug}`).toBeDefined();
  (propsOf(card!).onClick as () => void)();
  await settle();
}

/** Run the replay to the end (plus slack) and flush the harness re-renders. */
async function playOut(steps = 40): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await vi.advanceTimersByTimeAsync(400);
    await settle();
  }
}

describe("AiArchitectDemo — the template rail", () => {
  it("renders one card per committed run, finals-day first and emphasised", async () => {
    const island = await mount();
    const cards = all(island, "data-ai-template");
    expect(cards.map((c) => propsOf(c)["data-ai-template"])).toEqual([
      "finals-day",
      "club-night",
      "northside-open",
    ]);
    // The hero is the repair run — the one where the machine reports what it
    // could NOT do. Emphasis is a flag on the card, so it survives a re-order.
    expect(propsOf(cards[0]!)["data-ai-hero"]).toBe("true");
    expect(propsOf(cards[1]!)["data-ai-hero"]).toBeUndefined();
    expect(propsOf(cards[2]!)["data-ai-hero"]).toBeUndefined();
  });

  // The REC slate names a model and a capture date. Holding the previous
  // recording on screen while the next chunk arrives attributes one run's
  // receipt to another — briefly, but on the one surface whose whole job is
  // saying where the numbers came from.
  it("drops the previous recording the moment another card is picked", async () => {
    const island = await mount(); // settles on the hero, finals-day
    expect(island.text()).toContain(FINALS_DAY.meta.instruction);

    const next = find(island, "data-ai-template", "northside-open")!;
    (propsOf(next).onClick as () => void)(); // deliberately NOT settled
    const midLoad = island.text();
    expect(midLoad).toContain(msg("scheduling.aidemo.loading"));
    expect(midLoad).not.toContain(FINALS_DAY.meta.instruction);
    expect(find(island, "data-ai-price")).toBeUndefined();

    await settle();
    expect(island.text()).toContain(NORTHSIDE.meta.instruction);
  });

  // Backs the e2e assertion `toHaveCount(joint ? 0 : 1)` on the replay button
  // (marketing-ai-demo.spec.ts:146), which replaced an `if (await count())` that
  // passed whether the control rendered or not. The e2e proves it in a browser;
  // this proves the rule the e2e now encodes.
  it("offers the replay control only where there is a trace to replay", async () => {
    const label = msg("scheduling.aidemo.replay");
    const replayButton = (island: Island) =>
      island
        .tree()
        .find(
          (el) => el.type === "button" && textOf(propsOf(el).children as never) === label,
        );

    const island = await mount();
    for (const slug of ["finals-day", "club-night"] as const) {
      await select(island, slug);
      await playOut();
      expect(replayButton(island), `${slug} has no replay control`).toBeDefined();
    }
    await select(island, "northside-open");
    await playOut();
    expect(replayButton(island), "the joint run has no trace, so nothing to replay").toBeUndefined();
  });

  it("carries the smoke hooks in the server-rendered body", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={DICT} locale="en">
        <AiArchitectDemo locale="en" weights={schedulingRungWeights()} />
      </DictProvider>,
    );
    expect(html).toContain('data-ai-demo="ready"');
    for (const slug of ["finals-day", "club-night", "northside-open"]) {
      expect(html).toContain(`data-ai-template="${slug}"`);
    }
    expect(html).toContain(esc(msg("scheduling.aidemo.title")));
  });
});

describe("AiArchitectDemo — T1 club night", () => {
  it("replays the composed trace one event at a time, then settles", async () => {
    const island = await mount();
    await select(island, "club-night");

    const expected = buildScheduleTrace(
      planOf(CLUB_NIGHT) as unknown as TraceSource,
      CLUB_NIGHT.board.courts.length,
      msg,
    ).events;
    expect(expected.length).toBeGreaterThan(4);

    // Mid-replay the trace holds a strict prefix — proof the section drives the
    // reveal rather than dumping the script.
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    const mid = island.tree().find((el) => el.type === AiTrace);
    expect(mid, "no trace mounted for a single-division run").toBeDefined();
    const midEvents = propsOf(mid!).events as { text: string }[];
    expect(midEvents.length).toBeGreaterThan(0);
    expect(midEvents.length).toBeLessThan(expected.length);
    expect(propsOf(mid!).running).toBe(true);

    await playOut();
    const done = island.tree().find((el) => el.type === AiTrace)!;
    expect(propsOf(done).events).toEqual(expected);
    expect(propsOf(done).running).toBe(false);
    expect(propsOf(done).phase).toBe("schedule");
  });

  it("dumps the whole trace at once under prefers-reduced-motion", async () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    const island = await mount();
    await select(island, "club-night");
    const expected = buildScheduleTrace(
      planOf(CLUB_NIGHT) as unknown as TraceSource,
      CLUB_NIGHT.board.courts.length,
      msg,
    ).events;
    // No timer advanced at all.
    const trace = island.tree().find((el) => el.type === AiTrace)!;
    expect(propsOf(trace).events).toEqual(expected);
    expect(propsOf(trace).running).toBe(false);
  });

  it("names the run it recorded — label and capture date, never the model", async () => {
    const island = await mount();
    await select(island, "club-night");
    const text = island.text();
    expect(text).toContain(msg("scheduling.aidemo.recordedLabel"));
    expect(text).toContain(captureDate(CLUB_NIGHT.meta.capturedAt));
    expect(text).toContain("2026");
    // The organiser's own sentence, verbatim.
    expect(text).toContain(CLUB_NIGHT.meta.instruction);
  });

  // Owner's ruling (2026-08-09): the marketing page does not name the model it
  // was served by. `meta.model` stays in the recording — it is provenance the
  // capture harness and the drift guard both read — but nothing rendered may
  // carry it. Two halves, because either alone is escapable: the render half
  // proves the component does not print `fixture.meta.model`, and the dictionary
  // half proves no locale's copy hardcodes the name (the slate's text is a
  // per-locale value, and only `en` is mounted here).
  it("never renders the served model", async () => {
    const island = await mount();
    for (const slug of ["club-night", "northside-open", "finals-day"]) {
      await select(island, slug);
      await playOut();
      expect(island.text(), `${slug} names the model`).not.toContain(CLUB_NIGHT.meta.model);
    }
  });

  it("names the model in no locale's copy", () => {
    for (const [locale, dict] of Object.entries(MARKETING_DICTS)) {
      const named = Object.entries(dict).filter(([, v]) =>
        typeof v === "string" ? v.includes(CLUB_NIGHT.meta.model) : false,
      );
      expect(named, `${locale} marketing copy names the model`).toEqual([]);
    }
  });

  it("prices the run with quoteRun, and agrees with what the run was charged", async () => {
    const island = await mount();
    await select(island, "club-night");
    const expected = quoteRun(
      [
        {
          key: "club-night",
          input: {
            movableFixtures: CLUB_NIGHT.movableIds.length,
            entrants: CLUB_NIGHT.board.entrants.length,
            courts: CLUB_NIGHT.board.courts.length,
          },
        },
      ],
      schedulingRungWeights(),
    );
    const price = find(island, "data-ai-price");
    expect(price, "no price shown").toBeDefined();
    expect(propsOf(price!)["data-credits"]).toBe(String(expected.credits));
    expect(propsOf(price!)["data-credits"]).toBe(String(planOf(CLUB_NIGHT).credits));
    expect(propsOf(price!)["data-discount"]).toBe("0");
  });

  it("prices a single division off the pack, the way schedule-ai.ts does", () => {
    expect(demoQuoteLines(CLUB_NIGHT)).toEqual([
      { key: "club-night", input: { movableFixtures: 12, entrants: 8, courts: 2 } },
    ]);
    expect(demoQuoteLines(FINALS_DAY)).toEqual([
      { key: "finals-day", input: { movableFixtures: 29, entrants: 16, courts: 6 } },
    ]);
  });

  it("shows no per-division ledger for a single-division run", async () => {
    const island = await mount();
    await select(island, "club-night");
    expect(all(island, "data-ai-ledger")).toHaveLength(0);
    expect(find(island, "data-ai-divergent")).toBeUndefined();
  });
});

describe("AiArchitectDemo — T2 Northside Open (joint)", () => {
  it("renders the per-division ledger, not a trace", async () => {
    const island = await mount();
    await select(island, "northside-open");
    await playOut();

    // The real joint console has no referee trace; inventing one for the demo
    // would be the exact drift this section exists to disprove.
    expect(island.tree().find((el) => el.type === AiTrace)).toBeUndefined();

    const rows = all(island, "data-ai-ledger");
    const divisions = planOf(NORTHSIDE).divisions!;
    expect(rows).toHaveLength(divisions.length);
    const placed = new Map<string, number>();
    for (const p of planOf(NORTHSIDE).proposal as unknown as { division_id?: string }[]) {
      placed.set(p.division_id!, (placed.get(p.division_id!) ?? 0) + 1);
    }
    for (const d of divisions) {
      const row = rows.find((r) => propsOf(r)["data-division-id"] === d.id);
      expect(row, `no ledger row for ${d.name}`).toBeDefined();
      expect(propsOf(row!)["data-placed"]).toBe(String(placed.get(d.id)));
    }
    expect(island.text()).toContain(divisions[0]!.name);
  });

  it("never prints a raw court id in the divergent-courts note", async () => {
    // P9 review wave 3: `divergent_courts` carries court UUIDs since the
    // cutover, and this component renders on the PUBLIC marketing site. The
    // note resolves through the capture's own recorded `courtNames` and DROPS
    // anything it cannot resolve — so a fixture recorded before that field
    // existed suppresses the note entirely rather than showing three uuids.
    const island = await mount();
    await select(island, "northside-open");
    const ids = planOf(NORTHSIDE).divergent_courts ?? [];
    expect(ids.length, "the fixture still carries divergent courts").toBeGreaterThan(0);
    for (const court of ids) {
      expect(island.text(), "a raw court uuid reached the public page").not.toContain(court);
    }
    // This fixture predates `courtNames`, so nothing resolves and the note is
    // withheld. Re-capturing restores it — the capture records the map now.
    const hasNames = Boolean((NORTHSIDE as { courtNames?: unknown }).courtNames);
    expect(Boolean(find(island, "data-ai-divergent"))).toBe(hasNames);
  });

  it("resolves divergent courts to NAMES, and to nothing when unnamed", () => {
    // The other half, as a direct unit on the exported rule: the component
    // loads fixtures through a dynamic import() a test cannot substitute
    // per-case. Without this, the assertion above would be satisfied by a
    // component that simply never shows the note at all.
    const ids = planOf(NORTHSIDE).divergent_courts ?? [];
    expect(resolveDivergentCourtNames(NORTHSIDE, ids)).toEqual([]);
    const named = {
      ...NORTHSIDE,
      courtNames: Object.fromEntries(ids.map((id, i) => [id, `Show Court ${i + 1}`])),
    } as AiDemoFixture;
    expect(resolveDivergentCourtNames(named, ids)).toEqual(
      ids.map((_, i) => `Show Court ${i + 1}`),
    );
    // An id present in the list but absent from the map is dropped, never shown.
    expect(resolveDivergentCourtNames(named, [...ids, "ffffffff-0000-4000-8000-000000000000"]))
      .toHaveLength(ids.length);
  });

  it("lists the conflicts flat, and says so when there are none", async () => {
    const island = await mount();
    await select(island, "northside-open");
    const box = find(island, "data-ai-conflicts");
    expect(box, "no conflict list").toBeDefined();
    const n = planOf(NORTHSIDE).blocking.length + planOf(NORTHSIDE).warnings.length;
    expect(n).toBe(0);
    expect(propsOf(box!)["data-count"]).toBe("0");
    expect(island.text()).toContain(msg("scheduling.aidemo.conflicts.none"));
  });

  // The inputs, not just the answer. `sizeScore` for Men's and Women's lands at
  // 55 and 55.5 against an `s1` of 60, so a board-derived quote (5 courts, and a
  // participation count of 24 for U15 rather than the draw's 23) is within one
  // recapture of printing a rung the run never paid — while `credits` still
  // happens to come out at 3 today. Pinning the credits alone cannot see that.
  it("prices each division on the SERVER's inputs, not the board's", () => {
    const lines = demoQuoteLines(NORTHSIDE);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.key)).toEqual(planOf(NORTHSIDE).divisions!.map((d) => d.id));
    expect(lines.map((l) => l.input.movableFixtures)).toEqual([31, 48, 36]);
    // Per-division court sets off `pack.divisions[].settings.courts` …
    expect(lines.map((l) => l.input.courts)).toEqual([4, 3, 4]);
    // … and the DRAW's entrants off `pack.entrants`, not board participation.
    expect(lines.map((l) => l.input.entrants)).toEqual([32, 32, 23]);
    // The board would have said 5 courts for every one of them.
    expect(NORTHSIDE.board.courts.length).toBe(5);
  });

  it("charges the batch price — Σ of the rungs, less one", async () => {
    const island = await mount();
    await select(island, "northside-open");
    const price = find(island, "data-ai-price")!;
    const plan = planOf(NORTHSIDE);
    const rungTotal = plan.divisions!.reduce((n, d) => n + d.rung, 0);
    expect(propsOf(price)["data-credits"]).toBe(String(Math.max(1, rungTotal - 1)));
    expect(propsOf(price)["data-credits"]).toBe(String(plan.credits));
    expect(propsOf(price)["data-discount"]).toBe("1");
    // Plural pair, not a hardcoded singular around `{discount}`.
    expect(island.text()).toContain(
      tPlural("scheduling.aidemo.price.joint", 1, { divisions: plan.divisions!.length }),
    );
    expect(island.text()).toContain("1 credit off");
    expect(island.text()).not.toContain("1 credits off");
  });

  it("has both plural branches for the batch discount, in all four locales", async () => {
    for (const loc of ["en", "es", "fr", "nl"] as const) {
      const dict = (await import(`../../../dictionaries/${loc}/marketing.json`)).default as Dict;
      for (const cat of ["one", "other"] as const) {
        const v = dict[`scheduling.aidemo.price.joint.${cat}`];
        expect(typeof v, `${loc}.${cat}`).toBe("string");
        expect(v as string, `${loc}.${cat}`).toContain("{count}");
      }
      // The flat key it replaced must be gone, or `lookup` would find it first
      // and the plural pair would be dead weight.
      expect(dict["scheduling.aidemo.price.joint"], loc).toBeUndefined();
    }
  });
});

describe("AiArchitectDemo — T3 finals day (repair)", () => {
  it("lists every fixture nobody could place, with the run's own reason", async () => {
    const island = await mount();
    await select(island, "finals-day");
    await playOut();

    const unsch = planOf(FINALS_DAY).unschedulable as { fixture_id: string; reason: string }[];
    expect(unsch.length).toBeGreaterThan(0);
    const rows = all(island, "data-ai-unschedulable");
    expect(rows).toHaveLength(unsch.length);
    const text = island.text();
    expect(text).toContain(msg("scheduling.aidemo.unschedulable.title"));
    for (const u of unsch) {
      const row = rows.find((r) => propsOf(r)["data-fixture-id"] === u.fixture_id);
      expect(row, `no row for ${u.fixture_id}`).toBeDefined();
      expect(text).toContain(u.reason);
    }
  });

  it("hands the diff panel the recorded plan and board, explanations included", async () => {
    const island = await mount();
    await select(island, "finals-day");
    await playOut();

    const panel = island.tree().find((el) => el.type === AiDiffPanel);
    expect(panel, "no diff panel").toBeDefined();
    const plan = propsOf(panel!).plan as AiPlanResponse;
    expect(plan.proposal).toHaveLength(planOf(FINALS_DAY).proposal.length);
    expect(plan.explanations.length).toBeGreaterThan(0);
    expect(propsOf(panel!).fixtures).toHaveLength(FINALS_DAY.board.fixtures.length);
    expect(propsOf(panel!).excluded).toEqual([]);
    expect(typeof propsOf(panel!).onToggleExclude).toBe("function");
  });

  it("puts the run's per-fixture explanations on screen through the diff panel", () => {
    // The panel is the surface that renders `explanations`; the island only
    // hands them over. Render it directly with the recorded plan so the demo's
    // claim ("it says why it moved each match") is pinned by real markup.
    const plan = planOf(FINALS_DAY);
    const diff = computeAiDiff(plan, FINALS_DAY.board.fixtures);
    const changed = new Set<string>([
      ...diff.moved.map((m) => m.fixture_id),
      ...diff.placed.map((p) => p.fixture_id),
      ...diff.unscheduled.map((u) => u.fixture_id),
    ]);
    const note = plan.explanations.find((e) => changed.has(e.fixture_id))?.note;
    expect(note, "no explanation lands on a changed row").toBeDefined();
    const html = renderToStaticMarkup(
      <DictProvider dict={DICT} locale="en">
        <AiDiffPanel
          plan={plan}
          fixtures={FINALS_DAY.board.fixtures}
          excluded={[]}
          onToggleExclude={() => {}}
        />
      </DictProvider>,
    );
    expect(html).toContain(esc(note!));
  });

  // The card blurb used to promise "matches already played stay put" directly
  // above a panel that strikes eleven of those very fixtures "→ tray". The diff
  // is the PRODUCT's — `computeAiDiff` buckets any placed board row missing from
  // the proposal, with no movable filter — so the section explains it instead of
  // filtering it, which would show a console that does not exist.
  it("explains the tray rows the repair was never allowed to touch", async () => {
    const plan = planOf(FINALS_DAY);
    const diff = computeAiDiff(plan, FINALS_DAY.board.fixtures);
    const movable = new Set(FINALS_DAY.movableIds);
    const outOfScope = diff.unscheduled.filter((u) => !movable.has(u.fixture_id));
    // The premise, read from the recording rather than asserted from memory.
    expect(diff.unscheduled).toHaveLength(15);
    expect(outOfScope).toHaveLength(11);

    const island = await mount();
    await select(island, "finals-day");
    await playOut();
    expect(find(island, "data-ai-scope"), "no scope note beside an out-of-scope diff").toBeDefined();
    expect(island.text()).toContain(
      msg("scheduling.aidemo.scopeNote", {
        movable: FINALS_DAY.movableIds.length,
        total: FINALS_DAY.board.fixtures.length,
      }),
    );
    // …and the blurb no longer makes the claim the panel contradicts.
    expect(msg("scheduling.aidemo.card.finals-day.what")).not.toContain("stay put");
  });

  it("shows no scope note when the run could move the whole board", async () => {
    expect(CLUB_NIGHT.movableIds.length).toBe(CLUB_NIGHT.board.fixtures.length);
    const island = await mount();
    await select(island, "club-night");
    await playOut();
    expect(find(island, "data-ai-scope")).toBeUndefined();
  });

  it("prices the repair from the movable set it was given", async () => {
    const island = await mount();
    await select(island, "finals-day");
    const expected = quoteRun(
      [
        {
          key: "finals-day",
          input: {
            movableFixtures: FINALS_DAY.movableIds.length,
            entrants: FINALS_DAY.board.entrants.length,
            courts: FINALS_DAY.board.courts.length,
          },
        },
      ],
      schedulingRungWeights(),
    );
    const price = find(island, "data-ai-price")!;
    expect(propsOf(price)["data-credits"]).toBe(String(expected.credits));
    expect(propsOf(price)["data-credits"]).toBe(String(planOf(FINALS_DAY).credits));
  });
});
