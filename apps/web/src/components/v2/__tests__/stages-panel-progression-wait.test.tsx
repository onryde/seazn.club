// A stage added with "Add stage" (AddStageForm) is an `on_complete`
// progression stage: it has no fixtures until the stage before it completes,
// and the server refuses Generate until then (stages.ts
// generateStageFixtures' pre-flight, STAGE_NOT_READY reason
// "previous_stage_incomplete"). Two screens used to tell the organiser the
// wrong thing about it:
//
//  1. the empty stage card said "generate them when entrants are
//     registered" — advice that does nothing for a stage whose entrants come
//     from another stage's table;
//  2. an early Generate painted the server's English sentence in a RED banner.
//
// Owner-approved "Option 1, wording only": the card names the stage it waits
// for, and the early Generate is an AMBER notice naming both stages. The
// Generate button itself is untouched (Option 2 was declined).
//
// Every progression below comes from `addStageProgression` — the form's own
// POST body — so these tests describe the stage the form really creates, not
// a hand-typed look-alike.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import {
  StagesPanel,
  addStageProgression,
  classifyActError,
  generatePreconditionMessage,
  progressionWaitSource,
} from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import type { Locale } from "@/lib/i18n-constants";

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const EN = en as unknown as Record<string, string>;
const DICTS: Record<Locale, Record<string, string>> = {
  en: EN,
  es: es as unknown as Record<string, string>,
  fr: fr as unknown as Record<string, string>,
  nl: nl as unknown as Record<string, string>,
};

/** React escapes these in text nodes, so a dictionary sentence with an
 *  apostrophe ("they're") is never a raw substring of the markup. */
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// Names that appear nowhere else in the markup except the card headers, and
// differ from each other, so "named the WRONG stage" is a different sentence.
const LEAGUE = {
  id: "s1", seq: 1, kind: "league", name: "Spring League",
  config: {}, progression: null, status: "active",
};
const FINALS = {
  id: "s2", seq: 2, kind: "knockout", name: "Cup Finals",
  config: {}, progression: addStageProgression(4) as Record<string, unknown>, status: "pending",
};

const FIXTURE = {
  id: "f1", stage_id: "s2", pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null,
  court_label: null, court_id: null, court_name: null, status: "scheduled", outcome: null,
  ext_key: "ko-1",
};

const baseProps = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [LEAGUE, FINALS],
  fixtures: [] as (typeof FIXTURE)[],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  activeEntrantIds: ["e1", "e2"],
  entrantSeeds: { e1: 1, e2: 2 },
  canEdit: true,
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
};

const notReady = (extra: Record<string, unknown>) =>
  new ApiV1Error(
    "this stage draws its entrants from the previous stage's final table — complete the previous stage first",
    422,
    "STAGE_NOT_READY",
    extra,
  );
const PROGRESSION_REFUSAL = { reason: "previous_stage_incomplete", stageId: "s2", previousStageId: "s1" };
const NAMES: Record<string, string> = { s1: "Spring League", s2: "Cup Finals" };
const lookup = (id: string) => NAMES[id];

