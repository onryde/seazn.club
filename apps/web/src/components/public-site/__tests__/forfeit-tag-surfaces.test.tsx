// W2b Task 13 (spec §5.5, UI-2 option A) — each surface that calls `forfeitTag` puts its tag and sentence where it
// says it does: the hub's results card, the hub's draw node, the public bracket tile, the live score's fallback line
// and the organiser's run-sheet result line. `apps/web` vitest is `environment: "node"`, so these are rendered markup
// (what the browser receives); `e2e/walkover-public.spec.ts` drives the same surfaces in a browser at 320/768/1280.
//
// The forfeit outcomes are the engine's shape for each of its reasons (`FORFEIT_REASONS`; forfeit-tag.test.ts folds
// them through real modules); the words are the real public.json / ui.json, never typed here except UI-2's tags.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { FORFEIT_REASONS } from "@seazn/engine/core";
import en from "@/dictionaries/en/public.json";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { msg } from "@/lib/messages";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
import { getDictionary } from "@/lib/i18n";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import type { PublicFixture } from "@/server/public-site/data";
import { hubForfeit } from "@/server/public-site/competition-hub";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { MatchCard } from "../matches-hub/match-card";
import { ForfeitTagChip } from "../forfeit-tag-chip";
import { Bracket } from "../bracket";
import { Schedule } from "../schedule";
import { ResultsMatrix } from "../results-matrix";
import { LiveScoreBody } from "../live-score";
import { outcomeText } from "@/components/v2/stages-panel";
import { resolveSlotLabel } from "@/lib/slot-label";

const DICT = en as unknown as Dict;
const UI = uiEn as Record<string, string>;
const tr = (key: string, vars?: Record<string, string | number>) => t(DICT, key, vars);
const NAMES: Record<string, string> = { h: "Riverside FC", a: "Harbour United", b: "Bears", c: "Cats" };
const award = (reason: string, winner = "h", loser = "a") => ({ kind: "award", winner, loser, reason });
const TAG: Record<string, string> = { walkover: "w/o", withdrew: "w/o", retired: "ret.", disqualified: "DQ" };

/** Escape for a search inside rendered markup: React writes `'` as `&#x27;`. */
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

function fixture(over: Partial<PublicFixture>): PublicFixture {
  return {
    id: "f1", division_id: "d", stage_id: "s", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: "h", away_entrant_id: "a", home_slot_label: null, away_slot_label: null, scheduled_at: null,
    venue: null, court_label: null, venue_name: null, court_name: null, status: "forfeited", outcome: null,
    summary: { headline: "3–0", perSide: [{ entrantId: "h", line: "3" }, { entrantId: "a", line: "0" }] }, last_seq: 1,
    ...over,
  } as PublicFixture;
}

const ctx = (fixtures: PublicFixture[] = [], resultSentence: () => string | null = () => null) => ({
  byId: new Map(fixtures.map((f) => [f.id, f])),
  names: NAMES,
  msg: tr,
  resultSentence,
});

