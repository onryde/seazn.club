// W4 app B, B5b Task 13 (X-CH-1, X-CH-4; owner pick 3A) - the PUBLIC wording for a final the organiser ruled joint winners:
// the bracket tile ("Joint winners" under ONE trophy, both seats weighted), the schedule row (the label in the result's
// place), and the vacant title's muted line. The labels are the dictionaries' own, read per locale, never typed here.
// Node env: markup assertions anchored on `="`. The 320 fit with a 43-character name is judged in the browser.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Bracket, type BracketCopy } from "@/components/public-site/bracket";
import { Schedule } from "@/components/public-site/schedule";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import type { PublicFixture } from "@/server/public-site/data";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const LONG = "Harbourside Shuttlers Badminton Club Ladies"; // 43 characters
const NAMES = { e1: LONG, e2: "Canada", e3: "Japan", e4: "Chile" };
const AT = "2026-11-10T12:00:00.000Z";
const WIN = (w: string, l: string) => ({ kind: "win", winner: w, loser: l });

const F = (id: string, over: Partial<PublicFixture> & Record<string, unknown> = {}): PublicFixture =>
  ({
    id, division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2",
    home_slot_label: null, away_slot_label: null, scheduled_at: "2026-11-10T10:00:00.000Z", venue: null, court_label: null,
    venue_name: null, court_name: null, status: "scheduled", outcome: null, summary: null, last_seq: null,
    lane: null, is_final: false, third_place: false, conditional: false, joint_winners_at: null, ...over,
  }) as PublicFixture;

