import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail, SwissPairingMenuPanel } from "@/components/v2/desk/stage-rail";
import { DictProvider } from "@/components/i18n/dict-provider";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import enDict from "@/dictionaries/en/ui.json";
import { ApiV1Error } from "@/lib/client-v1";
import { SWISS_PAIRING_ROUND_ONE_ONLY_CODE } from "@/lib/swiss-pairing";
import { innerOf, parentOf, subtreeOf } from "./_markup";

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Swiss round-1 pairing (spec 2026-09-22-swiss-round-one-pairing, "UI"): the
// PANEL is what decides whether the rail gets a menu at all. `stage-rail.test`
// pins the rail given a menu, and `swiss-pairing-menu.test` pins the
// derivation; this file pins the seam between them — that StagesPanel really
// computes the menu from its own stage/fixtures and hands it down (an inert
// seam passes both of those other files).
//
// Markup only (vitest is node): the OPEN menu is not reachable from here.

const swissStage = (config: Record<string, unknown> = { rounds: 2 }, status = "active") => ({
  id: "s1",
  seq: 1,
  kind: "swiss",
  name: "Swiss",
  config,
  progression: null,
  status,
});

/** Two rounds of four boards for an 8-entrant field; `seated` rounds carry
 *  both seats, the rest are the empty shells a first Generate mints. */
const fixtures = (seatedRounds: number[] = []) =>
  Array.from({ length: 8 }, (_, i) => {
    const round = Math.floor(i / 4) + 1;
    const seated = seatedRounds.includes(round);
    return {
      id: `f${i + 1}`,
      stage_id: "s1",
      pool_id: null,
      round_no: round,
      seq_in_round: (i % 4) + 1,
      fixture_no: i + 1,
      home_entrant_id: seated ? `e${(i % 4) + 1}` : null,
      away_entrant_id: seated ? `e${(i % 4) + 5}` : null,
      scheduled_at: null,
      venue: null,
      court_label: null,
      court_id: null,
      court_name: null,
      status: "scheduled",
      outcome: null,
      ext_key: `sw-r${round}-b${(i % 4) + 1}`,
    };
  });

const ids = Array.from({ length: 8 }, (_, i) => `e${i + 1}`);
const props = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])),
  activeEntrantIds: ids,
  entrantSeeds: Object.fromEntries(ids.map((id, i) => [id, i + 1])),
  canEdit: true,
};

const TOGGLE = 'data-testid="stage-pairing-toggle"';

describe("StagesPanel — hands the Pair next split button its menu", () => {
  it("a Swiss stage with round 1 waiting gets the toggle, beside Pair next", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures()} />,
    );
    expect(html).toContain(">Pair next round</button>");
    expect(html).toContain(TOGGLE);
    expect(html).toContain('aria-controls="pairing-menu-s1"');
  });

  it("round 2 waiting still gets it (the menu opens read-only there)", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([1])} />,
    );
    expect(html).toContain(">Pair next round</button>");
    expect(html).toContain(TOGGLE);
  });

  // Review ruling R3 — no round waiting ⇒ no menu. Positive pair first: the
  // rail must still be rendering its buttons, or the absence proves nothing.
  it("every round seated ⇒ no toggle", () => {
    // Match Day C3 (review m5): the split button (and so its toggle) only renders where Generate / Pair next leads, which an
    // ACTIVE stage never does - so the absence of the toggle there is the stage's state, not the guard under test. A PENDING stage
    // keeps the Generate button on screen (the positive pair), and then only "a round is waiting to be paired" can put a toggle in
    // it: every round seated, it must not.
    const html = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage({ rounds: 2 }, "pending")]} fixtures={fixtures([1, 2])} />,
    );
    expect(html, "the rail is rendering its lead button, or the absence proves nothing").toContain('data-testid="stage-generate"');
    expect(html).not.toContain(">Pair next round</button>");
    expect(html).not.toContain(TOGGLE);
    // And the same stage with a round waiting DOES carry it - the toggle is a function of the unseated round, not of the status.
    const waiting = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage({ rounds: 2 }, "pending")]} fixtures={fixtures([1])} />,
    );
    expect(waiting).toContain(TOGGLE);
  });

  it("no shells yet (first Generate) ⇒ no toggle — the server refuses a pick there", () => {
    const html = renderToStaticMarkup(<StagesPanel {...props} stages={[swissStage({ rounds: 2 }, "pending")]} fixtures={[]} />);
    expect(html).toContain(">Generate fixtures</button>");
    expect(html).not.toContain(TOGGLE);
  });

  it("a non-Swiss stage never gets one, even with unseated rows", () => {
    // Pending, like the test above: the league's Generate button is on screen, so the toggle's absence is the KIND guard working
    // (the same unseated shells on a Swiss stage carry the toggle - see "round 1 waiting"), not a hidden button.
    const league = { ...swissStage({ rounds: 2 }, "pending"), kind: "league", name: "League" };
    const html = renderToStaticMarkup(<StagesPanel {...props} stages={[league]} fixtures={fixtures()} />);
    expect(html, "the rail's lead button is on screen").toContain('data-testid="stage-generate"');
    expect(html).not.toContain(TOGGLE);
    const swiss = renderToStaticMarkup(<StagesPanel {...props} stages={[swissStage({ rounds: 2 }, "pending")]} fixtures={fixtures()} />);
    expect(swiss, "the positive pair: the same rows on a Swiss stage").toContain(TOGGLE);
  });

  it("a viewer who cannot edit sees no rail, so no toggle", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...props} canEdit={false} stages={[swissStage()]} fixtures={fixtures()} />,
    );
    expect(html).not.toContain('data-testid="stage-generate"');
    expect(html).not.toContain(TOGGLE);
  });
});

