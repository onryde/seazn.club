// W4 app B, Task 10 (X-TP-2, X-TP-6; owner pick 1A; carry C35): the knockout stage card's Third place control. Editable until the
// stage starts, read-only (with the lock's own sentence) once a line has begun, the Play-off disabled below four entrants, and the
// plate's dropped third-place match said in one line. Static markup: the PATCH wiring is the route's and the usecase's own tests.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import uiEn from "@/dictionaries/en/ui.json";
import { THIRD_PLACE_MIN } from "@/lib/third-place";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const en = uiEn as Record<string, string>;
const stage = (id: string, seq: number, kind: string, config: Record<string, unknown> = {}) => ({ id, seq, kind, name: `Stage ${seq}`, config, progression: null, status: "active" });
const fixture = (stageId: string, no: number, status = "scheduled") => ({
  id: `f${no}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status, outcome: null,
});
const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const PROPS = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  entrantNames: { e1: "Alpha", e2: "Bravo" }, canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
  viewerPlan: "community" as const, sportKey: "badminton",
};
const CONTROL = 'data-testid="stage-third-place-choice"';
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<StagesPanel {...PROPS} stages={[stage("s1", 1, "knockout", { thirdPlace: true })]} fixtures={[fixture("s1", 1)]} activeEntrantIds={ids(8)} {...over} />);
/** renderToStaticMarkup escapes the apostrophe in "can't". */
const html = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");
const count = (h: string, needle: string) => h.split(needle).length - 1;
/** Just the control's own fieldset: the card holds other aria-disabled controls. */
const controlOf = (h: string) => {
  const at = h.indexOf(CONTROL);
  expect(at, "the control is on the page").toBeGreaterThan(-1);
  return h.slice(at, h.indexOf("</fieldset>", at));
};

describe("the knockout stage card's Third place control", () => {
  it("the empty case first: a viewer sees no control, and a non-knockout stage has none for an editor", () => {
    expect(render({ canEdit: false })).not.toContain(CONTROL);
    const swiss = renderToStaticMarkup(<StagesPanel {...PROPS} stages={[stage("s1", 1, "swiss")]} fixtures={[fixture("s1", 1)]} activeEntrantIds={ids(8)} />);
    expect(swiss).not.toContain(CONTROL);
    expect(render()).toContain(CONTROL);
  });

  it("an editor before play: the stored choice is picked, both segments live, and no lock sentence", () => {
    const h = render();
    expect(h).toMatch(/data-third-place="playoff"/);
    expect(h).not.toContain("data-read-only");
    expect(h).not.toContain(html(en["knockout.refusal.THIRD_PLACE_LOCKED"]!));
    expect(count(controlOf(h), 'aria-disabled="true"'), "no segment is disabled at 8 entrants").toBe(0);
    const shared = render({ stages: [stage("s1", 1, "knockout", { thirdPlace: false })] });
    expect(shared).toMatch(/data-third-place="shared"/);
  });

  it("once a line has begun the control is read-only and says the lock's own sentence", () => {
    for (const status of ["in_play", "decided"]) {
      const h = render({ fixtures: [fixture("s1", 1, status)] });
      expect(h, status).toContain("data-read-only");
      expect(h, status).toContain(html(en["knockout.refusal.THIRD_PLACE_LOCKED"]!));
    }
  });

  it("I-2: a STORED Play-off the field can no longer play stays picked and disabled, says the count, and offers Use Shared", () => {
    let checked = 0;
    for (const n of [0, 1, THIRD_PLACE_MIN - 1]) {
      const h = render({ activeEntrantIds: ids(n) });
      const ctl = controlOf(h);
      expect(ctl, `${n} entrants: the stored value, not a coerced Shared`).toMatch(/data-third-place="playoff"/);
      expect(count(ctl, 'aria-disabled="true"'), `${n} entrants: only the Play-off segment is inert`).toBe(1);
      expect(ctl.split('data-third-place-option="shared"')[1]!.split("</label>")[0], `${n}: Shared is live`).not.toContain("aria-disabled");
      expect(ctl, `${n}: the count`).toContain(`This stage has ${n} entrants`);
      expect(ctl, `${n}: Use Shared is offered here`).toContain('data-testid="stage-third-place-choice-use-shared"');
      checked++;
    }
    expect(checked).toBe(3);
    const ok = controlOf(render({ activeEntrantIds: ids(THIRD_PLACE_MIN) }));
    expect(ok, "at the minimum nothing is stuck").not.toContain("use-shared");
    expect(ok).not.toContain("This stage has");
  });

  it("M-7: the server's started list makes the control read-only even when no line looks played (a called match)", () => {
    const h = render({ startedKnockoutStageIds: ["s1"] });
    expect(h).toContain("data-read-only");
    expect(h).toContain(html(en["knockout.refusal.THIRD_PLACE_LOCKED"]!));
    expect(render({ startedKnockoutStageIds: ["other"] }), "another stage's start is not this one's").not.toContain("data-read-only");
  });

  it("C35: the dropped note shows only on the stage the proposal dropped it for", () => {
    const two = { stages: [stage("s1", 1, "knockout"), stage("s2", 2, "knockout", { thirdPlace: true })], fixtures: [fixture("s1", 1), fixture("s2", 2)] };
    expect(render(two)).not.toContain('data-testid="stage-third-place-dropped"');
    const h = render({ ...two, thirdPlaceDropped: ["s2"] });
    expect(count(h, 'data-testid="stage-third-place-dropped"')).toBe(1);
    expect(h).toContain(en["thirdPlace.dropped"]!);
    // a viewer still reads it: it is information, not a control
    expect(render({ ...two, thirdPlaceDropped: ["s2"], canEdit: false })).toContain('data-testid="stage-third-place-dropped"');
  });
});
