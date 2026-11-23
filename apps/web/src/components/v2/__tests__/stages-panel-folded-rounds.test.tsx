// W5 follow-ups C (owner 2026-11-23, Option A "by round"): a big division's StagesPanel gets the shipped rows plus a TALLY of the folded
// rounds (`lib/run-sheet-paging.ts`). Windowing must not move a single figure the organiser reads: the stage's counts line, every round
// bar's "N of M done" (in order), and the Unscheduled chip read the same from the window as from the whole list. A differential test -
// the whole-list render is the expected value, never a number typed here.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import { windowRunSheet } from "@/lib/run-sheet-paging";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const NOW = Date.now();
const DAY = 86_400_000;
const STAGE = { id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" };
/** A 22-player single league (231 lines, over the paging line): rounds 1-5 played, round 6 part played, rounds 7-21 to come, and
 *  rounds 15-21 not yet given a time (so a folded round holds unscheduled matches). */
function league() {
  let n = 0;
  const rows = [];
  for (let round = 1; round <= 21; round++) {
    for (let seq = 1; seq <= 11; seq++) {
      n += 1;
      const done = round <= 5 || (round === 6 && seq <= 4);
      const at = round >= 15 ? null : new Date(done ? NOW - (10 - round) * DAY : NOW + (round + 2) * DAY).toISOString();
      rows.push({
        id: `f${n}`, division_id: "d1", stage_id: "s1", pool_id: null, fixture_no: n, round_no: round, seq_in_round: seq,
        status: done ? "decided" : "scheduled", scheduled_at: at, home_entrant_id: `e${seq}`, away_entrant_id: `e${seq + 11}`,
        outcome: done ? { kind: "win", winner: `e${seq}` } : null, home_slot_label: null, away_slot_label: null, court_id: null,
        court_name: null, venue_name: null, officials: [], lane: null, is_final: false, third_place: false, conditional: false, ext_key: null,
      });
    }
  }
  return rows;
}
const props = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div", stages: [STAGE],
  entrantNames: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`e${i + 1}`, `Player ${i + 1}`])),
  tz: "UTC", orgTz: "UTC", canExport: false, viewerPlan: "community" as const, canEdit: true, matchMinutes: 60,
};
/** The panel over loosely typed props: the scene's rows are plain objects, and each test passes a different subset. */
const Panel = StagesPanel as unknown as (p: Record<string, unknown>) => ReactElement;
const render = (p: Record<string, unknown>) =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Record<string, string>} locale="en">
      <Panel {...props} {...p} />
    </DictProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The stage card's counts line, as read. */
const countsLine = (html: string) => {
  const at = html.indexOf('data-testid="stage-progress"');
  return at === -1 ? null : text(html.slice(at, html.indexOf("</div>", at)));
};
/** Every round bar's "N of M done", in the order the card reads them. */
const doneWords = (html: string) => [...text(html).matchAll(/(\d+) of (\d+) done/g)].map((m) => m[0]);
/** The Unscheduled chip's count. */
const unscheduledChip = (html: string) => {
  const at = html.indexOf('data-filter="unscheduled"');
  return text(html.slice(at, html.indexOf("</button>", at)));
};

describe("C: windowing a big run sheet moves no figure the organiser reads", () => {
  it("premise: the window folds rounds, ships rows, and holds unscheduled matches in a fold", () => {
    const all = league();
    const w = windowRunSheet(all, [STAGE], { held: new Set(), nowMs: NOW, matchMinutes: 60, tz: "UTC" });
    expect(all.length).toBe(231);
    expect(w.folded.length, "most rounds fold").toBeGreaterThan(10);
    expect(w.shipped.length).toBeLessThan(all.length / 4);
    expect(w.folded.reduce((n, r) => n + r.unscheduled, 0), "some folded matches are unscheduled").toBe(77);
  });

  it("the counts line, every round's done words in order, and the Unscheduled chip read the same from the window as from the whole list", () => {
    const all = league();
    const w = windowRunSheet(all, [STAGE], { held: new Set(), nowMs: NOW, matchMinutes: 60, tz: "UTC" });
    const whole = render({ fixtures: all });
    const windowed = render({ fixtures: w.shipped, foldedRounds: w.folded });
    expect(countsLine(whole), "premise: the whole list has a counts line").not.toBeNull();
    expect(countsLine(windowed)).toBe(countsLine(whole));
    expect(doneWords(whole).length, "anti-vacuity: a bar per round").toBe(21);
    expect(doneWords(windowed)).toEqual(doneWords(whole));
    expect(unscheduledChip(windowed)).toBe(unscheduledChip(whole));
    expect(unscheduledChip(whole), "premise: the chip counts the 77 untimed matches").toContain("77");
  });

  it("with no folded rounds the panel renders exactly as before", () => {
    const all = league().slice(0, 50);
    expect(render({ fixtures: all, foldedRounds: [] })).toBe(render({ fixtures: all }));
  });
});