// W3 T8 (X-SW-22): an unseeded round 1 is the stage's seeded random draw, and the round-1 menu says so. The seam is the
// panel's: it reads the page's real seeds (null for an unseeded entrant) into the menu it hands the rail. A menu
// derivation that is right but never fed the seeds would leave the line dark — so this drives the PANEL's own menu
// through the rail's real panel component.
describe("StagesPanel — the round-1 menu says an unseeded field is drawn at random (X-SW-22)", () => {
  const menuOf = (entrantSeeds: Record<string, number | null>, seated: number[] = []) => {
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation(() => Promise.resolve({}));
    const island = renderIsland(StagesPanel, { ...props, entrantSeeds, stages: [swissStage()], fixtures: fixtures(seated) });
    const rails = island.tree().filter((el) => el.type === StageRail);
    expect(rails).toHaveLength(1);
    return propsOf(rails[0]!).swissPairingMenu as Parameters<typeof SwissPairingMenuPanel>[0]["menu"];
  };
  const NOTE = 'data-testid="stage-pairing-draw-note"';
  const panelHtml = (menu: Parameters<typeof SwissPairingMenuPanel>[0]["menu"]) =>
    renderToStaticMarkup(<SwissPairingMenuPanel stageId="s1" menu={menu} pick={null} onPick={() => {}} onClose={() => {}} />);

  it("a wholly seeded field: no draw, no line (the empty case first)", () => {
    const menu = menuOf(props.entrantSeeds);
    expect(menu).toMatchObject({ round: 1, choosable: true, unseededDrawn: false });
    const html = panelHtml(menu);
    expect(html, "positive control: the round-1 options rendered").toContain('data-testid="stage-pairing-fold"');
    expect(html).not.toContain(NOTE);
    expect(html).not.toContain("aria-describedby=");
  });

  it("one unseeded entrant: the line, under the options, described by the group", () => {
    const menu = menuOf({ ...props.entrantSeeds, e5: null });
    expect(menu).toMatchObject({ round: 1, choosable: true, unseededDrawn: true });
    const html = panelHtml(menu);
    expect(html).toContain(`${NOTE}>Unseeded entrants are drawn at random.</p>`);
    // Review m1: the option hints above it no longer say "by seed" alone — seeds first, then the draw (e5 unseeded).
    expect(html).not.toContain(">top half v bottom half by seed<");
    expect(html).toContain("top half v bottom half by seed, then the draw");
    expect(html).toContain('aria-describedby="pairing-draw-note-s1"');
    expect(html).toContain('id="pairing-draw-note-s1"');
    expect(html.indexOf(NOTE), "under both options").toBeGreaterThan(html.indexOf('data-testid="stage-pairing-rank_adjacent"'));
  });

  it("in Spanish, the line is the Spanish catalog's", () => {
    const menu = menuOf({ ...props.entrantSeeds, e5: null });
    const html = renderToStaticMarkup(
      <DictProvider dict={es} locale="es">
        <SwissPairingMenuPanel stageId="s1" menu={menu} pick={null} onPick={() => {}} onClose={() => {}} />
      </DictProvider>,
    );
    expect(html).toContain(`>${es["schedule.pairing.drawnAtRandom"]}</p>`);
  });

  it("round 2 waiting: the draw is round 1's alone — no line in the read-only menu", () => {
    const menu = menuOf({ ...props.entrantSeeds, e5: null }, [1]);
    expect(menu).toMatchObject({ round: 2, choosable: false, unseededDrawn: false });
    const html = panelHtml(menu);
    expect(html, "positive control: the read-only menu rendered").toContain('data-testid="stage-pairing-readonly"');
    expect(html).not.toContain(NOTE);
  });
});

