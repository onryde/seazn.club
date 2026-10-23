// The Streaming side's markup (components/billing-stream-credits.tsx): balance, the free meter, the buy tiles or the reason
// there are none, and the history as a reader sees it. Static markup — no DOM — so what is asserted is the CONTENT and the
// structure; the layout (stacked cards at 320, five columns at 768+, no horizontal page scroll) is walked in a browser by
// e2e/credits-tab-shots.spec.ts.
//
// Expected strings come from the dictionary FILES read off disk, never from the component's own keys: a label renamed in
// the component but not in the dictionary renders the key, and these tests see it.
//
// Mutant table (each applied once by hand):
//   V1 kind label      render `kind` instead of its label / drop a kind's key   → "every kind a ledger row can have is a plain-words sentence in all four locales"
//   V2 pack plural     use `t` for the pack row instead of `plural`              → "a pack row names how many credits it brought"
//   V3 fixture label   drop the TBD / Match n fallbacks                           → "a match with no entrants yet is named by its number; one side missing is TBD"
//   V4 meter fill      fill every segment / none                                  → "the meter counts the allowance: one segment per free credit, filled as they are used"
//   V5 offer           show the tiles whatever the offer                          → "with Stream off the tiles are replaced by the reason"
//   V6 empty           render the table for zero rows                             → "an empty ledger says so, and offers no export"
//   V7 pager           drop the cursor encode / the Latest link                   → "the pager"
//   V11 change colour  swap the spend / gain colours                              → "shows the date, the change with its sign, the balance after"
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getDictionary } from "@/lib/i18n";
import { STREAM_CREDIT_PACKS } from "@/lib/stream-credit-packs";
import { STREAM_HISTORY_KINDS, type StreamHistoryRow } from "@/server/usecases/stream-credit-history";
import type { StreamCreditsTabView } from "@/server/usecases/stream-credits-tab";
import { BillingStreamCredits } from "@/components/billing-stream-credits";

const LOCALES = ["en", "nl", "fr", "es"] as const;
type Loc = (typeof LOCALES)[number];

const dictFile = (loc: Loc): Record<string, string> =>
  JSON.parse(readFileSync(path.join(process.cwd(), "src/dictionaries", loc, "ui.json"), "utf8"));
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
// HTML-escape what the renderer escapes, so an expected sentence with an apostrophe still matches its markup.
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

const row = (over: Partial<StreamHistoryRow> = {}): StreamHistoryRow => ({
  id: "00000000-0000-0000-0000-000000000001", dateIso: "2026-10-20T09:00:00.000Z", kind: "streamUsed", delta: -1, balanceAfter: 4,
  fixture: { homeName: "Hawks", awayName: "Owls", fixtureNo: 3, competitionName: "Autumn League", href: "/o/riverside/c/autumn/d/open/f/3" },
  ...over,
});
const view = (over: Partial<StreamCreditsTabView> = {}): StreamCreditsTabView => ({
  offer: "on", total: 7, monthly: 2, pack: 5, freeAllowance: 5, freeUsed: 3, freeResetsInDays: 11,
  history: { rows: [row()], nextCursor: null },
  ...over,
});

async function markup(v: StreamCreditsTabView, loc: Loc = "en", extra: { notice?: "paid" | "processing" | null; cursor?: string } = {}): Promise<string> {
  const dict = await getDictionary(loc, "ui");
  return renderToStaticMarkup(
    <BillingStreamCredits
      view={v} dict={dict} locale={loc} orgId="org-1" orgSlug="riverside" currency="gbp"
      notice={extra.notice ?? null} cursor={extra.cursor}
    />,
  );
}

