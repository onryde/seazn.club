// The Arbiter Panel round column's QUEUE (spec 2026-10-24-arbiter-round-column-design.md §5.6, plan Task 7): the boards that need
// a decision as compact cards, "Review board N" as a button that selects in place or a link to another round's page, a cancelled
// flagged board's "Mark as reviewed", the seated card that is shown and not counted, and the ownFlagged line.
//
// Two ways of looking, on purpose. `renderToStaticMarkup` reads what a person would see (copy comes from the English dictionary,
// never typed here). The hook harness (`renderIsland`, no DOM in this workspace) drives the REAL seam: the second decision reducer
// and runner this component mounts (pre-flight T7, accepted), with the network doubled at `apiV1` - because markup cannot see
// whether a button is wired to anything (AGENTS recurring classes 1 and 2).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import { ApiV1Error } from "@/lib/client-v1";
import type { Dict } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import { messages } from "@/lib/messages";
import { routes } from "@/lib/routes";
import { NEEDS_REASONS } from "@/server/external-play/types";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import { HELD_TITLE_KEYS, heldBody } from "../../external-play-held-copy";
import { RoundQueueCards } from "../round-queue-cards";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    // Each request waits until the test answers it: "in flight" is a real state here.
    apiV1: (url: string, options?: { json?: unknown }) =>
      new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});

// The queue formats through `useFmt` (the panel's formatter, shared with the Fixtures-tab queue), which needs a DictProvider; the
// hook harness has none, so the lookups are the English dictionary's own, as external-play-needs-result-queue-actions.test.tsx does.
// The locale cases run through the real provider in round-column.test.tsx.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(enUi as unknown as Dict, key, vars),
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(enUi as unknown as Dict, key, count, "en", vars),
    useLocale: () => "en",
  };
});

const en = messages as unknown as Record<string, string>;
const SLUGS = { org: "club", comp: "autumn", div: "open" };

const t = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]!);
const pl = (key: string, n: number, vars: Record<string, string | number> = {}) =>
  Object.entries({ count: n, ...vars }).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[`${key}.${n === 1 ? "one" : "other"}`]!);
/** React escapes text; compare against the escaped form. */
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// ---- fixtures ---------------------------------------------------------------------------------------------------

const HELD = (fixtureId: string, o: Partial<NeedsOrganiserExternalPlayRow> = {}): NeedsOrganiserExternalPlayRow => ({
  fixtureId,
  fixtureNo: 4,
  homeName: "Ada L.",
  awayName: "Bo M.",
  scheduledAt: null,
  reason: "no_show_white",
  lastError: null,
  whiteSide: "home",
  revokedSeat: null,
  roundNo: 2,
  boardNo: 4,
  stageName: "Swiss Open",
  canResync: false,
  seated: false,
  noResultOffer: { kind: "void" },
  ...o,
});

function boardOf(fixtureId: string, o: Partial<ArbiterBoard> = {}): ArbiterBoard {
  return {
    fixtureId,
    fixtureNo: 1,
    boardNo: 7,
    white: { name: "Wendy W.", personId: null },
    black: { name: "Blake B.", personId: null },
    state: { kind: "live", moveNo: 3 },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    sides: { home: { state: "none", endedAt: null, evidenceAt: null }, away: { state: "none", endedAt: null, evidenceAt: null } },
    canResync: false,
    playable: true,
    canSettle: false,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    checkin: null,
    seats: null,
    flags: [],
    ...o,
  };
}
const FLAG = (id: string) => ({ id, kind: "out_of_band_play" as const, at: "2026-10-24T12:00:00.000Z", plies: null });
const FLAGGED = (fixtureId: string, o: Partial<FlaggedBoard> = {}): FlaggedBoard => ({
  ...boardOf(fixtureId, { flags: [FLAG(`${fixtureId}-a`), FLAG(`${fixtureId}-b`)] }),
  roundNo: 2,
  stageName: "Swiss Open",
  ...o,
});
const CANCELLED = (fixtureId: string, o: Partial<FlaggedBoard> = {}) => FLAGGED(fixtureId, { state: { kind: "cancelled" }, ...o });