// W3 T14 (X-SW-30, SW-L12, RB3-25): from round 2 on, the read-only mode line also says the Swiss rules decide the pairing and
// how to re-derive it — Unpair, then Pair next, after a corrected result or roster — because a board's seats cannot be edited (PATCH /fixtures/{id} refuses them: fixtures/[id]/__tests__/
// route.test.ts). The verdict is the PANEL's: a running root Swiss (isRunningRootSwiss) whose Unpair button is on offer
// (canUnpairSwiss), so the line never points at a button the rail is not showing. Driven through the panel's own menu
// and the rail's real panel component, as the X-SW-22 block above does.
describe("StagesPanel — rounds >= 2 explain how to change a pairing (X-SW-30)", () => {
  type Stage = Omit<ReturnType<typeof swissStage>, "progression"> & { progression: Record<string, unknown> | null };
  const menuFor = (stage: Stage, rows: ReturnType<typeof fixtures>) => {
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation(() => Promise.resolve({}));
    const island = renderIsland(StagesPanel, { ...props, stages: [stage], fixtures: rows });
    const rails = island.tree().filter((el) => el.type === StageRail);
    expect(rails).toHaveLength(1);
    return propsOf(rails[0]!).swissPairingMenu as Parameters<typeof SwissPairingMenuPanel>[0]["menu"];
  };
  const panelHtml = (menu: Parameters<typeof SwissPairingMenuPanel>[0]["menu"], dict?: { dict: typeof es; locale: "es" }) => {
    const panel = <SwissPairingMenuPanel stageId="s1" menu={menu} pick={null} onPick={() => {}} onClose={() => {}} />;
    return renderToStaticMarkup(dict ? <DictProvider {...dict}>{panel}</DictProvider> : panel);
  };
  const HINT = 'data-testid="stage-pairing-change-hint"';
  const COPY = "Round pairings follow the Swiss rules. After correcting a result or the entrants, Unpair, then Pair next.";
  /** Round 1 seated and PLAYED: a decided row, which `swissRoundHasPlayedResult` reads as a result. */
  const playedRound1 = () => fixtures([1]).map((f) => (f.round_no === 1 ? { ...f, status: "decided" } : f));

  it("X-SW-30 the round-2 menu shows the Unpair-then-Pair guidance; round 1 does not", () => {
    // Round 2 waiting (round 1 seated, unplayed): the read-only line, the guidance under it, and the Unpair button the
    // guidance names is really on the rail beside it (the sentence is only true while the button is).
    const r2 = menuFor(swissStage(), fixtures([1]));
    expect(r2).toMatchObject({ round: 2, choosable: false });
    const html2 = panelHtml(r2);
    expect(html2, "positive control: the read-only line rendered").toContain('data-testid="stage-pairing-readonly"');
    expect(html2).toContain(`${HINT}>${COPY}</p>`);
    expect(html2.indexOf(HINT), "under the read-only line").toBeGreaterThan(html2.indexOf('data-testid="stage-pairing-hint"'));
    const rail = renderToStaticMarkup(<StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([1])} />);
    expect(rail, "the button the line names is on the rail").toContain('data-testid="stage-unpair"');
    expect(enDict["schedule.pairing.changeHint"]).toBe(COPY);

    // Round 1 waiting: the choosable round. Its options rendered (positive control), and no guidance.
    const r1 = menuFor(swissStage(), fixtures());
    expect(r1).toMatchObject({ round: 1, choosable: true });
    const html1 = panelHtml(r1);
    expect(html1, "positive control: the round-1 options rendered").toContain('data-testid="stage-pairing-fold"');
    expect(html1).not.toContain(HINT);
    expect(html1).not.toContain(COPY);
  });

  it("round 3 waiting says it too (every read-only round, not only round 2)", () => {
    const round3 = fixtures()
      .slice(0, 4)
      .map((f, i) => ({ ...f, id: `g${i}`, round_no: 3, fixture_no: 9 + i, ext_key: `sw-r3-b${i + 1}` }));
    const menu = menuFor(swissStage({ rounds: 3 }), [...fixtures([1, 2]), ...round3]);
    expect(menu).toMatchObject({ round: 3, choosable: false });
    expect(panelHtml(menu)).toContain(`${HINT}>${COPY}</p>`);
  });

  it("round 2 waiting but round 1 is played: Unpair is not offered, so the line is not either", () => {
    const rail = renderToStaticMarkup(<StagesPanel {...props} stages={[swissStage()]} fixtures={playedRound1()} />);
    expect(rail, "positive control: the rail rendered its Pair next").toContain('data-testid="stage-generate"');
    expect(rail).not.toContain('data-testid="stage-unpair"');
    const menu = menuFor(swissStage(), playedRound1());
    expect(menu).toMatchObject({ round: 2, choosable: false });
    const html = panelHtml(menu);
    expect(html, "positive control: the read-only line rendered").toContain('data-testid="stage-pairing-readonly"');
    expect(html).not.toContain(HINT);
  });

  it.each([
    ["a finished Swiss", swissStage({ rounds: 2 }, "complete")],
    ["a Swiss fed by an earlier stage (config.qualified)", swissStage({ rounds: 2, qualified: ["e1", "e2", "e3", "e4"] })],
    ["a Swiss with a progression source", { ...swissStage(), progression: { from: "s0" } }],
  ])("%s: not a running root Swiss, so no line even in round 2", (_label, stage) => {
    const menu = menuFor(stage, fixtures([1]));
    expect(menu).toMatchObject({ round: 2, choosable: false });
    const html = panelHtml(menu);
    expect(html, "positive control: the read-only line rendered").toContain('data-testid="stage-pairing-readonly"');
    expect(html).not.toContain(HINT);
  });

  // Batch-4 m2: with every round seated there is no Pair next menu to carry the line, yet Unpair is on the rail for the final round - the
  // line is said on the SAME gate (a running root Swiss whose Unpair is offered), for a round from 2 on, and in exactly one place. SCF fix
  // round 1 (review I1): that place is the stage's LEGEND LINE, beside the "paired by the system" sentence - the actions row holds controls
  // only. The expected words are the dictionary's.
  it("batch-4 m2 + SCF I1: the FINAL round paired says the line on the legend line, not in the row; one place only, on the same gate", () => {
    const UNPAIR_HINT = /data-testid="stage-unpair-hint"[^>]*>([^<]*)<\/span>/;
    const html = (stage: Stage, rows: ReturnType<typeof fixtures>, over: Record<string, unknown> = {}) =>
      renderToStaticMarkup(<StagesPanel {...props} stages={[stage]} fixtures={rows} {...over} />);
    const lastPaired = fixtures([1, 2]).map((f) => (f.round_no === 1 ? { ...f, status: "decided" } : f));
    const roundOneOnly = fixtures([1]).filter((f) => f.round_no === 1);
    // Round 3 waiting behind a paired round 2: the round Unpair clears is from 2 on, yet the menu carries the line.
    const round3Waiting = [
      ...lastPaired,
      ...fixtures()
        .slice(0, 4)
        .map((f, i) => ({ ...f, id: `g${i}`, round_no: 3, fixture_no: 9 + i, ext_key: `sw-r3-b${i + 1}` })),
    ];
    type Row = { name: string; stage: Stage; rows: ReturnType<typeof fixtures>; unpair: boolean; line: boolean; menu: boolean };
    const ROWS: Row[] = [
      { name: "round 2 of 2 paired, unplayed: no menu, the line on the legend line", stage: swissStage(), rows: lastPaired, unpair: true, line: true, menu: false },
      { name: "round 2 waiting: the menu carries the line, not the legend too", stage: swissStage(), rows: fixtures([1]), unpair: true, line: false, menu: true },
      { name: "round 3 waiting, round 2 paired: the menu carries it, not the legend too", stage: swissStage({ rounds: 3 }), rows: round3Waiting, unpair: true, line: false, menu: true },
      { name: "a fed Swiss, its final round paired: not a running root Swiss", stage: { ...swissStage(), progression: { from: "s0" } }, rows: lastPaired, unpair: true, line: false, menu: false },
      { name: "a one-round Swiss paired: round 1's pairing is a choice, not the rules'", stage: swissStage({ rounds: 1 }), rows: roundOneOnly, unpair: true, line: false, menu: false },
      { name: "the final round played: no Unpair, no line", stage: swissStage(), rows: lastPaired.map((f) => (f.round_no === 2 ? { ...f, status: "decided" } : f)), unpair: false, line: false, menu: false },
    ];
    let checked = 0;
    for (const r of ROWS) {
      const out = html(r.stage, r.rows);
      expect(out, `${r.name}: positive control, the rail rendered`).toContain('data-testid="stage-complete"');
      expect(out.includes('data-testid="stage-unpair"'), `${r.name}: Unpair`).toBe(r.unpair);
      expect(menuFor(r.stage, r.rows) !== null, `${r.name}: a Pair next menu`).toBe(r.menu);
      const said = UNPAIR_HINT.exec(out);
      expect(said?.[1] ?? null, `${r.name}: the line on the legend line`).toBe(r.line ? COPY : null);
      // Never in the row, whatever the state: the rail's subtree holds no hint, and no paragraph of its own.
      expect(subtreeOf(out, "stage-rail") ?? "", `${r.name}: the row holds controls only`).not.toContain("stage-unpair-hint");
      if (r.line) {
        expect(parentOf(out, "stage-unpair-hint"), `${r.name}: shares the legend's container`).toBe(parentOf(out, "stage-swiss-legend"));
        expect(out.indexOf("stage-unpair-hint"), `${r.name}: after the legend`).toBeGreaterThan(out.indexOf('data-testid="stage-swiss-legend"'));
      }
      checked++;
    }
    expect(checked, "anti-vacuity: rows").toBe(ROWS.length);
    expect(ROWS.filter((r) => r.line).length, "both answers reached").toBeGreaterThan(0);

    // The same gates as the row had: a viewer (the rail is the editor's), and a finished stage, say none - each beside its positive pair.
    const final = html(swissStage(), lastPaired);
    expect(final, "positive pair: the editor of the final round sees the line").toMatch(UNPAIR_HINT);
    expect(html(swissStage(), lastPaired, { canEdit: false }), "a viewer").not.toContain("stage-unpair-hint");
    // A finished stage's card is folded to one line (its body, rail and legend line are away), so ask for it open first: it is open, the line is not.
    const finished = swissStage({}, "complete");
    const finishedOpen = html(finished, lastPaired, { attentionStageIds: [finished.id] });
    expect(finishedOpen, "positive pair: asked open, the finished card is open").toMatch(/data-testid="stage-collapse-toggle"[^>]*aria-expanded="true"/);
    expect(finishedOpen, "a finished stage").not.toContain("stage-unpair-hint");
  });

  it("the final round paired shows BOTH sentences on the one legend line, in order: the system pairs it, then Unpair-then-Pair-next", () => {
    const lastPaired = fixtures([1, 2]).map((f) => (f.round_no === 1 ? { ...f, status: "decided" } : f));
    const out = renderToStaticMarkup(<StagesPanel {...props} stages={[swissStage()]} fixtures={lastPaired} />);
    const line = parentOf(out, "stage-swiss-adhoc-note")!;
    expect(line, "positive control: the shared legend container").toContain('data-testid="stage-swiss-legend"');
    expect(line.indexOf("stage-swiss-adhoc-note"), "the system-pairs sentence first").toBeLessThan(line.indexOf("stage-unpair-hint"));
    expect(parentOf(out, "stage-unpair-hint"), "one container").toBe(line);
    const seps = (line.match(/aria-hidden="true"> · </g) ?? []).length;
    expect(seps, "legend · sentence · line: two separators, none dangling").toBe(2);
    expect(innerOf(out, "stage-unpair-hint")).toBe(COPY);
  });

  it("in Spanish, the line is the Spanish catalog's", () => {
    const html = panelHtml(menuFor(swissStage(), fixtures([1])), { dict: es, locale: "es" });
    expect(html).toContain(`${HINT}>${es["schedule.pairing.changeHint"]}</p>`);
    expect(es["schedule.pairing.changeHint"]).not.toBe(COPY);
  });
});

