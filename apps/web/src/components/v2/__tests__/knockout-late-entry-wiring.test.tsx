// W4 app-A Task 19 (X-LE-3, X-LE-10; class #1, the inert seam): the JOIN between the division page's two late-entry facts
// and the stage card. The pure builders are tested apart (`knockoutLateEntryOffered`, the strip's own island); this drives the
// REAL panel — `renderToStaticMarkup` over `StagesPanel` renders its nested components — and reads what the organiser's card
// shows: the rail's More item named "Add to bracket" on a started root knockout only, and the "Waiting to join the bracket"
// strip on the card the waiting player belongs to, for an organiser only.
//
// Expected sentences are the approved English typed out here (R24 page, task-19 brief, b6a carry), never read off the
// component. Single-sport by nature: the panel reads the stage kind/progression/status and the division's status.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";
import type { KnockoutWaitingEntrant } from "@/server/usecases/knockout-desk";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const names: Record<string, string> = { e1: "Arjun Menon", e2: "Lee Wei Jie", e3: "Rasmus Holm", e4: "Daniel Okafor", e5: "Oliver Grant", e6: "Nora Lind" };
const stage = (id: string, seq: number, o: Record<string, unknown> = {}) => ({
  id,
  seq,
  kind: "knockout",
  name: `Stage ${seq}`,
  config: {},
  progression: null,
  status: "active",
  ...o,
});
const fixture = (stageId: string, n: number, status = "scheduled") => ({
  id: `${stageId}-${n}`,
  stage_id: stageId,
  pool_id: null,
  round_no: 1,
  seq_in_round: n,
  fixture_no: n,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: null,
  venue: null,
  court_label: null,
  court_id: null,
  court_name: null,
  status,
  outcome: null,
});
const waiter = (entrantId: string, stageId: string, o: Partial<KnockoutWaitingEntrant> = {}): KnockoutWaitingEntrant => ({
  entrantId,
  stageId,
  name: names[entrantId]!,
  paid: false,
  ...o,
});

const base = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: names,
  activeEntrantIds: Object.keys(names),
};
const render = (o: {
  stages: ReturnType<typeof stage>[];
  canEdit?: boolean;
  divisionStatus?: string;
  waiting?: KnockoutWaitingEntrant[];
  fixtures?: ReturnType<typeof fixture>[];
  drawSeeds?: Record<string, number>;
}) =>
  renderToStaticMarkup(
    <StagesPanel
      {...base}
      stages={o.stages}
      fixtures={o.fixtures ?? o.stages.flatMap((s) => [fixture(s.id, 1), fixture(s.id, 2)])}
      canEdit={o.canEdit ?? true}
      divisionStatus={o.divisionStatus ?? "active"}
      knockoutWaiting={o.waiting}
      drawSeeds={o.drawSeeds}
    />,
  );
const cardOf = (html: string, stageId: string): string => {
  const CARD = '<section class="card" data-stage-id=';
  const start = html.indexOf(`${CARD}"${stageId}"`);
  expect(start, `premise: the card ${stageId} rendered`).toBeGreaterThan(-1);
  const next = html.indexOf(CARD, start + 10);
  return html.slice(start, next === -1 ? undefined : next);
};