describe("progressionWaitSource — the stage an on_complete stage is waiting on", () => {
  // Empty case first: with nothing to wait on, every question answers "no".
  it("empty case: a stage list with no earlier stage, or a stage with no progression, waits on nothing", () => {
    expect(progressionWaitSource(FINALS, [])).toBeNull();
    expect(progressionWaitSource(FINALS, [FINALS])).toBeNull();
    expect(progressionWaitSource(LEAGUE, [LEAGUE, FINALS])).toBeNull();
  });

  it("an on_complete stage whose previous stage is not complete waits on that stage", () => {
    expect(progressionWaitSource(FINALS, [LEAGUE, FINALS])).toBe(LEAGUE);
    // A `pending` source waits too — "not complete" is the server's rule, not "active".
    const pendingLeague = { ...LEAGUE, status: "pending" };
    expect(progressionWaitSource(FINALS, [pendingLeague, FINALS])).toBe(pendingLeague);
  });

  it("once the previous stage is complete it waits on nothing (Generate now works)", () => {
    expect(progressionWaitSource(FINALS, [{ ...LEAGUE, status: "complete" }, FINALS])).toBeNull();
  });

  it("an already-seeded stage (config.qualified) waits on nothing — the server skips the check too", () => {
    const seeded = { ...FINALS, config: { qualified: ["e1", "e2"] } };
    expect(progressionWaitSource(seeded, [LEAGUE, seeded])).toBeNull();
  });

  it("a timing:'setup' progression waits on nothing — it draws a TBD bracket at once", () => {
    const setup = { ...FINALS, progression: { ...addStageProgression(4), timing: "setup" } };
    expect(progressionWaitSource(setup, [LEAGUE, setup])).toBeNull();
  });

  // Ordering differential: the server reads the IMMEDIATELY previous stage by
  // seq (`seq < x order by seq desc limit 1`), not the first stage, not any
  // incomplete earlier stage, and not list order. Input is shuffled and the
  // seqs are gapped so neither array position nor seq-1 arithmetic can pass.
  it("waits on the IMMEDIATELY previous stage by seq, whatever the list order", () => {
    const pools = { ...LEAGUE, id: "p", seq: 3, name: "Pools", status: "complete" };
    const middle = { ...LEAGUE, id: "m", seq: 7, name: "Middle", status: "active" };
    const last = { ...FINALS, id: "l", seq: 12 };
    expect(progressionWaitSource(last, [last, pools, middle])).toBe(middle);
    // …and the reverse: an earlier stage still open does not count once the
    // immediately previous one is complete.
    const openPools = { ...pools, status: "active" };
    const doneMiddle = { ...middle, status: "complete" };
    expect(progressionWaitSource(last, [doneMiddle, last, openPools])).toBeNull();
  });
});

describe("StagesPanel — the empty card of a stage waiting on its source", () => {
  // Lazily, inside each test: a key missing from the dictionary then reds the
  // test that needs it instead of failing the whole file at collection.
  const copy = () => ({
    awaitingCan: escapeHtml(String(msg("schedule.noFixtures.awaitingCan", { stage: "Spring League" }))),
    awaitingView: escapeHtml(String(msg("schedule.noFixtures.awaitingView", { stage: "Spring League" }))),
    plainCan: escapeHtml(EN["schedule.noFixtures.can"]!),
    plainView: escapeHtml(EN["schedule.noFixtures.view"]!),
  });

  it("editor: the waiting card names its source; the plain stage keeps today's copy", () => {
    const { awaitingCan, awaitingView, plainCan, plainView } = copy();
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} />);
    // The owner-approved wording, pinned literally once, with the source's
    // NAME in it (not the waiting stage's own).
    expect(html).toContain("No fixtures yet — they&#x27;re drawn when Spring League completes.");
    expect(count(html, awaitingCan), "the waiting card's copy").toBe(1);
    expect(html).not.toContain(escapeHtml(msg("schedule.noFixtures.awaitingCan", { stage: "Cup Finals" })));
    // Positive pair for the absence below: the League card (no progression)
    // still renders today's copy, exactly once.
    expect(count(html, plainCan), "the plain League card keeps noFixtures.can").toBe(1);
    expect(html).not.toContain(awaitingView);
    expect(html).not.toContain(plainView);
    // Both empty cards are the same testid'd line, so the e2e can anchor on it.
    expect(count(html, 'data-testid="stage-no-fixtures"')).toBe(2);
  });

  it("viewer: the waiting card names its source in the viewer copy", () => {
    const { awaitingCan, awaitingView, plainCan, plainView } = copy();
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit={false} />);
    expect(html).toContain("No fixtures yet — drawn after Spring League.");
    expect(count(html, awaitingView)).toBe(1);
    expect(count(html, plainView), "the plain League card keeps noFixtures.view").toBe(1);
    expect(html).not.toContain(awaitingCan);
    expect(html).not.toContain(plainCan);
  });

  it("a waiting stage that already HAS fixtures shows no empty-card message at all", () => {
    const { awaitingCan, awaitingView, plainCan } = copy();
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={[FIXTURE]} />);
    // Positive pair: the League card is still empty and still says so.
    expect(count(html, plainCan)).toBe(1);
    expect(count(html, 'data-testid="stage-no-fixtures"')).toBe(1);
    expect(html).not.toContain(awaitingCan);
    expect(html).not.toContain(awaitingView);
  });

  it("once the source is complete the card falls back to today's copy (Generate works now)", () => {
    const { awaitingCan, plainCan } = copy();
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} stages={[{ ...LEAGUE, status: "complete" }, FINALS]} />,
    );
    expect(count(html, plainCan), "both empty cards read noFixtures.can").toBe(2);
    expect(html).not.toContain(awaitingCan);
  });
});

