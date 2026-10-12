// W2b loop H F2 — the fixture console's decided line said "Bears of Brockley won" for a walkover the run sheet beside it
// called "Bears of Brockley won (w/o)" and every public surface tagged "w/o". A credited result now reads on the console
// as it reads on the run sheet: the tag from `forfeitTag` (the one reader), the ledger from the console's own ACTIVE
// events (a voided abandon is no abandon). A result with no tag keeps the console's own sentence ("won on penalties").
//
// Every expected line is built from the en dictionary's templates — never from the code under test.
//
// single-sport: generic — the line reads the outcome and the ledger; the sport only words a played method's sentence,
// which the positive pair below pins once.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { messages } from "@/lib/messages";
import { FORFEIT_TAG_KEY } from "@/lib/forfeit-tag";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const UI = messages as Record<string, string>;
const word = (key: string) => {
  const w = UI[key];
  expect(w, `en ui.json has ${key}`).toBeTruthy();
  return w!;
};
const tagged = (name: string, tagKey: string) =>
  word("schedule.outcome.wonTagged").replace("{name}", name).replace("{tag}", word(tagKey));

const sport: SportInfo = { key: "generic", config: {}, scorerLabel: "Scorer", positionGroups: [], roles: [], lineupSize: 1, benchMax: 0 };
const HOME: SideInfo = { id: "e-home", name: "Riverside Athletic FC", members: [], lineup: [] };
const AWAY: SideInfo = { id: "e-away", name: "Bears of Brockley", members: [], lineup: [] };

const ev = (id: string, seq: number, type: string, payload: unknown, voids: string | null = null): EventIn => ({
  id,
  seq,
  type,
  payload,
  recorded_at: "2026-10-12T10:00:00.000Z",
  recorded_by: null,
  voids_event_id: voids,
});
const ABANDON = [ev("ev-1", 1, "core.start", {}), ev("ev-2", 2, "core.abandon", { reason: "rain" })];