// W3 RB3-15 A (X-SW-21, ruling 252): the panel's half of "no Add match on a Swiss stage". The rail refuses on the kind
// whatever it is handed (stage-rail.test.tsx); this pins that the PANEL no longer calls Swiss an ad-hoc kind either,
// so the two guards are each killable on their own.
describe("StagesPanel — no Add match on a Swiss stage (X-SW-21)", () => {
  const railOf = (stage: ReturnType<typeof swissStage>) => {
    // The island runs the panel's mount effects, which read the network: answer them empty.
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation(() => Promise.resolve({}));
    const island = renderIsland(StagesPanel, { ...props, stages: [stage], fixtures: fixtures([1]) });
    const rails = island.tree().filter((el) => el.type === StageRail);
    expect(rails).toHaveLength(1);
    return propsOf(rails[0]!);
  };

  it("hands the rail adhoc=false for Swiss and adhoc=true for a league, and the page shows the note, not the trigger", () => {
    expect(railOf(swissStage()).adhoc, "swiss").toBe(false);
    expect(railOf({ ...swissStage(), kind: "league", name: "League" }).adhoc, "league").toBe(true);

    const html = renderToStaticMarkup(<StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([1])} />);
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).not.toContain('data-testid="stage-add-match"');
    expect(html).toContain('data-testid="stage-swiss-adhoc-note"');
  });
});

