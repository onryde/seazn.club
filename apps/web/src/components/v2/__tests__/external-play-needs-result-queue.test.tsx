// T16 — the organiser's "Online play — needs result" queue (canvas
// HoldQueueDesktop / HoldQueuePhone), rendered to markup through the real
// DictProvider in every locale. What it SHOWS: the two lists, a held card's
// title / names by colour / sentence, which controls each card offers, and
// the flagged boards with their own flag cards. The clicks are driven in
// external-play-needs-result-queue-actions.test.tsx; the copy vocabulary in
// external-play-reason-map.test.ts.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { NEEDS_REASONS } from "@/server/external-play/types";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import { ExternalPlayNeedsResultQueue, type ExternalPlayQueueProps, type HeldRow } from "../external-play-needs-result-queue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (h: string) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const SLUGS = { org: "northfield", comp: "autumn-rapid", div: "open" };

function held(over: Partial<HeldRow> & Pick<HeldRow, "fixtureId" | "reason">): HeldRow {
  return {
    homeName: "Rafael Quintero",
    awayName: "Mei Lin Chu",
    whiteSide: "home",
    revokedSeat: null,
    roundNo: 3,
    boardNo: 5,
    stageName: "Open Swiss",
    canResync: false,
    seated: false,
    noNextMatch: false,
    ...over,
  };
}

function flaggedBoard(over: Partial<FlaggedBoard> & Pick<FlaggedBoard, "fixtureId">): FlaggedBoard {
  return {
    fixtureNo: 12,
    boardNo: 3,
    white: { name: "Jonah Mbeki", personId: "p-w" },
    black: { name: "Elif Demirtaş", personId: "p-b" },
    state: { kind: "live" },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    canResync: true,
    playable: true,
    canSettle: true,
    whiteSide: "home",
    tiebreakOwed: false,
    flags: [{ id: "fl-1", kind: "out_of_band_play", at: "2026-10-12T19:38:00.000Z", plies: { from: 51, to: 53 } }],
    roundNo: 3,
    stageName: "Open Swiss",
    ...over,
  } as FlaggedBoard;
}

function render(props: Partial<ExternalPlayQueueProps>, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <ExternalPlayNeedsResultQueue held={[]} flagged={[]} ownFlagged={0} slugs={SLUGS} {...props} />
    </DictProvider>,
  );
}

/** One `<li id="external-play-queue-row-…">` card's markup. */
function card(h: string, fixtureId: string): string {
  const start = h.indexOf(`id="external-play-queue-row-${fixtureId}"`);
  expect(start, `card ${fixtureId} rendered`).toBeGreaterThan(-1);
  const from = h.lastIndexOf("<li", start);
  return h.slice(from, h.indexOf("</li>", start) + 5);
}

const testIds = (h: string, id: string) => h.split(`data-testid="${id}"`).length - 1;

describe("the empty case", () => {
  it("nothing held, nothing flagged, nothing hidden: the queue renders nothing at all", () => {
    expect(render({})).toBe("");
  });

  it("only boards the viewer plays on are flagged: the list says so, and holds no card", () => {
    const h = render({ ownFlagged: 2 });
    expect(text(h)).toContain("2 flagged boards are hidden because you play on them.");
    expect(testIds(h, "external-play-go-on")).toBe(0);
  });
});

