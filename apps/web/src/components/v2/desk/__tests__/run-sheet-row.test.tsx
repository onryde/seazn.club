import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheetRow, SCHEDULE_ERROR_FALLBACK_KEY, scheduleErrorKey } from "@/components/v2/desk/run-sheet-row";
import { fixtureStatusLabel, outcomeText, VOID_STATUSES } from "@/components/v2/stages-panel";
import { hasAssignedScorer } from "@/lib/fixture-row-action";
import { ApiV1Error } from "@/lib/client-v1";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import { restByeExtKey } from "@/lib/fixture-bye";
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

function rowHtml(fixture: RunSheetFixture, canEdit = true, stageName?: string | null, stageKind = "knockout"): string {
  return renderToStaticMarkup(
    <RunSheetRow
      fixture={fixture}
      href="/f/1"
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      canEdit={canEdit}
      entrantNames={ENTRANTS}
      stageName={stageName}
      stageKind={stageKind}
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
// F3 (W2 walkthrough gate 1): the unscheduled/settled groups merge every
// stage into one list with nothing identifying which stage a row belongs
// to — two same-named "Round 1 · Bravo vs Echo" rows from different stages
// were indistinguishable. `RunSheet` passes `stageName` only for those two
// blocks and only when the division has more than one stage; this proves
// the ROW half of that contract: rendered when given, absent when not.
describe("stageName (F3 — unscheduled/settled rows identify their stage)", () => {
  it("prints the stage name ahead of the court/round meta line when provided", () => {
    const html = rowHtml(fx(), true, "Cup");
    expectRowRendered(html);
    expect(html).toContain("Cup ·");
  });

  it("omits the stage name entirely when not provided (single-stage division)", () => {
    const html = rowHtml(fx());
    expectRowRendered(html);
    expect(html).not.toContain("Cup ·");
  });
});

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

  // F5 (W2 walkthrough gate 1): the report's own screenshot — a TIMED row
  // reading "Awaiting draw" and offering "Score" at the same time, a promise
  // the fixture cannot keep since neither side is named yet. The sub-line
  // half of this was already correct (the test above); this is the ACTION
  // half, at its real call site — a test of the pure ladder alone
  // (`fixture-row-action.test.ts`) cannot see whether the row actually wires
  // `awaitingDraw` through to it.
  it("F5: a TIMED, undrawn fixture never offers Score or Assign scorer — it reads View", () => {
    const html = rowHtml(fx({ home_entrant_id: null, home_slot_label: null }));
    expect(rowAction(html)).toBe("view");
    expect(html).toContain(messages["runsheet.action.view"]);
    expect(html).not.toContain(messages["runsheet.action.score"]);
  });

  // The POSITIVE pair: an UNTIMED, undrawn fixture still offers Set time —
  // pre-scheduling a bracket round's slot ahead of the draw is unaffected.
  it("F5: an UNTIMED, undrawn fixture still offers Set time, not View", () => {
    const html = rowHtml(fx({ home_entrant_id: null, home_slot_label: null, scheduled_at: null }));
    expect(rowAction(html)).toBe("set_time");
  });
});

// Swiss / KO award bye: isBye short-circuits before the voided sub-line, so a
// forfeited+award sit-out used to print only "{name} has a bye" and hide the
// walkover. Pin both halves — bye label AND won (w/o) — derived from the same
// helpers the row uses.
describe("an awarded bye names the sit-out AND the walkover", () => {
  it("shows schedule.bye and schedule.outcome.wonWo for a one-sided award", () => {
    const outcome = { kind: "award" as const, winner: "e1" };
    const html = rowHtml(
      fx({
        status: "forfeited",
        outcome,
        home_entrant_id: "e1",
        away_entrant_id: null,
        scheduled_at: null,
      }),
      true,
      null,
      "swiss",
    );
    expect(html).toContain(msg("schedule.bye", { name: "Alpha" }));
    expect(html).toContain(outcomeText(msg, outcome, ENTRANTS)!);
    expect(html).toContain('data-testid="run-sheet-bye"');
    expect(rowAction(html)).toBeNull();
  });
});

