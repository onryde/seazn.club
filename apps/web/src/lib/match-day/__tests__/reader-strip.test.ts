// Match Day PB2 item 3: `matchDayForReader` is the ONE strip both Match Day doors use — the page's first paint (task G5) and the
// poll the shell runs after it (the route). Pure, so the owed-result count is pinned here deterministically; the route's own
// test (read-only-staff.test.ts) drives real sessions through it.
//
// The predicate is the page's: `isEditorRole` is what page-auth.ts computes `canEdit` from (owner, admin). Every role the
// organisation has is enumerated off ORG_ROLES itself, plus the API key's null role, so a new role cannot slip past unasked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_ROLES, EDITOR_ROLES, isEditorRole, type OrgRole } from "@/lib/types";
import { matchDayForReader } from "@/lib/match-day/view";
import type { MatchDayBoardRow, MatchDayOnlineRound, MatchDayView } from "@/lib/match-day/types";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";

type Strip = Pick<MatchDayView, "needs_you" | "results_owed"> & { courts: string[]; fixtures_today: number };
const ROW = { key: "k-1", severity: "red" as const, kind: "result_missing" as const, title: "Result owed", sub: "Court 1", action: { label: "Open", href: "/x" } };
const VIEW: Strip = { needs_you: [ROW, { ...ROW, key: "k-2", kind: "unscheduled" as const }], results_owed: 3, courts: ["c-1", "c-2"], fixtures_today: 7 };

