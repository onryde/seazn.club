// "Your recent quick matches" (plan 2 Task 9; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 5;
// pre-flight A9, A10, D11): the strip itself, over rows handed to it. The rows' READ (the visitor cookie, the alive
// predicate, newest first, the cap of 5, a damaged row skipped) is tested through the marketing page against a real
// database, `app/[lang]/(marketing)/__tests__/home-quick-match-cta.test.tsx` (B9: the src/app job runs it in CI).
//
// Expected values come from the spec and the owner's rulings, never from the strip: a home is `/q/<token>` (§7.4), an
// English date is day-month (owner ruling 2026-09-16, lib/public-date-locale.ts), and a link that paints a home token
// carries `ph-no-capture` (PostHog's one blocked class, lib/__tests__/scrub-secret-painters.test.ts).
//
// Sport: not applicable (the strip reads no sport; its rows carry a name and a date only, D11).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecentStrip, type RecentQuickMatch } from "../recent-strip";

const TITLE = "Your recent quick matches";
/** Home-token shaped (`qm_` + 43 base64url characters), as `mintHomeToken` writes them. */
const TOKEN_A = `qm_${"A".repeat(42)}a`;
const TOKEN_B = `qm_${"B".repeat(42)}b`;

const rows: RecentQuickMatch[] = [
  { token: TOKEN_A, name: "Friday doubles", createdAt: "2026-11-08T10:00:00.000Z", played: 1, total: 6 },
  { token: TOKEN_B, name: "Badminton · Thu 6 Nov", createdAt: "2026-11-06T18:30:00.000Z", played: 1, total: 1 },
];

const html = (items: readonly RecentQuickMatch[], lang = "en") =>
  renderToStaticMarkup(<>{RecentStrip({ lang, title: TITLE, items })}</>);

/** Every `<a …>` opening tag, in document order. */
const anchors = (markup: string) => [...markup.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
const hrefOf = (tag: string) => /\bhref="([^"]*)"/.exec(tag)?.[1];

describe("RecentStrip", () => {
  it("renders nothing with no rows (the empty case: a guest who never made one, or whose rows all expired)", () => {
    expect(RecentStrip({ lang: "en", title: TITLE, items: [] })).toBeNull();
  });

  it("one link per row, to the row's home `/q/<token>`, in the order it was handed (the read sorts; the strip never re-sorts)", () => {
    const tags = anchors(html(rows));
    expect(tags.map(hrefOf)).toEqual([`/q/${TOKEN_A}`, `/q/${TOKEN_B}`]);
    // The other order, so a strip that sorted by name or date itself could not pass both.
    expect(anchors(html([rows[1]!, rows[0]!])).map(hrefOf)).toEqual([`/q/${TOKEN_B}`, `/q/${TOKEN_A}`]);
  });

  it("every link paints a home token, so every link carries ph-no-capture (the recorder blocks exactly that class)", () => {
    const tags = anchors(html(rows));
    expect(tags).toHaveLength(rows.length);
    let checked = 0;
    for (const tag of tags) {
      expect(tag, "a strip link without ph-no-capture leaks the home token into session replay").toMatch(
        /\bclass="[^"]*\bph-no-capture\b[^"]*"/,
      );
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("each row shows its name and its created date, day-month in English, as a machine-readable <time> (D11)", () => {
    const markup = html(rows);
    expect(markup).toContain(">Friday doubles<");
    expect(markup).toContain(">Badminton · Thu 6 Nov<");
    expect(markup).toMatch(/<time dateTime="2026-11-08T10:00:00\.000Z"[^>]*>8 Nov<\/time>/);
    expect(markup).toMatch(/<time dateTime="2026-11-06T18:30:00\.000Z"[^>]*>6 Nov<\/time>/);
  });

  it("the date is the UTC calendar day whatever the server's zone: 23:30 UTC on the 8th reads the 8th", () => {
    const late = html([{ token: TOKEN_A, name: "Late one", createdAt: "2026-11-08T23:30:00.000Z", played: 0, total: 1 }]);
    expect(late).toMatch(/>8 Nov<\/time>/);
  });

  it("the date speaks the page's language: French is not English", () => {
    const fr = html(rows, "fr");
    expect(fr).toMatch(/<time dateTime="2026-11-08T10:00:00\.000Z"[^>]*>8 nov\.<\/time>/);
    expect(fr).not.toContain(">8 Nov<");
  });

  it("is a titled section: the heading names it for a screen reader", () => {
    const markup = html(rows);
    const id = /<h2\b[^>]*\bid="([^"]+)"[^>]*>Your recent quick matches<\/h2>/.exec(markup)?.[1];
    expect(id, "the title is an <h2> with an id").toBeTruthy();
    expect(markup).toContain(`aria-labelledby="${id}"`);
    expect(markup).toMatch(/<section\b[^>]*\bdata-testid="qm-recent"/);
  });

  it("a long name truncates instead of widening the page: min-w-0 down the chain, `truncate` on the name, 44px rows", () => {
    const long = "The Thursday night mixed doubles ladder at the community hall, second court";
    const markup = html([{ token: TOKEN_A, name: long, createdAt: "2026-11-08T10:00:00.000Z", played: 0, total: 1 }]);
    const tag = anchors(markup)[0]!;
    // The tap target: at least 44px tall (min-h-11), and allowed to shrink below its content's width.
    expect(tag).toMatch(/\bclass="[^"]*\bmin-h-11\b/);
    expect(tag).toMatch(/\bclass="[^"]*\bmin-w-0\b/);
    expect(markup).toMatch(new RegExp(`<span[^>]*class="[^"]*\\bmin-w-0\\b[^"]*\\btruncate\\b[^"]*"[^>]*>${long}</span>`));
    expect(markup).toMatch(/<li\b[^>]*class="[^"]*\bmin-w-0\b/);
    expect(markup).toMatch(/<ul\b[^>]*class="[^"]*\bmin-w-0\b/);
    expect(markup).toMatch(/<section\b[^>]*class="[^"]*\bmin-w-0\b/);
  });
});