// SCF (owner pick, Option A, 2026-11-03): the sentence that stood in the rail's action row, where the Add match button would be, is
// INFORMATION - it moved to the stage's legend line ("5 rounds · 3 matches per round · 15 fixtures · Swiss rounds are paired by the system.
// Add friendlies in another stage."), under the gates it always had (an editor, a stage that is not finished, one with fixtures). The copy
// is ruling 252's and is unchanged: the expected words are the dictionaries', never retyped here.
describe("StagesPanel — the Swiss 'paired by the system' sentence is on the legend line, not in the action row (SCF)", () => {
  const KEY = "swiss.refusal.SWISS_ADHOC_REFUSED";
  const NOTE = 'data-testid="stage-swiss-adhoc-note"';
  const render = (over: Record<string, unknown> = {}, dict: Record<string, string> = enDict as Record<string, string>, locale = "en") =>
    renderToStaticMarkup(
      <DictProvider dict={dict as never} locale={locale as never}>
        <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([1])} {...over} />
      </DictProvider>,
    );
  const plain = (markup: string) => markup.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("an editor of a running Swiss: the sentence follows the legend, in the same line, in every locale; the rail's row does not hold it", () => {
    let locales = 0;
    for (const [locale, dict] of [["en", enDict], ["es", es], ["fr", fr], ["nl", nl]] as const) {
      const D = dict as Record<string, string>;
      const html = render({}, D, locale);
      const rail = subtreeOf(html, "stage-rail");
      expect(rail, `${locale}: positive pair, the rail rendered`).toContain('data-testid="stage-generate"');
      expect(rail, `${locale}: the row holds controls only`).not.toContain("stage-swiss-adhoc-note");
      expect(plain(rail!), `${locale}: nor its words`).not.toContain(D[KEY]);
      const legendText = plain(subtreeOf(html, "stage-swiss-legend")!);
      expect(legendText, `${locale}: premise, the legend line has its own words`).toMatch(/\d/);
      const line = parentOf(html, "stage-swiss-legend");
      expect(line, `${locale}: the sentence shares the legend's container`).toBe(parentOf(html, "stage-swiss-adhoc-note"));
      expect(plain(line!), `${locale}: "<legend> · <sentence>", the sentence in the reader's words`).toBe(`${legendText} · ${D[KEY]}`);
      locales++;
    }
    expect(locales, "anti-vacuity: locales checked - all four").toBe(4);
  });

  it("the gates it always had: a viewer, a finished stage, a stage with nothing generated and a league all show none - each with its positive pair", () => {
    const shows = render();
    expect(shows, "positive pair: the editor of a running Swiss sees it").toContain(NOTE);
    const viewer = render({ canEdit: false });
    expect(viewer, "viewer: the legend is still there").toContain('data-testid="stage-swiss-legend"');
    expect(viewer, "viewer: no sentence").not.toContain(NOTE);
    const done = render({ stages: [swissStage({ rounds: 2 }, "complete")] });
    expect(done, "complete: the legend is still there").toContain('data-testid="stage-swiss-legend"');
    expect(done, "complete: no sentence").not.toContain(NOTE);
    const empty = render({ stages: [swissStage({ rounds: 2 }, "pending")], fixtures: [] });
    expect(empty, "nothing generated: Generate is offered").toContain('data-testid="stage-generate"');
    expect(empty, "nothing generated: no sentence").not.toContain(NOTE);
    const league = render({ stages: [{ ...swissStage(), kind: "league", name: "League" }] });
    expect(league, "league: Add match is offered").toContain('data-testid="stage-add-match"');
    expect(league, "league: no sentence").not.toContain(NOTE);
  });

  it("with no legend (a field too small to describe) the sentence stands alone, with no dangling separator", () => {
    const html = render({ activeEntrantIds: [] });
    expect(html, "premise: no legend for an empty field").not.toContain('data-testid="stage-swiss-legend"');
    expect(subtreeOf(html, "stage-swiss-adhoc-note"), "the sentence is still told").not.toBeNull();
    expect(plain(parentOf(html, "stage-swiss-adhoc-note")!), "alone on its line, no dangling separator").toBe((enDict as Record<string, string>)[KEY]);
  });
});