describe("BillingStreamCredits — the history's words", () => {
  it("every kind a ledger row can have is a plain-words sentence in all four locales — never its key, never its raw name (V1, V2)", async () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const d = dictFile(loc);
      for (const kind of STREAM_HISTORY_KINDS) {
        const delta = kind === "packPurchase" ? 5 : kind === "streamUsed" || kind === "expired" ? -1 : 1;
        const out = await markup(view({ history: { rows: [row({ kind, delta, fixture: null })], nextCursor: null } }), loc);
        const want =
          kind === "packPurchase"
            ? fill(d["settings.credits.stream.kind.packPurchase.other"]!, { count: 5 })
            : d[`settings.credits.stream.kind.${kind}`]!;
        expect(want, `${loc}/${kind}: the dictionary has the sentence`).toBeTruthy();
        expect(out, `${loc}/${kind}`).toContain(esc(want));
        expect(out, `${loc}/${kind}: the key leaked`).not.toContain("settings.credits.stream.kind");
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * STREAM_HISTORY_KINDS.length);
  });

  it("a pack of one is the singular, a pack of five the plural (V2)", async () => {
    const d = dictFile("en");
    for (const [n, key] of [[1, "one"], [5, "other"]] as const) {
      const out = await markup(view({ history: { rows: [row({ kind: "packPurchase", delta: n, fixture: null })], nextCursor: null } }));
      expect(out).toContain(esc(fill(d[`settings.credits.stream.kind.packPurchase.${key}`]!, { count: n })));
    }
  });

  it("the kind sentences are distinct — two kinds never read the same to a person", () => {
    for (const loc of LOCALES) {
      const d = dictFile(loc);
      const sentences = STREAM_HISTORY_KINDS.map((k) => (k === "packPurchase" ? d["settings.credits.stream.kind.packPurchase.other"]! : d[`settings.credits.stream.kind.${k}`]!));
      expect(new Set(sentences).size, loc).toBe(STREAM_HISTORY_KINDS.length);
    }
  });
});

