// T16 — the organiser's "Online play: needs result" queue (canvas
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
import { routes } from "@/lib/routes";
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
    noResultOffer: { kind: "void" },
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
      <ExternalPlayNeedsResultQueue held={[]} flagged={[]} ownFlagged={0} {...props} />
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

  it("final re-review P11 (2): an account change names the re-linked seat's player by colour, in every locale — counted", () => {
    // Home plays Black here, so the name must follow the colour V454 recorded, not the side.
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const h = card(
        render({ held: [held({ fixtureId: "f1", reason: "account_changed", revokedSeat: "black", whiteSide: "away", homeName: "Mei Lin Chu", awayName: "Rafael Quintero" })] }, locale),
        "f1",
      );
      const t = text(h);
      expect(t, locale).toContain("Mei Lin Chu (");
      expect(t, `${locale}: not White's player`).not.toContain("Rafael Quintero (");
      expect(t, `${locale}: no raw slot or key`).not.toMatch(/\{name\}|externalPlay\./);
      checked++;
    }
    expect(checked).toBe(4);
    const en = text(card(render({ held: [held({ fixtureId: "f1", reason: "account_changed", revokedSeat: "black", whiteSide: "away", homeName: "Mei Lin Chu", awayName: "Rafael Quintero" })] }), "f1"));
    expect(en).toContain(
      "Mei Lin Chu (Black) linked a different Lichess account during this game, so their moves can no longer be made from Seazn. The game may still be running on Lichess.",
    );
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

  // I-3: where the server refuses No result — any knockout, and a Swiss (fix round 3) — the row's `noResultOffer` is the
  // server's own reading, and the queue offers exactly what the server takes.
  it("a refused No result (knockout, Swiss): not offered, and the guidance says why — each refusal, every locale, both ways, counted", () => {
    // The sentence for each refusal, typed from the rulings (never the component's own map).
    const SENTENCE = { knockout: "arbiter.decide.knockoutNeedsWinner", swiss: "arbiter.decide.swissNeedsResult" } as const;
    const settles = (h: string) => [...h.matchAll(/data-settle="([a-z_]+)"/g)].map((m) => m[1]);
    let checked = 0;
    for (const why of ["knockout", "swiss"] as const) {
      const offer = { kind: "refused" as const, why };
      for (const locale of Object.keys(LOCALES) as Locale[]) {
        const dict = LOCALES[locale] as Record<string, string>;
        const h = render({ held: [held({ fixtureId: "f1", reason: "not_started", noResultOffer: offer }), held({ fixtureId: "f2", reason: "not_started" })] }, locale);
        const refused = card(h, "f1");
        expect(settles(refused), `${why}, ${locale}`).toEqual(["home_wins", "away_wins", "draw"]);
        const guide = refused.match(/<p[^>]*data-testid="external-play-settle-guidance"[^>]*data-why="([a-z]+)"[^>]*>(.*?)<\/p>/);
        expect(guide, `${why}, ${locale}: the guidance renders`).not.toBeNull();
        expect(guide![1], `${why}, ${locale}`).toBe(why);
        expect(text(guide![2]!), `${why}, ${locale}`).toBe(dict[SENTENCE[why]]);
        // The pair: a board where the void is offered keeps all four, and no guidance.
        const offered = card(h, "f2");
        expect(settles(offered), `${why}, ${locale}`).toEqual(["home_wins", "away_wins", "draw", "no_result"]);
        expect(offered).not.toContain("external-play-settle-guidance");
        checked++;
      }
      // A drawn knockout held for its tie-break: a winner only, no guidance.
      const owed = card(render({ held: [held({ fixtureId: "f1", reason: "tiebreak_owed", noResultOffer: offer })] }), "f1");
      expect(settles(owed), why).toEqual(["home_wins", "away_wins"]);
      expect(owed, why).not.toContain("external-play-settle-guidance");
    }
    expect(checked).toBe(2 * 4);
  });

  // I-3, fix round 3: both players absent where W2b takes a double walkover — the queue offers it by its own name.
  it("both players absent: the settle offers W2b's double walkover by its own name, on its own row — every locale, counted; the void keeps \"No result\"", () => {
    // M-7 (fix round 4): each sends its OWN kind — the server refuses the other one as a stale screen's.
    const button = (h: string, choice: "no_result" | "double_walkover") => h.match(new RegExp(`<button([^>]*)data-settle="${choice}"([^>]*)>(.*?)</button>`));
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const dict = LOCALES[locale] as Record<string, string>;
      const h = render({ held: [held({ fixtureId: "f1", reason: "no_show_both", noResultOffer: { kind: "double_walkover" } }), held({ fixtureId: "f2", reason: "not_started" })] }, locale);
      const dw = button(card(h, "f1"), "double_walkover");
      expect(dw, `${locale}: the double walkover renders`).not.toBeNull();
      expect(text(dw![3]!), locale).toBe(dict["externalPlay.resolve.doubleWalkover"]);
      expect(`${dw![1]} ${dw![2]}`, `${locale}: a row of its own`).toMatch(/\bmin-\[360px\]:col-span-2\b/);
      expect(card(h, "f1"), locale).not.toContain("external-play-settle-guidance");
      // The pair: the void's button says "No result".
      expect(text(button(card(h, "f2"), "no_result")![3]!), locale).toBe(dict["externalPlay.resolve.noResult"]);
      expect(button(card(h, "f1"), "no_result"), `${locale}: the double walkover never sends no_result`).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
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
  it("each board: where and how it stands, the names, its flag cards, and 'Let the game go on'", () => {
    const h = render({ flagged: [flaggedBoard({ fixtureId: "fx-9" })] });
    const t = text(h);
    expect(t).toContain("Flagged · the game carried on · 1");
    expect(t).toContain("Flags are evidence for you to review. Nothing happens to a result automatically.");
    expect(t).toContain("Round 3 · Board 3 · live");
    expect(t).toContain("Jonah Mbeki vs Elif Demirtaş");
    expect(t).toContain("3 moves reached Lichess that were not played on Seazn's board (moves 26 to 27).");
    expect(t).toContain("Let the game go on");
  });

  // Phase 2 (spec 2026-10-24-arbiter-round-column-design.md §8): the queue is on the Fixtures tab only when the panel is NOT
  // offered (online play off now, or the flag off), and there the panel 404s. Its old "Review in arbiter panel" link was a live
  // 404 in exactly the one place it rendered, so no card links into the panel in any state. Task 11 deleted the link's words
  // (`externalPlay.queue.review`) from every dictionary, so a check on those words would test an undefined key; the checks that
  // can still fail are the testid, the href and the anchor itself, each beside a card that IS on screen with its other control.
  it("no flagged board links into the arbiter panel, in any state or any locale (the panel would 404 where this queue shows)", () => {
    const ANCHOR = /<a[\s>]/;
    // The probes are not blind: the markup of a link into the panel trips all three.
    const link = `<a data-testid="external-play-review" href="${routes.divisionArbiter("o", "c", "d", "fx-1")}">x</a>`;
    expect(testIds(link, "external-play-review"), "the testid probe sees a review link").toBe(1);
    expect(link, "the href probe sees a link into the panel").toContain("/arbiter");
    expect(link, "the anchor probe sees an anchor").toMatch(ANCHOR);

    const states: [string, FlaggedBoard][] = [
      ["live", flaggedBoard({ fixtureId: "fx-1" })],
      ["finished", flaggedBoard({ fixtureId: "fx-2", state: { kind: "result", score: "1–0", noResult: false } })],
      ["cancelled", flaggedBoard({ fixtureId: "fx-3", state: { kind: "cancelled" }, canSettle: false, canResync: false, playable: false })],
    ];
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      for (const [label, board] of states) {
        const h = render({ flagged: [board], held: [held({ fixtureId: "h1", reason: "aborted" })] }, locale);
        // Positive pair: the board's card IS on screen with its other control, so an absent link is not an absent card.
        expect(testIds(h, "external-play-go-on"), `${locale} ${label}: the card renders`).toBe(1);
        expect(testIds(h, "external-play-review"), `${locale} ${label}: no review link`).toBe(0);
        expect(h, `${locale} ${label}: no href into the panel`).not.toContain("/arbiter");
        expect(h, `${locale} ${label}: no anchor of any kind`).not.toMatch(ANCHOR);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: three states in four locales").toBe(12);
  });

  it("a finished game's flags are reviewed, not let go on: the button says 'Mark as reviewed' and the state is the score", () => {
    const h = render({ flagged: [flaggedBoard({ fixtureId: "fx-1", state: { kind: "result", score: "1–0", noResult: false } })] });
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
