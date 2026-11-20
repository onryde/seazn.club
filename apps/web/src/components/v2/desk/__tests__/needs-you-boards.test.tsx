// Match Day online (T4, spec 2026-11-05 §5.4): the two PER-BOARD Needs-you rows, as `needsYouItems` builds them from the desk's attentions
// and as `NeedsYou` presses them. Pure and DOM-free (vitest here is `environment: "node"`), so the press is reached the one way a node
// test can: `NeedsYou` is a plain function component, called directly, and its `onClick` props are read off the element tree.
//
// Expected values are the dictionaries' own words (`HELD_TITLE_KEYS`, the one table of a held reason's chip) and the routes' own
// spelling; the reasons are swept from `NEEDS_REASONS`, the vocabulary V451's CHECK pins.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { plural, t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { NeedsYou, needsYouItems, needsYouKey, type NeedsYouItem } from "@/components/v2/desk/needs-you";
import { HELD_TITLE_KEYS } from "@/components/v2/external-play-held-copy";
import { ATTENTION_SEVERITY, type Attention } from "@/lib/division-phase";
import { isLinkHold, NEEDS_REASONS } from "@/server/external-play/types";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

const LOCALES: [Locale, Dict][] = [
  ["en", en as unknown as Dict],
  ["es", es as unknown as Dict],
  ["fr", fr as unknown as Dict],
  ["nl", nl as unknown as Dict],
];
const NAMES = [{ id: "d1", name: "Open", slug: "open" }];
const STAGE = "11111111-1111-4111-8111-111111111111";
const FX_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FX_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Held = Extract<Attention, { kind: "board_held" }>;
type Flagged = Extract<Attention, { kind: "board_flagged" }>;
const held = (o: Partial<Held> = {}): Held => ({
  kind: "board_held", fixtureId: FX_A, stageId: STAGE, roundNo: 2, boardNo: 4, home: "Novak", away: "Silva", reason: "no_show_white", reopen: false, ...o,
});
const flagged = (o: Partial<Flagged> = {}): Flagged => ({
  kind: "board_flagged", fixtureId: FX_B, roundNo: 2, boardNo: 7, home: "Chen", away: "Abara", flags: 1, ...o,
});
const deskOf = (attention: Attention[]): CompetitionDesk =>
  ({ divisions: new Map([["d1", { attention, fixture_names: {} }]]) }) as unknown as CompetitionDesk;
const rows = (attention: Attention[], dict: Dict = en as unknown as Dict, locale: Locale = "en"): NeedsYouItem[] =>
  needsYouItems(dict, deskOf(attention), NAMES, "acme", "spring-open", locale);

const MATCH_DAY = "/o/acme/c/spring-open/match-day";

