// The page's keep of its last online answer (gaps wave A2, final review M5 leftover): a poll whose ONLINE read failed (`online_failed`) carries
// `online_rounds: []` because nothing was read, so taking it whole would close the board panel open on a game, drop the phone to the list
// and make the camera joins leave and join again for one poll. `viewAfterPoll` is the one rule: a failed poll keeps the rounds the page
// had and takes everything else (the courts are answered whole); an ANSWERED poll is taken whole, an empty answer included - a round that
// ended is a round that left, and holding it forever would be the opposite defect.
//
// Where an expected value comes from: the marker's meaning is the type's own sentence (types.ts `online_failed`); the rounds are fixture
// objects compared by identity, so "kept" means the very array the page held. Anti-vacuity: each case counts what it compared.
import { describe, expect, it } from "vitest";
import type { MatchDayView } from "../types";
import { viewAfterPoll } from "../view";
import { checkinRound, onlineView, pairedRound } from "../../../components/v2/match-day/__tests__/_online-fixtures";

const prev = (): MatchDayView => onlineView([checkinRound("stage-1:3"), pairedRound("stage-2:1")], { now: "2026-11-19T18:00:00.000Z" });
const polled = (over: Partial<MatchDayView>): MatchDayView => ({ ...onlineView([], { now: "2026-11-19T18:01:00.000Z" }), ...over });

describe("viewAfterPoll", () => {
  it("a poll whose online read FAILED keeps the rounds the page had and takes the rest of the day from the poll; the marker stays so the page says so", () => {
    const had = prev();
    const next = polled({ online_failed: true, online_rounds: [], results_owed: 4, fixtures_today: 7 });

    const out = viewAfterPoll(had, next);

    expect(out.online_rounds, "the very rounds the page held").toBe(had.online_rounds);
    expect(out.online_rounds, "premise: it held something").toHaveLength(2);
    expect(out.now, "the day itself is the poll's").toBe(next.now);
    expect(out.results_owed).toBe(4);
    expect(out.fixtures_today).toBe(7);
    expect(out.online_failed, "still marked: this poll's online half is stale").toBe(true);
  });

  it("an ANSWERED poll is taken whole - an empty answer too: a round that ended leaves, it is not held for ever", () => {
    const had = prev();
    const empty = polled({ online_failed: false, online_rounds: [] });
    expect(viewAfterPoll(had, empty), "the poll itself").toBe(empty);
    expect(viewAfterPoll(had, empty).online_rounds, "the empty answer is the answer").toEqual([]);
    const fresh = polled({ online_failed: false, online_rounds: [checkinRound("stage-1:4")] });
    expect(viewAfterPoll(had, fresh).online_rounds.map((r) => r.key)).toEqual(["stage-1:4"]);
  });

  it("the sequence: answer, failure, failure, answer - the rounds are held through both failures and replaced by the next answer", () => {
    let page = prev();
    const first = page.online_rounds;
    for (const n of [1, 2]) {
      page = viewAfterPoll(page, polled({ online_failed: true, online_rounds: [], now: `2026-11-19T18:0${n}:00.000Z` }));
      expect(page.online_rounds, `failure ${n} holds the first answer`).toBe(first);
    }
    page = viewAfterPoll(page, polled({ online_failed: false, online_rounds: [pairedRound("stage-2:2")], now: "2026-11-19T18:03:00.000Z" }));
    expect(page.online_rounds.map((r) => r.key)).toEqual(["stage-2:2"]);
    expect(page.online_failed).toBe(false);
  });

  it("a body with no marker at all (a server older than the page) is an answer, taken whole", () => {
    const { online_failed: _gone, ...legacy } = polled({ online_rounds: [checkinRound("stage-1:4")] });
    void _gone;
    const out = viewAfterPoll(prev(), legacy as unknown as MatchDayView);
    expect(out.online_rounds.map((r) => r.key)).toEqual(["stage-1:4"]);
  });

  it("a failed poll when the page holds nothing yet (a first paint that failed) is the poll as it is", () => {
    const first = polled({ online_failed: true, online_rounds: [] });
    const out = viewAfterPoll(onlineView([]), first);
    expect(out.online_rounds).toEqual([]);
    expect(out.online_failed).toBe(true);
  });
});
