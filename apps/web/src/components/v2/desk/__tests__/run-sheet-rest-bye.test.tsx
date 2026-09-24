import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { restByeExtKey } from "@/lib/fixture-bye";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

// #850 (owner ruling 2026-09-23, "inside its round (and pool)") — the RENDERED
// run sheet, not only the builder: a round-robin rest bye is the Swiss ghost
// row, drawn inside the day block its round is played on, and the day header's
// "N fixtures" counts the MATCHES under it, not the bye riding with them. The
// builder's placement is pinned in lib/__tests__/run-sheet-groups.test.ts; this
// proves the component renders what the builder placed, where it placed it.

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 1, 12, 0, 0);
const DAY = "2026-09-05";

function fx(id: string, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id,
    stage_id: "s1",
    fixture_no: 1,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: `${DAY}T09:00:00.000Z`,
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

const bye = (id: string, round: number): RunSheetFixture =>
  fx(id, {
    round_no: round,
    seq_in_round: 3,
    scheduled_at: null,
    status: "forfeited",
    home_entrant_id: "e5",
    away_entrant_id: null,
    outcome: { kind: "award", winner: "e5" },
    away_slot_label: { key: "bracket.slot.bye", params: {} },
    // The rest-bye MARKER, spelled by the generator's own function.
    ext_key: restByeExtKey("", round),
  });

function sheet(fixtures: RunSheetFixture[], filter: RunSheetFilter = "all"): string {
  const stages = [{ id: "s1", seq: 1, kind: "league", name: "League" }];
  return renderToStaticMarkup(
    <DictProvider dict={enUi} locale="en">
      <RunSheet
        blocks={buildRunSheet({ fixtures, stages, tz: TZ, nowMs: NOW_MS })}
        stages={stages}
        tz={TZ}
        orgTz={TZ}
        nowMs={NOW_MS}
        matchMinutes={60}
        entrantNames={{ e1: "Alpha", e2: "Bravo", e3: "Cara", e4: "Dan", e5: "Eve" }}
        canEdit
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter={filter}
        onFilter={() => {}}
        stageId={null}
        onStageFilter={() => {}}
      />
    </DictProvider>,
  );
}

/** The markup of the `<section>` holding the day header for `dayKey`. */
function daySection(html: string, dayKey: string): string {
  const at = html.indexOf(`data-run-sheet-day="${dayKey}"`);
  expect(at, `no day block for ${dayKey}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<section", at);
  return html.slice(start, html.indexOf("</section>", at));
}

const text = (html: string) => html.replace(/<[^>]*>/g, "");

describe("#850 — the rendered run sheet puts a league bye inside its round's day", () => {
  const fixtures = [
    fx("r1-a", { fixture_no: 1, seq_in_round: 1, scheduled_at: `${DAY}T09:00:00.000Z` }),
    fx("r1-b", { fixture_no: 2, seq_in_round: 2, scheduled_at: `${DAY}T10:00:00.000Z`, home_entrant_id: "e3", away_entrant_id: "e4" }),
    bye("bye-r1", 1),
  ];

  it("the ghost row renders INSIDE the day section, after the round's last match", () => {
    const section = daySection(sheet(fixtures), DAY);
    const ghost = section.indexOf('data-testid="run-sheet-bye"');
    expect(ghost, "the bye's ghost row is inside the day section").toBeGreaterThan(-1);
    expect(text(section.slice(ghost))).toContain("Round 1 · Eve has a bye");
    // After BOTH of the round's matches, not merely somewhere in the section.
    expect(section.indexOf('data-fixture-no="2"')).toBeGreaterThan(-1);
    expect(ghost).toBeGreaterThan(section.indexOf('data-fixture-no="2"'));
  });

  it("no 'Played, not scheduled' block is drawn for it — nothing was played", () => {
    expect(sheet(fixtures)).not.toContain('data-run-sheet-block="settled"');
  });

  it("the day header counts the two MATCHES, not the bye beside them", () => {
    const header = text(daySection(sheet(fixtures), DAY).split("</h3>")[0]!);
    expect(header).toContain("2 fixtures");
    expect(header).not.toContain("3 fixtures");
  });

  it("a league bye carries no '(won w/o)' suffix — it scores nothing", () => {
    const section = daySection(sheet(fixtures), DAY);
    const ghost = section.slice(section.indexOf('data-testid="run-sheet-bye"'));
    expect(text(ghost.split("</li>")[0]!)).not.toMatch(/w\/o/i);
  });
});

// Review round 2, R2-5 — RENDERED: a partly played untimed round keeps its
// ghost row in "Not yet scheduled", beside the match still waiting for a time,
// never under "Played, not scheduled" with the match that was played.
describe("#850 R2-5 — the rendered sheet never splits a bye from its round's unplayed match", () => {
  const block = (html: string, kind: string): string => {
    const at = html.indexOf(`data-run-sheet-block="${kind}"`);
    expect(at, `no ${kind} block`).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf("</section>", at));
  };
  const played = fx("r1-a", { fixture_no: 1, seq_in_round: 1, scheduled_at: null, status: "decided", outcome: { kind: "win", winner: "e1", loser: "e2" } });
  const waiting = fx("r1-b", { fixture_no: 2, seq_in_round: 2, scheduled_at: null, home_entrant_id: "e3", away_entrant_id: "e4" });

  it("with a match of its round still to play, the ghost row sits in 'Not yet scheduled' after it", () => {
    const html = sheet([played, waiting, bye("bye-r1", 1)]);
    const open = block(html, "unscheduled");
    expect(open).toContain('data-testid="run-sheet-bye"');
    expect(open.indexOf('data-testid="run-sheet-bye"')).toBeGreaterThan(open.indexOf('data-fixture-no="2"'));
    expect(block(html, "settled")).not.toContain('data-testid="run-sheet-bye"');
  });

  it("once that match is played too, the ghost row closes the round under 'Played, not scheduled'", () => {
    const html = sheet([played, { ...waiting, status: "decided", outcome: { kind: "win", winner: "e3", loser: "e4" } }, bye("bye-r1", 1)]);
    expect(html).not.toContain('data-run-sheet-block="unscheduled"');
    expect(block(html, "settled")).toContain('data-testid="run-sheet-bye"');
  });
});