describe("the per-board Needs-you rows", () => {
  it("EMPTY CASE FIRST: an online division with nothing held or flagged raises neither row; the key of every other kind is still division:kind", () => {
    expect(rows([])).toEqual([]);
    const [other] = rows([{ kind: "unscheduled", count: 2 }]);
    expect(other!.key).toBe("d1:unscheduled");
    expect(other!.fixture_id, "an ordinary row carries no board").toBeUndefined();
    expect(needsYouKey("d1", "unscheduled")).toBe("d1:unscheduled");
    expect(needsYouKey("d1", "board_held", FX_A)).toBe(`d1:board_held:${FX_A}`);
  });

  it("a held board is one RED row naming its division, board and players, carrying its fixture id, opening that board in Match Day", () => {
    const [item, ...rest] = rows([held()]);
    expect(rest, "one row").toEqual([]);
    expect(item).toMatchObject({
      key: `d1:board_held:${FX_A}`,
      severity: "red",
      kind: "board_held",
      fixture_id: FX_A,
      title: "Open · Board 4 · Novak v Silva is on hold",
      action: { label: "Review board 4", href: `${MATCH_DAY}?board=${FX_A}` },
    });
    expect(item!.round_key, "the board's own press, no round").toBeUndefined();
    expect(item!.severity, "the severity is the kind's own declaration").toBe(ATTENTION_SEVERITY.board_held);
  });

  it("the sub is the held reason's own chip word, for EVERY reason of the vocabulary, in every locale (count reported); a link hold is a reason like the rest", () => {
    let checked = 0;
    for (const [locale, dict] of LOCALES) {
      for (const reason of NEEDS_REASONS) {
        const [item] = rows([held({ reason })], dict, locale);
        expect(item!.sub, `${locale} ${reason}`).toBe(t(dict, HELD_TITLE_KEYS[reason]));
        expect(item!.sub, `${locale} ${reason}: a sentence, never a key`).not.toMatch(/externalPlay\./);
        checked++;
      }
    }
    expect(checked, "reason x locale pairs").toBe(NEEDS_REASONS.length * LOCALES.length);
    expect(NEEDS_REASONS.length, "premise: the vocabulary reaches the link holds").toBeGreaterThanOrEqual(16);
    expect(NEEDS_REASONS.filter(isLinkHold)).toEqual(["lichess_unlinked", "lichess_reconnect"]);
  });

  it("a hold whose reason is not known (null: a reader who is no editor) says the generic sentence, never a stale or empty one", () => {
    const [item] = rows([held({ reason: null })]);
    expect(item!.sub).toBe(t(en as unknown as Dict, "desk.needsYou.board_held.sub"));
    expect(item!.sub.length).toBeGreaterThan(0);
  });

  it("MD-R2: a LINK hold the viewer may re-open opens the ROUND panel's Open round (?round=, the round row's key), never 'Review board'", () => {
    let checked = 0;
    for (const reason of NEEDS_REASONS.filter(isLinkHold)) {
      const [item] = rows([held({ reason, reopen: true })]);
      const key = `${STAGE}:2`;
      expect(item!.action, reason).toEqual({ label: "Open round 2 again", href: `${MATCH_DAY}?round=${encodeURIComponent(key)}` });
      expect(item!.round_key, reason).toBe(key);
      expect(item!.fixture_id, `${reason}: still the board's row`).toBe(FX_A);
      expect(item!.action.label, reason).not.toMatch(/Review board/);
      checked++;
    }
    expect(checked, "link reasons routed").toBe(2);
  });

  it("MD-R2, the other side: a link hold the viewer may NOT re-open (reopen false), and every other hold, keep 'Review board N' -> the board panel", () => {
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      const [item] = rows([held({ reason, reopen: false })]);
      expect(item!.action, reason).toEqual({ label: "Review board 4", href: `${MATCH_DAY}?board=${FX_A}` });
      expect(item!.round_key, reason).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
    // A round that cannot be named is no round to open: the board it is.
    const [noRound] = rows([held({ reason: "lichess_unlinked", reopen: true, roundNo: null })]);
    expect(noRound!.action.href).toBe(`${MATCH_DAY}?board=${FX_A}`);
    expect(noRound!.round_key).toBeUndefined();
  });

  it("a flagged board is one AMBER row, its report count in the sub (singular and plural), opening that board; a decided or cancelled board reads the same", () => {
    const [one] = rows([flagged({ flags: 1 })]);
    expect(one).toMatchObject({
      key: `d1:board_flagged:${FX_B}`,
      severity: "amber",
      kind: "board_flagged",
      fixture_id: FX_B,
      title: "Open · Board 7 · Chen v Abara has a report to review",
      sub: "1 camera report to review. The game carried on.",
      action: { label: "Review board 7", href: `${MATCH_DAY}?board=${FX_B}` },
    });
    const [many] = rows([flagged({ flags: 3 })]);
    expect(many!.sub).toBe("3 camera reports to review. The game carried on.");
    expect(many!.round_key).toBeUndefined();
  });

  it("two held boards of one division are two rows with distinct keys; one board both held and flagged is two rows (one of each kind), one board", () => {
    const two = rows([held({ fixtureId: FX_A, boardNo: 1 }), held({ fixtureId: FX_B, boardNo: 2 })]);
    expect(two.map((i) => i.key)).toEqual([`d1:board_held:${FX_A}`, `d1:board_held:${FX_B}`]);
    expect(new Set(two.map((i) => i.key)).size).toBe(2);
    const both = rows([held({ fixtureId: FX_A }), flagged({ fixtureId: FX_A })]);
    expect(both.map((i) => i.kind).sort()).toEqual(["board_flagged", "board_held"]);
    expect(new Set(both.map((i) => i.key)).size, "distinct keys").toBe(2);
    expect(new Set(both.map((i) => i.fixture_id))).toEqual(new Set([FX_A]));
    // Red before amber, as every Needs-you list is.
    expect(both.map((i) => i.severity)).toEqual(["red", "amber"]);
  });

  it("every copy of both rows is a sentence in every locale - no dictionary key, no unfilled {placeholder} (count reported)", () => {
    let checked = 0;
    for (const [locale, dict] of LOCALES) {
      const items = rows([held({ reopen: true, reason: "lichess_unlinked" }), held({ fixtureId: FX_B }), flagged({ flags: 1 }), flagged({ fixtureId: FX_A, flags: 2 })], dict, locale);
      expect(items).toHaveLength(4);
      for (const it of items) {
        for (const [what, text] of [["title", it.title], ["sub", it.sub], ["action", it.action.label]] as const) {
          expect(text, `${locale} ${it.kind} ${what}`).not.toMatch(/desk\.|externalPlay\./);
          expect(text, `${locale} ${it.kind} ${what}`).not.toMatch(/\{\w+\}/);
          expect(text.length, `${locale} ${it.kind} ${what}`).toBeGreaterThan(0);
          checked++;
        }
      }
      // The words differ from English where a locale has its own (a copy-paste of the English line would pass the checks above).
      if (locale !== "en") expect(items[0]!.title, locale).not.toBe(rows([held({ reopen: true, reason: "lichess_unlinked" })])[0]!.title);
    }
    expect(checked, "strings checked").toBe(LOCALES.length * 4 * 3);
    expect(plural(en as unknown as Dict, "desk.needsYou.board_flagged.sub", 2, "en")).toContain("2");
  });
});