describe("hubForfeit — the hub card's words (the producer)", () => {
  it("empty case first: a played result and a bye carry none", () => {
    expect(hubForfeit(fixture({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" } }), ctx())).toBeNull();
    expect(hubForfeit(fixture({ away_entrant_id: null, outcome: { kind: "award", winner: "h", loser: null, reason: "bye" } as never }), ctx())).toBeNull();
    expect(hubForfeit(fixture({ outcome: null }), ctx())).toBeNull();
  });

  it("X-RS-2: every reason, its tag and a sentence naming the side that did not play on", () => {
    let rows = 0;
    for (const reason of FORFEIT_REASONS) {
      const w = hubForfeit(fixture({ outcome: award(reason) as never }), ctx())!;
      expect(w.tag, reason).toBe(TAG[reason]);
      expect(w.kind).toBe(reason);
      expect(w.sentence, reason).toContain("Harbour United");
      expect(w.sentence, reason).not.toContain("Riverside FC");
      rows++;
    }
    expect(rows).toBe(4);
  });

  it("X-DW-1: the next-round clause comes from the division's own next fixture, and only when the line feeds it", () => {
    const next = fixture({ id: "fin", home_entrant_id: "b", away_entrant_id: null, outcome: award("walkover", "b", null as never) as never });
    const dw = fixture({ outcome: { kind: "double_walkover" } as never, winner_to_fixture: "fin", loser_to_fixture: null });
    expect(hubForfeit(dw, ctx([dw, next]))!.sentence).toBe("Neither side turned up — both lose. Next round: walkover for Bears");
    // A final (feeds nothing): no clause. A next match still waiting: no clause.
    const final = fixture({ outcome: { kind: "double_walkover" } as never, winner_to_fixture: null, loser_to_fixture: null });
    expect(hubForfeit(final, ctx([final]))!.sentence).toBe("Neither side turned up — both lose");
    const waiting = fixture({ id: "fin", outcome: null, status: "scheduled" });
    expect(hubForfeit(dw, ctx([dw, waiting]))!.sentence).toBe("Neither side turned up — both lose");
    // D19 (`feedsNextMatch`): a line whose winner AND loser both go to the same match (a two-entrant double elim's
    // winners' match into the grand final) feeds no NEXT match — even with that match walked over, no clause.
    const both = fixture({ outcome: { kind: "double_walkover" } as never, winner_to_fixture: "fin", loser_to_fixture: "fin" });
    expect(hubForfeit(both, ctx([both, next]))!.sentence).toBe("Neither side turned up — both lose");
  });

  it("X-AB-2: an abandon's words read the ledger column, and carry the card's own result sentence", () => {
    const dls = fixture({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a", method: "dls" } });
    expect(hubForfeit(dls, ctx()), "no abandon in the ledger: a played DLS result").toBeNull();
    const w = hubForfeit({ ...dls, abandon_reason: "rain" }, ctx([], () => "Riverside FC won by 12 runs (DLS)"))!;
    expect(w.tag).toBe("Aband. · DLS");
    expect(w.sentence).toBe("Abandoned (rain) — Riverside FC won by 12 runs (DLS)");
  });

  it("M-2: a HELD abandon (status abandoned, a level result owed a settle) carries no result — the card never reads finished", () => {
    const level = fixture({ outcome: { kind: "no_result" } as never, abandon_reason: "rain" });
    const result = () => tr("matchCentre.result.no_result");
    const held = hubForfeit({ ...level, status: "abandoned" }, ctx([], result))!;
    expect(held.sentence).toBe(tr("forfeit.sentence.abandonedBare", { reason: "rain" }));
    // the positive pair: the same no-result DECIDED (a table stage) is the match's result, and says so
    const decided = hubForfeit({ ...level, status: "decided" }, ctx([], result))!;
    expect(decided.sentence).toBe(tr("forfeit.sentence.abandoned", { reason: "rain", result: result() }));
  });
});

// ---------------------------------------------------------------- the results card

function header(over: Partial<MatchCentreHeaderT> = {}): MatchCentreHeaderT {
  return {
    live: false, status: "other",
    sides: [
      { entrantId: "h", name: "Riverside FC", short: "RIV", colour: null, badgeUrl: null },
      { entrantId: "a", name: "Harbour United", short: "HAR", colour: null, badgeUrl: null },
    ],
    scoreLines: ["3", "0"], subLines: [null, null], battingIndex: null,
    statusLine: { key: "matchCentre.status.forfeited" }, rateLine: null, phase: null, strength: null, pillNote: null,
    metaLine: null, updatedAt: "2026-10-09T12:00:00.000Z", ...over,
  };
}
function hubMatch(over: Partial<HubMatchT> = {}): HubMatchT {
  return {
    fixtureId: "f1", divisionId: "d1", divisionSlug: "d", divisionName: "Division", sportKey: "football",
    stageName: "Cup", roundNo: 1, roundLabel: null, bucket: "completed", tz: "UTC", scheduledAt: null,
    venueName: null, courtName: null, href: "/x/f1", header: header(), winnerIndex: 0, resultLine: null, ...over,
  };
}
const card = (m: HubMatchT) => renderToStaticMarkup(createElement(MatchCard, { match: m, dict: DICT, locale: "en", now: 0 }));

describe("MatchCard — the results list (the consumer)", () => {
  it("empty case first: no forfeit, no tag — the status line reads as before", () => {
    const h = card(hubMatch());
    expect(h).not.toContain('role="img"');
    expect(h).toContain(">Forfeited<");
    expect(h).not.toContain("aria-describedby");
  });

  it("the tag is shown, its accessible name and tooltip are the sentence, and the card is described by it", () => {
    const sentence = "Harbour United didn't turn up — walkover";
    const h = card(hubMatch({ forfeit: { kind: "walkover", tag: "w/o", sentence } }));
    expect(h).toContain(`role="img" aria-label="${html(sentence)}" title="${html(sentence)}"`);
    expect(h).toMatch(/data-testid="mh-match-forfeit-tag"[^>]*>w\/o<\/span>/);
    expect(h).toContain('aria-describedby="mh-forfeit-f1"');
    expect(h).toContain('id="mh-forfeit-f1"');
    expect(h, "the tag replaces the bare status word").not.toContain(">Forfeited<");
  });

  // Design audit 3.7: the result line already names the method ("… (DLS)", "No result"), so the tag beside it is the
  // bare abandon word — "Aband. · DLS" after "(DLS)" said DLS twice in one row. The words are the dictionary's (the
  // card's own tag word, `forfeit.tag.abandoned`); with no result line (a held abandon) the full tag stays.
  it("audit 3.7: an abandon keeps its result sentence, and the tag beside it does not repeat the method", () => {
    const bare = tr("forfeit.tag.abandoned");
    let checked = 0;
    for (const [kind, full, line] of [
      ["abandoned_dls", tr("forfeit.tag.abandonedDls"), tr("matchCentre.result.dlsRuns.other", { winner: "Riverside FC", runs: 12 })],
      ["abandoned_no_result", tr("forfeit.tag.abandonedNoResult"), tr("matchCentre.result.no_result")],
    ] as const) {
      expect(full.startsWith(bare) && full !== bare, `premise: ${kind}'s tag is the abandon word plus its method`).toBe(true);
      const h = card(hubMatch({ resultLine: line, forfeit: { kind, tag: full, sentence: "S" } }));
      const slot = h.slice(h.indexOf('data-testid="mh-match-forfeit"'));
      expect(slot, kind).toContain(html(line));
      expect(slot, `${kind}: the bare abandon word`).toMatch(new RegExp(`data-testid="mh-match-forfeit-tag"[^>]*>${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`));
      expect(slot, `${kind}: not the method twice`).not.toContain(`>${html(full)}<`);
      // The pair: a held abandon has no result line, and keeps the full tag.
      const held = card(hubMatch({ resultLine: null, forfeit: { kind, tag: full, sentence: "S" } }));
      expect(held, `${kind}, no result line: the full tag`).toContain(`>${html(full)}<`);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// Design audit 3.8: in the 264px card at 320 a long result ("… won by an innings and 12 runs") beside the tag could
// not wrap — the slot was `shrink-0` — and painted past the card's edge. The card's own wrap discipline: the sentence
// is `min-w-0` and wraps; only the tag (and a score inside the sentence) keeps `shrink-0`/`nowrap`. The plain result
// line (no tag) had the same `shrink-0` and takes the same rule. Classes read off the rendered markup; the geometry
// at 320 is walkover-public's (a 43-character name's "… won" beside "Aband.").
describe("MatchCard — a long result wraps inside the card (audit 3.8)", () => {
  const classOf = (h: string, testId: string) => new Set((new RegExp(`data-testid="${testId}" class="([^"]*)"`).exec(h)?.[1] ?? "").split(/\s+/u));
  it("the forfeit slot and the plain result line shrink and wrap; the tag alone stays whole", () => {
    const line = "Riverside Athletic Football Club Under-21 A won by an innings and 12 runs";
    const tagged = card(hubMatch({ resultLine: line, forfeit: { kind: "abandoned", tag: "Aband.", sentence: "S" } }));
    const slot = classOf(tagged, "mh-match-forfeit");
    expect(slot.has("shrink-0"), "the forfeit slot may shrink").toBe(false);
    expect(slot.has("min-w-0"), "the forfeit slot's min-w-0").toBe(true);
    const sentence = new RegExp(`<span class="([^"]*)">${line}</span>`).exec(tagged)?.[1];
    expect(sentence, "the sentence has its own wrapping box").toBeDefined();
    for (const token of ["min-w-0", "break-words"]) expect(new Set(sentence!.split(/\s+/u)).has(token), `the sentence's ${token}`).toBe(true);
    expect(classOf(tagged, "mh-match-forfeit-tag").has("shrink-0"), "the tag stays whole").toBe(true);
    const plain = classOf(card(hubMatch({ resultLine: line, header: header({ statusLine: null }) })), "mh-match-result");
    expect(plain.has("shrink-0"), "the plain result line may shrink").toBe(false);
    for (const token of ["min-w-0", "break-words"]) expect(plain.has(token), `the plain result's ${token}`).toBe(true);
  });
});

// ---------------------------------------------------------------- the bracket tile

describe("Bracket — the tile at every width has ONE footer row (the consumer)", () => {
  const boardText = (_stageId: string, label: never) => resolveSlotLabel(label, msg, "schedule.tbd");
  const render = async (fixtures: PublicFixture[], withForfeit = true) => {
    const dict = await getDictionary("en", "public");
    const copy = publicScheduleCopy(dict, msg);
    return renderToStaticMarkup(
      createElement(Bracket, {
        kind: "knockout", fixtures, entrantNames: NAMES, fixtureHref: (id: string) => `/f/${id}`, lookup: msg,
        slotText: boardText, copy: withForfeit ? { ...copy, forfeit: forfeitCopyOf((k) => t(dict, k)) } : copy,
        tz: "UTC", locale: "en",
      }),
    );
  };
  const two = (semi: Partial<PublicFixture>) => [
    fixture({ id: "s1", round_no: 0, seq_in_round: 1, winner_to_fixture: "fin", winner_to_slot: 0, ...semi }),
    fixture({ id: "s2", round_no: 0, seq_in_round: 2, home_entrant_id: "b", away_entrant_id: "c", status: "decided", outcome: { kind: "win", winner: "b", loser: "c" }, winner_to_fixture: "fin", winner_to_slot: 1 }),
    fixture({ id: "fin", round_no: 1, seq_in_round: 1, home_entrant_id: null, away_entrant_id: "b", status: "scheduled", outcome: null, summary: null }),
  ];

  it("the forfeit tile shows the credited score and the tag on one row; the sentence is the tag's name", async () => {
    const h = await render(two({ outcome: award("withdrew") as never }));
    const row = h.slice(h.indexOf('data-testid="bracket-forfeit"'), h.indexOf('data-testid="bracket-forfeit"') + 900);
    expect(row).toContain("3–0");
    expect(row).toContain(">w/o<");
    expect(row).toContain(`aria-label="${html("Harbour United withdrew — walkover")}"`);
    expect(h.match(/data-testid="bracket-forfeit-tag"/g)?.length, "only the forfeited tile").toBe(1);
  });

  it("X-DW-1 on a tile: the double walkover names the next round's walkover once the final stands walked over", async () => {
    const fx = two({ outcome: { kind: "double_walkover" } as never });
    fx[2] = { ...fx[2]!, status: "forfeited", outcome: award("walkover", "b", null as never) as never };
    const h = await render(fx);
    expect(h).toContain(`aria-label="${html("Neither side turned up — both lose. Next round: walkover for Bears")}"`);
    expect(h).toContain(">2× w/o<");
  });

  it("the positive pair: a caller that hands no forfeit copy shows no tag (the old footer)", async () => {
    const h = await render(two({ outcome: award("walkover") as never }), false);
    expect(h).not.toContain("bracket-forfeit");
    expect(h).toContain("3–0");
  });
});

// ---------------------------------------------------------------- the schedule tab (review I-2)

// The division page's DEFAULT tab and the embed schedule widget. Before fix round 1 a forfeited row read its time (or
// TBD) in the rail as if it were still to be played, carried no tag, and a double walkover's "0 — 0" headline read as
// an unplayed match.
describe("Schedule — a forfeited row reads Ended, its credited score and its tag (T13 review I-2)", () => {
  const render = async (fixtures: PublicFixture[], withForfeit = true) => {
    const dict = await getDictionary("en", "public");
    const copy = publicScheduleCopy(dict, msg);
    return renderToStaticMarkup(
      createElement(Schedule, {
        fixtures, entrantNames: NAMES, divisionPath: "/d", tz: "UTC", slotLabels: {}, roundLabels: {}, stageOrder: {},
        stageNames: {}, copy: withForfeit ? { ...copy, forfeit: forfeitCopyOf((k) => t(dict, k)) } : copy, locale: "en",
      }),
    );
  };
  /** One row (a link) by its fixture href. */
  const rowOf = (h: string, id: string) => {
    const at = h.indexOf(`href="/d/fixtures/${id}"`);
    expect(at, `row ${id}`).toBeGreaterThan(-1);
    return h.slice(at, h.indexOf("</a>", at));
  };
  const ENDED = en["matchesHub.ended"];

  it("empty case first: a played decided row has no tag (and reads Ended, as before)", async () => {
    const h = await render([fixture({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" } as never, scheduled_at: "2026-09-25T09:00:00.000Z" })]);
    expect(rowOf(h, "f1")).toContain(`>${ENDED}<`);
    expect(rowOf(h, "f1")).not.toContain('role="img"');
  });

  it("every forfeit reason, either seat winning: Ended, the credited score, and the tag on the WINNER's row named by the sentence", async () => {
    let checked = 0;
    for (const reason of FORFEIT_REASONS) {
      for (const [winner, loser] of [["h", "a"], ["a", "h"]] as const) {
        const credited = { headline: "3–0", perSide: [{ entrantId: winner, line: "3" }, { entrantId: loser, line: "0" }] };
        const fx = fixture({ outcome: award(reason, winner, loser) as never, summary: credited as never, scheduled_at: "2026-09-25T09:00:00.000Z" });
        const row = rowOf(await render([fx]), "f1");
        const tag = `${reason}, ${NAMES[winner]} won`;
        expect(row, tag).toContain(`>${ENDED}<`);
        expect(row, `${tag}: not the kickoff time`).not.toContain(">09:00<");
        const sentence = tr(`forfeit.sentence.${reason}`, { loser: NAMES[loser]! });
        const chip = new RegExp(`role="img" aria-label="${html(sentence).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)<`).exec(row);
        expect(chip?.[1], `${tag}: the tag, named by "${sentence}"`).toBe(TAG[reason]);
        // The rows split at the away name's cell: the tag sits in the winner's half only, before its own 3.
        const [homeHalf, awayHalf] = row.split('title="Harbour United"');
        const [win, lose] = winner === "h" ? [homeHalf!, awayHalf!] : [awayHalf!, homeHalf!];
        expect(win, `${tag}: the winner's row carries the tag`).toMatch(/role="img"[^]*>3<\/span>/);
        expect(lose, `${tag}: the loser's row does not`).not.toContain('role="img"');
        checked++;
      }
    }
    expect(checked).toBe(FORFEIT_REASONS.length * 2);
  });

  it("R116-2: ruling 116's walkover over her dead seat stacks its credited score like any walkover, either seat", async () => {
    // Her seat is empty (she withdrew after winning in, X-WD-3); the award names her, and its stored summary keys her
    // line by her id. The row must read as the ordinary walkover above — not fall back to the headline chip.
    let checked = 0;
    for (const [winner, her] of [["h", "a"], ["a", "h"]] as const) {
      const credited = { headline: "3–0", perSide: [{ entrantId: winner, line: "3" }, { entrantId: her, line: "0" }] };
      const fx = fixture({
        [her === "h" ? "home_entrant_id" : "away_entrant_id"]: null,
        outcome: award("withdrew", winner, her) as never,
        summary: credited as never,
      });
      const row = rowOf(await render([fx]), "f1");
      const what = `her ${her === "h" ? "home" : "away"} seat`;
      const [homeHalf, awayHalf] = row.split('title="Harbour United"');
      const [win, lose] = winner === "h" ? [homeHalf!, awayHalf!] : [awayHalf!, homeHalf!];
      expect(win, `${what}: the winner's row carries the tag before its credit`).toMatch(/role="img"[^]*>3<\/span>/);
      expect(lose, `${what}: her row shows nil`).toMatch(/>0<\/span>/);
      expect(lose, `${what}: and no tag`).not.toContain('role="img"');
      expect(row, `${what}: not the headline chip of a row with no lines`).not.toContain(">3–0<");
      checked++;
    }
    expect(checked).toBe(2);
    // The positive pair: a genuine bye has nobody to credit and no score — no line, no headline, no tag.
    const bye = fixture({ away_entrant_id: null, outcome: { kind: "award", winner: "h", loser: null, reason: "bye" } as never, summary: null });
    const byeRow = rowOf(await render([bye]), "f1");
    expect(byeRow).not.toMatch(/>\d+<\/span>/);
    expect(byeRow).not.toContain('role="img"');
  });

  it("a double walkover reads Ended and its 2× w/o tag — never an unplayed 0 — 0", async () => {
    const dw = fixture({ outcome: { kind: "double_walkover" } as never, summary: { headline: "0 — 0", perSide: [{ entrantId: "h", line: "0" }, { entrantId: "a", line: "0" }] } as never });
    const row = rowOf(await render([dw]), "f1");
    expect(row).toContain(`>${ENDED}<`);
    expect(row).toContain(">2× w/o<");
    expect(row).toContain(`aria-label="${html(tr("forfeit.sentence.doubleWalkover"))}"`);
    expect(row).not.toContain("0 — 0");
    expect(row).not.toMatch(/>0<\/span>/);
  });

  // Design audit 3.3: a forfeited row with no per-side lines (a line too long for the score column — cricket's
  // "120/3 (20)") shows its credited headline. Every other decided row in this list shows a headline as the accent
  // pill; this one read as plain text. The pill's classes are read off a played row's own headline in the same list,
  // never retyped here.
  it("audit 3.3: a forfeited row's credited headline wears the list's own headline pill", async () => {
    const long = { headline: "120/3 – 0/0", perSide: [{ entrantId: "h", line: "120/3 (20)" }, { entrantId: "a", line: "0/0 (0)" }] };
    const h = await render([
      fixture({ id: "p1", status: "decided", outcome: { kind: "win", winner: "h", loser: "a" } as never, summary: long as never }),
      fixture({ id: "f1", outcome: award("walkover") as never, summary: long as never }),
    ]);
    const pill = /<span class="([^"]*)">120\/3 – 0\/0<\/span>/.exec(rowOf(h, "p1"))?.[1];
    expect(pill, "premise: a played row with no per-side lines shows its headline pill").toContain("bg-accent-soft");
    const forfeited = /<span class="([^"]*)">120\/3 – 0\/0<\/span>/.exec(rowOf(h, "f1"))?.[1];
    expect(forfeited, "the forfeited row's headline, beside its tag").toBeDefined();
    expect(new Set(forfeited!.split(/\s+/u)), "the same pill as the played row's").toEqual(new Set(pill!.split(/\s+/u).filter((c) => !c.startsWith("row-span") && !c.startsWith("self-"))));
    expect(rowOf(h, "f1")).toContain(">w/o<");
  });

  it("the positive pair: a caller that hands no forfeit copy shows no tag", async () => {
    const row = rowOf(await render([fixture({ outcome: award("walkover") as never })], false), "f1");
    expect(row).not.toContain('role="img"');
    expect(row).toContain(`>${ENDED}<`);
  });
});

describe("ResultsMatrix — a forfeited cell carries its tag (T13 review I-2)", () => {
  const render = (fixtures: PublicFixture[]) =>
    renderToStaticMarkup(
      createElement(ResultsMatrix, { entrantIds: ["h", "a"], entrantNames: NAMES, fixtures, fixtureHref: (id: string) => `/f/${id}`, dict: DICT }),
    );
  it("empty case first: a played result's cell is its headline alone", () => {
    const h = render([fixture({ status: "decided", outcome: { kind: "win", winner: "h", loser: "a" } as never })]);
    expect(h).toContain(">3–0</a>");
    expect(h).not.toContain('role="img"');
  });
  it("a walkover's cell: the credited headline and the w/o tag, named by the sentence", () => {
    const h = render([fixture({ outcome: award("walkover") as never })]);
    expect(h).toContain("3–0");
    expect(h).toContain(`aria-label="${html(tr("forfeit.sentence.walkover", { loser: "Harbour United" }))}"`);
    expect(h).toMatch(/role="img"[^>]*>w\/o</);
  });
  it("a double walkover's cell: the 2× w/o tag, never an unplayed 0 — 0", () => {
    const h = render([fixture({ outcome: { kind: "double_walkover" } as never, summary: { headline: "0 — 0" } as never })]);
    expect(h).toContain(">2× w/o<");
    expect(h).not.toContain("0 — 0");
  });
});

// ---------------------------------------------------------------- the live score

describe("LiveScoreBody — the fallback line (no document)", () => {
  const templates = { tie: "", plain: "{winner} won", shootoutPlain: "", byMethod: {} };
  it("a forfeit reads its sentence, not the bare winner line; a played win keeps its own", () => {
    const forfeit = renderToStaticMarkup(
      createElement(LiveScoreBody, {
        data: { status: "forfeited", summary: { headline: "3 – 0" }, outcome: award("retired") },
        entrantNames: NAMES, sportKey: "tennis", decidedTemplates: templates, dict: DICT,
      }),
    );
    expect(forfeit).toContain("Harbour United retired");
    const played = renderToStaticMarkup(
      createElement(LiveScoreBody, {
        data: { status: "decided", summary: { headline: "2 – 1" }, outcome: { kind: "win", winner: "h", loser: "a" } },
        entrantNames: NAMES, sportKey: "tennis", decidedTemplates: templates, dict: DICT,
      }),
    );
    expect(played).toContain("Riverside FC won");
    expect(played).not.toContain("retired");
  });
});

// ---------------------------------------------------------------- the organiser's run sheet

describe("outcomeText — the division result line (stages-panel, read by the run sheet)", () => {
  const ui = (key: string, vars?: Record<string, string | number>) => msg(key as never, vars);
  it("empty case first: no outcome is no line; a played win reads as before", () => {
    expect(outcomeText(ui, null, NAMES)).toBeNull();
    expect(outcomeText(ui, { kind: "win", winner: "h" }, NAMES)).toBe("Riverside FC won");
  });
  it("each forfeit reason carries its tag; a double walkover reads its tag (it read nothing before); a bye keeps today's copy", () => {
    let rows = 0;
    for (const reason of FORFEIT_REASONS) {
      expect(outcomeText(ui, award(reason), NAMES), reason).toBe(`Riverside FC won (${TAG[reason]})`);
      rows++;
    }
    expect(rows).toBe(4);
    expect(outcomeText(ui, { kind: "double_walkover" }, NAMES)).toBe(UI["forfeit.tag.doubleWalkover"]);
    expect(outcomeText(ui, { kind: "award", winner: "h", loser: null, reason: "bye" }, NAMES)).toBe(
      UI["schedule.outcome.wonWo"]!.replace("{name}", "Riverside FC"),
    );
  });
  it("X-AB-2: an abandon's tag reads the row's ledger — none without it", () => {
    const dls = { kind: "win", winner: "h", loser: "a", method: "dls" };
    expect(outcomeText(ui, dls, NAMES)).toBe("Riverside FC won");
    expect(outcomeText(ui, dls, NAMES, { abandon: { reason: "rain" } })).toBe("Riverside FC won (Aband. · DLS)");
    expect(outcomeText(ui, { kind: "no_result" }, NAMES, { abandon: { reason: "rain" } })).toBe(
      `${UI["schedule.outcome.noResult"]} · ${UI["forfeit.tag.abandonedNoResult"]}`,
    );
  });
});

// ---------------------------------------------------------------- design audit round

// Design audit 3.2: the tag is one of the public site's small neutral status tags, so it takes their shape — the pill
// (`rounded-full px-2 py-0.5 text-[11px] font-semibold`) the seed chip wears in the SAME colours (teams-tab.tsx), not a
// one-off 4px-cornered `rounded px-1 py-px`.
describe("ForfeitTagChip — the house pill (audit 3.2)", () => {
  it("the seed chip's pill shape and colours; none of the one-off shape", () => {
    const h = renderToStaticMarkup(createElement(ForfeitTagChip, { tag: "w/o", sentence: "S" }));
    const cls = new Set((/class="([^"]*)"/.exec(h)?.[1] ?? "").split(/\s+/u));
    for (const token of ["rounded-full", "px-2", "py-0.5", "text-[11px]", "font-semibold", "bg-zinc-100", "text-ink-muted", "whitespace-nowrap", "shrink-0"]) {
      expect(cls.has(token), `the pill's ${token}`).toBe(true);
    }
    for (const token of ["rounded", "px-1", "py-px"]) expect(cls.has(token), `no one-off ${token}`).toBe(false);
  });
});
