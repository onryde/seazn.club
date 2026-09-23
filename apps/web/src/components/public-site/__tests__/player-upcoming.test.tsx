// Player profile — the Upcoming list (spec 2026-09-23, plan Task 2). A server
// component, so static markup IS what a spectator gets; the "Show N more"
// reveal is a native <details> (plan D2). Expected copy is read from each
// locale's own dictionary, never typed. Assertions anchor on `="`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { interpolate } from "@/lib/i18n-runtime";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { PlayerUpcomingRow } from "@/server/public-site/public-player-matches";
import { PlayerUpcoming, UPCOMING_VISIBLE } from "../player-upcoming";

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

/** The text a screen reader gets: aria-hidden subtrees dropped, then every tag. */
const spokenText = (html: string) =>
  html.replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "");

describe("PlayerUpcoming", () => {
  it("EMPTY: renders nothing at all (the page shows no section)", () => {
    expect(render([])).toBe("");
  });

  it("R3: five are shown, the rest wait behind the reveal", () => {
    expect(UPCOMING_VISIBLE).toBe(5);
  });

  it("exactly five rows: all shown, and no reveal", () => {
    const html = render(seven.slice(0, 5));
    expect(rowIds(html)).toEqual(["a", "b", "c", "d", "e"]);
    expect(html).not.toContain('data-testid="mh-player-upcoming-more"');
  });

  it("seven rows: the first five before the reveal, in the reader's order; two inside it; the summary counts TWO", () => {
    const html = render(seven);
    expect(rowIds(html)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    const reveal = html.indexOf('data-testid="mh-player-upcoming-rest"');
    expect(reveal).toBeGreaterThan(html.indexOf('data-testid="mh-player-upcoming-row-e"'));
    expect(reveal).toBeLessThan(html.indexOf('data-testid="mh-player-upcoming-row-f"'));
    expect(html).toContain(`>${esc(interpolate(en["player.upcoming.showMore"], { count: 2 }))}<`);
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

  it("the summary stays visible when open (it holds focus) and swaps its label: Show N more closed, Show less open", () => {
    const html = render(seven);
    expect(html).toMatch(/data-testid="mh-player-upcoming-rest" class="[^"]*\bgroup\b/); // group-open: is inert without it
    const summary = html.slice(html.indexOf('data-testid="mh-player-upcoming-more"'), html.indexOf("</summary>"));
    expect(summary).not.toMatch(/^data-testid="mh-player-upcoming-more" class="[^"]*group-open:hidden/);
    expect(summary).toContain(`class="group-open:hidden">${esc(interpolate(en["player.upcoming.showMore"], { count: 2 }))}<`);
    expect(summary).toContain(`class="hidden group-open:inline">${esc(en["player.upcoming.showLess"])}<`);
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
    const html = render(
      [...seven.slice(0, 5), row("tbc", { scheduledAt: null }), row("other", { isOtherCompetition: true })],
      dict as Dict,
      locale,
    );
    expect(html).toContain(`>${esc(dict["player.upcoming.timeTbd"])}<`);
    expect(html).toContain(`>${esc(dict["player.upcoming.otherEvent"])}<`);
    expect(html).toContain(`>${esc(interpolate(dict["player.upcoming.showMore"], { count: 2 }))}<`);
    expect(html).toContain(`>${esc(dict["player.upcoming.showLess"])}<`);
    expect(html).not.toContain("player.upcoming.");
  });
});