describe("the early Generate on a waiting stage — amber, named, never raw English", () => {
  const namedCopy = () =>
    String(msg("schedule.error.previousStageIncomplete", { source: "Spring League", stage: "Cup Finals" }));

  it("generatePreconditionMessage names both stages", () => {
    const named = namedCopy();
    expect(generatePreconditionMessage(notReady(PROGRESSION_REFUSAL), msg, lookup)).toBe(named);
    // Owner-approved wording, pinned literally once.
    expect(named).toBe("Spring League hasn't finished — the fixtures for Cup Finals are drawn when it completes.");
  });

  it("classifyActError makes it an amber warning that does not refresh", () => {
    const named = namedCopy();
    expect(classifyActError(notReady(PROGRESSION_REFUSAL), msg, "en", lookup)).toEqual({
      tone: "warning",
      text: named,
      refresh: false,
    });
  });

  // Assumption-as-guard: the board renders every stage of the division and
  // the server names one of them, so an unknown id means a stale board. Still
  // amber, still never the English wire text — just without the names.
  it("a stage id the board cannot name still gets the amber notice, unnamed", () => {
    const unnamed = EN["schedule.error.previousStageIncompleteUnnamed"];
    expect(unnamed, "the fallback key exists").toBeTruthy();
    const stale = classifyActError(notReady({ ...PROGRESSION_REFUSAL, previousStageId: "gone" }), msg, "en", lookup);
    expect(stale).toEqual({ tone: "warning", text: unnamed, refresh: false });
    // No lookup at all (a caller without the stage list) — same.
    expect(classifyActError(notReady(PROGRESSION_REFUSAL), msg, "en")).toEqual({
      tone: "warning",
      text: unnamed,
      refresh: false,
    });
    expect(stale.text).not.toContain("complete the previous stage first");
  });

  it("every OTHER STAGE_NOT_READY is unchanged: no reason stays red with the server's own text", () => {
    const bare = new ApiV1Error("need at least 2 active entrants to generate", 422, "STAGE_NOT_READY", {});
    expect(generatePreconditionMessage(bare, msg, lookup)).toBeNull();
    expect(classifyActError(bare, msg, "en", lookup)).toEqual({
      tone: "error",
      text: "need at least 2 active entrants to generate",
      refresh: false,
    });
    // …and the group-shortfall reason still maps to its own copy.
    const groups = new ApiV1Error("too few", 422, "STAGE_NOT_READY", {
      reason: "group_too_few_entrants", groups: 4, entrants: 2, required: 8,
    });
    expect(classifyActError(groups, msg, "en", lookup)).toEqual({
      tone: "warning",
      text: msg("schedule.error.tooFewGroupEntrants", { required: 8, have: 2, groups: 4 }),
      refresh: false,
    });
  });

  // Four-locale sweep. msgFor falls back to ENGLISH for a missing key, so
  // "translated" means: differs from en, carries both names, and leaves no
  // `{placeholder}` behind (a template naming a param the code never sends
  // prints literally).
  it("all four locales: translated, both names interpolated, no placeholder left", () => {
    const named = namedCopy();
    let checked = 0;
    for (const locale of Object.keys(DICTS) as Locale[]) {
      const m = ((k, v) => msgFor(locale, k, v)) as typeof msg;
      const out = classifyActError(notReady(PROGRESSION_REFUSAL), m, locale, lookup);
      const unnamed = classifyActError(notReady(PROGRESSION_REFUSAL), m, locale).text;
      const can = m("schedule.noFixtures.awaitingCan", { stage: "Spring League" });
      const view = m("schedule.noFixtures.awaitingView", { stage: "Spring League" });
      for (const key of [
        "schedule.noFixtures.awaitingCan",
        "schedule.noFixtures.awaitingView",
        "schedule.error.previousStageIncomplete",
        "schedule.error.previousStageIncompleteUnnamed",
      ]) {
        expect(DICTS[locale][key], `${locale} is missing ${key}`).toBeTruthy();
      }
      expect(out.tone).toBe("warning");
      expect(out.text, `${locale}: source name`).toContain("Spring League");
      expect(out.text, `${locale}: stage name`).toContain("Cup Finals");
      expect(can, `${locale}: card source name`).toContain("Spring League");
      expect(view, `${locale}: viewer card source name`).toContain("Spring League");
      for (const s of [out.text, unnamed, can, view]) {
        expect(s, `${locale}: leftover placeholder in "${s}"`).not.toMatch(/\{\w+\}/);
      }
      if (locale !== "en") {
        expect(out.text, `${locale} is English`).not.toBe(named);
        expect(unnamed).not.toBe(EN["schedule.error.previousStageIncompleteUnnamed"]);
        expect(can).not.toBe(msg("schedule.noFixtures.awaitingCan", { stage: "Spring League" }));
        expect(view).not.toBe(msg("schedule.noFixtures.awaitingView", { stage: "Spring League" }));
      }
      checked += 1;
    }
    expect(checked, "locales swept").toBe(4);
  });
});

