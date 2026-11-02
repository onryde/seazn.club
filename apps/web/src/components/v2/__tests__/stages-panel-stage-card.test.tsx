// Match Day Phase C, Task C3 (spec 2026-10-31-match-day-design.md §12 Phase C items 1, 8, 9, 12; owner-approved mock option 2) - the
// stage card, REACHED: the real StagesPanel rendered the way the division's Fixtures tab renders it. Node env, no DOM (AGENTS.md
// class 2): "is the control on the screen, in this state, with these words" - the open/close taps are the e2e's
// (`e2e/stage-card-c3.spec.ts`). The wiring of C1's `stageActions`/`stageCounts` is proven HERE through the real panel: the fixtures
// are the panel's own props, the buttons are what the rail renders from them.
//
// Expected values come from the engine's declarations (stage kinds, `DRAW_KINDS`, the sport registry, a sport's own default order
// through `unitLabelKey`) and the en dictionary - never from the code under test. Every sweep reports its count; zero is a failure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { unitLabelKey } from "@/lib/stage-card/summaries";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder, type GeneratedBracket } from "@seazn/engine/scheduling";
import { tableRulesOf } from "../stage-rules/__tests__/_table-rules-fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const UI = enUi as Record<string, string>;
const DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];
const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const sport = (key: string) => builtinModules.find((m) => m.key === key)!;

const stageRow = (o: Partial<{ id: string; seq: number; kind: string; name: string; status: string; config: Record<string, unknown> }> = {}) => ({
  id: A,
  seq: 1,
  kind: "league",
  name: "League",
  config: {},
  progression: null,
  status: "active",
  ...o,
});
const fixture = (stageId: string, no: number, o: Partial<{ status: string; scheduled_at: string | null; outcome: unknown }> = {}) => ({
  id: `f-${stageId.slice(0, 2)}-${no}`,
  stage_id: stageId,
  pool_id: null,
  round_no: 1,
  seq_in_round: no,
  fixture_no: no,
  home_entrant_id: "e1",
  away_entrant_id: "e2" as string | null,
  scheduled_at: null as string | null,
  venue: null,
  court_label: null,
  court_id: null,
  court_name: null,
  status: "scheduled",
  outcome: null as unknown,
  ...o,
});
const DECIDED = { kind: "win", winner: "e1" };

/** The owner's case from the mock: a badminton league, active - one match in play, two still to schedule. */
const MOCK_FIXTURES = [
  fixture(A, 1, { status: "in_play", scheduled_at: "2026-09-05T09:00:00.000Z" }),
  fixture(A, 2),
  fixture(A, 3),
];

function panel(over: Record<string, unknown> = {}, locale: Locale = "en", dict: Dict = enUi as Dict): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <StagesPanel
        divisionId="d1"
        competitionId="c1"
        orgSlug="o"
        compSlug="c"
        divSlug="d"
        stages={[stageRow()]}
        fixtures={MOCK_FIXTURES}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        canEdit
        sportKey="badminton"
        divisionConfig={{}}
        tz="UTC"
        orgTz="UTC"
        canExport={false}
        viewerPlan={{ plan: "pro", isStaff: false } as never}
        stageTableRules={{ [A]: tableRulesOf(sport("badminton"), "league") }}
        {...over}
      />
    </DictProvider>,
  );
}

const tag = (html: string, testId: string): string | null => new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? null;
const count = (html: string, testId: string): number => html.split(`data-testid="${testId}"`).length - 1;
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
// "Locked": a pressed-in-flight button is `disabled`; Complete waiting on an open match is `aria-disabled` (E1 item 1 - it stays focusable
// so the reason behind its ⓘ is reachable). Either way the press does nothing, which is what these tests mean by it.
const disabled = (html: string, testId: string): boolean => /\sdisabled=""|\saria-disabled="true"/.test(tag(html, testId) ?? "");

// Match Day E1 item 2 (owner 2026-11-01): "Match format" is "Match rules" everywhere a person reads it. The literals below are the owner's
// words, typed here on purpose: reading them back from the dictionary would pass with the old name still in it. "Format" (league /
// swiss / playoff) is a different word and stays.
const MATCH_RULES: Record<Locale, string> = { en: "Match rules", es: "Reglas del partido", fr: "Règles du match", nl: "Wedstrijdregels" };
const RETIRED_NAMES = ["Match format", "Formato de partido", "Format de match", "Wedstrijdformat"] as const;

describe("E1 item 2: the stage card says Match rules, in every locale", () => {
  it("the header button, the sheet row and the panel's section carry the new name; no label in any locale keeps the old one", () => {
    let locales = 0;
    for (const [loc, dict] of DICTS) {
      const html = panel({}, loc, dict);
      expect(text(tag(html, "stage-tool-format") === null ? "" : html.slice(html.indexOf('data-testid="stage-tool-format"'), html.indexOf("</button>", html.indexOf('data-testid="stage-tool-format"')))), `${loc}: the header button`).toContain(MATCH_RULES[loc]);
      const sheetAt = html.indexOf('data-testid="stage-sheet-tool-format"');
      expect(sheetAt, `${loc}: the sheet row is there`).toBeGreaterThan(-1);
      expect(text(html.slice(sheetAt, html.indexOf("</button>", sheetAt))), `${loc}: the sheet row`).toContain(MATCH_RULES[loc]);
      expect((dict as Record<string, string>)["rulesStrip.format"], `${loc}: strip + card button`).toBe(MATCH_RULES[loc]);
      expect((dict as Record<string, string>)["stageRules.section.format"], `${loc}: the panel's section title key is retired (m6: the panel is already called Match rules)`).toBeUndefined();
      let checked = 0;
      for (const [key, value] of Object.entries(dict as Record<string, string>)) {
        checked++;
        for (const old of RETIRED_NAMES) expect(value, `${loc} ${key}: the retired name "${old}"`).not.toContain(old);
      }
      expect(checked, `${loc}: anti-vacuity, every key read`).toBeGreaterThan(5000);
      locales++;
    }
    expect(locales, "all four locales").toBe(4);
  });
});