describe("X-LE-3 the rail's Add to bracket reaches a started root knockout's card", () => {
  it("a started root knockout offers it, named exactly 'Add to bracket' (never 'Add late player')", () => {
    const html = cardOf(render({ stages: [stage("k1", 1)] }), "k1");
    expect(html).toContain('data-testid="stage-add-late-player"');
    expect(html).toContain(">Add to bracket<");
    expect(html).not.toContain("Add late player");
  });

  it("not offered: before Start, a fed knockout, a finished one, a card with no bracket drawn, or a viewer", () => {
    const group = stage("g1", 1, { kind: "group", status: "complete" });
    const fed = stage("k2", 2, { progression: { from: "g1", top: 2 } });
    const ROWS: { name: string; html: string }[] = [
      { name: "before Start", html: cardOf(render({ stages: [stage("k1", 1)], divisionStatus: "setup" }), "k1") },
      { name: "fed by a group stage", html: cardOf(render({ stages: [group, fed] }), "k2") },
      { name: "a finished bracket", html: cardOf(render({ stages: [stage("k1", 1, { status: "complete" })] }), "k1") },
      { name: "no bracket drawn", html: cardOf(render({ stages: [stage("k1", 1)], fixtures: [] }), "k1") },
      { name: "a viewer", html: cardOf(render({ stages: [stage("k1", 1)], canEdit: false }), "k1") },
    ];
    let checked = 0;
    for (const r of ROWS) {
      expect(r.html, r.name).not.toContain('data-testid="stage-add-late-player"');
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    // positive pair: the same panel with everything in place DOES offer it
    expect(cardOf(render({ stages: [stage("k1", 1)] }), "k1")).toContain('data-testid="stage-add-late-player"');
  });
});

describe("X-LE-10 the waiting strip reaches the card the player waits on", () => {
  it("the empty case first: nobody waiting, nothing supplied, or a viewer — no strip", () => {
    expect(render({ stages: [stage("k1", 1)] })).not.toContain('data-testid="knockout-waiting"');
    expect(render({ stages: [stage("k1", 1)], waiting: [] })).not.toContain('data-testid="knockout-waiting"');
    expect(render({ stages: [stage("k1", 1)], waiting: [waiter("e5", "k1")], canEdit: false })).not.toContain('data-testid="knockout-waiting"');
    // positive pair
    expect(render({ stages: [stage("k1", 1)], waiting: [waiter("e5", "k1")] })).toContain('data-testid="knockout-waiting"');
  });

  it("lists the waiting players by name on THEIR stage's card, with the tap, and nothing on another card", () => {
    const html = render({
      stages: [stage("k1", 1), stage("k2", 2)],
      waiting: [waiter("e5", "k1"), waiter("e6", "k1", { paid: true })],
    });
    const k1 = cardOf(html, "k1");
    const k2 = cardOf(html, "k2");
    expect(k1).toContain("Waiting to join the bracket");
    expect(k1).toContain("Oliver Grant");
    expect(k1).toContain("Nora Lind");
    expect(k1).toContain("Joined after the draw. Not in the bracket yet.");
    expect(k1).toContain("Paid online after the draw. Not in the bracket yet.");
    expect(k1.match(/data-testid="knockout-waiting-place"/g)).toHaveLength(2);
    expect(k1.match(/>Add to bracket</g)!.length).toBeGreaterThanOrEqual(2);
    expect(k2).not.toContain('data-testid="knockout-waiting"');
    expect(k2).not.toContain("Oliver Grant");
    // the strip sits in the card's body, above the bracket
    expect(k1.indexOf('data-testid="knockout-waiting"')).toBeGreaterThan(k1.indexOf('id="stage-body-k1"'));
  });

  it("the strip is anchored on its stage id: the strip's data-stage-id is the card's", () => {
    const html = render({ stages: [stage("k1", 1), stage("k2", 2)], waiting: [waiter("e5", "k2")] });
    expect(html).toMatch(/data-testid="knockout-waiting"[^>]*data-stage-id="k2"|data-stage-id="k2"[^>]*data-testid="knockout-waiting"/);
    expect(cardOf(html, "k1")).not.toContain('data-testid="knockout-waiting"');
  });
});

// X-SD-7 (W4 T20, K5 "shown"; R24 pick 3A): the stage's draw seed, a muted line under the card's header. The seed is what the
// stage's newest Generate drew with (`listStageDrawSeeds`); the line reads it off the card's own stage id. Numbers here are
// typed out (a seed is any 32-bit integer: 4040404040 is none the panel could have invented), and every assertion on the
// markup anchors on `="`, since React serialises an omitted prop as `"$undefined"`.
describe("X-SD-7 the stage card shows its draw seed", () => {
  const SEED = 4040404040;
  const lineOf = (html: string) => /data-testid="stage-draw-seed"[^>]*data-draw-seed="(\d+)"[^>]*>([^<]*)</.exec(html);
  const hintOf = (html: string) => /data-testid="stage-draw-seed-hint"[^>]*>([^<]*)</.exec(html)?.[1];
  // Owner option B (2026-11-09): the label and its hint, read off the English catalog the panel renders (never the panel).
  const label = (seed: number) => en["knockout.drawSeed"].replace("{seed}", String(seed));
  const HINT = en["knockout.drawSeedHint"];

  it("a drawn knockout shows the draw label under its header, with its hint, for an organiser and a viewer alike", () => {
    expect(label(SEED), "premise: the label names the seed").toContain(String(SEED));
    expect(HINT.trim(), "premise: the hint has words").not.toBe("");
    for (const canEdit of [true, false]) {
      const html = cardOf(render({ stages: [stage("k1", 1)], drawSeeds: { k1: SEED }, canEdit }), "k1");
      const m = lineOf(html);
      expect(m, `canEdit=${canEdit}: the line rendered`).not.toBeNull();
      expect(m![1]).toBe(String(SEED));
      expect(m![2]).toBe(label(SEED));
      expect(hintOf(html), `canEdit=${canEdit}: the hint is shown with it`).toBe(HINT);
      // under the header, above the card's body; the hint right under the label
      expect(html.indexOf('data-testid="stage-draw-seed"')).toBeLessThan(html.indexOf('data-testid="stage-draw-seed-hint"'));
      expect(html.indexOf('data-testid="stage-draw-seed-hint"')).toBeLessThan(html.indexOf('id="stage-body-k1"'));
    }
  });

  it("the empty case first: no seed supplied, none for this stage, or a seed for another card: no line", () => {
    const stages = [stage("k1", 1), stage("k2", 2)];
    expect(render({ stages })).not.toContain('data-testid="stage-draw-seed"');
    expect(render({ stages }), "no seed, no hint").not.toContain('data-testid="stage-draw-seed-hint"');
    expect(render({ stages, drawSeeds: {} })).not.toContain('data-testid="stage-draw-seed"');
    const html = render({ stages, drawSeeds: { k2: SEED } });
    expect(cardOf(html, "k1")).not.toContain('data-testid="stage-draw-seed"');
    expect(cardOf(html, "k2")).toContain('data-draw-seed="4040404040"');
  });

  it("each card names ITS stage's seed, never a neighbour's", () => {
    const html = render({ stages: [stage("k1", 1), stage("k2", 2)], drawSeeds: { k1: 11, k2: 22 } });
    expect(lineOf(cardOf(html, "k1"))![1]).toBe("11");
    expect(lineOf(cardOf(html, "k2"))![1]).toBe("22");
  });

  it("only a knockout-family stage shows one: a Swiss or group stage with a seed on the ledger shows none", () => {
    const swiss = stage("s1", 1, { kind: "swiss", config: { rounds: 3 } });
    const group = stage("g1", 2, { kind: "group" });
    const html = render({ stages: [swiss, group], drawSeeds: { s1: SEED, g1: SEED } });
    expect(html).not.toContain('data-testid="stage-draw-seed"');
    // positive pair: the same seed on a knockout stage DOES show
    expect(render({ stages: [stage("k1", 1)], drawSeeds: { k1: SEED } })).toContain('data-testid="stage-draw-seed"');
  });

  it("seed 0 is a seed: it shows the label for #0, not nothing (a falsy value is not an absent one)", () => {
    const m = lineOf(cardOf(render({ stages: [stage("k1", 1)], drawSeeds: { k1: 0 } }), "k1"));
    expect(m, "the line rendered").not.toBeNull();
    expect([m![1], m![2]]).toEqual(["0", label(0)]);
  });
});