// The wiring: the classifier above is pure, so nothing there proves the panel's
// Generate handler hands it the stage list. Drive the real island: press
// Generate on the waiting stage through the rail's own `onAct`, refuse it the
// way the server does, and read the banners back.
describe("StagesPanel — an early Generate paints the named amber notice", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const lines = (tree: ReactElement[], testid: string) =>
    tree.filter((el) => propsOf(el)["data-testid"] === testid).map((el) => textOf(el));

  it("the refusal lands in the amber line naming both stages, and the red line stays empty", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation((path: string) =>
      String(path).endsWith("/stages/s2/generate")
        ? Promise.reject(notReady(PROGRESSION_REFUSAL))
        : Promise.resolve({}),
    );
    const island = renderIsland(StagesPanel, baseProps);
    await flush();
    const rails = island.tree().filter((el) => el.type === StageRail);
    expect(rails.map((r) => (propsOf(r).stage as { id: string }).id)).toEqual(["s1", "s2"]);
    const finalsRail = rails[1]!;
    const landed = await (propsOf(finalsRail).onAct as (id: string, a: string) => Promise<boolean>)("s2", "generate");
    await flush();
    expect(landed, "a refused Generate resolves false").toBe(false);
    expect(apiV1Mock.mock.calls.some(([p]) => String(p).endsWith("/stages/s2/generate"))).toBe(true);
    expect(lines(island.tree(), "schedule-warning")).toEqual([
      msg("schedule.error.previousStageIncomplete", { source: "Spring League", stage: "Cup Finals" }),
    ]);
    expect(lines(island.tree(), "schedule-error")).toEqual([]);
  });
});