// Match Day E1 fix round 1 (m6): the Match rules panel opens under a button already called "Match rules"; a second "Match rules" title
// inside it said the same thing twice. And each locale has ONE term for it: French had "règles du match", "règles de match" and
// "règles de la rencontre"; Spanish "reglas del partido", "reglas de partido" and "reglas de juego".
describe("E1 fix 1 m6: the Match rules panel names itself once, and every locale uses one term for it", () => {
  it("the panel's format section has no title of its own; the other sections keep theirs", () => {
    const html = panel({ initialOpenPanels: ["format"] });
    const at = html.indexOf('data-testid="stage-rules-section-format"');
    expect(at, "premise: the format section is on the page").toBeGreaterThan(-1);
    const section = html.slice(at, html.indexOf("</section>", at));
    expect(section, "premise: it holds fields").toContain("stage-rule-field-");
    expect(section, "no second 'Match rules' title").not.toMatch(/<h4/);

    expect(text(section)).not.toContain(MATCH_RULES.en);
    // The sections beside it still read as sections.
    const deciders = html.indexOf('data-testid="stage-rules-section-deciders"');
    if (deciders > -1) expect(text(html.slice(deciders, deciders + 400))).toContain("Deciders");
  });

  it("every English string that says 'match rules' is worded with the locale's one term in es, fr and nl (the owner's words, typed here)", () => {
    let checked = 0;
    for (const [loc, dict] of DICTS) {
      if (loc === "en") continue;
      const own = dict as Record<string, string>;
      for (const [key, english] of Object.entries(enUi as Record<string, string>)) {
        if (!/match rules/i.test(english)) continue;
        expect(own[key]?.toLowerCase(), `${loc} ${key}: says "${MATCH_RULES[loc]}"`).toContain(MATCH_RULES[loc].toLowerCase());
        checked++;
      }
    }
    expect(checked, "anti-vacuity: strings checked across es / fr / nl").toBeGreaterThan(20);
  });

  it("the drifted spellings are gone from every string", () => {
    const DRIFT: Record<string, string[]> = {
      fr: ["règles de match", "règles de la rencontre", "règles de rencontre"],
      es: ["reglas de partido", "reglas de juego", "reglas del encuentro"],
    };
    let checked = 0;
    for (const [loc, dict] of DICTS) {
      for (const bad of DRIFT[loc] ?? []) {
        for (const [key, value] of Object.entries(dict as Record<string, string>)) {
          expect(value.toLowerCase(), `${loc} ${key}: "${bad}"`).not.toContain(bad);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: every string of fr and es read").toBeGreaterThan(10000);
  });
});

// Match Day E1 item 3 (owner 2026-11-01): the bracket tree moved from above the cards INTO the knockout stage's card, behind a "Bracket"
// header button (closed by default), a "Bracket" row in the phone's Stage tools sheet, and the tree scrolling sideways inside the card.
// The fixtures are the ENGINE'S OWN generator output, numbered the way the stage writer numbers persisted rows; which kinds draw in the
// card is the owner's ruling (single-elimination shapes yes; double-elimination and stepladder keep the page), typed here on purpose.
const BR = "22222222-2222-4222-8222-222222222222";
function bracketRows(stageId: string, gen: GeneratedBracket, deLanes = false) {
  const counters = new Map<string, number>();
  return gen.fixtures.map((f) => {
    const lane = f.bracket ?? "WB";
    const offset = !deLanes ? 0 : lane === "LB" ? gen.rounds : lane === "GF" ? 2 * gen.rounds : 0;
    const round_no = offset + f.round + 1;
    const key = `${lane}:${round_no}`;
    const seq = (counters.get(key) ?? 0) + 1;
    counters.set(key, seq);
    return { ...fixture(stageId, counters.size * 10 + seq), id: f.id, round_no, seq_in_round: seq, fixture_no: counters.size * 10 + seq, home_entrant_id: f.home ?? null, away_entrant_id: f.away ?? null };
  });
}
const T4 = ["T1", "T2", "T3", "T4"];
const names = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `Team ${id}`]));
const bracketPanelProps = (stageKind: string, rows: ReturnType<typeof bracketRows>, over: Record<string, unknown> = {}) => ({
  stages: [stageRow({ id: BR, kind: stageKind, name: "Knockout" })],
  fixtures: rows,
  entrantNames: names(T4),
  stageTableRules: {},
  ...over,
});

