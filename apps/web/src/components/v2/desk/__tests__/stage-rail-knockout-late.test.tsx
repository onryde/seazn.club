// W4 app-A Task 19 (X-LE-3 UI half; b6a carry B3 #3, R10): the knockout rail's late-entry control. A started ROOT
// knockout's More menu holds "Add to bracket" — the control's ONE name, shared with the waiting strip's tap and the
// KO_GENERATE_AFTER_START sentence — going to the Entrants tab's own add form (reused, never a second form). A fed
// knockout, a knockout before Start, a finished bracket and one with no bracket drawn show none. Swiss keeps its own
// "Add late player".
//
// Expected copy is the approved English typed out here (b6a-carry "Add to bracket"), not read off the component.
// Single-sport by nature: the rail reads stage kind/progression/config/seq/status and the division's status.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageRail, type StageRailProps } from "../stage-rail";

const HREF = "/o/club/c/open/d/main?tab=entrants#add-entrant";
const NEUTRAL = {
  counts: { played: 0, inPlay: 0, unplayed: 4 },
  matchCount: 4,
  open: false,
  onToggleOpen: () => {},
  swissHasUnseated: false,
  canUnpairSwiss: false,
  swissPairingMenu: null,
};
type Row = { id: string; name: string; kind: string; seq: number; status: string; progression: unknown; config: unknown };
const ko = (o: Partial<Row> = {}): Row => ({ id: "s1", name: "Cup", kind: "knockout", seq: 1, status: "active", progression: null, config: {}, ...o });

function render(stage: Row, division: Row[], divisionStatus: string, fixtureCount = 8, extra: Partial<StageRailProps> = {}) {
  return renderToStaticMarkup(
    <StageRail stage={stage as never} canEdit busy={null} fixtureCount={fixtureCount} deletable={false}
      onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}} adhoc={false} {...NEUTRAL}
      lateEntry={{ divisionStatus, roundSeated: false, href: HREF, division }} {...extra} />,
  );
}

describe("X-LE-3 the knockout rail offers Add to bracket", () => {
  it("the empty case first: a started root knockout with no bracket drawn has no More", () => {
    const s = ko();
    const html = render(s, [s], "active", 0);
    expect(html, "positive pair: the rail rendered").toContain('data-testid="stage-rail-trigger"');
    expect(html).not.toContain('data-testid="stage-add-late-player"');
  });

  it("a started root knockout: More holds Add to bracket, to the Entrants tab's add form, never 'Add late player'", () => {
    const s = ko();
    const html = render(s, [s], "active");
    expect(html).toContain('data-testid="stage-more"');
    expect(html).toContain('data-testid="stage-add-late-player"');
    expect(html).toContain(`href="${HREF}"`);
    expect(html).toContain(">Add to bracket<");
    expect(html).toContain("Seats someone who arrived after the draw.");
    expect(html).not.toContain("Add late player");
  });

  it("a table: fed, before Start, finished, no division facts — none offered", () => {
    const group: Row = { id: "g", name: "Groups", kind: "group", seq: 1, status: "complete", progression: null, config: {} };
    const fed = ko({ seq: 2, progression: { from: "g", top: 2 } });
    const fedNoProgression = ko({ seq: 2 });
    const done = ko({ status: "complete" });
    const ROWS: { name: string; html: string }[] = [
      { name: "fed by a group stage", html: render(fed, [group, fed], "active") },
      { name: "fed with no progression stored (not the entry stage)", html: render(fedNoProgression, [group, fedNoProgression], "active") },
      { name: "before Start (setup)", html: render(ko({ status: "pending" }), [ko({ status: "pending" })], "setup") },
      { name: "before Start (scheduled)", html: render(ko(), [ko()], "scheduled") },
      { name: "a finished bracket", html: render(done, [done], "active") },
      {
        name: "no division facts (a caller that passes none)",
        html: renderToStaticMarkup(
          <StageRail stage={ko() as never} canEdit busy={null} fixtureCount={8} deletable={false}
            onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}} adhoc={false} {...NEUTRAL}
            lateEntry={{ divisionStatus: "active", roundSeated: false, href: HREF }} />,
        ),
      },
    ];
    let checked = 0;
    for (const r of ROWS) {
      expect(r.html, `${r.name}: positive pair, the rail rendered`).toContain('data-testid="stage-rail-trigger"');
      expect(r.html, r.name).not.toContain('data-testid="stage-add-late-player"');
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("another format beside it: a started root Swiss keeps 'Add late player' (the knockout's name never leaks)", () => {
    const sw = { id: "s2", name: "Swiss", kind: "swiss", seq: 1, status: "active", progression: null, config: {} };
    const html = renderToStaticMarkup(
      <StageRail stage={sw as never} canEdit busy={null} fixtureCount={8} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}} adhoc={false} {...NEUTRAL}
        lateEntry={{ divisionStatus: "active", roundSeated: true, href: HREF, division: [sw] }} />,
    );
    expect(html).toContain('data-testid="stage-add-late-player"');
    expect(html).toContain(">Add late player<");
    expect(html).not.toContain("Add to bracket");
  });
});