describe("a held card", () => {
  it("says what happened, names the players BY COLOUR, and where the board is (canvas: Lichess link revoked, R3 · Board 5)", () => {
    // Away plays White here: the names must follow the colour, not the side.
    const h = card(
      render({ held: [held({ fixtureId: "f1", reason: "token_revoked", revokedSeat: "black", whiteSide: "away", homeName: "Mei Lin Chu", awayName: "Rafael Quintero" })] }),
      "f1",
    );
    const t = text(h);
    expect(t).toContain("Lichess link revoked");
    expect(t).toContain("Round 3 · Board 5");
    expect(t).toContain("Rafael Quintero vs Mei Lin Chu");
    expect(t).toContain(
      "Mei Lin Chu (Black) revoked Seazn's access to their Lichess account. This is not a no-show. The game may still be running on Lichess.",
    );
    expect(t.indexOf("Rafael Quintero vs"), "White first").toBeGreaterThan(-1);
  });

  it("every reason renders its own title in every locale, never a raw key — counted", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const rows = NEEDS_REASONS.map((reason, i) => held({ fixtureId: `f${i}`, reason }));
      const h = render({ held: rows }, locale);
      const titles = [...h.matchAll(/data-testid="external-play-held-title"[^>]*>([^<]*)</g)].map((m) => decode(m[1]!));
      expect(titles, locale).toHaveLength(NEEDS_REASONS.length);
      expect(new Set(titles).size, `${locale}: one title per reason`).toBe(NEEDS_REASONS.length);
      expect(text(h), `${locale}: no raw key`).not.toMatch(/externalPlay\.|arbiter\./);
      checked += titles.length;
    }
    expect(checked).toBe(4 * NEEDS_REASONS.length);
  });

  it("Settle sits behind a toggle with the four outcomes by colour; Resync only when a game is on file", () => {
    const h = render({
      held: [held({ fixtureId: "f1", reason: "aborted", canResync: false }), held({ fixtureId: "f2", reason: "create_outcome_unknown", canResync: true })],
    });
    const one = card(h, "f1");
    expect(testIds(one, "external-play-settle-toggle")).toBe(1);
    expect(one).toContain("<details");
    expect(one, "closed until asked").not.toMatch(/<details[^>]* open/);
    expect([...one.matchAll(/data-settle="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["home_wins", "away_wins", "draw", "no_result"]);
    expect(text(one)).toContain("Rafael Quintero wins");
    expect(text(one)).toContain("Mei Lin Chu wins");
    expect(testIds(one, "external-play-resync"), "no game on file").toBe(0);
    expect(testIds(card(h, "f2"), "external-play-resync"), "a game may be on file").toBe(1);
  });

  // W2b D19: on a bracket line that feeds no next match the server refuses No result (a double walkover) — the
  // row's `noNextMatch` is the server's own reading, and the queue offers exactly what the server takes.
  it("a line that feeds no next match: No result is not offered and the guidance says why — every locale, both ways, counted", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const dict = LOCALES[locale] as Record<string, string>;
      const h = render({ held: [held({ fixtureId: "f1", reason: "not_started", noNextMatch: true }), held({ fixtureId: "f2", reason: "not_started" })] }, locale);
      const refused = card(h, "f1");
      expect([...refused.matchAll(/data-settle="([a-z_]+)"/g)].map((m) => m[1]), locale).toEqual(["home_wins", "away_wins", "draw"]);
      const guide = refused.match(/<p[^>]*data-testid="external-play-settle-no-next-match"[^>]*>(.*?)<\/p>/);
      expect(guide, `${locale}: the guidance renders`).not.toBeNull();
      expect(text(guide![1]!), locale).toBe(dict["arbiter.decide.noNextMatch"]);
      // The pair: a line that feeds a next match keeps all four, and no guidance.
      const offered = card(h, "f2");
      expect([...offered.matchAll(/data-settle="([a-z_]+)"/g)].map((m) => m[1]), locale).toEqual(["home_wins", "away_wins", "draw", "no_result"]);
      expect(offered).not.toContain("external-play-settle-no-next-match");
      checked++;
    }
    expect(checked).toBe(4);
    // A drawn knockout held for its tie-break on such a line: a winner only, no guidance.
    const owed = card(render({ held: [held({ fixtureId: "f1", reason: "tiebreak_owed", noNextMatch: true })] }), "f1");
    expect([...owed.matchAll(/data-settle="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["home_wins", "away_wins"]);
    expect(owed).not.toContain("external-play-settle-no-next-match");
  });

  it("the settle buttons send a SIDE by colour: White's name sends White's side, both ways", () => {
    for (const [whiteSide, white] of [
      ["home", "home_wins"],
      ["away", "away_wins"],
    ] as const) {
      const one = card(render({ held: [held({ fixtureId: "f1", reason: "aborted", whiteSide, homeName: "Hal", awayName: "Ana" })] }), "f1");
      const whiteName = whiteSide === "home" ? "Hal" : "Ana";
      const m = new RegExp(`data-settle="([a-z_]+)"[^>]*>${whiteName} wins<`).exec(one);
      expect(m?.[1], `${whiteSide} plays White`).toBe(white);
    }
  });

  it("a drawn knockout: grouped under its stage, the pick is OPEN with two 'goes through' buttons, no draw and no 'no result'", () => {
    const h = render({ held: [held({ fixtureId: "k1", reason: "tiebreak_owed", stageName: "Junior Cup" })] });
    expect(text(h)).toContain("Knockout draw · Junior Cup");
    const one = card(h, "k1");
    expect(testIds(one, "external-play-settle-toggle"), "no toggle: the pick is the whole card").toBe(0);
    expect(text(one)).toContain("Pick the winner");
    expect([...one.matchAll(/data-settle="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["home_wins", "away_wins"]);
    expect(text(one)).toContain("Rafael Quintero goes through");
    expect(text(one)).toContain("Drawn in a knockout. A knockout needs a winner, and this draw is not recorded as a result.");
  });

  it("C: the organiser who plays on the board sees why, and no control at all", () => {
    const one = card(render({ held: [held({ fixtureId: "f1", reason: "aborted", seated: true, canResync: true })] }), "f1");
    expect(text(one)).toContain("You play on this board, so another organiser must settle it.");
    expect(one).not.toContain("<button");
    expect(testIds(one, "external-play-settle-toggle")).toBe(0);
  });

  it("the invite resend is not offered anywhere on the queue (the server refuses it for every held board)", () => {
    const h = render({ held: NEEDS_REASONS.map((reason, i) => held({ fixtureId: `f${i}`, reason, canResync: true })) });
    expect(testIds(h, "external-play-resend")).toBe(0);
    expect(text(h)).not.toMatch(/resend/i);
  });

  it("the Held count is every held board, knockout draws included", () => {
    const h = render({
      held: [held({ fixtureId: "a", reason: "aborted" }), held({ fixtureId: "b", reason: "tiebreak_owed" }), held({ fixtureId: "c", reason: "fair_play" })],
    });
    expect(text(h)).toContain("Held · 3");
  });
});

describe("the flagged list", () => {
  it("each board: where and how it stands, the names, its flag cards, the arbiter link for THIS board, and 'Let the game go on'", () => {
    const h = render({ flagged: [flaggedBoard({ fixtureId: "fx-9" })] });
    const t = text(h);
    expect(t).toContain("Flagged · the game carried on · 1");
    expect(t).toContain("Flags are evidence for you to review. Nothing happens to a result automatically.");
    expect(t).toContain("Round 3 · Board 3 · live");
    expect(t).toContain("Jonah Mbeki vs Elif Demirtaş");
    expect(t).toContain("3 moves reached Lichess that were not played on Seazn's board (moves 26 to 27).");
    // Typed from the route's contract, not built with the helper.
    expect(h).toContain('href="/o/northfield/c/autumn-rapid/d/open/arbiter?fixture=fx-9"');
    expect(t).toContain("Let the game go on");
  });

  it("a finished game's flags are reviewed, not let go on: the button says 'Mark as reviewed' and the state is the score", () => {
    const h = render({ flagged: [flaggedBoard({ fixtureId: "fx-1", state: { kind: "result", score: "1–0" } })] });
    expect(text(h)).toContain("Round 3 · Board 3 · 1–0");
    expect(text(h)).toContain("Mark as reviewed");
    expect(text(h)).not.toContain("Let the game go on");
  });

  // R4 (T16 fix round 1): a cancelled board's open flags are reviewed too — never "Finished", never "go on".
  it("a CANCELLED board's flags: its state says cancelled, the button says 'Mark as reviewed'", () => {
    const h = render({ flagged: [flaggedBoard({ fixtureId: "fx-1", state: { kind: "cancelled" }, canSettle: false, canResync: false, playable: false })] });
    expect(text(h)).toContain(`Round 3 · Board 3 · ${(en as Record<string, string>)["arbiter.state.cancelled"]}`);
    expect(text(h)).toContain("Mark as reviewed");
    expect(text(h)).not.toContain("Let the game go on");
    expect(text(h)).not.toContain("Finished");
  });

  it("Held and Flagged side by side on desktop, one column below `lg`: one DOM, the grid splits at lg", () => {
    const h = render({ held: [held({ fixtureId: "a", reason: "aborted" })], flagged: [flaggedBoard({ fixtureId: "b" })] });
    expect(h).toMatch(/class="[^"]*\bgrid-cols-1\b[^"]*\blg:grid-cols-\[minmax\(0,3fr\)_minmax\(0,2fr\)\]/);
    expect(h.indexOf('data-testid="external-play-held"')).toBeLessThan(h.indexOf('data-testid="external-play-flagged"'));
  });
});