// Review M2 (Task 4): the rail clears the organiser's round-1 pick only when a
// press LANDS, and it learns that from what `onAct` resolves to. This pins the
// panel's half of that contract through the real `act()`: the StageRail
// element's own `onAct` (the one production hands down), with only the
// network mocked. A panel that went back to `void act(...)`, or an `act()` that
// reported a refused press as landed, would hand the rail a lie — the pick
// would vanish on a failure, or survive a success into the next press.
describe("StagesPanel — tells the rail whether a press landed (review M2)", () => {
  type OnAct = (stageId: string, action: "generate", opts?: { pairing?: "fold" | "rank_adjacent" }) => Promise<boolean>;

  function railOnAct(): OnAct {
    const island = renderIsland(StagesPanel, { ...props, stages: [swissStage()], fixtures: fixtures() });
    const rails = island.tree().filter((el) => el.type === StageRail);
    expect(rails).toHaveLength(1);
    return propsOf(rails[0]!).onAct as OnAct;
  }

  function generateAnswers(answer: () => Promise<unknown>) {
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation((path: string) =>
      path.endsWith("/generate") ? answer() : Promise.resolve({}),
    );
  }

  const generateBodies = () =>
    apiV1Mock.mock.calls
      .filter(([path]) => String(path).endsWith("/generate"))
      .map(([, init]) => (init as { json?: unknown }).json);

  it("resolves true when generate lands — and sent the pick it was given", async () => {
    generateAnswers(() => Promise.resolve({ created: 4, existing: 4 }));
    await expect(railOnAct()("s1", "generate", { pairing: "rank_adjacent" })).resolves.toBe(true);
    expect(generateBodies()).toEqual([{ pairing: "rank_adjacent" }]);
  });

  it.each([
    ["a refused pick (422)", () => new ApiV1Error("wire", 422, SWISS_PAIRING_ROUND_ONE_ONLY_CODE, {})],
    ["a server error (500)", () => new ApiV1Error("boom", 500, "INTERNAL", {})],
    ["a paywall (402)", () => new ApiV1Error("pay", 402, "PAYMENT_REQUIRED", { feature_key: "x" })],
    ["a dropped connection", () => new TypeError("Failed to fetch")],
  ])("resolves false when generate does not land: %s", async (_label, failure) => {
    generateAnswers(() => Promise.reject(failure()));
    await expect(railOnAct()("s1", "generate", { pairing: "rank_adjacent" })).resolves.toBe(false);
    expect(generateBodies()).toEqual([{ pairing: "rank_adjacent" }]);
  });
});

