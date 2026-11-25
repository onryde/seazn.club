// Online Chess credits, Step 1b (spec 2026-11-23-online-chess-credits-design.md §8.8; plan Task 12): an online division that still owes its package
// carries a "Not paid" flag on the competition page's divisions list, an amber link to the division's Fixtures tab. The flag is the ORGANISER's: a
// view-only reader never sees it, and a row that owes nothing never carries it. node vitest, so this reads the static markup (the page's own wiring is
// pinned in app/o/[orgSlug]/c/[compSlug]/__tests__/competition-page-online-unpaid.test.tsx).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { DivisionLedger, type LedgerRow } from "@/components/v2/desk/division-ledger";
import { routes } from "@/lib/routes";
import { t } from "@/lib/i18n";
import type { DeskDivision } from "@/server/usecases/competition-desk";

const desk: DeskDivision = {
  phase: "setting_up", attention: [], played: 0, total: 0, unscheduled: 0, in_play: 0, entrants: 3, next: null, needs_draw_stage: null,
  fixture_names: {}, display_tz: "UTC",
};
const row = (slug: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  id: `id-${slug}`, name: `Chess ${slug}`, slug, sportKey: "boardgame", logoUrl: null, desk, statusLine: "0 of 0 played", ...extra,
});
const render = (rows: LedgerRow[], canEdit: boolean, dict = en) =>
  renderToStaticMarkup(<DivisionLedger page={1} showFinished canEdit={canEdit} dict={dict} org="org" comp="comp" locale="en" now="2026-11-24T09:00:00Z" rows={rows} />);
const flags = (html: string) => html.match(/data-testid="online-unpaid-flag"/g)?.length ?? 0;

describe("the divisions list's Online Chess 'Not paid' flag", () => {
  it("an unpaid row carries the flag on BOTH of its renderings (phone card and desktop row), each a link to the division's Fixtures tab", () => {
    const html = render([row("alpha", { onlineUnpaid: true })], true);
    expect(flags(html), "one per rendering: the phone card and the desktop row").toBe(2);
    const href = routes.division("org", "comp", "alpha", "fixtures");
    const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*data-testid="online-unpaid-flag"|<a [^>]*data-testid="online-unpaid-flag"[^>]*href="([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    expect(links).toEqual([href, href]);
    expect(href).toBe("/o/org/c/comp/d/alpha?tab=fixtures");
    expect(html).toContain(t(en, "onlineChess.flag.text"));
  });

  it("a row that owes nothing, or that does not say, carries none (the empty case: no flagged row, no flag)", () => {
    expect(flags(render([row("a"), row("b", { onlineUnpaid: false })], true))).toBe(0);
  });

  it("only the unpaid row of several is flagged, and the flag sits in ITS row", () => {
    const html = render([row("paid", { onlineUnpaid: false }), row("owes", { onlineUnpaid: true }), row("other")], true);
    const rows = html.split('data-testid="desk-ledger-row"').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map(flags)).toEqual([0, 2, 0]);
  });

  it("a view-only reader never sees it, even on an unpaid row (the organiser's flag)", () => {
    const html = render([row("owes", { onlineUnpaid: true })], false);
    expect(flags(html)).toBe(0);
    expect(html).not.toContain(t(en, "onlineChess.flag.text"));
    expect(render([row("owes", { onlineUnpaid: true })], true), "the editor's pair: the flag IS drawn for the same row").toContain(t(en, "onlineChess.flag.text"));
  });

  it("is a SIBLING of the row's own link, never nested inside it (no <a> in an <a>)", () => {
    const html = render([row("alpha", { onlineUnpaid: true })], true);
    // Every anchor opens and closes before the next opens.
    let depth = 0;
    let deepest = 0;
    for (const m of html.matchAll(/<a[\s>]|<\/a>/g)) {
      depth += m[0] === "</a>" ? -1 : 1;
      deepest = Math.max(deepest, depth);
    }
    expect(depth).toBe(0);
    expect(deepest).toBe(1);
  });

  it("reads in each of the four languages (never hardcoded English)", () => {
    for (const [name, dict] of [["es", es], ["fr", fr], ["nl", nl]] as const) {
      const html = render([row("owes", { onlineUnpaid: true })], true, dict as typeof en);
      expect(html, name).toContain(t(dict as typeof en, "onlineChess.flag.text"));
      expect(t(dict as typeof en, "onlineChess.flag.text"), `${name} is translated`).not.toBe(t(en, "onlineChess.flag.text"));
    }
  });
});
