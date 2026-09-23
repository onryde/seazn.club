// Player profile — the Upcoming list (spec 2026-09-23, plan Task 2). A server
// component, so static markup IS what a spectator gets before hydration (and
// without JS). "Show N more" is a small client island (owner request
// 2026-09-23, superseding plan D2's <details>): ONE list, rows 6+ straight
// under row 5, a real <button> below it. The island is driven through
// `renderIsland` (no DOM here), fed the props the server component hands it.
// Expected copy is read from each locale's own dictionary, never typed.
// Assertions anchor on `="`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { interpolate } from "@/lib/i18n-runtime";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { PlayerUpcomingRow } from "@/server/public-site/public-player-matches";
import { PlayerUpcoming, UPCOMING_VISIBLE } from "../player-upcoming";
import { UPCOMING_LIST_ID, UpcomingReveal, type UpcomingRevealProps } from "../player-upcoming-reveal";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const row = (id: string, over: Partial<PlayerUpcomingRow> = {}): PlayerUpcomingRow => ({
  fixtureId: id,
  href: `/shared/riverside/autumn-cup/premier/fixtures/${id}`,
  scheduledAt: "2030-07-01T10:00:00.000Z",
  tz: "Asia/Kolkata",
  venue: null,
  courtLabel: null,
  opponentLabel: `Opponent ${id}`,
  competitionName: "Autumn Cup",
  competitionSlug: "autumn-cup",
  divisionName: "Premier",
  divisionSlug: "premier",
  isOtherCompetition: false,
  ...over,
});

const render = (rows: PlayerUpcomingRow[], dict: Dict = en as Dict, locale: Locale = "en") =>
  renderToStaticMarkup(<PlayerUpcoming rows={rows} dict={dict} locale={locale} />);

const rowIds = (html: string) => [...html.matchAll(/data-testid="mh-player-upcoming-row-([^"]+)"/g)].map((m) => m[1]);
const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id) => row(id));

/** The collapsed toggle as the server writes it: the whole tag, and its label. */
const toggleIn = (html: string) => html.match(/<button [^>]*data-testid="mh-player-upcoming-more"[^>]*>([^<]*)<\/button>/);

/** Mount the island with EXACTLY the props the server component hands it. */
const island = (rows: PlayerUpcomingRow[], dict: Dict = en as Dict, locale: Locale = "en") => {
  const el = walk(PlayerUpcoming({ rows, dict, locale })).find((e) => e.type === UpcomingReveal);
  expect(el, "the reveal island is mounted").toBeDefined();
  const h = renderIsland(UpcomingReveal, propsOf(el!) as unknown as UpcomingRevealProps);
  const top = () => (h.tree()[0]!.props as { children: ReactElement[] }).children;
  const button = () => h.tree().find((e) => e.type === "button");
  return {
    /** The fragment's own children: list, then button — the SAME places in both states. */
    top,
    button,
    lists: () => h.tree().filter((e) => e.type === "ul"),
    ids: () =>
      h
        .tree()
        .map((e) => propsOf(e)["data-testid"])
        .filter((id): id is string => typeof id === "string" && id.startsWith("mh-player-upcoming-row-"))
        .map((id) => id.slice("mh-player-upcoming-row-".length)),
    click: () => (propsOf(button()!).onClick as () => void)(),
    text: () => textOf(h.tree()[0]),
  };
};

/** The text a screen reader gets: aria-hidden subtrees dropped, then every tag. */
const spokenText = (html: string) =>
  html.replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "");