describe("BillingStreamCredits — a history row", () => {
  it("shows the date, the change with its sign, the balance after, and links the match it was for", async () => {
    const out = await markup(view({
      history: { rows: [row(), row({ id: "2", kind: "packPurchase", delta: 5, balanceAfter: 9, fixture: null, dateIso: "2026-10-01T00:00:00.000Z" })], nextCursor: null },
    }));
    expect(out).toContain('<time dateTime="2026-10-20T09:00:00.000Z">Oct 20, 2026</time>');
    expect(out).toContain('<time dateTime="2026-10-01T00:00:00.000Z">Oct 1, 2026</time>');
    expect(out).toContain(">-1<");
    expect(out).toContain(">+5<");
    // a spend is quiet, a gain is green (V11) — read off the cell that carries the number
    expect(out).toMatch(/text-slate-700">-1</);
    expect(out).toMatch(/text-emerald-700">\+5</);
    expect(out).toContain('href="/o/riverside/c/autumn/d/open/f/3"');
    expect(out).toContain("Hawks v Owls");
    expect(out).toContain("Autumn League");
    expect((out.match(/data-testid="credits-stream-row"/g) ?? []).length).toBe(2);
    // only the match row carries a link into a fixture
    expect((out.match(/\/f\/3"/g) ?? []).length).toBe(1);
  });

  it("a match with no entrants yet is named by its number; one side missing is TBD (V3)", async () => {
    const f = { homeName: null, awayName: null, fixtureNo: 12, competitionName: "L", href: "/x" };
    expect(await markup(view({ history: { rows: [row({ fixture: f })], nextCursor: null } }))).toContain("Match 12");
    const half = await markup(view({ history: { rows: [row({ fixture: { ...f, homeName: "Hawks" } })], nextCursor: null } }));
    expect(half).toContain("Hawks v TBD");
    expect(half).not.toContain("Match 12");
  });

  it("is ONE structure: a table with five column headers and one row per ledger row of exactly five cells, the header row and the empty-match placeholder hidden below lg", async () => {
    const rows = [row({ id: "1" }), row({ id: "2" }), row({ id: "3", fixture: null, kind: "monthlyGrant", delta: 5 })];
    const out = await markup(view({ history: { rows, nextCursor: null } }));
    expect(out).toContain('role="table"');
    expect((out.match(/role="columnheader"/g) ?? []).length).toBe(5);
    expect((out.match(/data-testid="credits-stream-row"/g) ?? []).length).toBe(rows.length);
    expect((out.match(/<div role="rowgroup" class="max-lg:hidden">/g) ?? []).length, "the header rowgroup, hidden below lg").toBe(1);
    // each row has EXACTLY five cells — a row with a match and a row without one alike, so the columns line up under the headers
    const chunks = out.split('data-testid="credits-stream-row"').slice(1);
    expect(chunks).toHaveLength(rows.length);
    for (const [i, chunk] of chunks.entries()) {
      expect((chunk.match(/role="cell"/g) ?? []).length, `row ${i + 1}`).toBe(5);
    }
    // the row with no match keeps its column: a dash that is hidden on the stacked card (it has nothing to say there)
    expect(chunks[2]).toContain('<div role="cell" class="text-sm text-slate-500 max-lg:hidden">—</div>');
    expect(chunks[0]).not.toContain("—");
  });

  it("the table starts at lg, not md: the Settings rail leaves a 768px card ~490px wide, too narrow for five columns (m4)", async () => {
    const out = await markup(view({ history: { rows: [row()], nextCursor: null } }));
    expect(out, "the wide shape is lg's").toMatch(/lg:grid-cols-\[7rem_minmax\(0,1\.2fr\)_minmax\(0,1\.6fr\)_4rem_6rem\]/);
    // …and no md-keyed class survives in the HISTORY (the pack tiles above it are a different grid and keep theirs)
    const history = out.split('data-testid="credits-stream-history"')[1] ?? "";
    expect(history.length, "anti-vacuity: the history section was found").toBeGreaterThan(200);
    expect(history, "no md-keyed layout class survives in the history").not.toMatch(/(?:^|[\s"])(?:max-)?md:/);
  });
});

describe("BillingStreamCredits — balance and the free meter", () => {
  it("says the balance in match credits, singular for one", async () => {
    expect(await markup(view({ total: 7 }))).toContain(">7 match credits<");
    expect(await markup(view({ total: 1 }))).toContain(">1 match credit<");
    expect(await markup(view({ total: 0 }))).toContain(">0 match credits<");
  });

  it("the meter counts the allowance: one segment per free credit, filled as they are used (V4)", async () => {
    let checked = 0;
    for (const [cap, used] of [[1, 0], [1, 1], [5, 0], [5, 3], [5, 5], [12, 4], [20, 20]] as const) {
      const out = await markup(view({ freeAllowance: cap, freeUsed: used }));
      const meter = out.split('data-testid="credits-stream-meter"')[1]?.split("</div>")[0] ?? "";
      expect((meter.match(/<span/g) ?? []).length, `${used}/${cap} segments`).toBe(cap);
      const filled = (meter.match(/bg-(purple-500|amber-500)/g) ?? []).length;
      expect(filled, `${used}/${cap} filled`).toBe(used);
      expect(out).toContain(`${used} of ${cap} used`);
      checked++;
    }
    expect(checked).toBe(7);
    // amber at 90% and over, purple below — the AI meter's own threshold
    expect(await markup(view({ freeAllowance: 10, freeUsed: 9 }))).toContain("bg-amber-500");
    expect(await markup(view({ freeAllowance: 10, freeUsed: 8 }))).not.toContain("bg-amber-500");
  });

  it("past twenty free credits the meter is one continuous bar, still honest", async () => {
    const out = await markup(view({ freeAllowance: 30, freeUsed: 15 }));
    expect(out).not.toContain('data-testid="credits-stream-meter"');
    expect(out).toContain("width:50%");
    expect(out).toContain("15 of 30 used");
  });

  it("a plan with no free credits has no free meter at all — and still shows what was bought", async () => {
    const out = await markup(view({ freeAllowance: 0, freeUsed: 0, monthly: 0, pack: 3, total: 3 }));
    expect(out).not.toContain("Free this month");
    expect(out).not.toContain("credits-stream-meter");
    expect(out).toContain("Bought credits: 3");
    expect(out).toContain("never expire");
  });

  it("says when the unused free credits expire, singular for one day", async () => {
    expect(await markup(view({ freeResetsInDays: 11 }))).toContain("Unused free credits expire in 11 days");
    expect(await markup(view({ freeResetsInDays: 1 }))).toContain("Unused free credits expire in 1 day<");
  });
});

describe("BillingStreamCredits — buying", () => {
  it("with Stream on there is one tile per pack the catalogue sells, and no notice", async () => {
    const out = await markup(view({ offer: "on" }));
    expect(STREAM_CREDIT_PACKS.length).toBeGreaterThan(0);
    for (const pack of STREAM_CREDIT_PACKS) expect(out).toContain(`data-testid="credits-stream-buy-pack-${pack.size}"`);
    expect((out.match(/data-testid="credits-stream-buy-pack-/g) ?? []).length).toBe(STREAM_CREDIT_PACKS.length);
    expect(out).not.toContain('data-testid="credits-stream-notice"');
  });

  it("with Stream off the tiles are replaced by the reason (V5) — each reason its own sentence, in every locale", async () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const d = dictFile(loc);
      for (const [offer, key] of [["unavailable", "unavailable"], ["notIncluded", "notIncluded"]] as const) {
        const out = await markup(view({ offer }), loc);
        expect(out, `${loc}/${offer}`).not.toContain("credits-stream-buy-pack-");
        expect(out, `${loc}/${offer}`).toContain('data-testid="credits-stream-notice"');
        expect(out, `${loc}/${offer}`).toContain(esc(d[`settings.credits.stream.${key}`]!));
        checked++;
      }
    }
    expect(checked).toBe(8);
    // …and what the org holds is still on the page
    const held = await markup(view({ offer: "notIncluded", total: 5, pack: 5, monthly: 0, freeAllowance: 0 }));
    expect(held).toContain(">5 match credits<");
  });

  it("the return from Stripe is announced, in the words that match whether the credits are in", async () => {
    expect(await markup(view(), "en", { notice: "paid" })).toContain("Payment received. Your match credits are in your balance.");
    const processing = await markup(view(), "en", { notice: "processing" });
    expect(processing).toContain("Your payment is still processing.");
    expect(processing, "a payment that has not cleared is not 'received'").not.toContain("Payment received");
    expect(processing).toContain('data-testid="credits-stream-processing"');
    expect(processing).not.toContain('data-testid="credits-stream-paid"');
    const nothing = await markup(view());
    expect(nothing).not.toContain('data-testid="credits-stream-paid"');
    expect(nothing).not.toContain('data-testid="credits-stream-processing"');
    // all four locales carry both sentences, and neither is the other
    for (const loc of LOCALES) {
      const d = dictFile(loc);
      expect(d["settings.credits.stream.processing"], loc).toBeTruthy();
      expect(d["settings.credits.stream.processing"], loc).not.toBe(d["settings.credits.stream.paid"]);
      expect(await markup(view(), loc, { notice: "processing" }), loc).toContain(esc(d["settings.credits.stream.processing"]!));
      expect(d["settings.credits.stream.paidPending"], `${loc}: the old key is gone`).toBeUndefined();
    }
  });
});

describe("BillingStreamCredits — empty, export and paging", () => {
  it("an empty ledger says so and offers no export (V6)", async () => {
    const out = await markup(view({ total: 0, history: { rows: [], nextCursor: null } }));
    expect(out).toContain('data-testid="credits-stream-empty"');
    expect(out).toContain("No match credits yet.");
    expect(out).not.toContain('role="table"');
    expect(out).not.toContain('data-testid="credits-stream-export"');
    expect(out).not.toContain('data-testid="credits-stream-pager"');
  });

  it("a ledger with rows links its CSV export", async () => {
    const out = await markup(view());
    expect(out).toMatch(/<a[^>]*href="\/o\/riverside\/settings\/credits\/stream\.csv"[^>]*download=""[^>]*>|<a[^>]*download=""[^>]*href="\/o\/riverside\/settings\/credits\/stream\.csv"/);
    expect(out).not.toContain('data-testid="credits-stream-empty"');
  });

  it("the pager: Older on the first page of a long ledger, both ways in the middle, Latest on the last (V7)", async () => {
    const cursor = "MjAyNi0xMC0yMCAwOTowMDowMC4xMjM0NTYrMDB8dHwxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTE";
    const first = await markup(view({ history: { rows: [row()], nextCursor: cursor } }));
    expect(first).toContain(`href="/o/riverside/settings/credits?kind=stream&amp;before=${cursor}"`);
    expect(first).toContain('data-testid="credits-stream-older"');
    expect(first).not.toContain('data-testid="credits-stream-latest"');

    const middle = await markup(view({ history: { rows: [row()], nextCursor: cursor } }), "en", { cursor: "abc" });
    expect(middle).toContain('data-testid="credits-stream-older"');
    expect(middle).toContain('data-testid="credits-stream-latest"');
    expect(middle).toContain('href="/o/riverside/settings/credits?kind=stream"');

    const last = await markup(view({ history: { rows: [row()], nextCursor: null } }), "en", { cursor: "abc" });
    expect(last).not.toContain('data-testid="credits-stream-older"');
    expect(last).toContain('data-testid="credits-stream-latest"');

    const only = await markup(view({ history: { rows: [row()], nextCursor: null } }));
    expect(only).not.toContain('data-testid="credits-stream-pager"');
  });

  it("a cursor with characters a URL would mangle is encoded into the Older link", async () => {
    const out = await markup(view({ history: { rows: [row()], nextCursor: "a b&c" } }));
    expect(out).toContain("before=a%20b%26c");
  });
});

describe("the dictionary — Streaming side keys", () => {
  it("all four locales carry every key the English side does, with the same {placeholders}", () => {
    const en = dictFile("en");
    const keys = Object.keys(en).filter((k) => k.startsWith("settings.credits."));
    expect(keys.length).toBeGreaterThan(30);
    let checked = 0;
    for (const loc of LOCALES.filter((l) => l !== "en")) {
      const d = dictFile(loc);
      for (const k of keys) {
        expect(d[k], `${loc} ${k}`).toBeTruthy();
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(vars(d[k]!), `${loc} ${k} placeholders`).toEqual(vars(en[k]!));
        checked++;
      }
    }
    expect(checked).toBe(keys.length * 3);
  });
});