/** A round on screen whose boards are exactly these fixture ids. */
const ROUND = (...fixtureIds: string[]): ArbiterRound => ({
  stageId: "s1",
  stageName: "Swiss Open",
  roundNo: 2,
  timeControl: null,
  boards: fixtureIds.map((id) => boardOf(id)),
  ownBoards: 0,
  current: true,
  extendableBoards: 0,
});

type Props = Parameters<typeof RoundQueueCards>[0];
const PROPS = (o: Partial<Props> = {}): Props => ({ round: null, held: [], flagged: [], ownFlagged: 0, slugs: SLUGS, onSelect: () => {}, ...o });
const queue = (o: Partial<Props> = {}) => renderToStaticMarkup(<RoundQueueCards {...PROPS(o)} />);

// ---- markup probes ----------------------------------------------------------------------------------------------

const ATTR = (testid: string) => `data-testid="${testid}"`;
const count = (h: string, testid: string) => h.split(ATTR(testid)).length - 1;
const tagOf = (h: string, testid: string): string | null => new RegExp(`<[a-z0-9]+\\b[^>]*${ATTR(testid)}[^>]*>`).exec(h)?.[0] ?? null;
/** The inner markup of the first element whose opening tag contains `attr` (balanced on its own tag name). */
function innerAttr(h: string, attr: string): string | null {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*${attr}[^>]*>`).exec(h);
  if (!open) return null;
  const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  const from = open.index + open[0].length;
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(h); m; m = re.exec(h)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return h.slice(from, m.index);
  }
  throw new Error(`unbalanced <${open[1]}> for ${attr}`);
}
const inner = (h: string, testid: string): string | null => innerAttr(h, ATTR(testid));
const textIn = (h: string, testid: string): string | null => {
  const i = inner(h, testid);
  return i === null ? null : i.replace(/<[^>]*>/g, "");
};
const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1] ?? "";
const hasClass = (tag: string | null, cls: string) => (tag === null ? false : classOf(tag).split(/\s+/).includes(cls));
/** Every card's markup, in order: the cards are the only `li` carrying this test id. */
function cardsOf(h: string): string[] {
  const out: string[] = [];
  const re = /<li\b[^>]*data-testid="arbiter-column-card"[^>]*>/g;
  for (let m = re.exec(h); m; m = re.exec(h)) {
    const rest = h.slice(m.index);
    out.push(`${m[0]}${innerAttr(rest, ATTR("arbiter-column-card"))!}`);
  }
  return out;
}
const cardFor = (h: string, fixtureId: string, kind?: "held" | "flagged") =>
  cardsOf(h).find((c) => c.includes(`data-fixture-id="${fixtureId}"`) && (kind === undefined || c.includes(`data-kind="${kind}"`)));
const hrefsOf = (h: string) => [...h.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1]);

// ---- the empty case first ---------------------------------------------------------------------------------------

describe("queue: the empty case", () => {
  it("no cards, no title, no '0 boards', no ownFlagged line: it renders nothing at all", () => {
    for (const round of [null, ROUND("f1")]) {
      const h = queue({ round });
      expect(h).toBe("");
      expect(h).not.toContain(ATTR("arbiter-column-queue"));
    }
    // And with the counted words written out: a zero is never printed (desk _RULES: an empty cell is not information).
    expect(queue()).not.toContain(pl("arbiter.column.queue", 0));
  });

  it("nothing flagged on boards the organiser plays on, nothing held: still nothing (ownFlagged 0 is no line)", () => {
    expect(queue({ ownFlagged: 0 })).toBe("");
  });
});

// ---- the cards --------------------------------------------------------------------------------------------------

describe("queue: a held board", () => {
  it("in the round on screen, 'Review board 4' is a BUTTON that selects it, and it links nowhere", () => {
    const h = queue({ round: ROUND("h1"), held: [HELD("h1")] });
    const tag = tagOf(h, "arbiter-column-review")!;
    expect(tag).toMatch(/^<button\b/);
    expect(tag).toContain('type="button"');
    expect(tag).toContain('data-target="select"');
    expect(textIn(h, "arbiter-column-review")).toBe(esc(t("arbiter.column.review", { board: 4 })));
    expect(hrefsOf(h), "the card has no link at all").toEqual([]);
  });

  it("the button calls onSelect with THIS card's fixture id (handler, not markup), on each of two cards", () => {
    const onSelect = vi.fn();
    const ui = renderIsland(RoundQueueCards, PROPS({ round: ROUND("h1", "h2"), held: [HELD("h1"), HELD("h2", { boardNo: 5 })], onSelect }));
    const buttons = [...new Set(ui.tree().filter((n) => propsOf(n)["data-testid"] === "arbiter-column-review"))];
    expect(buttons, "anti-vacuity: one Review per card").toHaveLength(2);
    (propsOf(buttons[1]!).onClick as () => void)();
    expect(onSelect).toHaveBeenLastCalledWith("h2");
    (propsOf(buttons[0]!).onClick as () => void)();
    expect(onSelect).toHaveBeenLastCalledWith("h1");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("in another round, 'Review board 4' is a LINK to the panel pinned to that board's round", () => {
    const h = queue({ round: ROUND("elsewhere"), held: [HELD("h1")] });
    const tag = tagOf(h, "arbiter-column-review")!;
    expect(tag).toMatch(/^<a\b/);
    expect(tag).toContain('data-target="link"');
    expect(tag).toContain(`href="${esc(routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div, "h1"))}"`);
    expect(textIn(h, "arbiter-column-review")).toBe(esc(t("arbiter.column.review", { board: 4 })));
  });

  it("with no round on screen at all, a held board is a link too (there is nothing to select in)", () => {
    const h = queue({ round: null, held: [HELD("h1")] });
    expect(tagOf(h, "arbiter-column-review")).toMatch(/^<a\b/);
    expect(hrefsOf(h)).toEqual([esc(routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div, "h1"))]);
  });

  it("nothing in the column links to the panel's own URL, with or without the current board's ?fixture= (the self-link fix)", () => {
    // Two cards select in place (one held, one flagged), two link out. The links are the only hrefs there may be.
    const h = queue({
      round: ROUND("in-held", "in-flag"),
      held: [HELD("in-held"), HELD("out-held", { boardNo: 9 })],
      flagged: [FLAGGED("in-flag"), FLAGGED("out-flag")],
    });
    const hrefs = hrefsOf(h);
    expect(hrefs, "anti-vacuity: the two links out are scanned").toHaveLength(2);
    const own = [
      routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div),
      routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div, "in-held"),
      routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div, "in-flag"),
    ].map(esc);
    for (const href of hrefs) expect(own, href).not.toContain(href);
    expect(hrefs).toEqual([esc(routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div, "out-held")), esc(routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div, "out-flag"))]);
    expect(count(h, "arbiter-column-review"), "four cards, four Review controls").toBe(4);
  });

  it("a board with no number: the where line is the stage name, and the action reads 'Review this board' (button and link)", () => {
    for (const round of [ROUND("h1"), ROUND("elsewhere")]) {
      const h = queue({ round, held: [HELD("h1", { boardNo: null })] });
      expect(textIn(h, "arbiter-column-card-where"), "the where line is the stage").toBe(esc("Swiss Open"));
      expect(textIn(h, "arbiter-column-review")).toBe(esc(en["arbiter.column.reviewThis"]!));
      expect(h).not.toContain(esc(t("arbiter.column.review", { board: 0 })));
      expect(h).not.toContain("null");
    }
  });

  it("a round number with no board number still falls back to the stage; a board number with no round number too", () => {
    const noRound = queue({ round: ROUND("h1"), held: [HELD("h1", { roundNo: null })] });
    expect(textIn(noRound, "arbiter-column-card-where")).toBe(esc("Swiss Open"));
    expect(textIn(noRound, "arbiter-column-review"), "it has a number, so it is named by it").toBe(esc(t("arbiter.column.review", { board: 4 })));
    const full = queue({ round: ROUND("h1"), held: [HELD("h1")] });
    expect(textIn(full, "arbiter-column-card-where")).toBe(esc(t("externalPlay.queue.where", { round: 2, board: 4 })));
  });

  it("the card names the players by colour, and says what happened in the run sheet's own words", () => {
    // whiteSide "away": White is the AWAY entrant, and the no-show is the colour that stayed away.
    const h = queue({ round: ROUND("h1"), held: [HELD("h1", { whiteSide: "away", reason: "no_show_white" })] });
    const names = textIn(h, "arbiter-column-card-names")!;
    expect(names.indexOf("Bo M."), "white first").toBeGreaterThan(-1);
    expect(names.indexOf("Bo M.")).toBeLessThan(names.indexOf("Ada L."));
    expect(names).toContain(esc(en["arbiter.vs"]!));
    expect(textIn(h, "arbiter-column-card-chip")).toBe(esc(en["externalPlay.held.noShowWhite"]!));
    expect(textIn(h, "arbiter-column-card-body")).toBe(esc(t("externalPlay.reason.noShowWhite", { name: "Bo M." })));
  });

  it("every held reason the engine declares has a chip and a sentence on the card (a sweep over NEEDS_REASONS)", () => {
    // Em dashes in dictionary copy are Task 11's to reword (externalPlay.held.clockFlagUnsettled is on its list); the rest are scanned.
    const OWED_TO_TASK_11 = ["clock_flag_unsettled"];
    const banned = [0x2013, 0x2014, 0x2192, 0x2190, 0x2197].map((c) => String.fromCharCode(c));
    let checked = 0;
    let scanned = 0;
    for (const reason of NEEDS_REASONS) {
      const row = HELD("h1", { reason, revokedSeat: reason === "token_revoked" || reason === "account_changed" ? "white" : null });
      const h = queue({ round: ROUND("h1"), held: [row] });
      expect(textIn(h, "arbiter-column-card-chip"), reason).toBe(esc(en[HELD_TITLE_KEYS[reason]]!));
      const body = heldBody({ reason, revokedSeat: row.revokedSeat, whiteName: "Ada L.", blackName: "Bo M." });
      expect(textIn(h, "arbiter-column-card-body"), reason).toBe(esc(t(body.key, body.vars ?? {})));
      expect(textIn(h, "arbiter-column-card-chip")!.length, reason).toBeGreaterThan(0);
      checked += 1;
      if (OWED_TO_TASK_11.includes(reason)) continue;
      for (const ch of banned) expect(h, `${reason} U+${ch.charCodeAt(0).toString(16)}`).not.toContain(ch);
      scanned += 1;
    }
    expect(checked, "anti-vacuity: every reason rendered").toBe(NEEDS_REASONS.length);
    expect(NEEDS_REASONS.length, "premise: the declared list is not empty").toBeGreaterThan(0);
    expect(scanned, "anti-vacuity: the dash scan covered all but the owed ones").toBe(NEEDS_REASONS.length - OWED_TO_TASK_11.length);
    expect(OWED_TO_TASK_11.every((r) => (NEEDS_REASONS as readonly string[]).includes(r)), "the owed list names real reasons").toBe(true);
  });

  it("seated: the card is shown with the settle-own-board line and NO action; the title's count leaves it out (C6)", () => {
    const seated = HELD("s1", { seated: true });
    const alone = queue({ round: ROUND("s1"), held: [seated] });
    expect(count(alone, "arbiter-column-card")).toBe(1);
    expect(textIn(alone, "arbiter-column-seated")).toBe(esc(en["arbiter.notice.settleOwnBoard"]!));
    expect(alone).not.toContain(ATTR("arbiter-column-review"));
    expect(alone).not.toContain(ATTR("arbiter-column-mark-reviewed"));
    expect(hrefsOf(alone)).toEqual([]);
    // Counted: 0, so the title is not printed ("0 boards need a decision" would be false and noisy).
    expect(alone).not.toContain(ATTR("arbiter-column-queue-title"));
    expect(alone).not.toContain(pl("arbiter.column.queue", 0));

    // Beside a real card the count is 1, not 2: the seated card is shown and not counted.
    const both = queue({ round: ROUND("s1", "h1"), held: [seated, HELD("h1")] });
    expect(count(both, "arbiter-column-card")).toBe(2);
    expect(textIn(both, "arbiter-column-queue-title")).toBe(esc(pl("arbiter.column.queue", 1)));
    expect(count(both, "arbiter-column-review"), "only the unseated card offers Review").toBe(1);
    expect(innerAttr(both, 'data-testid="arbiter-column-card" data-kind="held" data-fixture-id="h1"')).toContain(ATTR("arbiter-column-review"));
  });

  it("a held board that is also flagged: two cards, counted once", () => {
    const h = queue({ round: ROUND("both"), held: [HELD("both")], flagged: [FLAGGED("both")] });
    expect(count(h, "arbiter-column-card")).toBe(2);
    expect(cardFor(h, "both", "held"), "the held card").toBeDefined();
    expect(cardFor(h, "both", "flagged"), "the flagged card").toBeDefined();
    expect(textIn(h, "arbiter-column-queue-title")).toBe(esc(pl("arbiter.column.queue", 1)));
    expect(h).not.toContain(esc(pl("arbiter.column.queue", 2)));
  });
});

describe("queue: a flagged board", () => {
  it("in the round on screen: the flag count, where, the board's state, the names, and a Review button; held cards come first", () => {
    const h = queue({ round: ROUND("g1", "h1"), held: [HELD("h1")], flagged: [FLAGGED("g1", { boardNo: 7, roundNo: 2 })] });
    expect(cardsOf(h).map((c) => /data-kind="([^"]+)"/.exec(c)![1])).toEqual(["held", "flagged"]);
    const card = cardFor(h, "g1", "flagged")!;
    expect(textIn(card, "arbiter-column-card-chip")).toBe(esc(pl("arbiter.flagCount", 2)));
    expect(textIn(card, "arbiter-column-card-where")).toBe(esc(t("externalPlay.queue.where", { round: 2, board: 7 })));
    expect(textIn(card, "arbiter-column-card-state")).toBe(esc(en["arbiter.state.live"]!));
    expect(textIn(card, "arbiter-column-card-names")).toContain("Wendy W.");
    expect(textIn(card, "arbiter-column-review")).toBe(esc(t("arbiter.column.review", { board: 7 })));
    expect(tagOf(card, "arbiter-column-review")).toMatch(/^<button\b/);
    expect(card).not.toContain(ATTR("arbiter-column-mark-reviewed"));
  });

  it("the flag count is singular for one flag", () => {
    const h = queue({ round: ROUND("g1"), flagged: [FLAGGED("g1", { flags: [FLAG("only")] })] });
    expect(textIn(h, "arbiter-column-card-chip")).toBe(esc(pl("arbiter.flagCount", 1)));
  });

  it("in another round: a link; with no roundNo the where line is the stage", () => {
    const h = queue({ round: ROUND("elsewhere"), flagged: [FLAGGED("g1", { roundNo: null })] });
    expect(tagOf(h, "arbiter-column-review")).toMatch(/^<a\b/);
    expect(hrefsOf(h)).toEqual([esc(routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div, "g1"))]);
    expect(textIn(h, "arbiter-column-card-where")).toBe(esc("Swiss Open"));
  });

  it("cancelled: 'Mark as reviewed' and no Review (it can never be selected), even when its fixture id is in the round", () => {
    const h = queue({ round: ROUND("c1"), flagged: [CANCELLED("c1")] });
    expect(textIn(h, "arbiter-column-mark-reviewed")).toBe(esc(en["externalPlay.queue.markReviewed"]!));
    expect(tagOf(h, "arbiter-column-mark-reviewed")).toMatch(/^<button\b/);
    expect(h).not.toContain(ATTR("arbiter-column-review"));
    expect(hrefsOf(h)).toEqual([]);
    expect(textIn(h, "arbiter-column-card-state")).toBe(esc(en["arbiter.state.cancelled"]!));
    // It is a real card: counted, in the title.
    expect(textIn(h, "arbiter-column-queue-title")).toBe(esc(pl("arbiter.column.queue", 1)));
  });
});

// ---- the title and the ownFlagged line --------------------------------------------------------------------------

describe("queue: the title and the ownFlagged line", () => {
  it("'2 boards need a decision'; singular for one", () => {
    const h = queue({ round: ROUND("h1", "g1"), held: [HELD("h1")], flagged: [FLAGGED("g1")] });
    expect(textIn(h, "arbiter-column-queue-title")).toBe(esc(pl("arbiter.column.queue", 2)));
    expect(pl("arbiter.column.queue", 2), "premise: the plural really counts").toContain("2");
    const one = queue({ round: ROUND("h1"), held: [HELD("h1")] });
    expect(textIn(one, "arbiter-column-queue-title")).toBe(esc(pl("arbiter.column.queue", 1)));
  });

  it("red when any counted card is held; not red when only flagged; a SEATED held card does not make it red", () => {
    const red = (h: string) => hasClass(tagOf(h, "arbiter-column-queue-title"), "text-[#b42318]");
    const tone = (h: string) => /data-tone="([^"]+)"/.exec(tagOf(h, "arbiter-column-queue-title") ?? "")?.[1];
    const held = queue({ round: ROUND("h1"), held: [HELD("h1")] });
    expect(red(held)).toBe(true);
    expect(tone(held)).toBe("held");
    // Held beside flagged: any counted held card is enough.
    const mixed = queue({ round: ROUND("h1", "g1"), held: [HELD("h1")], flagged: [FLAGGED("g1")] });
    expect(red(mixed)).toBe(true);
    const flagged = queue({ round: ROUND("g1"), flagged: [FLAGGED("g1")] });
    expect(red(flagged)).toBe(false);
    expect(tone(flagged)).toBe("flagged");
    expect(hasClass(tagOf(flagged, "arbiter-column-queue-title"), "text-[#2e1065]"), "the ink colour instead").toBe(true);
    // A seated held card is shown and not counted, so on its own it cannot colour the title (and a flagged card beside it does not go red).
    const seatedPlusFlagged = queue({ round: ROUND("g1"), held: [HELD("s1", { seated: true })], flagged: [FLAGGED("g1")] });
    expect(red(seatedPlusFlagged)).toBe(false);
    expect(textIn(seatedPlusFlagged, "arbiter-column-queue-title")).toBe(esc(pl("arbiter.column.queue", 1)));
  });

  it("ownFlagged: absent at 0 (beside a card, so the absence means something); at 1 and 2 the plural of the tab's own line", () => {
    const card = { round: ROUND("h1"), held: [HELD("h1")] };
    expect(queue({ ...card, ownFlagged: 0 })).not.toContain(ATTR("arbiter-column-own-flagged"));
    expect(textIn(queue({ ...card, ownFlagged: 2 }), "arbiter-column-own-flagged")).toBe(esc(pl("externalPlay.queue.ownFlagged", 2)));
    expect(textIn(queue({ ...card, ownFlagged: 1 }), "arbiter-column-own-flagged")).toBe(esc(pl("externalPlay.queue.ownFlagged", 1)));
    expect(pl("externalPlay.queue.ownFlagged", 1)).not.toBe(pl("externalPlay.queue.ownFlagged", 2));
  });

  it("ownFlagged with no card at all: the line stands alone (C11: never inert), and no title, no '0 boards'", () => {
    const h = queue({ ownFlagged: 2 });
    expect(textIn(h, "arbiter-column-own-flagged")).toBe(esc(pl("externalPlay.queue.ownFlagged", 2)));
    expect(count(h, "arbiter-column-card")).toBe(0);
    expect(h).not.toContain(ATTR("arbiter-column-queue-title"));
    expect(h).not.toContain(pl("arbiter.column.queue", 0));
    // No cards, so no list: an empty <ul> is a list landmark that announces "list, 0 items" (Task 7 review M3).
    expect(h).not.toContain("<ul");
    expect(h).not.toContain("<li");
    // ...and the same markup WITH a card does carry the list, so the absence above is the gate and not a markup change.
    expect(queue({ round: ROUND("h1"), held: [HELD("h1")], ownFlagged: 2 })).toContain("<ul");
  });

  it("the block's accessible name is its title when it has one", () => {
    const h = queue({ round: ROUND("h1"), held: [HELD("h1")] });
    const tag = tagOf(h, "arbiter-column-queue")!;
    expect(tag).toMatch(/^<section\b/);
    const id = /aria-labelledby="([^"]+)"/.exec(tag)![1]!;
    expect(textIn(h, "arbiter-column-queue-title")).toBe(esc(pl("arbiter.column.queue", 1)));
    expect(tagOf(h, "arbiter-column-queue-title")).toContain(`id="${id}"`);
  });
});

// ---- layout rules -----------------------------------------------------------------------------------------------

describe("queue: layout rules", () => {
  it("every control is at least 44px tall, and a long name wraps with min-w-0 down the chain (no truncation)", () => {
    const long = "Maximiliano Bartholomew-Fitzgerald III";
    const h = queue({
      round: ROUND("h1", "c1"),
      held: [HELD("h1", { homeName: long, awayName: long }), HELD("h2", { boardNo: 9 })],
      flagged: [CANCELLED("c1")],
    });
    const controls = [...h.matchAll(/<(?:button|a)\b[^>]*>/g)].map((m) => m[0]);
    expect(controls.length, "anti-vacuity: controls checked (select, link, mark reviewed)").toBe(3);
    for (const c of controls) expect(classOf(c).split(/\s+/), c).toContain("min-h-11");
    const names = [...h.matchAll(/<p\b[^>]*data-testid="arbiter-column-card-names"[^>]*>/g)].map((m) => m[0]);
    expect(names).toHaveLength(3);
    for (const n of names) {
      expect(classOf(n).split(/\s+/), n).toContain("break-words");
      expect(classOf(n).split(/\s+/), n).toContain("min-w-0");
      expect(classOf(n)).not.toMatch(/(^|\s)truncate(\s|$)/);
    }
    const chain = [tagOf(h, "arbiter-column-queue"), ...[...h.matchAll(/<(?:ul|li)\b[^>]*>/g)].map((m) => m[0])];
    expect(chain.length, "anti-vacuity: the chain has the block, the list and the cards").toBe(5);
    for (const tag of chain) expect(classOf(tag!).split(/\s+/), tag!).toContain("min-w-0");
    expect(textIn(h, "arbiter-column-card-names")!.split(long).length - 1, "the long name is on the card in full, both sides").toBe(2);
  });

  it("no CSS order inside the queue (source order is visual order, C10)", () => {
    const h = queue({ round: ROUND("h1"), held: [HELD("h1")], flagged: [FLAGGED("g1")], ownFlagged: 1 });
    const classes = [...h.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!);
    expect(classes.length, "anti-vacuity: class strings scanned").toBeGreaterThan(5);
    for (const c of classes) expect(c, c).not.toMatch(/(^|\s)(?:[\w-]+:)*-?order-/);
  });

  it("the markup carries no em dash, en dash or arrow of its own", () => {
    const h = queue({ round: ROUND("h1", "c1"), held: [HELD("h1"), HELD("s1", { seated: true })], flagged: [FLAGGED("g1"), CANCELLED("c1")], ownFlagged: 2 });
    for (const code of [0x2013, 0x2014, 0x2192, 0x2190, 0x2197]) expect(h, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
    expect(count(h, "arbiter-column-card"), "anti-vacuity: four cards scanned").toBe(4);
  });
});

// ---- Mark as reviewed: the second decision reducer and runner, through the real hook -----------------------------

const flush = () => new Promise((r) => setTimeout(r, 0));
const byId = (tree: ReactElement[], id: string) => [...new Set(tree.filter((n) => propsOf(n)["data-testid"] === id))];
const click = (el: ReactElement | undefined) => (propsOf(el!).onClick as () => void)();

describe("queue: Mark as reviewed (the cancelled card's own request)", () => {
  beforeEach(() => {
    net.calls.length = 0;
    router.refresh.mockReset();
  });
  const two = () => PROPS({ round: ROUND("x"), flagged: [CANCELLED("c1"), CANCELLED("c2")] });

  it("the empty case first: nothing pressed, nothing sent, no notice", () => {
    const ui = renderIsland(RoundQueueCards, two());
    expect(net.calls).toHaveLength(0);
    expect(byId(ui.tree(), "arbiter-column-mark-reviewed")).toHaveLength(2);
    expect(byId(ui.tree(), "arbiter-column-card-notice")).toHaveLength(0);
  });

  it("each button closes exactly ITS card's flags: the second card's press sends the second card's id and flag ids", () => {
    const ui = renderIsland(RoundQueueCards, two());
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[1]);
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/fixtures/c2/external-play/flags/close", { ids: ["c2-a", "c2-b"] }]]);
  });

  it("ONE request at a time: while it is in flight, both buttons read busy/disabled and a second press sends nothing", async () => {
    const ui = renderIsland(RoundQueueCards, two());
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[0]);
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[0]);
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[1]);
    expect(net.calls, "a double press and another card's press send nothing more").toHaveLength(1);
    const buttons = byId(ui.tree(), "arbiter-column-mark-reviewed");
    for (const b of buttons) expect(propsOf(b).disabled).toBe(true);
    expect(propsOf(buttons[0]!)["aria-busy"], "the pressed one is busy").toBe(true);
    expect(propsOf(buttons[1]!)["aria-busy"], "the other is only held").toBeUndefined();
    net.calls[0]!.resolve({ closed: 2, stillOpen: 0 });
    await flush();
    for (const b of byId(ui.tree(), "arbiter-column-mark-reviewed")) expect(propsOf(b).disabled, "freed by the answer").toBe(false);
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[1]);
    expect(net.calls, "freed").toHaveLength(2);
  });

  it("the answer shows on the card it was sent for, in the queue's 'Marked as reviewed' words, and the page refreshes", async () => {
    const ui = renderIsland(RoundQueueCards, two());
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[1]);
    net.calls[0]!.resolve({ closed: 2, stillOpen: 0 });
    await flush();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const notices = byId(ui.tree(), "arbiter-column-card-notice");
    expect(notices, "one answer, on one card").toHaveLength(1);
    expect(textOf(notices[0])).toBe(en["externalPlay.queue.reviewed"]);
  });

  it("a refusal shows on its card by its code and refreshes nothing; the button is free again", async () => {
    const ui = renderIsland(RoundQueueCards, two());
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[0]);
    net.calls[0]!.reject(new ApiV1Error("x", 409, "ARBITER_PLAYS_THIS_BOARD"));
    await flush();
    expect(textOf(byId(ui.tree(), "arbiter-column-card-notice")[0])).toBe(en["arbiter.notice.goOnOwnBoard"]);
    expect(router.refresh).not.toHaveBeenCalled();
    // Any other failure says it plainly.
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[1]);
    net.calls[1]!.reject(new ApiV1Error("x", 500, "BOOM"));
    await flush();
    expect(textOf(byId(ui.tree(), "arbiter-column-card-notice")[0])).toBe(en["arbiter.notice.failed"]);
  });

  it("the sequence: review the LAST card, the refresh takes it away, and the answer is still on screen (a visible status, not sr-only)", async () => {
    const one = PROPS({ round: ROUND("x"), flagged: [CANCELLED("c1")] });
    const ui = renderIsland(RoundQueueCards, one);
    // Before any answer the live region exists and is read, not shown.
    expect(propsOf(byId(ui.tree(), "arbiter-column-queue-status")[0]!).className).toContain("sr-only");
    click(byId(ui.tree(), "arbiter-column-mark-reviewed")[0]);
    net.calls[0]!.resolve({ closed: 2, stillOpen: 0 });
    await flush();
    ui.rerender({ ...one, flagged: [] });
    const status = byId(ui.tree(), "arbiter-column-queue-status");
    expect(status, "the empty queue keeps only the answer").toHaveLength(1);
    expect(textOf(status[0])).toBe(en["externalPlay.queue.reviewed"]);
    expect(propsOf(status[0]!).className, "visible, not screen-reader only").not.toContain("sr-only");
    expect(byId(ui.tree(), "arbiter-column-card")).toHaveLength(0);
  });
});

// ---- the new copy ------------------------------------------------------------------------------------------------

describe("the queue's own keys, in four locales", () => {
  // Spec section 9 is the authority for the English.
  const SPEC_EN: Record<string, string> = {
    "arbiter.column.queue.one": "{count} board needs a decision",
    "arbiter.column.queue.other": "{count} boards need a decision",
    "arbiter.column.review": "Review board {board}",
    "arbiter.column.reviewThis": "Review this board",
    "arbiter.column.playing.one": "{count} of {total} board playing",
    "arbiter.column.playing.other": "{count} of {total} boards playing",
  };
  const BANNED = [0x2014, 0x2013, 0x2192, 0x2190, 0x2197].map((c) => String.fromCharCode(c));
  const locales: [string, Record<string, unknown>][] = [["en", enUi], ["es", esUi], ["fr", frUi], ["nl", nlUi]];

  it("English is the spec's; es, fr and nl are real translations; none carries a dash or an arrow; every placeholder survives", () => {
    let checked = 0;
    for (const [locale, dict] of locales) {
      for (const [key, english] of Object.entries(SPEC_EN)) {
        const v = dict[key];
        expect(typeof v, `${locale} ${key}`).toBe("string");
        if (locale === "en") expect(v).toBe(english);
        else {
          expect(v, `${locale} ${key} is translated`).not.toBe(english);
          const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
          expect(holes(v as string), `${locale} ${key} placeholders`).toEqual(holes(english));
        }
        for (const ch of BANNED) expect(v as string, `${locale} ${key}`).not.toContain(ch);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 6 keys x 4 locales").toBe(24);
  });
});