describe("matchDayForReader — the organiser's to-do list reaches organisers only", () => {
  it("EMPTY CASE FIRST: a view with no rows and nothing owed is the same for every reader", () => {
    const empty: Strip = { ...VIEW, needs_you: [], results_owed: 0 };
    expect(matchDayForReader(empty, true)).toEqual(empty);
    expect(matchDayForReader(empty, false)).toEqual(empty);
  });

  it("an organiser gets the view whole — the same object, rows and count", () => {
    expect(matchDayForReader(VIEW, true)).toBe(VIEW);
  });

  it("anyone else gets no rows and a zero owed count, and the rest of the board untouched; the input is not mutated", () => {
    const out = matchDayForReader(VIEW, false);
    expect(out.needs_you).toEqual([]);
    expect(out.results_owed).toBe(0);
    expect({ courts: out.courts, fixtures_today: out.fixtures_today }).toEqual({ courts: VIEW.courts, fixtures_today: VIEW.fixtures_today });
    expect(VIEW.needs_you).toHaveLength(2);
    expect(VIEW.results_owed).toBe(3);
  });

  it("the online rounds are every reader's, a hold's reason is not: a reader keeps every row, with the reason blanked and nothing else changed (MD-R21)", () => {
    const online = [{ key: "s:1", division_id: "d-1", round: null, needs_decision: [] }] as unknown as MatchDayView["online_rounds"];
    const withOnline = { ...VIEW, online_rounds: online };
    expect(matchDayForReader(withOnline, true).online_rounds).toBe(online);
    expect(matchDayForReader(withOnline, false).online_rounds, "kept whole, not an emptied copy").toEqual(online);
    expect(matchDayForReader(withOnline, false).online_rounds).toHaveLength(1);
  });

  it("the predicate, per role: owner and admin are organisers; viewer and an API key (role null) are not", () => {
    const want: Record<OrgRole, boolean> = { owner: true, admin: true, viewer: false };
    let checked = 0;
    for (const role of ORG_ROLES) {
      expect(isEditorRole(role), role).toBe(want[role]);
      expect(isEditorRole(role), `${role} agrees with EDITOR_ROLES`).toBe((EDITOR_ROLES as readonly string[]).includes(role));
      const out = matchDayForReader(VIEW, isEditorRole(role));
      expect(out.needs_you.length, role).toBe(want[role] ? 2 : 0);
      checked++;
    }
    expect(checked, "anti-vacuity: every org role").toBe(ORG_ROLES.length);
    expect(isEditorRole(null), "an API key").toBe(false);
  });

  it("fix round 1 (m3): the console pages' canEdit is the SAME predicate — page-auth.ts asks isEditorRole and never re-spells EDITOR_ROLES", () => {
    const src = readFileSync(join(process.cwd(), "src/server/page-auth.ts"), "utf8");
    const asks = src.match(/\bisEditorRole\(/g) ?? [];
    expect(asks.length, "page-auth computes canEdit through isEditorRole").toBeGreaterThan(0);
    expect(src, "no second spelling of the editor set").not.toMatch(/EDITOR_ROLES/);
  });
});

// MD-R21: a held board's reason (`fair_play`, `no_show_white`, ...) is about named players - an organiser's fact, like a flag's evidence (MD-R13).
// `online_rounds` carries it twice: on each `round.boards` entry and on each `needs_decision` entry. Both doors (the page's first paint and the
// route's poll) strip it through this one function, so it is pinned here deterministically; the routes' own tests drive real roles through it.
describe("matchDayForReader - a hold's reason reaches organisers only (MD-R21)", () => {
  const held = (id: string, reason: NeedsReason | null): MatchDayBoardRow =>
    ({
      fixtureId: id,
      boardNo: 1,
      state: reason === null ? { kind: "live", moveNo: 3 } : { kind: "on_hold" },
      flags: [],
      flagCount: 2,
      stage_id: "s-1",
      round_no: 2,
      hold_reason: reason,
    }) as unknown as MatchDayBoardRow;
  const row = (key: string, boards: MatchDayBoardRow[], decision: MatchDayBoardRow[]): MatchDayOnlineRound =>
    ({ key, division_id: "d-1", own_boards: 1, view: null, round: { boards, ownBoards: 1, current: 2 }, needs_decision: decision }) as unknown as MatchDayOnlineRound;
  /** Every board of the rows, the round's own and the decisions' (the round's are `ArbiterBoard`s typed, `MatchDayBoardRow`s on the wire). */
  const allBoards = (rows: MatchDayView["online_rounds"]): MatchDayBoardRow[] => rows.flatMap((r) => [...((r.round?.boards ?? []) as MatchDayBoardRow[]), ...r.needs_decision]);
  const reasonsOf = (rows: MatchDayView["online_rounds"]): (NeedsReason | null | undefined)[] => allBoards(rows).map((b) => b.hold_reason);
  /** One held board per reason of the vocabulary in the round, and one beside it in the decisions: the whole vocabulary on both lists. */
  const FULL: MatchDayView["online_rounds"] = [
    row("s-1:2", [...NEEDS_REASONS.map((r, i) => held(`r-${i}`, r)), held("live", null)], NEEDS_REASONS.map((r, i) => held(`d-${i}`, r))),
  ];
  const withOnline = { ...VIEW, online_rounds: FULL };

  it("a reader gets null for every reason on BOTH lists (the vocabulary swept, not a sample); an organiser gets the very same object", () => {
    expect(matchDayForReader(withOnline, true)).toBe(withOnline);
    const seen = reasonsOf(matchDayForReader(withOnline, false).online_rounds);
    expect(seen.length, "anti-vacuity: boards read").toBe(NEEDS_REASONS.length * 2 + 1);
    expect(seen.every((r) => r === null), "every reason blanked, on round.boards and on needs_decision").toBe(true);
    const wire = JSON.stringify(matchDayForReader(withOnline, false));
    for (const reason of NEEDS_REASONS) expect(wire, `${reason} does not travel`).not.toContain(`"${reason}"`);
    expect(reasonsOf(withOnline.online_rounds).filter((r) => r !== null), "the organiser's own copy still has them all").toHaveLength(NEEDS_REASONS.length * 2);
  });

  it("the round list needs_decision alone, and round.boards alone, are each stripped (one list is not the other's cover)", () => {
    const onlyBoards = { ...VIEW, online_rounds: [row("s-1:2", [held("a", "fair_play")], [])] };
    const onlyDecision = { ...VIEW, online_rounds: [row("s-1:2", [], [held("b", "no_show_white")])] };
    expect(reasonsOf(matchDayForReader(onlyBoards, false).online_rounds)).toEqual([null]);
    expect(reasonsOf(matchDayForReader(onlyDecision, false).online_rounds)).toEqual([null]);
    expect(reasonsOf(matchDayForReader(onlyBoards, true).online_rounds)).toEqual(["fair_play"]);
    expect(reasonsOf(matchDayForReader(onlyDecision, true).online_rounds)).toEqual(["no_show_white"]);
  });

  it("nothing but the reason changes: every other key of every board and of every row is the input's, and the input is not mutated", () => {
    const out = matchDayForReader(withOnline, false);
    const unreasoned = (b: MatchDayBoardRow) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "hold_reason"));
    const boardsOf = (rows: MatchDayView["online_rounds"]) => allBoards(rows).map(unreasoned);
    expect(boardsOf(out.online_rounds)).toEqual(boardsOf(withOnline.online_rounds));
    expect(boardsOf(out.online_rounds).length, "anti-vacuity: boards compared").toBeGreaterThan(0);
    const [before] = withOnline.online_rounds;
    const [after] = out.online_rounds;
    expect({ ...after!, round: null, needs_decision: [] }).toEqual({ ...before!, round: null, needs_decision: [] });
    expect(after!.round!.ownBoards).toBe(before!.round!.ownBoards);
    expect(reasonsOf(withOnline.online_rounds).filter((r) => r !== null), "the input kept its reasons").toHaveLength(NEEDS_REASONS.length * 2);
    expect(matchDayForReader(withOnline, false), "a second strip is the first's answer").toEqual(out);
  });

  it("the empty cases: no online rounds, a round not opened yet (round null), a division with nothing held - and a view that has no online_rounds key at all", () => {
    expect(matchDayForReader({ ...VIEW, online_rounds: [] }, false).online_rounds).toEqual([]);
    const unopened = { ...VIEW, online_rounds: [{ key: "s-1:1", division_id: "d-1", round: null, needs_decision: [], own_boards: 0 }] as unknown as MatchDayView["online_rounds"] };
    expect(matchDayForReader(unopened, false).online_rounds).toEqual(unopened.online_rounds);
    const quiet = { ...VIEW, online_rounds: [row("s-1:2", [held("a", null)], [])] };
    expect(reasonsOf(matchDayForReader(quiet, false).online_rounds)).toEqual([null]);
    expect("online_rounds" in matchDayForReader(VIEW, false), "no key is invented").toBe(false);
  });
});