// #850 (owner ruling 2026-09-23): a round-robin REST bye reuses the ghost row
// but carries NO outcome suffix — it scores nothing, so "won (w/o)" would be a
// false claim. The row asks `isScoringBye`, so the answer is the stage KIND's:
// the SAME row prints the suffix under Swiss/knockout and not under league/
// group. Every assertion is anchored on the ghost row existing first, so an
// absent suffix can never be satisfied by an absent row.
describe("#850: a round-robin bye's ghost row has no outcome suffix", () => {
  const outcome = { kind: "award" as const, winner: "e1" };
  const bye = fx({
    status: "forfeited",
    outcome,
    home_entrant_id: "e1",
    away_entrant_id: null,
    round_no: 3,
    scheduled_at: null,
    // The rest-bye MARKER (owner ruling 2026-09-24, fourth round), spelled by
    // the generator's own function.
    ext_key: restByeExtKey("", 3),
  });
  const ghost = `${msg("schedule.round", { n: 3 })} · ${msg("schedule.bye", { name: "Alpha" })}`;
  const suffix = outcomeText(msg, outcome, ENTRANTS)!;
  /** The ghost row's visible text, or null when there is no ghost row. */
  const ghostText = (html: string): string | null => {
    const m = /<li[^>]*data-testid="run-sheet-bye"[^>]*>([\s\S]*?)<\/li>/.exec(html);
    return m ? m[1]!.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "") : null;
  };

  it.each(["league", "group"])("%s: exactly 'Round N · X has a bye' — nothing after it", (kind) => {
    const html = rowHtml(bye, true, null, kind);
    expect(ghostText(html), "the ghost row itself").not.toBeNull();
    expect(ghostText(html)).toBe(ghost);
    expect(html).not.toContain(suffix);
    expect(rowAction(html)).toBeNull();
  });

  it.each(["swiss", "knockout", "double_elim", "stepladder", "page_playoff"])(
    "%s (a scoring bye): the same row keeps its '(w/o)' suffix",
    (kind) => {
      const html = rowHtml(bye, true, null, kind);
      expect(ghostText(html)).toBe(`${ghost} · ${suffix}`);
    },
  );
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

// ---------------------------------------------------------------------------
// W2 fix — the inline editor's refusal copy. `patchSchedule`'s catch used to
// render `err.message`, i.e. the SERVER's own English sentence ("schedule
// change hits a blocking conflict", the EngineError raised by
// `assertNoNewBlocking` in server/usecases/schedule.ts), to an organiser who
// may be reading the console in es/fr/nl. The branch is on the wire CODE now
// and the raw message is never read on any path.
//
// This suite pins the PURE half — code -> key. What that key RENDERS, and in
// which locale, is only provable in a browser: `e2e/run-sheet-dates-and-court
// .spec.ts` drives a real double-book through the editor and reads the copy off
// the page in fr. A node-environment suite can see neither.
describe("the inline editor maps a wire code to organiser copy, never a raw message", () => {
  it("a SCHEDULE_CONFLICT gets its own key, not the generic failure", () => {
    const err = new ApiV1Error("schedule change hits a blocking conflict", 409, "SCHEDULE_CONFLICT");
    expect(scheduleErrorKey(err)).toBe("schedule.error.conflict");
    // The differential that kills a "return the fallback for everything" mutant.
    expect(scheduleErrorKey(err)).not.toBe(SCHEDULE_ERROR_FALLBACK_KEY);
  });

  it("every other wire code falls back — nothing unmapped invents copy", () => {
    for (const code of ["SEQ_CONFLICT", "ERROR", "NOT_FOUND", "PAYMENT_REQUIRED", "VALIDATION", "INTERNAL"]) {
      expect(scheduleErrorKey(new ApiV1Error("raw english", 422, code)), code).toBe(
        SCHEDULE_ERROR_FALLBACK_KEY,
      );
    }
  });

  it("a non-ApiV1Error — a network drop, a thrown string — falls back too", () => {
    expect(scheduleErrorKey(new TypeError("Failed to fetch"))).toBe(SCHEDULE_ERROR_FALLBACK_KEY);
    expect(scheduleErrorKey("boom")).toBe(SCHEDULE_ERROR_FALLBACK_KEY);
    expect(scheduleErrorKey(undefined)).toBe(SCHEDULE_ERROR_FALLBACK_KEY);
  });

  // A plain `Error` whose MESSAGE happens to be the code must NOT match: the
  // branch reads `.code`, and only `ApiV1Error` carries one. Kills a mutant
  // that sniffs the message text instead of the typed field.
  it("an Error carrying the code only in its message is not a conflict", () => {
    expect(scheduleErrorKey(new Error("SCHEDULE_CONFLICT"))).toBe(SCHEDULE_ERROR_FALLBACK_KEY);
  });

  // Both keys must exist in the catalog, or the editor renders the key string
  // itself (`tRuntime`'s miss behaviour) — a raw dotted identifier on screen.
  it("both keys are real catalog entries with distinct copy", () => {
    for (const key of ["schedule.error.conflict", SCHEDULE_ERROR_FALLBACK_KEY]) {
      const copy = (messages as Record<string, string>)[key];
      expect(copy, key).toBeTruthy();
      expect(copy, key).not.toBe(key);
    }
    // And they are DIFFERENT copy — a court clash that reads "Failed" is the
    // defect this fix exists to remove, one indirection later.
    expect(messages["schedule.error.conflict"]).not.toBe(messages[SCHEDULE_ERROR_FALLBACK_KEY]);
    // The organiser must be told what to DO, not just that it broke. A bare
    // status word is exactly the failure mode the fallback already is.
    expect(messages["schedule.error.conflict"]!.length).toBeGreaterThan(
      messages[SCHEDULE_ERROR_FALLBACK_KEY]!.length,
    );
  });
});