describe("PlayerUpcoming", () => {
  it("EMPTY: renders nothing at all (the page shows no section)", () => {
    expect(render([])).toBe("");
  });

  it("R3: five are shown, the rest wait behind the toggle", () => {
    expect(UPCOMING_VISIBLE).toBe(5);
  });

  it("exactly five rows: all shown in one list, and no toggle", () => {
    const html = render(seven.slice(0, 5));
    expect(rowIds(html)).toEqual(["a", "b", "c", "d", "e"]);
    expect(html.match(/<ul\b/g)).toHaveLength(1);
    expect(html).not.toContain("<button");
    expect(html).not.toContain('data-testid="mh-player-upcoming-more"');
  });

  it("seven rows, as served (SSR, and no JS): ONE list of the first five in the reader's order, then a collapsed BUTTON counting TWO", () => {
    const html = render(seven);
    expect(rowIds(html)).toEqual(["a", "b", "c", "d", "e"]);
    expect(html.match(/<ul\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<details\b|<summary\b/);
    expect(html).toContain(`<ul id="${UPCOMING_LIST_ID}"`);
    const toggle = toggleIn(html);
    expect(toggle, "the toggle is a real <button>").not.toBeNull();
    expect(toggle![0]).toContain('type="button"');
    expect(toggle![0]).toContain('aria-expanded="false"');
    expect(toggle![0]).toContain(`aria-controls="${UPCOMING_LIST_ID}"`);
    expect(toggle![1]).toBe(esc(interpolate(en["player.upcoming.showMore"], { count: 2 })));
    // BELOW the last visible row, outside the list.
    expect(html.indexOf("<button")).toBeGreaterThan(html.indexOf("</ul>"));
  });

  it("the toggle: open puts rows 6+ straight under row 5 in the SAME list, flips aria-expanded and the label; closing puts them away", () => {
    const u = island(seven);
    const more = interpolate(en["player.upcoming.showMore"], { count: 2 });
    expect(u.ids()).toEqual(["a", "b", "c", "d", "e"]);
    expect(propsOf(u.button()!)["aria-expanded"]).toBe(false);
    expect(textOf(u.button())).toBe(more);

    u.click();
    expect(u.ids()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(u.lists()).toHaveLength(1);
    expect(propsOf(u.button()!)["aria-expanded"]).toBe(true);
    expect(propsOf(u.button()!)["aria-controls"]).toBe(UPCOMING_LIST_ID);
    expect(propsOf(u.lists()[0]!).id).toBe(UPCOMING_LIST_ID);
    expect(textOf(u.button())).toBe(en["player.upcoming.showLess"]);

    u.click();
    expect(u.ids()).toEqual(["a", "b", "c", "d", "e"]);
    expect(propsOf(u.button()!)["aria-expanded"]).toBe(false);
    expect(textOf(u.button())).toBe(more);
  });

  it("focus survives a toggle: the button is the SAME element in the same place, open or closed (never unmounted or re-keyed)", () => {
    const u = island(seven);
    const shape = () => u.top().map((e) => [e.type, e.key]);
    const before = shape();
    expect(before).toEqual([
      ["ul", null],
      ["button", null],
    ]);
    u.click();
    expect(shape()).toEqual(before);
    expect(u.button()!.props).toMatchObject({ type: "button" });
  });

  it("a dated row shows the time in the VENUE zone; an undated row shows Time TBD instead", () => {
    const html = render([row("dated"), row("undated", { scheduledAt: null })]);
    const dated = html.slice(html.indexOf('mh-player-upcoming-row-dated"'), html.indexOf('mh-player-upcoming-row-undated"'));
    const undated = html.slice(html.indexOf('mh-player-upcoming-row-undated"'));
    expect(dated).toContain(">15:30<"); // 10:00Z in Asia/Kolkata — not the runtime's 10:00
    expect(dated).not.toContain('data-testid="mh-player-upcoming-tbc"');
    expect(undated).toContain('data-testid="mh-player-upcoming-tbc"');
    expect(undated).toContain(`>${esc(en["player.upcoming.timeTbd"])}<`);
    expect(undated).not.toContain('data-testid="mh-player-upcoming-time"');
  });

  it("the Other event chip rides ONLY the other competition's rows", () => {
    const html = render([row("home"), row("away", { isOtherCompetition: true, competitionName: "Spring Open" })]);
    expect(html.match(/data-testid="mh-player-upcoming-other"/g)).toHaveLength(1);
    const away = html.slice(html.indexOf('mh-player-upcoming-row-away"'));
    expect(away).toContain(`>${esc(en["player.upcoming.otherEvent"])}<`);
  });

  it("every row links to its fixture, names competition and division as SEPARATE elements, and the opponent with the Matches grammar", () => {
    const html = render([row("x", { courtLabel: "Court 3", venue: "Riverside Hall" })]);
    expect(html).toContain('href="/shared/riverside/autumn-cup/premier/fixtures/x"');
    expect(html).toContain(">Autumn Cup<");
    expect(html).toContain(">Premier<");
    expect(html).toContain(`>${esc(interpolate(en["player.opponent"], { opponent: "Opponent x" }))}<`);
    expect(html).toContain('data-testid="mh-player-upcoming-court"');
    expect(html).toContain(">Court 3<");
    expect(html).toContain(">Riverside Hall<");
  });

  it("the truncation chain: the link and the text column carry min-w-0, long text truncates", () => {
    const html = render([row("x")]);
    expect(html).toMatch(/data-testid="mh-player-upcoming-row-x" class="[^"]*\bmin-w-0\b/);
    // The text column: the grid's second cell, whose first child is the opponent line.
    expect(html).toMatch(/<span class="[^"]*\bmin-w-0\b[^"]*"><span class="[^"]*\btruncate\b[^"]*">[^<]*Opponent x</);
    expect(html).toMatch(/class="[^"]*\btruncate\b[^"]*"[^>]*>[^<]*Opponent x</);
  });

  it("the date tile writes day and month in the VENUE zone (20:00Z is 2 Jul 01:30 in Kolkata, still 1 Jul in UTC)", () => {
    const ISO = "2030-07-01T20:00:00.000Z";
    const at = (timeZone: string, opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(intlLocaleFor("en"), { timeZone, ...opts }).format(Date.parse(ISO));
    const day = at("Asia/Kolkata", { day: "numeric" });
    const month = at("Asia/Kolkata", { month: "short" });
    expect(day, "premise: the venue day differs from the UTC day").not.toBe(at("UTC", { day: "numeric" }));
    const html = render([row("late", { scheduledAt: ISO })]);
    const late = html.slice(html.indexOf('mh-player-upcoming-row-late"'));
    expect(late).toContain(`>${esc(day)}<`);
    expect(late).toContain(`>${esc(month)}<`);
    expect(late).toContain(">01:30<");
  });

  it("competition and division are spoken as two words: the separator is aria-hidden, the spaces are not", () => {
    const html = render([row("x")]);
    const where = html.slice(html.indexOf('data-testid="mh-player-upcoming-where"'));
    expect(where).toContain('aria-hidden="true"');
    expect(spokenText(where)).toMatch(/Autumn Cup\s+Premier/);
  });

  it.each([
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["nl", nl],
  ] as const)("%s: Time TBD is the SAME words the match centre and the matches hub already use", (_locale, dict) => {
    expect(dict["player.upcoming.timeTbd"]).toBe(dict["matchesHub.timeTbd"]);
    expect(dict["player.upcoming.timeTbd"]).toBe(dict["matchCentre.status.timeTbd"]);
  });

  it.each([
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["nl", nl],
  ] as const)("%s: every new word is that locale's own dictionary value, never a dotted key", (locale, dict) => {
    // The TBD and Other-event rows sit inside the first five, so the served
    // markup carries them; the last two wait behind the toggle.
    const rows = [row("tbc", { scheduledAt: null }), row("other", { isOtherCompetition: true }), ...seven.slice(0, 5)];
    const html = render(rows, dict as Dict, locale);
    expect(html).toContain(`>${esc(dict["player.upcoming.timeTbd"])}<`);
    expect(html).toContain(`>${esc(dict["player.upcoming.otherEvent"])}<`);
    expect(html).toContain(`>${esc(interpolate(dict["player.upcoming.showMore"], { count: 2 }))}<`);
    expect(html).not.toContain("player.upcoming.");
    const u = island(rows, dict as Dict, locale);
    u.click();
    expect(textOf(u.button())).toBe(dict["player.upcoming.showLess"]);
    expect(u.text()).not.toContain("player.upcoming.");
  });
});
