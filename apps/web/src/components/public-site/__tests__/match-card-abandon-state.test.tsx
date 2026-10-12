// W2b loop H F4 — the hub's results card said "ENDED" over a football final abandoned for replay (outcome none, the
// "Aband." tag below it): a match flagged to be played again is not over. The card's status slot now reads the SAME
// reader its tag does — `hubForfeit` → `forfeitTag` over the outcome and the LEDGER (`abandon_reason`, the active
// abandon) — never the fixture status (X-AB-2): an abandon that left no winner reads the match centre's own word,
// "Abandoned"; an abandon that decided a winner (DLS, the award policy's leader) ended, and still says so.
//
// The producer is the real `hubForfeit`; the consumer the real `MatchCard`. Words are the real en public.json.
// single-sport: the slot reads the outcome and the ledger alone; no sport is consulted on the way.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import type { PublicFixture } from "@/server/public-site/data";
import { hubForfeit } from "@/server/public-site/competition-hub";
import { bucketFixture, type MatchBucket } from "@/lib/matches-hub";
import { MatchCard } from "../matches-hub/match-card";

const DICT = en as unknown as Dict;
const tr = (key: string, vars?: Record<string, string | number>) => t(DICT, key, vars);
const ENDED = tr("matchesHub.ended");
const ABANDONED = tr("matchCentre.status.abandoned");
const LIVE = tr("matchesHub.live");

function fixture(over: Partial<PublicFixture>): PublicFixture {
  return {
    id: "f1", division_id: "d", stage_id: "s", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: "h", away_entrant_id: "a", home_slot_label: null, away_slot_label: null, scheduled_at: null,
    venue: null, court_label: null, venue_name: null, court_name: null, status: "decided", outcome: null,
    summary: { headline: "1–0", perSide: [{ entrantId: "h", line: "1" }, { entrantId: "a", line: "0" }] }, last_seq: 4,
    abandon_reason: null,
    ...over,
  } as PublicFixture;
}

function header(): MatchCentreHeaderT {
  return {
    live: false, status: "other",
    sides: [
      { entrantId: "h", name: "Riverside Athletic FC", short: "RIV", colour: null, badgeUrl: null },
      { entrantId: "a", name: "Bears of Brockley", short: "BEA", colour: null, badgeUrl: null },
    ],
    scoreLines: ["1", "0"], subLines: [null, null], battingIndex: null,
    statusLine: { key: "matchCentre.status.abandoned" }, rateLine: null, phase: null, strength: null, pillNote: null,
    metaLine: null, updatedAt: "2026-10-12T12:00:00.000Z",
  };
}

/** The card for a fixture, its `forfeit` from the real producer; `winnerIndex` as the builder reads it off the outcome. */
function card(f: PublicFixture, bucket: MatchBucket = bucketFixture(f.status)): string {
  const winner = (f.outcome as { winner?: string } | null)?.winner ?? null;
  const m: HubMatchT = {
    fixtureId: f.id, divisionId: "d1", divisionSlug: "d", divisionName: "Division", sportKey: "football",
    stageName: "Cup", roundNo: 1, roundLabel: null, bucket, tz: "UTC", scheduledAt: null,
    venueName: null, courtName: null, href: "/x/f1", header: header(),
    winnerIndex: winner === null ? null : winner === "h" ? 0 : 1,
    resultLine: null,
    forfeit: hubForfeit(f, { byId: new Map(), names: { h: "Riverside Athletic FC", a: "Bears of Brockley" }, msg: tr, resultSentence: () => null }),
  };
  return renderToStaticMarkup(createElement(MatchCard, { match: m, dict: DICT, locale: "en", now: 0 }));
}

/** The meta row's right-hand status slot: the `ml-auto shrink-0` span's text. */
function slot(html: string): string {
  const m = /<span class="ml-auto shrink-0">(.*?)<\/span><\/div>/.exec(html);
  expect(m, "the card renders its status slot").not.toBeNull();
  return m![1]!.replace(/<[^>]+>/g, "");
}

describe("the hub results card's status slot reads the abandon from the ledger (loop H F4)", () => {
  it("empty case first: a played result, a walkover and a DLS abandon with a winner all read Ended", () => {
    const ROWS: [string, PublicFixture][] = [
      ["a played win", fixture({ outcome: { kind: "win", winner: "h", loser: "a" } })],
      ["a walkover", fixture({ status: "forfeited", outcome: { kind: "award", winner: "h", loser: "a", reason: "walkover" } as never })],
      ["a DLS abandon (a winner)", fixture({ outcome: { kind: "win", winner: "h", loser: "a", method: "dls" } as never, abandon_reason: "rain" })],
      ["the award policy's leader", fixture({ outcome: { kind: "win", winner: "h", loser: "a", method: "abandoned" } as never, abandon_reason: "rain" })],
    ];
    let checked = 0;
    for (const [name, f] of ROWS) {
      expect(bucketFixture(f.status), `${name}: premise, a completed card`).toBe("completed");
      expect(slot(card(f)), name).toBe(ENDED);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("an abandon that left no winner reads Abandoned: flagged for replay, a held level abandon, a level and a no-result abandon", () => {
    const ROWS: [string, PublicFixture][] = [
      ["the replay final (no outcome)", fixture({ status: "abandoned", outcome: null, abandon_reason: "rain" })],
      ["a held level abandon", fixture({ status: "abandoned", outcome: { kind: "draw" } as never, abandon_reason: "rain" })],
      ["a level abandon", fixture({ outcome: { kind: "draw" } as never, abandon_reason: "floodlights" })],
      ["a no-result abandon", fixture({ outcome: { kind: "no_result" } as never, abandon_reason: "rain" })],
    ];
    let checked = 0;
    for (const [name, f] of ROWS) {
      expect(bucketFixture(f.status), `${name}: premise, a completed card`).toBe("completed");
      const h = card(f);
      expect(slot(h), name).toBe(ABANDONED);
      expect(h, `${name}: never Ended`).not.toContain(`>${ENDED}<`);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("X-AB-2: the LEDGER decides, not the status — a stored `abandoned` with no active abandon reads as it always has", () => {
    // An expunged abandon (a withdrawal took the match out of the table, D5) or a legacy row: the reader tags nothing.
    const f = fixture({ status: "abandoned", outcome: null, abandon_reason: null });
    expect(hubForfeit(f, { byId: new Map(), names: {}, msg: tr, resultSentence: () => null }), "premise: no tag").toBeNull();
    expect(slot(card(f))).toBe(ENDED);
  });

  it("the other buckets keep their own slot: a live card reads Live, an upcoming one its time or TBD", () => {
    const live = card(fixture({ status: "in_play", outcome: null }), "live");
    expect(slot(live)).toBe(LIVE);
    const upcoming = card(fixture({ status: "scheduled", outcome: null }), "upcoming");
    expect(slot(upcoming)).toBe(tr("matchesHub.timeTbd"));
  });
});