// W3 T10 (X-SW-12, X-SW-14 UI half): the seam between the panel and the rail's More menu, and the pending-latecomer
// line. `stage-rail.test` pins the rail's gate given its facts; this pins that the panel really hands it the facts
// (the division's status, whether a round is seated, the Entrants tab's add form) and that the count line is in the
// CARD HEADER under the legend (coordinator ruling: a count that changes what the organiser does next must not hide
// behind the phone's Stage tools fold). Expected copy is the en dictionary's, with the count put in.
describe("StagesPanel — Add late player and the pending-latecomer line (W3 T10)", () => {
  const EN = enDict as unknown as Record<string, string>;
  const line = (key: string, count: number) => EN[key]!.replace("{count}", String(count));
  const HREF = "/o/org/c/comp/d/div?tab=entrants#add-entrant";
  const render = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([1])} {...over} />,
    );

  it("a started division with round 1 paired: the item goes to the Entrants tab's add form", () => {
    const html = render({ divisionStatus: "active" });
    expect(html).toContain('data-testid="stage-add-late-player"');
    expect(html).toContain(`href="${HREF}"`);
  });

  it("before Start, or with no status passed, there is no More menu", () => {
    for (const over of [{ divisionStatus: "scheduled" }, { divisionStatus: "setup" }, {}]) {
      const html = render(over);
      expect(html, JSON.stringify(over)).toContain('data-testid="stage-generate"');
      expect(html, JSON.stringify(over)).not.toContain('data-testid="stage-more"');
    }
    // Started, but nothing seated yet: the ordinary add seats them in round 1.
    const unpaired = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([])} divisionStatus="active" />,
    );
    expect(unpaired).toContain('data-testid="stage-generate"');
    expect(unpaired).not.toContain('data-testid="stage-more"');
  });

  it("counts the latecomers waiting for the next Pair and those after the last round, in the card header under the legend", () => {
    // e9 was stamped for round 2 (the round the next Pair seats); e10 arrived after round 2, the last, had started.
    const html = render({
      divisionStatus: "active",
      activeEntrantIds: [...ids, "e9", "e10"],
      entrantSwissFirstRounds: {
        e9: { swiss_first_round: 2, swiss_first_round_stage_id: "s1" },
        e10: { swiss_first_round: 3, swiss_first_round_stage_id: "s1" },
      },
    });
    const lines = [...html.matchAll(/<p[^>]*data-testid="stage-swiss-latecomer"[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);
    expect(lines).toEqual([line("swiss.lateEntry.joinNextRound.one", 1), line("swiss.lateEntry.joinedAfterLast.one", 1)]);
    const legendAt = html.indexOf('data-testid="stage-swiss-legend"');
    const lineAt = html.indexOf('data-testid="stage-swiss-latecomer"');
    // Match Day #1103 (E1 item 1) moved the rail INTO the header, ahead of the legend, so "not inside the rail's fold" is no longer
    // "before the rail": it is "outside the rail's element". The rail wrapper is a <div>; its end is where its <div> depth returns to 0.
    const railAt = html.indexOf('data-testid="stage-rail"');
    const railOpen = html.lastIndexOf("<div", railAt);
    let depth = 0;
    let railEnd = -1;
    for (const m of html.slice(railOpen).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        railEnd = railOpen + m.index! + m[0].length;
        break;
      }
    }
    expect(railAt, "premise: the rail renders").toBeGreaterThan(-1);
    expect(railEnd, "premise: the rail's element closes").toBeGreaterThan(railAt);
    expect(html.slice(railOpen, railEnd), "premise: the fold (the rail's sheet) is inside that element").toContain('data-testid="stage-rail-sheet"');
    expect(legendAt, "premise: the legend renders").toBeGreaterThan(-1);
    expect(lineAt, "under the legend").toBeGreaterThan(legendAt);
    expect(lineAt < railOpen || lineAt > railEnd, "in the header, not inside the rail's fold").toBe(true);
    expect(html.slice(lineAt, html.indexOf("</header>", lineAt)).length, "before the header closes").toBeGreaterThan(0);
    expect(html.indexOf("</header>", legendAt)).toBeGreaterThan(lineAt);
  });

  it("says nothing with no latecomer, or to a viewer who cannot edit", () => {
    expect(render({ divisionStatus: "active" })).not.toContain("stage-swiss-latecomer");
    const viewer = render({
      canEdit: false,
      divisionStatus: "active",
      activeEntrantIds: [...ids, "e9"],
      entrantSwissFirstRounds: { e9: { swiss_first_round: 2, swiss_first_round_stage_id: "s1" } },
    });
    expect(viewer, "premise: the viewer's card renders the legend").toContain('data-testid="stage-swiss-legend"');
    expect(viewer).not.toContain("stage-swiss-latecomer");
  });
});
