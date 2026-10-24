import { describe, expect, it, vi } from "vitest";
import { FORFEIT_REASONS } from "@seazn/engine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheetRow, SCHEDULE_ERROR_FALLBACK_KEY, scheduleErrorKey } from "@/components/v2/desk/run-sheet-row";
import { fixtureStatusLabel, outcomeText, VOID_STATUSES } from "@/components/v2/stages-panel";
import { hasAssignedScorer } from "@/lib/fixture-row-action";
import { ApiV1Error } from "@/lib/client-v1";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import { messages } from "@/lib/messages";

// `RunSheetRow`'s inline Set-time editor refreshes on save. Nothing here clicks
// it, but the hook throws outside a router context.
// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
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

/** The markup's TEXT: a result's tag is its own element since design audit 4.3, so a sentence is read across tags. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

function rowHtml(fixture: RunSheetFixture, canEdit = true, stageName?: string | null, awaitsSettle = false): string {
  return renderToStaticMarkup(
    <RunSheetRow
      fixture={fixture}
      awaitsSettle={awaitsSettle}
      href="/f/1"
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      canEdit={canEdit}
      entrantNames={ENTRANTS}
      stageName={stageName}
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

  // Loop R I-1: a walkover stored before W2b (no loser, no reason; the reason in `method`) reads its w/o from the
  // row's two seats; the same shape with one seat empty is the bye it always was.
  it("Loop R I-1: a walkover STORED before W2b reads its w/o; a one-seat one is still the bye", () => {
    // The bye's own copy is "{name} won (w/o)" too, so the text cannot tell them apart: the walkover's tag is the named
    // symbol (audit 4.3), in both copies of the line, and the bye is the bye row with no symbol.
    const legacy = { kind: "award", winner: "e1", method: "walkover" };
    const full = msg("forfeit.tagFull.walkover" as never);
    const symbol = `<span role="img" aria-label="${full}" title="${full}">${msg("forfeit.tag.walkover" as never)}</span>`;
    const html = rowHtml(fx({ status: "forfeited", outcome: legacy, scheduled_at: null }));
    expect(html.split(symbol).length - 1, "the desktop sub-line and the phone tail").toBe(2);
    // Every reason: the legacy row renders exactly the typed one (a retirement's "ret." is not the bye's "w/o").
    let checked = 0;
    for (const reason of FORFEIT_REASONS) {
      const typed = rowHtml(fx({ status: "forfeited", outcome: { kind: "award", winner: "e1", loser: "e2", reason }, scheduled_at: null }));
      expect(rowHtml(fx({ status: "forfeited", outcome: { ...legacy, method: reason }, scheduled_at: null })), reason).toBe(typed);
      checked++;
    }
    expect(checked).toBe(FORFEIT_REASONS.length);
    const bye = rowHtml(fx({ status: "forfeited", outcome: legacy, away_entrant_id: null, scheduled_at: null }));
    expect(bye).toContain('data-testid="run-sheet-bye"');
    expect(bye).not.toContain('role="img"');
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

  // W2b Task 13 (X-AB-2): the row's abandon tag reads the row's ledger column (`abandon_reason`, the division read's
  // `activeAbandonReasonSql`), never its status — a DLS abandon is stored `decided`, like a reduced chase played out.
  it("a decided DLS row carries the abandon tag only when its ledger holds the abandon", () => {
    const outcome = { kind: "win", winner: "e1", loser: "e2", method: "dls" };
    const abandoned = rowHtml(fx({ status: "decided", outcome, abandon_reason: "rain" }));
    expectRowRendered(abandoned);
    expect(textOf(abandoned)).toContain(`Alpha won (${messages["forfeit.tag.abandonedDls"]})`);
    const played = rowHtml(fx({ status: "decided", outcome, abandon_reason: null }));
    expect(played).toContain("Alpha won");
    expect(played).not.toContain(messages["forfeit.tag.abandonedDls"]);
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
// W2a Task 11 (finding 25): a held bracket fixture says so on the run sheet — a chip in the red attention tone — and
// its one action is Settle, which opens the fixture page where the "Needs a decision" block lives.
describe("a held fixture (needs_decision) reads Needs a decision and offers Settle", () => {
  const HELD = fx({ status: "needs_decision", outcome: { kind: "draw" } });

  it("shows the held chip and the decide action to an editor", () => {
    const html = rowHtml(HELD);
    expectRowRendered(html);
    expect(html).toContain('data-testid="run-sheet-held-chip"');
    expect(html).toContain(">Needs a decision<");
    expect(rowAction(html)).toBe("decide");
    expect(html).toContain(">Settle<");
  });

  it("a read-only viewer still sees the chip, and only views", () => {
    const html = rowHtml(HELD, false);
    expect(html).toContain('data-testid="run-sheet-held-chip"');
    expect(rowAction(html)).toBe("view");
  });

  it("M10 (fix round 1): a recorded abandon awaiting its settle — stored `abandoned` — is held too: chip and Settle", () => {
    const abandoned = fx({ status: "abandoned", outcome: null });
    const held = rowHtml(abandoned, true, undefined, true);
    expectRowRendered(held);
    expect(held).toContain('data-testid="run-sheet-held-chip"');
    expect(rowAction(held)).toBe("decide");
    // The positive pair: the generator's void (abandoned, nothing owed) is a result with no chip.
    const voided = rowHtml(abandoned, true, undefined, false);
    expectRowRendered(voided);
    expect(voided).not.toContain('data-testid="run-sheet-held-chip"');
    expect(rowAction(voided)).not.toBe("decide");
  });

  it("X-AB-5: a Swiss board abandoned with no result (a TABLE stage's row) is held the same way: chip, Settle, no strike", () => {
    const abandoned = fx({ status: "abandoned", outcome: null });
    const held = rowHtml(abandoned, true, "Swiss", true);
    expectRowRendered(held);
    expect(held).toContain('data-testid="run-sheet-held-chip"');
    expect(rowAction(held)).toBe("decide");
    expect(held).not.toContain("line-through");
    // The positive pair: the same row with nothing owed (a generator void, or a withdrawal's expunge) is struck, no chip.
    const voided = rowHtml(abandoned, true, "Swiss", false);
    expect(voided).toContain("line-through");
    expect(voided).not.toContain('data-testid="run-sheet-held-chip"');
  });

  it("M10 (fix round 1): a held abandon's names are NOT struck through — the row is owed work, not a void; the void keeps its strike", () => {
    // Seen on the 320/1280 crops: a struck-through pair beside "Needs a decision" and Settle read as two contradicting
    // facts in one row (the void says "does not count"; the settle seats a winner). The reason line still says abandoned.
    const abandoned = fx({ status: "abandoned", outcome: null });
    const held = rowHtml(abandoned, true, undefined, true);
    const voided = rowHtml(abandoned, true, undefined, false);
    expectRowRendered(held);
    expectRowRendered(voided);
    expect(voided, "the positive pair: a void is struck").toContain("line-through");
    expect(held).not.toContain("line-through");
    expect(held, "the reason line stays").toContain(fixtureStatusLabel(msg, "abandoned"));
    // And a played row is never struck, held flag or not.
    const played = rowHtml(fx({ status: "decided", outcome: { kind: "win", winner: "e1", loser: "e2" } }));
    expectRowRendered(played);
    expect(played).not.toContain("line-through");
  });

  it("the positive pair: a decided row carries no held chip", () => {
    const html = rowHtml(fx({ status: "decided", outcome: { kind: "win", winner: "e1", loser: "e2" } }));
    expectRowRendered(html);
    expect(html).not.toContain('data-testid="run-sheet-held-chip"');
  });

  it("loop R M7(d): on a phone a held row gives its meta line a line of its own, so 'abandoned' is never truncated away", () => {
    // At 320 line 2 held the meta text, the held chip and Settle: the chip and the action took the room and the meta
    // truncated to "Round 1 · …", hiding the reason. A held row's meta now takes the whole line (max-md:basis-full) and
    // the chip and Settle wrap below it; any other row keeps the two-line composition (Task 9, A3).
    // Loop H F1: the line is now two spans (the truncating lead, the result's tail), so its text is read with the tags
    // stripped; the paragraph is still found by its own `md:hidden` class.
    const phoneMeta = (html: string) => {
      const m = /<p class="([^"]*\bmd:hidden\b[^"]*)">(.*?)<\/p>/.exec(html);
      return m === null ? null : ([m[0], m[1]!, m[2]!.replace(/<[^>]*>/g, "")] as const);
    };
    const abandoned = fx({ status: "abandoned", outcome: null });
    const rows = [
      { name: "held abandon", html: rowHtml(abandoned, true, undefined, true), own: true },
      { name: "needs_decision", html: rowHtml(HELD), own: true },
      { name: "a void (no chip)", html: rowHtml(abandoned, true, undefined, false), own: false },
      { name: "a decided row", html: rowHtml(fx({ status: "decided", outcome: { kind: "win", winner: "e1", loser: "e2" } })), own: false },
    ];
    let checked = 0;
    for (const r of rows) {
      expectRowRendered(r.html);
      const m = phoneMeta(r.html);
      expect(m, `${r.name}: the phone meta paragraph renders`).not.toBeNull();
      expect(m![1]!.split(/\s+/).includes("max-md:basis-full"), r.name).toBe(r.own);
      checked++;
    }
    expect(phoneMeta(rows[0]!.html)![2], "the held abandon's meta still carries the reason").toContain(fixtureStatusLabel(msg, "abandoned"));
    expect(checked).toBe(rows.length);
  });
});

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
    );
    expect(html).toContain(msg("schedule.bye", { name: "Alpha" }));
    expect(html).toContain(outcomeText(msg, outcome, ENTRANTS)!);
    expect(html).toContain('data-testid="run-sheet-bye"');
    expect(rowAction(html)).toBeNull();
  });
});

// R116-3 (W2b Task 16; owner ruling 116): a withdrawn winner's dead seat, walked over by the side that arrived, is a
// WALKOVER on the run sheet — the row an ordinary walkover gets, naming her in her seat — never "{name} has a bye". The
// pair: an award with no loser (an odd draw's bye, a double walkover's dead seat, a DQ'd winner's: withdrawal-w2b's
// `seatWalkover`) is still the bye row. Either seat dead.
describe("R116-3: ruling 116's walkover reads as a walkover naming her, never a bye", () => {
  const BYE_LABEL = { key: "bracket.slot.bye", params: {} };
  const NAMES = { ...ENTRANTS, e3: "Charlie" };
  const render = (f: RunSheetFixture) =>
    renderToStaticMarkup(
      <RunSheetRow fixture={f} href="/f/1" tz={TZ} orgTz={TZ} nowMs={NOW_MS} canEdit entrantNames={NAMES} />,
    );

  it("either seat: her name, the walkover's result, the ordinary walkover's action — and no bye row", () => {
    let checked = 0;
    for (const dead of ["home", "away"] as const) {
      const outcome = { kind: "award" as const, winner: "e1", loser: "e3", reason: "withdrew" as const };
      const seats =
        dead === "home"
          ? { home_entrant_id: null, away_entrant_id: "e1", home_slot_label: BYE_LABEL, away_slot_label: null }
          : { home_entrant_id: "e1", away_entrant_id: null, home_slot_label: null, away_slot_label: BYE_LABEL };
      const html = render(fx({ status: "forfeited", outcome, scheduled_at: null, ...seats }));
      // The oracle: the same walkover with her still seated.
      const ordinary = render(fx({ status: "forfeited", outcome, scheduled_at: null, home_entrant_id: dead === "home" ? "e3" : "e1", away_entrant_id: dead === "home" ? "e1" : "e3" }));
      expect(html, `${dead}: not the bye row`).not.toContain('data-testid="run-sheet-bye"');
      expect(html, `${dead}: no "has a bye"`).not.toContain(msg("schedule.bye", { name: "Alpha" }));
      expect(html, `${dead}: no bye label`).not.toContain(`>${msg("bracket.slot.bye")}<`);
      expect(html, `${dead}: names her`).toContain("Charlie");
      expect(html, `${dead}: and the winner`).toContain("Alpha");
      expect(textOf(html), `${dead}: the walkover's result`).toContain(outcomeText(msg, outcome, NAMES)!);
      expect(rowAction(html), `${dead}: the ordinary walkover's action`).toBe(rowAction(ordinary));
      // Design audit 4.1: and marks her as gone — the departed-entrant chip right after her name (ladder-panel's
      // pattern), the entrant status's own word; the ordinary walkover (her seated) has none.
      const chip = new RegExp(`Charlie</span><span class="shrink-0"><span data-testid="run-sheet-withdrawn" class="([^"]*)">${msg("entrants.status.withdrawn")}</span></span>`);
      expect(html, `${dead}: her name, then the Withdrawn chip`).toMatch(chip);
      // Whole beside the opponent at 320, and not struck with the names: an inline-block in a shrink-0 item of a flex
      // names line whose names each truncate (the e2e measures the painted result).
      expect(chip.exec(html)![1]!.split(" "), `${dead}: the chip is an atomic inline`).toContain("inline-block");
      const line = /<a [^>]*class="([^"]*)"[^>]*href="\/f\/1"|<a [^>]*href="\/f\/1"[^>]*class="([^"]*)"/.exec(html);
      const lineCls = (line?.[1] ?? line?.[2] ?? "").split(" ");
      expect(lineCls, `${dead}: the names line is a flex row`).toEqual(expect.arrayContaining(["flex", "min-w-0"]));
      expect(lineCls, `${dead}: that no longer truncates as one string`).not.toContain("truncate");
      expect((html.match(/<span class="min-w-0 truncate[^"]*">(Charlie|Alpha)<\/span>/g) ?? []).length, `${dead}: each name truncates on its own`).toBe(2);
      expect((html.match(/data-testid="run-sheet-withdrawn"/g) ?? []).length, `${dead}: one chip, hers`).toBe(1);
      expect(ordinary, `${dead}: a seated side carries no chip`).not.toContain('data-testid="run-sheet-withdrawn"');
      expect(ordinary, `${dead}: and keeps the one truncating names line`).toMatch(/class="block min-w-0 truncate text-sm/);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the pair: an award with no loser over the stamped seat is still the bye row", () => {
    const html = render(
      fx({ status: "forfeited", outcome: { kind: "award", winner: "e1", loser: null, reason: "bye" } as never, scheduled_at: null, away_entrant_id: null, away_slot_label: BYE_LABEL }),
    );
    expect(html).toContain('data-testid="run-sheet-bye"');
    expect(html).toContain(msg("schedule.bye", { name: "Alpha" }));
    expect(html).not.toContain("Charlie");
    expect(html, "no Withdrawn chip on a bye (audit 4.1)").not.toContain('data-testid="run-sheet-withdrawn"');
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

  // Review 3 of #857, N1: a start taken back leaves the row `scheduled`, so the
  // editor opens on it and the server refuses the move. The organiser reads why.
  it("the played refusal gets its own key, with copy of its own", () => {
    const err = new ApiV1Error("this match has a result or scoring recorded", 422, PLAYED_REFUSAL_CODE);
    expect(scheduleErrorKey(err)).toBe("schedule.error.played");
    const copy = (messages as Record<string, string>)["schedule.error.played"];
    expect(copy).toBeTruthy();
    expect(copy).not.toBe((messages as Record<string, string>)[SCHEDULE_ERROR_FALLBACK_KEY]);
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

// Design audit 4.3: the run sheet's tag is bare text no more — both copies of the result (the desktop sub-line and the
// phone line's tail) render it as the public chip does, a symbol named in full ("ret." → "retired"). The expansion owed
// is named by KEY per row here; the pair: a bye's "won (w/o)" carries no tag, so no symbol.
describe("the run sheet names its tag in full (audit 4.3)", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  it("each forfeit reason and a double walkover: the tag as role=img, named and titled in full, in both copies", () => {
    const ROWS: [reason: string, outcome: unknown, tagKey: string, fullKey: string][] = [
      ["walkover", { kind: "award", winner: "e1", loser: "e2", reason: "walkover" }, "forfeit.tag.walkover", "forfeit.tagFull.walkover"],
      ["withdrew", { kind: "award", winner: "e1", loser: "e2", reason: "withdrew" }, "forfeit.tag.walkover", "forfeit.tagFull.withdrew"],
      ["retired", { kind: "award", winner: "e1", loser: "e2", reason: "retired" }, "forfeit.tag.retired", "forfeit.tagFull.retired"],
      ["disqualified", { kind: "award", winner: "e1", loser: "e2", reason: "disqualified" }, "forfeit.tag.disqualified", "forfeit.tagFull.disqualified"],
      ["double walkover", { kind: "double_walkover" }, "forfeit.tag.doubleWalkover", "forfeit.tagFull.doubleWalkover"],
    ];
    let checked = 0;
    for (const [reason, outcome, tagKey, fullKey] of ROWS) {
      const full = msg(fullKey as never);
      expect(full, `${reason}: the expansion is not the tag`).not.toBe(msg(tagKey as never));
      const html = rowHtml(fx({ status: "forfeited", outcome: outcome as never, scheduled_at: null }));
      const symbol = new RegExp(`<span role="img" aria-label="${esc(full)}" title="${esc(full)}">${esc(msg(tagKey as never))}</span>`, "g");
      expect((html.match(symbol) ?? []).length, `${reason}: the desktop sub-line and the phone tail`).toBe(2);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
  it("the pair: a bye's walkover result names no tag", () => {
    const html = rowHtml(
      fx({ status: "forfeited", outcome: { kind: "award", winner: "e1", loser: null, reason: "bye" } as never, scheduled_at: null, away_entrant_id: null, away_slot_label: { key: "bracket.slot.bye", params: {} } }),
    );
    expect(html).toContain('data-testid="run-sheet-bye"');
    expect(html).not.toContain('role="img"');
  });
});