/** A 4-entrant knockout, final ruled by `finalOver`. */
const bracketFixtures = (finalOver: Record<string, unknown>): PublicFixture[] => [
  F("s1", { round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e4", status: "decided", outcome: WIN("e1", "e4") as never }),
  F("s2", { round_no: 1, seq_in_round: 2, home_entrant_id: "e2", away_entrant_id: "e3", status: "decided", outcome: WIN("e2", "e3") as never }),
  F("fin", { round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", is_final: true, ...finalOver }),
];

const JOINT = { status: "decided", joint_winners_at: AT, outcome: null };
const VACANT = { status: "forfeited", outcome: { kind: "double_walkover" } };

async function renderBracket(locale: (typeof LOCALES)[number], fx: PublicFixture[]): Promise<{ html: string; lookup: (k: never) => string; copy: BracketCopy }> {
  const lookup = ((k: never) => msgFor(locale, k)) as never as (k: never) => string;
  const copy = publicScheduleCopy(await getDictionary(locale, "public"), lookup as never);
  const slotText = (_s: string, label: SlotLabel | null) => resolveSlotLabel(label, lookup as never, "schedule.tbd");
  const html = renderToStaticMarkup(
    createElement(Bracket, { kind: "knockout", fixtures: fx as never, entrantNames: NAMES, fixtureHref: (id: string) => `/f/${id}`, lookup: lookup as never, slotText, copy, tz: "UTC", locale }),
  );
  return { html, lookup, copy };
}
const card = (html: string, id: string): string => {
  const m = html.match(new RegExp(`<a[^>]*href="/f/${id}"[^>]*>([\\s\\S]*?)</a>`));
  expect(m, `the card for ${id} rendered`).not.toBeNull();
  return m![1]!;
};

describe("B5b T13: the public bracket tile (pick 3A)", () => {
  it("a joint final reads the locale's 'Joint winners' under ONE trophy, both names weighted, no score row, in all four locales", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const { html, lookup } = await renderBracket(locale, bracketFixtures(JOINT));
      const tile = card(html, "fin");
      expect(tile, locale).toContain('data-testid="bracket-title-joint"');
      expect(tile, `${locale}: the dictionary's own label`).toContain(`>${lookup("bracket.jointWinners" as never)}<`);
      expect(tile.split("🏆").length - 1, `${locale}: ONE trophy`).toBe(1);
      expect(tile, `${locale}: no vacant line`).not.toContain("bracket-title-vacant");
      // Both seated names carry the winner's weight - and no name is muted (a joint final has no loser).
      const weighted = [...tile.matchAll(/<span title="([^"]*)" class="([^"]*)">/g)].map((m) => [m[1]!, m[2]!] as const);
      expect(weighted.map(([n]) => n), locale).toEqual([LONG, "Canada"]);
      for (const [n, cls] of weighted) {
        expect(cls, `${locale}: ${n} weighted`).toContain("font-semibold");
        expect(cls, `${locale}: ${n} not muted`).not.toContain("text-ink-muted");
      }
      // The 43-character name is not clipped by the label: it is whole in its own title and text.
      expect(tile).toContain(`>${LONG}<`);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a vacant title reads the locale's muted 'Title vacant' with no trophy; the double-walkover tag does not repeat beside it", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const { html, lookup } = await renderBracket(locale, bracketFixtures(VACANT));
      const tile = card(html, "fin");
      expect(tile, locale).toContain('data-testid="bracket-title-vacant"');
      expect(tile, locale).toContain(`>${lookup("bracket.titleVacant" as never)}<`);
      expect(tile, `${locale}: no trophy`).not.toContain("🏆");
      expect(tile, `${locale}: not the joint row`).not.toContain("bracket-title-joint");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the negative pairs: an unplayed final, a final with a winner and the semi of a joint bracket carry neither title", async () => {
    const open = (await renderBracket("en", bracketFixtures({}))).html;
    const won = (await renderBracket("en", bracketFixtures({ status: "decided", outcome: WIN("e1", "e2") as never }))).html;
    const joint = (await renderBracket("en", bracketFixtures(JOINT))).html;
    for (const [what, html, id] of [["unplayed", open, "fin"], ["winner", won, "fin"], ["semi of a joint bracket", joint, "s1"]] as const) {
      const c = card(html, id);
      expect(c, what).not.toContain("bracket-title");
      expect(c, what).not.toContain("🏆");
    }
  });
});

describe("B5b T13: the public schedule row", () => {
  const COPY_KEYS = ["jointWinners"] as const;
  async function renderRow(locale: (typeof LOCALES)[number], fixtures: PublicFixture[]) {
    const dict = await getDictionary(locale, "public");
    const copy = publicScheduleCopy(dict, ((k: never) => msgFor(locale, k)) as never);
    const html = renderToStaticMarkup(
      createElement(Schedule, { fixtures, entrantNames: NAMES, divisionPath: "/o/c/d", tz: "UTC", slotLabels: {}, roundLabels: {}, stageOrder: { s1: 1 }, stageNames: { s1: "Knockout" }, copy, locale } as never),
    );
    const row = (id: string) => html.match(new RegExp(`<a [^>]*href="/o/c/d/fixtures/${id}"[^>]*>([^]*?)</a>`))?.[1] ?? "";
    return { html, row, dict, copy };
  }

  it("the copy: publicScheduleCopy hands the banner's own words (title.joint) in every locale", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = await getDictionary(locale, "public");
      const copy = publicScheduleCopy(dict, ((k: never) => msgFor(locale, k)) as never);
      for (const k of COPY_KEYS) {
        expect(copy[k], `${locale} ${k}`).toBe(t(dict, "title.joint"));
        expect(copy[k]!.length).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("a joint final's row says 'Joint winners' with ONE trophy where a result would be; its stray side lines are not shown; both names weighted", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const joint = F("f1", { ...JOINT, round_no: 2, is_final: true, summary: { headline: "1 — 0", perSide: [{ entrantId: "e1", line: "1" }, { entrantId: "e2", line: "0" }] } as never });
      const { row, dict } = await renderRow(locale, [joint]);
      const r = row("f1");
      expect(r, `${locale}: the row rendered`).not.toBe("");
      expect(r, locale).toContain('data-testid="schedule-joint-winners"');
      expect(r, locale).toContain(`>${t(dict, "title.joint")}<`);
      expect(r.split("🏆").length - 1, `${locale}: ONE trophy`).toBe(1);
      expect(r, `${locale}: the abandoned game's side lines are not a result`).not.toContain('data-testid="schedule-score"');
      expect(r.match(/font-semibold leading-6 text-ink/g)?.length, `${locale}: both names weighted`).toBe(2);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the negative pair: a decided final with a winner, an unplayed final and a joint SEMI never wear the label", async () => {
    const { row } = await renderRow("en", [
      F("f1", { status: "decided", outcome: WIN("e1", "e2") as never, is_final: true, round_no: 2 }),
      F("f2", { is_final: true, round_no: 2, seq_in_round: 2 }),
      F("f3", { ...JOINT, is_final: false, seq_in_round: 3 }),
    ]);
    for (const id of ["f1", "f2", "f3"]) {
      expect(row(id), id).not.toBe("");
      expect(row(id), id).not.toContain("schedule-joint-winners");
    }
  });
});