/** The decided line's text, tags stripped — or null when the console prints none. */
function decidedLine(status: string, outcome: unknown, events: EventIn[] = []): string | null {
  const live: LiveState = { status, last_seq: events.length, summary: null, state: null, outcome };
  const html = renderToStaticMarkup(
    <FixtureConsole
      fixture={{ id: "f1", status, scheduled_at: null, venue_name: null, court_name: null, round_no: 2 }}
      sport={sport}
      home={HOME}
      away={AWAY}
      initialState={live}
      initialEvents={events}
      canEdit
      canOrganise
      stageKind="league"
      recorderNames={{}}
      audit={null}
      viewerPlan="community"
    />,
  );
  const m = /<p[^>]*data-testid="console-decided-line"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  return m === null ? null : m[1]!.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

describe("the console's decided line names a credited result as the run sheet does (loop H F2)", () => {
  it("every forfeit kind, a double walkover and each abandon the ledger holds: the run sheet's words, tag and all", () => {
    const ROWS: { name: string; status: string; outcome: unknown; events?: EventIn[]; want: string }[] = [
      ...(["walkover", "withdrew", "retired", "disqualified"] as const).map((reason) => ({
        name: `award ${reason}`,
        status: "forfeited",
        outcome: { kind: "award", winner: AWAY.id, loser: HOME.id, reason },
        want: tagged(AWAY.name, FORFEIT_TAG_KEY[reason]),
      })),
      { name: "double walkover", status: "forfeited", outcome: { kind: "double_walkover" }, want: word(FORFEIT_TAG_KEY.double_walkover) },
      {
        name: "DLS abandon",
        status: "decided",
        outcome: { kind: "win", winner: HOME.id, loser: AWAY.id, method: "dls" },
        events: ABANDON,
        want: tagged(HOME.name, FORFEIT_TAG_KEY.abandoned_dls),
      },
      {
        name: "award-policy abandon",
        status: "decided",
        outcome: { kind: "win", winner: HOME.id, loser: AWAY.id, method: "abandoned" },
        events: ABANDON,
        want: tagged(HOME.name, FORFEIT_TAG_KEY.abandoned),
      },
      {
        name: "level abandon",
        status: "decided",
        outcome: { kind: "draw" },
        events: ABANDON,
        want: `${word("schedule.outcome.draw")} · ${word(FORFEIT_TAG_KEY.abandoned)}`,
      },
    ];
    let checked = 0;
    for (const r of ROWS) {
      expect(decidedLine(r.status, r.outcome, r.events), r.name).toBe(r.want);
      checked++;
    }
    expect(checked, `rows checked: ${checked}`).toBe(ROWS.length);
  });

  it("the pairs: a result with no tag keeps the console's own sentence; an abandon a void took back tags nothing", () => {
    // An untagged win keeps the console's method sentence ("won after extra time"), which the run sheet never words.
    expect(decidedLine("decided", { kind: "win", winner: HOME.id, loser: AWAY.id, method: "extra_time" })).toBe(
      word("fixture.decidedBy.extraTime").replace("{winner}", HOME.name),
    );
    // The same DLS win with its abandon VOIDED: no active abandon, so no Aband. — the method's own sentence.
    const voided = [...ABANDON, ev("ev-3", 3, "core.void", {}, "ev-2")];
    const line = decidedLine("decided", { kind: "win", winner: HOME.id, loser: AWAY.id, method: "dls" }, voided);
    expect(line, "a line is printed").not.toBeNull();
    expect(line, "no abandon tag once the abandon is voided").not.toContain(word(FORFEIT_TAG_KEY.abandoned));
    expect(line).toBe(word("fixture.decidedBy.plain").replace("{winner}", HOME.name));
    // An abandon that decided nobody (a replay): no result, so no decided line at all — the run sheet prints none either.
    expect(decidedLine("abandoned", null, ABANDON)).toBeNull();
  });
});

// Design audit 4.3: the organiser's tag ("w/o", "ret.", "DQ", "2× w/o", "Aband. · DLS") was bare text — a screen reader
// read "ret dot", a hover showed nothing. It is now the public chip's pattern (`forfeit-tag-chip.tsx`): a symbol whose
// accessible name and tooltip are the full words. Each row names the expansion it owes by KEY (this table, not the code
// under test), and the value is the dictionary's.
describe("the console's decided line names its tag in full (audit 4.3)", () => {
  it("every forfeit kind, a double walkover and each abandon: role=img, aria-label and title the expansion, the tag shown", () => {
    const html = (status: string, outcome: unknown, events: EventIn[] = []) =>
      renderToStaticMarkup(
        <FixtureConsole
          fixture={{ id: "f1", status, scheduled_at: null, venue_name: null, court_name: null, round_no: 2 }}
          sport={sport}
          home={HOME}
          away={AWAY}
          initialState={{ status, last_seq: events.length, summary: null, state: null, outcome }}
          initialEvents={events}
          canEdit
          canOrganise
          stageKind="league"
          recorderNames={{}}
          audit={null}
          viewerPlan="community"
        />,
      );
    const ROWS: [name: string, status: string, outcome: unknown, events: EventIn[], tagKey: string, fullKey: string][] = [
      ["walkover", "forfeited", { kind: "award", winner: AWAY.id, loser: HOME.id, reason: "walkover" }, [], "forfeit.tag.walkover", "forfeit.tagFull.walkover"],
      ["withdrew", "forfeited", { kind: "award", winner: AWAY.id, loser: HOME.id, reason: "withdrew" }, [], "forfeit.tag.walkover", "forfeit.tagFull.withdrew"],
      ["retired", "forfeited", { kind: "award", winner: AWAY.id, loser: HOME.id, reason: "retired" }, [], "forfeit.tag.retired", "forfeit.tagFull.retired"],
      ["disqualified", "forfeited", { kind: "award", winner: AWAY.id, loser: HOME.id, reason: "disqualified" }, [], "forfeit.tag.disqualified", "forfeit.tagFull.disqualified"],
      ["double walkover", "forfeited", { kind: "double_walkover" }, [], "forfeit.tag.doubleWalkover", "forfeit.tagFull.doubleWalkover"],
      ["DLS abandon", "decided", { kind: "win", winner: HOME.id, loser: AWAY.id, method: "dls" }, ABANDON, "forfeit.tag.abandonedDls", "forfeit.tagFull.abandonedDls"],
      ["award-policy abandon", "decided", { kind: "win", winner: HOME.id, loser: AWAY.id, method: "abandoned" }, ABANDON, "forfeit.tag.abandoned", "forfeit.tagFull.abandoned"],
      ["level abandon", "decided", { kind: "draw" }, ABANDON, "forfeit.tag.abandoned", "forfeit.tagFull.abandoned"],
    ];
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let checked = 0;
    for (const [name, status, outcome, events, tagKey, fullKey] of ROWS) {
      const full = word(fullKey);
      expect(full, `${name}: the expansion is not the tag`).not.toBe(word(tagKey));
      const line = /<p[^>]*data-testid="console-decided-line"[^>]*>([\s\S]*?)<\/p>/.exec(html(status, outcome, events))?.[1] ?? "";
      expect(line, `${name}: the tag, named in full`).toMatch(new RegExp(`<span role="img" aria-label="${esc(full)}" title="${esc(full)}">${esc(word(tagKey))}</span>`));
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("the pair: an untagged result carries no symbol", () => {
    const line = /<p[^>]*data-testid="console-decided-line"[^>]*>([\s\S]*?)<\/p>/.exec(
      renderToStaticMarkup(
        <FixtureConsole
          fixture={{ id: "f1", status: "decided", scheduled_at: null, venue_name: null, court_name: null, round_no: 2 }}
          sport={sport}
          home={HOME}
          away={AWAY}
          initialState={{ status: "decided", last_seq: 0, summary: null, state: null, outcome: { kind: "win", winner: HOME.id, loser: AWAY.id, method: "extra_time" } }}
          initialEvents={[]}
          canEdit
          canOrganise
          stageKind="league"
          recorderNames={{}}
          audit={null}
          viewerPlan="community"
        />,
      ),
    )?.[1];
    expect(line, "a line is printed").toBeDefined();
    expect(line).not.toContain('role="img"');
  });
});
