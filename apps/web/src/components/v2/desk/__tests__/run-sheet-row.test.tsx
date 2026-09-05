import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { fixtureStatusLabel, outcomeText, VOID_STATUSES } from "@/components/v2/stages-panel";
import { hasAssignedScorer } from "@/lib/fixture-row-action";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import { messages } from "@/lib/messages";

// `RunSheetRow`'s inline Set-time editor refreshes on save. Nothing here clicks
// it, but the hook throws outside a router context.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Competition Desk W2, max-effort review findings 6 and 8 — both about what a
// SINGLE ROW says, so both are provable from `renderToStaticMarkup` with no
// DOM. (The inline editor's own contents are behind `useState`, so they are NOT
// reachable from here; that half is e2e's.)
//
// Rendered against the English catalog directly (`useMsg` falls back to it
// outside a `DictProvider`), and every expected string is DERIVED from the same
// helpers the component uses — never a hand-typed twin that would keep
// asserting yesterday's copy.

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const TODAY_1400 = "2026-09-05T14:00:00.000Z";
const ENTRANTS = { e1: "Alpha", e2: "Bravo" };
const msg = ((key: string, vars?: Record<string, string | number>) => {
  const raw = (messages as Record<string, string>)[key];
  if (raw === undefined) return key;
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? `{${k}}`));
}) as Parameters<typeof outcomeText>[0];

function fx(o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 1,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: TODAY_1400,
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

function rowHtml(fixture: RunSheetFixture, canEdit = true): string {
  return renderToStaticMarkup(
    <RunSheetRow
      fixture={fixture}
      href="/f/1"
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      canEdit={canEdit}
      entrantNames={ENTRANTS}
    />,
  );
}

/** The row's identity link is its POSITIVE pair: every "the label is absent"
 *  assertion below passes on a blank render otherwise. */
function expectRowRendered(html: string): void {
  expect(html, "the row itself did not render").toContain("Alpha");
  expect(html).toContain("Bravo");
}

/** The one action the row offers, read out of the markup the organiser sees. */
function rowAction(html: string): string | null {
  return /data-row-action="([a-z_]+)"/.exec(html)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// FINDING 6 — a cancelled / abandoned / forfeited row said nothing at all.
//
// The guard was `((decided && !voided) || subLine)`, whose first disjunct is
// false BY CONSTRUCTION for a voided fixture, and whose `subLine` could only be
// truthy for `awaitingDraw` or `assign_scorer` — neither of which a settled
// fixture reaches. So the `voided ? subLine : …` arm inside it was dead, the
// organiser saw a struck-through row with a "Result" button and no reason, and
// a screen-reader user got nothing whatsoever (CSS `line-through` is not
// announced). Design of record, `competition-desk-design.md:232-234`: "Status
// is carried by the dot colour + sub-line copy (`fixtureStatusLabel` stays as
// the sub-line source)."
describe("a voided row says WHY it is struck through", () => {
  // Enumerated, not sampled: the three void statuses must be distinguishable
  // from each other, which one lucky sample cannot show.
  it.each([...VOID_STATUSES])("a %s fixture names its status", (status) => {
    const html = rowHtml(fx({ status }));
    expectRowRendered(html);
    expect(html).toContain(fixtureStatusLabel(msg, status));
  });

  it("the three void statuses render three DIFFERENT sub-lines", () => {
    const labels = [...VOID_STATUSES].map((s) => fixtureStatusLabel(msg, s));
    expect(new Set(labels).size).toBe(VOID_STATUSES.size);
  });

  // The review's own failure scenario, verbatim: a forfeit with both entrants
  // known, whose `outcomeText` string was computed and then discarded.
  it("a forfeited fixture shows BOTH the reason and the winner", () => {
    const outcome = { kind: "award", winner: "e1" };
    const html = rowHtml(fx({ status: "forfeited", outcome }));
    expectRowRendered(html);
    expect(html).toContain(fixtureStatusLabel(msg, "forfeited"));
    expect(html).toContain(outcomeText(msg, outcome, ENTRANTS)!);
    // ...and it is still routed to "Result", i.e. the fix restores the missing
    // text without disturbing the ladder Task 2 pinned.
    expect(rowAction(html)).toBe("result");
  });

  it("a voided fixture with no recorded outcome still names its status", () => {
    const html = rowHtml(fx({ status: "cancelled", outcome: null }));
    expectRowRendered(html);
    expect(html).toContain(fixtureStatusLabel(msg, "cancelled"));
  });

  // The other direction. A settled, NON-void fixture must keep showing its
  // result and must NOT gain a status word — "decided" beside "Alpha won" is
  // the row noise this wave exists to cut.
  it("an ordinary decided fixture shows the result and no status word", () => {
    const outcome = { kind: "win", winner: "e1" };
    const html = rowHtml(fx({ status: "decided", outcome }));
    expectRowRendered(html);
    expect(html).toContain(outcomeText(msg, outcome, ENTRANTS)!);
    expect(html).not.toContain(fixtureStatusLabel(msg, "decided"));
  });

  it("an unresolved entrant still reads Awaiting draw", () => {
    const html = rowHtml(fx({ home_entrant_id: null, home_slot_label: null }));
    expect(html).toContain("Bravo");
    expect(html).toContain(messages["runsheet.sub.awaitingDraw"]);
  });
});

// ---------------------------------------------------------------------------
// FINDING 8 at its CALL SITE. `hasAssignedScorer`'s own table lives in
// `lib/__tests__/fixture-row-action.test.ts`; this pins that the ROW asks it,
// which a test of the pure function cannot see.
describe("a declined scorer is still no scorer, on the rendered row", () => {
  it("a fixture scheduled today whose only official declined offers Assign scorer", () => {
    const html = rowHtml(fx({ officials: [{ official_id: "o1", role: "scorer", response: "declined" }] }));
    expectRowRendered(html);
    expect(rowAction(html)).toBe("assign_scorer");
    expect(html).toContain(messages["runsheet.sub.noScorer"]);
  });

  it("the same row with an ACCEPTED official does not — the pair proves the input is read", () => {
    const html = rowHtml(fx({ officials: [{ official_id: "o1", role: "scorer", response: "accepted" }] }));
    expectRowRendered(html);
    expect(rowAction(html)).toBe("score");
    expect(html).not.toContain(messages["runsheet.sub.noScorer"]);
  });

  // Guards the guard: if the fixture above ever stopped being "today", both
  // assertions would pass against the unfixed code.
  it("the fixture under test really is scheduled today in the venue zone", () => {
    expect(TODAY_1400.slice(0, 10)).toBe(new Date(NOW_MS).toISOString().slice(0, 10));
    expect(hasAssignedScorer([{ response: "declined" }])).toBe(false);
  });
});