// ---- the press ---------------------------------------------------------------------------------------------------------------

type Anchor = { href: string; onClick?: (e: unknown) => void };
/** Every link of the rendered list whose href is `href`, with its click handler: the two copies of one row (phone and desktop). */
function anchorsFor(node: ReactNode, href: string): Anchor[] {
  const found: Anchor[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return void n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ href?: string; onClick?: (e: unknown) => void; children?: ReactNode }>;
    if (el.props.href === href) found.push({ href, onClick: el.props.onClick });
    walk(el.props.children);
  };
  walk(node);
  return found;
}
const click = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }> = {}) => ({
  metaKey: false, ctrlKey: false, shiftKey: false, button: 0, preventDefault: vi.fn(), ...over,
});

describe("NeedsYou: the per-board press, handled in place", () => {
  // Built per test (a getter), not at collection: a row the builder cannot make must fail ITS test, not the whole file's collection.
  const row = {
    get board() { return rows([held()])[0]!; },
    get round() { return rows([held({ fixtureId: FX_B, reason: "lichess_unlinked", reopen: true })])[0]!; },
    get other() { return rows([{ kind: "unscheduled", count: 2 }])[0]!; },
  };

  it("a board row's plain click opens the board (preventDefault, then the handler with the fixture id) on both copies of the row", () => {
    const onOpenBoard = vi.fn();
    const links = anchorsFor(NeedsYou({ dict: en as unknown as Dict, items: [row.board], onOpenBoard }), row.board.action.href);
    expect(links, "the phone copy and the desktop copy").toHaveLength(2);
    for (const l of links) {
      const e = click();
      l.onClick!(e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(onOpenBoard.mock.calls).toEqual([[FX_A], [FX_A]]);
  });

  it("a modified or non-primary click is the browser's (a new tab keeps its href): no preventDefault, no handler (variants reported)", () => {
    const onOpenBoard = vi.fn();
    const [link] = anchorsFor(NeedsYou({ dict: en as unknown as Dict, items: [row.board], onOpenBoard }), row.board.action.href);
    const variants = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }, { button: 2 }];
    for (const v of variants) {
      const e = click(v);
      link!.onClick!(e);
      expect(e.preventDefault, JSON.stringify(v)).not.toHaveBeenCalled();
    }
    expect(onOpenBoard).not.toHaveBeenCalled();
    expect(variants.length).toBe(5);
  });

  it("without a handler (the competition page) the link is a plain link: no onClick at all", () => {
    for (const l of anchorsFor(NeedsYou({ dict: en as unknown as Dict, items: [row.board, row.round] }), row.board.action.href)) expect(l.onClick).toBeUndefined();
    for (const l of anchorsFor(NeedsYou({ dict: en as unknown as Dict, items: [row.board, row.round] }), row.round.action.href)) expect(l.onClick).toBeUndefined();
  });

  it("MD-R2: a ROUND row opens its round in place (the round key), and NEVER the board - whatever fixture id it carries", () => {
    const onOpenBoard = vi.fn();
    const onOpenRound = vi.fn();
    const links = anchorsFor(NeedsYou({ dict: en as unknown as Dict, items: [row.round], onOpenBoard, onOpenRound }), row.round.action.href);
    expect(links).toHaveLength(2);
    for (const l of links) {
      const e = click();
      l.onClick!(e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(onOpenRound.mock.calls).toEqual([[`${STAGE}:2`], [`${STAGE}:2`]]);
    expect(onOpenBoard, "the board handler is not the round's").not.toHaveBeenCalled();
    // A host with only the board handler leaves the round link to navigate, rather than opening a board its action does not name.
    for (const l of anchorsFor(NeedsYou({ dict: en as unknown as Dict, items: [row.round], onOpenBoard }), row.round.action.href)) expect(l.onClick).toBeUndefined();
  });

  it("a row that is no board's keeps its link untouched, handler or not (the alt link's own rule is unchanged)", () => {
    const onOpenBoard = vi.fn();
    const onOpenRound = vi.fn();
    const links = anchorsFor(NeedsYou({ dict: en as unknown as Dict, items: [row.other], onOpenBoard, onOpenRound }), row.other.action.href);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.onClick).toBeUndefined();
  });
});