describe("E1 item 3: the bracket opens from the knockout stage's card", () => {
  const rows = bracketRows(BR, generateSingleElim({ entrants: T4 }));

  it("a single-elimination knockout card has a Bracket button in its header, closed, and the tree is not drawn until it opens", () => {
    expect(rows.length, "premise: the generator produced a bracket").toBeGreaterThan(0);
    for (const canEdit of [true, false]) {
      const html = panel(bracketPanelProps("knockout", rows, { canEdit }));
      const at = html.indexOf('data-testid="stage-tool-bracket"');
      expect(at, `canEdit=${canEdit}: the header button`).toBeGreaterThan(-1);
      expect(text(html.slice(at, html.indexOf("</button>", at))), "named by the existing bracket title, in the en words").toContain(UI["bracket.title"]);
      expect(tag(html, "stage-tool-bracket"), "a disclosure, closed").toMatch(/aria-expanded="false"/);
      expect(count(html, "stage-bracket"), "closed: no tree container").toBe(0);
      expect(count(html, "bracket-panel"), "closed: no tree").toBe(0);
    }
  });

  it("open, the tree is drawn INSIDE the card (the real BracketPanel), after the header and before the rows, and the button reads open", () => {
    const html = panel(bracketPanelProps("knockout", rows, { initialOpenPanels: ["bracket"] }));
    expect(tag(html, "stage-tool-bracket")).toMatch(/aria-expanded="true"/);
    expect(count(html, "stage-bracket")).toBe(1);
    expect(count(html, "bracket-panel"), "the existing panel, drawn once").toBe(1);
    const card = html.slice(html.indexOf('data-stage-id="'), html.lastIndexOf("</section>"));
    const inCard = (id: string) => card.indexOf(`data-testid="${id}"`);
    expect(inCard("bracket-panel"), "inside the stage's card").toBeGreaterThan(-1);
    expect(inCard("stage-tool-bracket"), "after the header's button").toBeLessThan(inCard("bracket-panel"));
    expect(inCard("bracket-panel"), "before the rows").toBeLessThan(inCard("stage-run-sheet"));
    // The control names the container it opens.
    const controls = /data-testid="stage-tool-bracket"[^>]*aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls, "aria-controls").toBe(`stage-panel-${BR}-bracket`);
    expect(html, "the container carries that id").toContain(`id="${controls}"`);
  });

  it("the tree scrolls sideways inside the card: the panel's own scroller is kept, and the card clips nothing else", () => {
    const html = panel(bracketPanelProps("knockout", rows, { initialOpenPanels: ["bracket"] }));
    const panelAt = html.indexOf('data-testid="bracket-panel"');
    const scroller = html.indexOf("overflow-x-auto", panelAt);
    expect(scroller, "BracketPanel's overflow-x-auto scroller is inside its own section").toBeGreaterThan(panelAt);
    // The container the card wraps it in must be able to shrink (`min-w-0`), or the tree's fixed width pushes the page sideways.
    const wrapper = tag(html, "stage-bracket") ?? "";
    expect(wrapper, "min-w-0 so the wide tree scrolls in the card rather than widening the page").toMatch(/min-w-0/);
  });

  it("a phone's Stage tools sheet has a Bracket row too (an editor), toggling the same panel", () => {
    const html = panel(bracketPanelProps("knockout", rows));
    const at = html.indexOf('data-testid="stage-sheet-tool-bracket"');
    expect(at, "the sheet row").toBeGreaterThan(-1);
    expect(text(html.slice(at, html.indexOf("</button>", at)))).toContain(UI["bracket.title"]);
    expect(tag(html, "stage-sheet-tool-bracket")).toMatch(/aria-controls="stage-panel-[^"]+-bracket"/);
    // A viewer has no sheet; theirs is the header button above.
    expect(count(panel(bracketPanelProps("knockout", rows, { canEdit: false })), "stage-sheet-tool-bracket")).toBe(0);
  });

  it("the Bracket button comes last in the settings group, after Match rules / Points / Tie-breaks", () => {
    const html = panel(bracketPanelProps("knockout", rows, { sportKey: "badminton" }));
    const order = ["stage-tool-format", "stage-tool-bracket"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i >= 0), `both are present: ${order}`).toBe(true);
    expect(order[0]!).toBeLessThan(order[1]!);
  });

  it("every locale names the button with its own bracket word (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of DICTS) {
      const html = panel(bracketPanelProps("knockout", rows), loc, dict);
      const at = html.indexOf('data-testid="stage-tool-bracket"');
      expect(at, loc).toBeGreaterThan(-1);
      expect(text(html.slice(at, html.indexOf("</button>", at))), loc).toContain((dict as Record<string, string>)["bracket.title"]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  // The tree labels an empty seat from the feed edge INTO it. A cross-stage edge (a league's winner seated into the knockout) has its
  // source in ANOTHER stage's rows, so the card must hand the tree the WHOLE division's fixtures to build that map from, not only
  // this stage's: with the stage's own rows the seat would read "TBD" (BracketPanel's `divisionFixtures` note).
  it("the tree names an empty seat from a feed edge whose source sits in another stage (the whole division's rows are handed over)", () => {
    const LG = "44444444-4444-4444-8444-444444444444";
    const ko = bracketRows(BR, generateSingleElim({ entrants: T4 }));
    const target = ko.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const seat = { ...target, home_entrant_id: null as string | null };
    const source = { ...fixture(LG, 1), id: "lg-source", round_no: 3, seq_in_round: 2, winner_to_fixture: target.id, winner_to_slot: 1 };
    const html = panel({
      stages: [stageRow({ id: LG, seq: 1, name: "League" }), stageRow({ id: BR, seq: 2, kind: "knockout", name: "Knockout" })],
      fixtures: [source, ...ko.map((f) => (f.id === target.id ? seat : f))],
      entrantNames: names(T4),
      stageTableRules: {},
      initialOpenPanels: ["bracket"],
    });
    const treeAt = html.indexOf('data-testid="bracket-panel"');
    expect(treeAt, "premise: the tree is open").toBeGreaterThan(-1);
    const tree = html.slice(treeAt, html.indexOf("</section>", treeAt));
    const winnerOf = UI["slot.winner_match"]!.split("{ext}")[0]!;
    expect(winnerOf.length, "premise: the en copy has a lead-in").toBeGreaterThan(2);
    expect(tree, "the seat reads as the winner of the other stage's match").toContain(`${winnerOf}R3\u00b72`);
  });

  it("a page playoff is a tree and gets the button; double-elimination, stepladder, a league and a knockout with no bracket yet do not", () => {
    const cases: { name: string; kind: string; rows: ReturnType<typeof bracketRows>; button: boolean }[] = [
      { name: "page playoff", kind: "page_playoff", rows: bracketRows(BR, generatePagePlayoff({ entrants: T4 })), button: true },
      { name: "double elimination", kind: "double_elim", rows: bracketRows(BR, generateDoubleElim({ entrants: T4 }), true), button: false },
      { name: "stepladder", kind: "stepladder", rows: bracketRows(BR, generateStepladder({ entrants: T4 })), button: false },
      { name: "league (tree-shaped rows or not)", kind: "league", rows: rows, button: false },
      { name: "knockout with no bracket yet", kind: "knockout", rows: [], button: false },
    ];
    let checked = 0;
    for (const c of cases) {
      expect(c.kind === "knockout" && c.rows.length === 0 ? true : c.rows.length > 0, `${c.name}: premise, rows exist`).toBe(true);
      const html = panel(bracketPanelProps(c.kind, c.rows, { initialOpenPanels: ["bracket"] }));
      expect(count(html, "stage-tool-bracket") > 0, `${c.name}: the header button`).toBe(c.button);
      expect(count(html, "stage-sheet-tool-bracket") > 0, `${c.name}: the sheet row`).toBe(c.button);
      expect(count(html, "stage-bracket") > 0, `${c.name}: asked open, the tree container`).toBe(c.button);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The kind sets are the engine's own: every kind that is NOT a bracket stage gets no button, whatever it holds (swept).
    let nonBracket = 0;
    for (const kind of StageKind.options.filter((k) => !BRACKET_KINDS.has(k))) {
      const html = panel(bracketPanelProps(kind, rows));
      expect(count(html, "stage-tool-bracket"), kind).toBe(0);
      nonBracket++;
    }
    expect(nonBracket, "anti-vacuity: non-bracket kinds swept").toBeGreaterThan(2);
  });
});

describe("the header: Match format / Points / Tie-breaks buttons (item 9)", () => {
  it("a table stage shows all three; each is a disclosure that names the panel it opens", () => {
    const html = panel();
    for (const id of ["format", "points", "tiebreaks"]) {
      const t = tag(html, `stage-tool-${id}`);
      expect(t, `stage-tool-${id}`).not.toBeNull();
      expect(t).toContain('aria-expanded="false"');
      expect(t).toContain(`aria-controls="stage-panel-${A}-${id}"`);
      expect(t, "44px tap floor").toMatch(/\bmin-h-11\b/);
    }
    expect(text(html)).toContain(UI["rulesStrip.format"]!);
    expect(text(html)).toContain(UI["stagePoints.title"]!);
    expect(text(html)).toContain(UI["stageTiebreaks.title"]!);
  });

  it("sweep: Points and Tie-breaks appear only on a table stage - every engine stage kind, counted", () => {
    let tables = 0;
    let brackets = 0;
    for (const kind of StageKind.options) {
      const html = panel({ stages: [stageRow({ kind })], stageTableRules: { [A]: tableRulesOf(sport("badminton"), "league") } });
      expect(tag(html, "stage-tool-format"), `${kind}: Match format is on every stage`).not.toBeNull();
      const table = (DRAW_KINDS as ReadonlySet<string>).has(kind);
      expect(tag(html, "stage-tool-points") !== null, `${kind}: Points`).toBe(table);
      expect(tag(html, "stage-tool-tiebreaks") !== null, `${kind}: Tie-breaks`).toBe(table);
      if (table) tables++;
      else brackets++;
    }
    expect(tables, "table kinds").toBe(DRAW_KINDS.size);
    expect(brackets, "bracket kinds").toBe(BRACKET_KINDS.size);
    expect(tables + brackets).toBe(StageKind.options.length);
  });

  it("Tie-breaks needs the stage's table rules: a table stage whose rules did not read shows Points but no Tie-breaks", () => {
    const html = panel({ stageTableRules: {} });
    expect(tag(html, "stage-tool-points")).not.toBeNull();
    expect(tag(html, "stage-tool-tiebreaks")).toBeNull();
  });

  it("a viewer gets the same buttons (each panel reads, nothing writes)", () => {
    const html = panel({ canEdit: false, initialOpenPanels: ["format", "points", "tiebreaks"] });
    for (const id of ["format", "points", "tiebreaks"]) expect(tag(html, `stage-tool-${id}`), id).not.toBeNull();
    expect(html).not.toContain('data-testid="stage-format-save"');
    expect(html).not.toContain('data-testid="stage-points-save"');
  });
});

describe("the kind pill (item 1)", () => {
  it("is absent when the name already says the kind, present when it does not", () => {
    const named = panel({ stages: [stageRow({ name: "League", kind: "league" })] });
    expect(named).not.toMatch(/<span class="chip">league<\/span>/);
    const other = panel({ stages: [stageRow({ name: "Round robin", kind: "league" })] });
    expect(other).toMatch(/<span class="chip">league<\/span>/);
  });

  it("sweep: a stage named for its own kind never prints the kind twice, whatever the kind (counted)", () => {
    let checked = 0;
    for (const kind of StageKind.options) {
      const spoken = kind.replace(/_/g, " ");
      const html = panel({ stages: [stageRow({ kind, name: spoken })] });
      expect(html, `${kind}: pill`).not.toContain(`<span class="chip">${spoken}</span>`);
      expect(html, `${kind}: the name is on the card`).toContain(`1. ${spoken}`);
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });
});

describe("the body: a one-line summary, no inline sections (items 5, 6, 7, 12)", () => {
  it("panels closed: the summary line is there; no format editor, points or tie-breaks section is", () => {
    const html = panel();
    expect(count(html, "stage-format-summary")).toBe(1);
    for (const id of ["stage-format-editor", "stage-format-save", `stage-points-${A}`, `stage-tiebreaks-${A}`, "stage-points-readonly"]) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
  });

  it("badminton: 'Win 2 · Loss 0' once, ties in the sport's own word 'game' (never 'set'), both from the engine's declarations", () => {
    const m = sport("badminton");
    const rules = tableRulesOf(m, "league");
    const html = panel();
    const line = text(/data-testid="stage-format-summary">([^<]*)</.exec(html)![1]!);
    const pair = m.tablePointsRule(m.configSchema.parse({}), "league").bySetScore!["*"]!;
    expect(line).toContain(UI["stageCard.points.uniform"]!.replace("{w}", String(pair[0])).replace("{l}", String(pair[1])));
    // the first real rung the engine's own order names, in the sport's unit
    const steps = rules.tiebreakers.keys.filter((k) => k !== "h2h_two");
    expect(line).toContain(UI["stageCard.summary.ties"]!.split("{steps}")[0]!);
    expect(line).toContain(UI[unitLabelKey(steps[0]!, "badminton")]!);
    const unit = UI[unitLabelKey("set_diff", "badminton")]!;
    expect(unit, "premise: badminton words a set as a game").toContain("game");
    expect(line.includes("set difference"), "never the volleyball word").toBe(false);
  });

  it("volleyball keeps 'set' - the same rung, another sport", () => {
    const m = sport("volleyball");
    const html = panel({ sportKey: "volleyball", stageTableRules: { [A]: tableRulesOf(m, "league") } });
    const line = text(/data-testid="stage-format-summary">([^<]*)</.exec(html)![1]!);
    const rungs = tableRulesOf(m, "league").tiebreakers.keys.filter((k) => k !== "h2h_two");
    expect(line).toContain(UI[unitLabelKey(rungs[0]!, "volleyball")]!);
    expect(UI[unitLabelKey("set_diff", "volleyball")]!).toContain("set");
  });

  it("a stage that follows the division says nothing of differing; one with its own format says exactly what differs", () => {
    expect(panel()).not.toContain('data-testid="stage-differs"');
    const html = panel({ stages: [stageRow({ config: { rules: { bestOf: 1 } } })] });
    expect(html).toContain('data-testid="stage-differs"');
    expect(text(html)).toContain(UI["stageCard.summary.differs"]!.replace("{parts}", UI["rulesStrip.format"]!));
  });

  it("M4 (C2 deferred): a stage pinned from the division's order differs once the division's order has changed", () => {
    const m = sport("badminton");
    const started = m.defaultTiebreakers("league", m.configSchema.parse({}));
    const pin = {
      points: m.tablePointsRule(m.configSchema.parse({}), "league"),
      tiebreakers: started,
      crossGroup: started,
      sources: { points: "sport", tiebreakers: "division", crossGroup: "derived" },
    } as never;
    const rules = tableRulesOf(m, "league", { pinned: pin });
    const moved = [...started].reverse();
    const strip = (order: readonly string[] | null) =>
      ({
        divisionId: "d1",
        sportKey: "badminton",
        variantKey: null,
        divisionConfig: {},
        divisionTiebreakers: order,
        tableKinds: ["league"],
        canEdit: true,
        ruleDict: undefined,
        pointsDict: undefined,
        variants: [],
        lockedFields: [],
        onlineChessOffered: false,
        lichessGaps: [],
      }) as never;
    const same = panel({ stageTableRules: { [A]: rules }, rulesStrip: strip(started) });
    expect(same, "the division still ranks as the stage was pinned").not.toContain('data-testid="stage-differs"');
    const differs = panel({ stageTableRules: { [A]: rules }, rulesStrip: strip(moved) });
    expect(differs, "the division changed after the stage started").toContain('data-testid="stage-differs"');
    expect(text(differs)).toContain(UI["stageTiebreaks.title"]!);
  });

  it("a started stage says it is locked ONCE in the summary", () => {
    const html = panel({ formatLockedStageIds: [A] });
    expect(count(html, "stage-locked")).toBe(1);
    expect(text(html)).toContain(UI["stageCard.locked"]!);
    expect(panel({ formatLockedStageIds: [] })).not.toContain('data-testid="stage-locked"');
  });

  // Review I3 (controller ruling): the card carries ONE lock line - the summary's. A panel opened under it renders locked, without
  // a line of its own. Every sport, every table kind, all three panels open at once: the sum of the four testids is exactly 1.
  it("sweep: all three panels open on a locked stage - exactly ONE lock line on the card, in every sport and table kind", () => {
    const LOCK_IDS = ["stage-locked", "stage-format-locked", "stage-points-locked", "stage-tiebreaks-locked"] as const;
    let checked = 0;
    for (const m of builtinModules) {
      for (const kind of ["league", "group"] as const) {
        const html = panel({
          sportKey: m.key,
          stages: [stageRow({ kind })],
          stageTableRules: { [A]: tableRulesOf(m, kind) },
          formatLockedStageIds: [A],
          initialOpenPanels: ["format", "points", "tiebreaks"],
        });
        // Anti-vacuity: the panels really are open and really are the locked kind, or a count of 1 proves nothing.
        expect(count(html, "stage-format-editor"), `${m.key}/${kind}: the format panel is open`).toBe(1);
        expect(html, `${m.key}/${kind}: format panel locked`).toMatch(/data-testid="stage-format-editor"[^>]*data-mode="locked"/);
        // (A sport whose engine cannot read the stage's points renders the "inexpressible" notice instead of the rows - either way the
        // points panel is open, and neither says a lock line.)
        expect(count(html, "stage-points-readonly") + count(html, "stage-points-inexpressible"), `${m.key}/${kind}: the points panel is open`).toBeGreaterThan(0);
        expect(count(html, "stage-points-clear") + count(html, "stage-points-save"), `${m.key}/${kind}: the points panel is not the editor`).toBe(0);
        expect(html, `${m.key}/${kind}: the tie-breaks panel is open and locked`).toContain('data-state="locked"');
        const lines = LOCK_IDS.reduce((n, id) => n + count(html, id), 0);
        expect(lines, `${m.key}/${kind}: one lock line on the card`).toBe(1);
        expect(count(html, "stage-locked"), `${m.key}/${kind}: it is the summary's`).toBe(1);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: sports x kinds swept").toBe(builtinModules.length * 2);
    expect(checked).toBeGreaterThan(0);
  });
});

// Match Day E1 item 1 (owner 2026-11-01): the stage's actions (Add match, Complete stage, Pair next / Unpair / Generate) are in the card
// HEADER - an actions group on the left, a thin divider, then the settings buttons on the right.
describe("E1 item 1: the header is [actions | divider | settings], the footer row is gone", () => {
  const order = (html: string, ids: string[]) => ids.map((id) => html.indexOf(`data-testid="${id}"`));

  it("an editor: actions, then the divider, then the settings buttons, all inside the header's one controls cluster", () => {
    const html = panel();
    const [rail, complete, add, divider, tools, format] = order(html, ["stage-rail", "stage-complete", "stage-add-match", "stage-controls-divider", "stage-tools", "stage-tool-format"]);
    for (const [name, at] of Object.entries({ rail, complete, add, divider, tools, format })) expect(at, `${name} is on the card`).toBeGreaterThan(-1);
    expect(complete!, "Complete is in the actions group").toBeGreaterThan(rail!);
    expect(divider!, "the divider follows the last action").toBeGreaterThan(Math.max(complete!, add!));
    expect(divider!, "and precedes the settings buttons").toBeLessThan(tools!);
    expect(tools!).toBeLessThan(format!);
    expect(count(html, "stage-controls-divider"), "one divider").toBe(1);
    expect(count(html, "stage-controls"), "one cluster").toBe(1);
    const cluster = html.slice(html.indexOf('data-testid="stage-controls"'));
    expect(cluster.indexOf('data-testid="stage-rail"'), "the actions group opens the cluster").toBeLessThan(cluster.indexOf('data-testid="stage-tools"'));
    // The divider is a desktop device: hidden below md, where the actions are the Stage tools sheet.
    expect(tag(html, "stage-controls-divider"), "bare `hidden`, not `max-md:hidden`").toMatch(/class="(?:[^"]* )?hidden /);
    expect(tag(html, "stage-controls-divider")).toMatch(/\bmd:block\b/);
    // The header is the cluster's home: it comes before the counts line and before the rows.
    expect(rail!).toBeLessThan(html.indexOf('data-testid="stage-progress-counts"'));
    expect(rail!).toBeLessThan(html.indexOf('data-testid="stage-run-sheet"'));
  });

  it("every stage kind, counted: at most one divider, and only with actions on the left AND settings on the right", () => {
    let checked = 0;
    let withDivider = 0;
    for (const kind of StageKind.options) {
      for (const status of ["pending", "active", "complete"]) {
        const html = panel({
          stages: [stageRow({ kind, status })],
          stageTableRules: { [A]: tableRulesOf(sport("badminton"), "league") },
          fixtures: status === "pending" ? [] : MOCK_FIXTURES,
        });
        const dividers = count(html, "stage-controls-divider");
        expect(dividers, `${kind}/${status}`).toBeLessThanOrEqual(1);
        if (dividers === 1) {
          withDivider++;
          const at = html.indexOf('data-testid="stage-controls-divider"');
          const actionAt = Math.max(...["stage-generate", "stage-complete", "stage-add-match", "stage-unpair", "stage-delete"].map((id) => html.indexOf(`data-testid="${id}"`)));
          expect(actionAt, `${kind}/${status}: an action sits before the divider`).toBeGreaterThan(-1);
          expect(actionAt, `${kind}/${status}`).toBeLessThan(at);
          expect(html.indexOf('data-testid="stage-tools"'), `${kind}/${status}: settings after it`).toBeGreaterThan(at);
        }
        checked++;
      }
    }
    expect(checked, "kinds x statuses swept").toBe(StageKind.options.length * 3);
    expect(withDivider, "anti-vacuity: some card really has both groups").toBeGreaterThan(0);
  });

  it("a viewer: no actions group, no divider; the settings buttons stay on screen at every width", () => {
    const html = panel({ canEdit: false });
    expect(html).not.toContain('data-testid="stage-rail"');
    expect(html).not.toContain("stage-controls-divider");
    expect(tag(html, "stage-controls"), "positive pair: the viewer still has the cluster").not.toBeNull();
    expect(tag(html, "stage-tools")).not.toMatch(/max-md:hidden/);
    expect(count(html, "stage-tool-format")).toBe(1);
  });

  it("the footer is gone: no 'To schedule in this stage' band; the court tags sit at the card's foot for editor and viewer alike", () => {
    for (const canEdit of [true, false]) {
      const html = panel({ canEdit });
      expect(html, `canEdit=${canEdit}`).not.toContain("stage-unscheduled-count");
      expect(text(html), `canEdit=${canEdit}`).not.toContain("To schedule in this stage");
      expect(count(html, "stage-court-tags"), `canEdit=${canEdit}: one court-tags line`).toBe(1);
      expect(html.indexOf('data-testid="stage-court-tags"'), `canEdit=${canEdit}: after the rows`).toBeGreaterThan(html.indexOf('data-testid="stage-run-sheet"'));
    }
  });

  it("the Complete reason is an ⓘ, not a paragraph: it names the button, and a stage that can complete has no ⓘ", () => {
    const waiting = panel();
    expect(tag(waiting, "stage-complete-info")).toContain('aria-describedby="stage-complete-hint-' + A + '"');
    expect(tag(waiting, "stage-complete")).toContain('aria-describedby="stage-complete-hint-' + A + '"');
    expect(waiting).not.toMatch(/<p[^>]*stage-complete-hint/);
    const done = panel({ fixtures: [fixture(A, 1, { status: "decided", outcome: DECIDED })] });
    expect(tag(done, "stage-complete")).not.toBeNull();
    expect(done).not.toContain("stage-complete-info");
  });
});

describe("the embedded sheet never rounds a bottom the card does not end on (review m3)", () => {
  // Something always follows the sheet inside a stage card: the court-tags line (an editor's editor, a viewer's read-only line - E1
  // item 1 moved the editor's out of the rail to the card's foot). So no stage-card sheet takes the card's radius on its last row - for
  // either audience. (React serialises `>` as `&gt;` in class text.)
  const ROUND_LAST = "[&amp;&gt;section:last-child&gt;ul&gt;li:last-child]:rounded-b-2xl";
  it("editor and viewer: the embedded sheet carries no last-row rounding; the court-tags line follows it", () => {
    let checked = 0;
    for (const canEdit of [true, false]) {
      const html = panel({ canEdit });
      expect(count(html, "stage-run-sheet"), `canEdit=${canEdit}: the sheet is in the card`).toBe(1);
      expect(html, `canEdit=${canEdit}: no last-row rounding`).not.toContain(ROUND_LAST);
      const sheetAt = html.indexOf('data-testid="stage-run-sheet"');
      const followedBy = html.indexOf('data-testid="stage-court-tags"', sheetAt);
      expect(followedBy, `canEdit=${canEdit}: something follows the sheet in the card`).toBeGreaterThan(sheetAt);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("the stage's fixtures are in the card (item 9)", () => {
  it("each stage card holds its OWN rows - no 'View N fixtures', no 'See the fixtures' link, in any locale", () => {
    let checked = 0;
    for (const [locale, dict] of DICTS) {
      const html = panel({}, locale, dict);
      expect(count(html, "stage-run-sheet"), `${locale}: the stage's rows are in the card`).toBe(1);
      expect(html, `${locale}: no View N fixtures`).not.toContain('data-testid="stage-view-fixtures"');
      expect(Object.keys(dict).filter((k) => k.startsWith("schedule.stage.viewFixtures")), `${locale}: the retired words are gone`).toEqual([]);
      expect(html.toLowerCase(), `${locale}: no link text`).not.toContain("see the fixtures");
      checked++;
    }
    expect(checked).toBe(DICTS.length);
  });

  it("the rows are the stage's: three matches in, three rows in the card", () => {
    const html = panel();
    expect(html.split("data-fixture-no=").length - 1).toBe(MOCK_FIXTURES.length);
    // E1 item 1: the stage's actions are in the card HEADER, above the rows (they used to sit below them).
    const railAt = html.indexOf('data-testid="stage-rail"');
    expect(railAt, "the actions are on the card").toBeGreaterThan(-1);
    expect(railAt, "the actions sit before the stage's rows").toBeLessThan(html.indexOf('data-testid="stage-run-sheet"'));
  });

  it("two stages: each card holds only its own stage's rows, under ONE filter bar for the division", () => {
    const stages = [stageRow(), stageRow({ id: B, seq: 2, name: "Playoffs", kind: "knockout", status: "pending" })];
    const fixtures = [...MOCK_FIXTURES, fixture(B, 11), fixture(B, 12)];
    const html = panel({ stages, fixtures, stageTableRules: { [A]: tableRulesOf(sport("badminton"), "league") } });
    expect(count(html, "stage-run-sheet")).toBe(2);
    expect(count(html, "run-sheet-filter"), "one filter bar").toBe(1);
    expect(count(html, "run-sheet"), "one run-sheet wrapper").toBe(1);
    const first = html.slice(html.indexOf(`data-stage-id="${A}"`), html.indexOf(`data-stage-id="${B}"`));
    const second = html.slice(html.indexOf(`data-stage-id="${B}"`));
    expect(first.split("data-fixture-no=").length - 1, "stage A's rows").toBe(MOCK_FIXTURES.length);
    expect(second.split("data-fixture-no=").length - 1, "stage B's rows").toBe(2);
  });

  it("a stage with no fixtures keeps its 'no fixtures' line and mounts no sheet; a division with none has no run-sheet at all", () => {
    const html = panel({ fixtures: [], stages: [stageRow({ status: "pending" })] });
    expect(html).toContain('data-testid="stage-no-fixtures"');
    expect(html).not.toContain('data-testid="stage-run-sheet"');
    expect(html).not.toContain('data-testid="run-sheet"');
  });

  it("the filter that leaves no row anywhere says so ONCE, with the way back (and the stage sheets stay quiet)", () => {
    // Every fixture is unscheduled or far in the future, so "Today" keeps none of them.
    const html = panel({ phase: "match_day" });
    expect(count(html, "run-sheet-empty")).toBe(1);
    expect(count(html, "run-sheet-empty-show-all")).toBe(1);
    expect(html).not.toContain('data-testid="stage-run-sheet-empty"');
  });
});

describe("the buttons follow the stage's state (item 8) - through the real panel", () => {
  it("the mock's case (1 in play, 2 to schedule): no Generate; Complete present but disabled with its reason; Add match is there", () => {
    const html = panel();
    expect(tag(html, "stage-generate")).toBeNull();
    expect(tag(html, "stage-complete")).not.toBeNull();
    expect(disabled(html, "stage-complete")).toBe(true);
    expect(tag(html, "stage-complete"), "E1 item 1: focusable, not `disabled`").toContain('aria-disabled="true"');
    expect(tag(html, "stage-complete")).not.toMatch(/\sdisabled=""/);
    expect(text(html)).toContain(UI["stageCard.completeHint.other"]!.replace("{count}", "3"));
    expect(tag(html, "stage-add-match")).not.toBeNull();
  });

  it("every match settled (a walkover and a cancelled one included): Complete leads and is enabled, with no hint", () => {
    const fixtures = [
      fixture(A, 1, { status: "decided", outcome: DECIDED }),
      fixture(A, 2, { status: "forfeited" }),
      fixture(A, 3, { status: "cancelled" }),
    ];
    const html = panel({ fixtures });
    expect(disabled(html, "stage-complete")).toBe(false);
    expect(tag(html, "stage-complete")).toMatch(/\bbtn-primary\b/);
    expect(html).not.toContain("stage-complete-hint");
  });

  it("a match in `needs_decision` keeps Complete locked and is said as waiting for a decision, not as 'in play'", () => {
    const fixtures = [fixture(A, 1, { status: "decided", outcome: DECIDED }), fixture(A, 2, { status: "needs_decision" })];
    const html = panel({ fixtures });
    expect(disabled(html, "stage-complete")).toBe(true);
    const counts = text(/data-testid="stage-progress-counts"[^>]*>(.*?)<\/p>/s.exec(html)![1]!.replace(/<[^>]*>/g, ""));
    expect(counts).toContain(UI["schedule.progress.held.one"]!);
    expect(counts).not.toContain(UI["schedule.progress.inPlay.one"]!);
  });

  // Review I2. The held match the organiser actually meets is a PLAIN ABANDON: it is stored `abandoned` (a settled-looking status)
  // and is held only because the page lists it as awaiting its settle - the same list the run sheet's rows read. The status map
  // alone would call it played and let Complete lead over a match the server still refuses Complete for.
  it("a plain abandon listed in awaitingSettle (status 'abandoned') keeps Complete locked and is counted as waiting for a decision", () => {
    const fixtures = [fixture(A, 1, { status: "decided", outcome: DECIDED }), fixture(A, 2, { status: "abandoned" })];
    const unlisted = panel({ fixtures });
    // The positive pair: the same fixtures WITHOUT the list read as settled - Complete leads, enabled (so the list is what holds it).
    expect(disabled(unlisted, "stage-complete"), "premise: unlisted, an abandon is settled").toBe(false);
    expect(tag(unlisted, "stage-complete")).toMatch(/\bbtn-primary\b/);
    const html = panel({ fixtures, awaitingSettle: [fixtures[1]!.id] });
    expect(disabled(html, "stage-complete")).toBe(true);
    expect(tag(html, "stage-complete")).not.toMatch(/\bbtn-primary\b/);
    expect(html).toContain("stage-complete-hint");
    const counts = text(/data-testid="stage-progress-counts"[^>]*>(.*?)<\/p>/s.exec(html)![1]!.replace(/<[^>]*>/g, ""));
    expect(counts).toContain(UI["schedule.progress.held.one"]!);
    expect(counts).not.toContain(UI["schedule.progress.inPlay.one"]!);
  });

  it("a settle that lands (the id leaves awaitingSettle) lets Complete lead again - a second render, not a stale first one", () => {
    const fixtures = [fixture(A, 1, { status: "decided", outcome: DECIDED }), fixture(A, 2, { status: "abandoned" })];
    const held = panel({ fixtures, awaitingSettle: [fixtures[1]!.id] });
    const settled = panel({ fixtures, awaitingSettle: [] });
    expect(disabled(held, "stage-complete")).toBe(true);
    expect(disabled(settled, "stage-complete")).toBe(false);
    expect(settled).not.toContain("stage-complete-hint");
  });

  it("Swiss mid-round: Pair next round leads (enabled), Complete is present but disabled", () => {
    const swiss = stageRow({ kind: "swiss", name: "Swiss", config: { rounds: 3 } });
    const fixtures = [
      fixture(A, 1, { status: "decided", outcome: DECIDED }),
      { ...fixture(A, 2), home_entrant_id: null as unknown as string, away_entrant_id: null, ext_key: "r2-1" } as never,
    ];
    const html = panel({ stages: [swiss], fixtures, stageTableRules: {} });
    expect(html).toContain(">Pair next round</button>");
    expect(disabled(html, "stage-generate")).toBe(false);
    expect(tag(html, "stage-generate")).toMatch(/\bbtn-primary\b/);
    expect(disabled(html, "stage-complete")).toBe(true);
  });

  it("a stage that has not started leads with Generate; a stage with no fixtures that has started offers neither", () => {
    const pending = panel({ stages: [stageRow({ status: "pending" })], fixtures: [] });
    expect(tag(pending, "stage-generate")).toMatch(/\bbtn-primary\b/);
    expect(tag(pending, "stage-complete")).toBeNull();
    const started = panel({ stages: [stageRow({ status: "active" })], fixtures: [] });
    expect(tag(started, "stage-generate")).toBeNull();
    expect(tag(started, "stage-complete")).toBeNull();
  });

  it("a complete stage offers no action (Delete aside); a viewer has no rail", () => {
    const fixtures = [fixture(A, 1, { status: "decided", outcome: DECIDED })];
    const done = panel({ stages: [stageRow({ status: "complete" })], fixtures });
    for (const id of ["stage-generate", "stage-complete", "stage-add-match"]) expect(done, id).not.toContain(`data-testid="${id}"`);
    const viewer = panel({ canEdit: false });
    expect(viewer).not.toContain('data-testid="stage-complete"');
  });

  it("a status the schema does not have is refused loudly, never counted as zero (the carried ruling)", () => {
    expect(() => panel({ fixtures: [fixture(A, 1, { status: "mystery" })] })).toThrow(/unknown fixture status/);
  });
});

describe("the phone: the three buttons are the TOP rows of the one 'Stage tools' sheet (review round 1; AGENTS.md rules 22, 23)", () => {
  it("an editor: no separate 'Stage settings' trigger or menu; ONE phone trigger (Stage tools); the rows sit first in the sheet, md:hidden", () => {
    const html = panel();
    expect(count(html, "stage-settings-trigger"), "the retired trigger is gone").toBe(0);
    expect(count(html, "stage-settings-menu"), "the retired menu is gone").toBe(0);
    expect(html).not.toContain("stage-settings-");
    expect(count(html, "stage-rail-trigger"), "the card's one phone trigger").toBe(1);
    expect(tag(html, "stage-rail-trigger")).toMatch(/\bmin-h-11\b/);
    expect(text(html)).toContain(UI["schedule.stageTools"]!);
    const group = tag(html, "stage-sheet-tools")!;
    expect(group, "the rows are phone-only: the header's buttons are the desktop twin").toMatch(/\smd:hidden\b/);
    expect(group).not.toMatch(/max-md:hidden/);
    const header = tag(html, "stage-tools")!;
    expect(header, "the header row is the desktop twin: hidden below md for an editor").toMatch(/max-md:hidden/);
    // The rows come BEFORE every action in the sheet (they are its top rows), and the sheet is where they live.
    const rail = html.slice(html.indexOf('data-testid="stage-rail-sheet"'));
    const rowsAt = rail.indexOf('data-testid="stage-sheet-tools"');
    expect(rowsAt, "the rows are inside the sheet").toBeGreaterThan(-1);
    for (const action of ["stage-complete", "stage-delete", "stage-add-match"]) {
      const at = rail.indexOf(`data-testid="${action}"`);
      if (at !== -1) expect(rowsAt, `${action}: after the rows`).toBeLessThan(at);
    }
    for (const id of ["format", "points", "tiebreaks"]) {
      const row = tag(html, `stage-sheet-tool-${id}`);
      expect(row, `${id}: a row in the sheet`).not.toBeNull();
      expect(row).toContain('aria-expanded="false"');
      expect(row).toContain(`aria-controls="stage-panel-${A}-${id}"`);
      expect(row, "44px tap floor").toMatch(/\bmin-h-11\b/);
      expect(count(html, `stage-tool-${id}`), `${id}: the header's twin exists once`).toBe(1);
      expect(count(html, `stage-sheet-tool-${id}`), `${id}: the sheet's row exists once`).toBe(1);
    }
  });

  it("sweep: the rows are the header's buttons, one for one, on every stage kind (Points and Tie-breaks on table stages only)", () => {
    let checked = 0;
    for (const kind of StageKind.options) {
      const html = panel({ stages: [stageRow({ kind })], stageTableRules: { [A]: tableRulesOf(sport("badminton"), "league") } });
      for (const id of ["format", "points", "tiebreaks"]) {
        expect(count(html, `stage-sheet-tool-${id}`), `${kind}/${id}: the sheet's row mirrors the header's button`).toBe(count(html, `stage-tool-${id}`));
        checked++;
      }
      const table = (DRAW_KINDS as ReadonlySet<string>).has(kind);
      expect(count(html, "stage-sheet-tool-format"), `${kind}: Match format is a row on every stage`).toBe(1);
      expect(count(html, "stage-sheet-tool-points"), `${kind}: Points`).toBe(table ? 1 : 0);
    }
    expect(checked, "anti-vacuity: kinds x panels swept").toBe(StageKind.options.length * 3);
  });

  it("an open panel reads open on BOTH twins (a second look at the same state)", () => {
    const html = panel({ initialOpenPanels: ["points"] });
    for (const id of ["stage-tool-points", "stage-sheet-tool-points"]) expect(tag(html, id), id).toContain('aria-expanded="true"');
    for (const id of ["stage-tool-format", "stage-sheet-tool-format"]) expect(tag(html, id), id).toContain('aria-expanded="false"');
  });

  it("two stages: each card has its own rows, aimed at its own panels, and no id collides", () => {
    const stages = [stageRow(), stageRow({ id: B, seq: 2, name: "Group B", kind: "group", status: "pending" })];
    const html = panel({ stages, fixtures: [], stageTableRules: { [A]: tableRulesOf(sport("badminton"), "league"), [B]: tableRulesOf(sport("badminton"), "group") } });
    expect(count(html, "stage-rail-trigger")).toBe(2);
    expect(count(html, "stage-sheet-tools")).toBe(2);
    expect(count(html, "stage-sheet-tool-format")).toBe(2);
    expect(html).toContain(`aria-controls="stage-panel-${A}-format"`);
    expect(html).toContain(`aria-controls="stage-panel-${B}-format"`);
    const ids = [...html.matchAll(/\sid="(stage-rail-sheet-[^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a viewer has no sheet (the rail renders nothing), so the header's buttons stay on screen at every width", () => {
    const html = panel({ canEdit: false });
    expect(count(html, "stage-rail-sheet")).toBe(0);
    expect(count(html, "stage-sheet-tools")).toBe(0);
    const header = tag(html, "stage-tools")!;
    expect(header, "no max-md:hidden: a phone viewer still reaches the panels").not.toMatch(/max-md:hidden/);
    for (const id of ["format", "points", "tiebreaks"]) expect(count(html, `stage-tool-${id}`), id).toBe(1);
  });
});
