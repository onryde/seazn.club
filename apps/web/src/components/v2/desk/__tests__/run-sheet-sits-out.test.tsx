// W5 app PR A, Task 3 (X-SF-4; owner R24 pick 4 option A): the desk's round bar says who sits out - "Round 2 · 0 of 2 done · Sits out: Eve" -
// on a round-robin stage's card. Read off the real `RunSheet` the stage card mounts (`embedded`), with the lines `sitsOutByRound` builds from the
// ENGINE's own byes. Node env, no DOM (AGENTS.md class 2). Every sweep reports its count; zero is a failure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { sitsOutByRound } from "@/lib/sits-out";
import type { Dict } from "@/lib/i18n-constants";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const IDS = ["a", "b", "c", "d", "e"];
const NAMES: Record<string, string> = { a: "Ana", b: "Bo", c: "Cy", d: "Di", e: "Eve" };
const SCHEDULE = generateRoundRobin({ entrants: IDS, config: { legs: 1 } });
const BYES = SCHEDULE.rounds.flatMap((r) => (r.bye === undefined ? [] : [{ round_no: r.roundNo, entrant_id: r.bye }]));
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const FIXTURES: RunSheetFixture[] = SCHEDULE.fixtures.map((f, i) => ({
  id: `f${i + 1}`, stage_id: "s1", fixture_no: i + 1, round_no: f.roundNo, seq_in_round: f.court, scheduled_at: null, status: "scheduled",
  court_name: null, court_id: null, venue_name: null, officials: [], outcome: null, home_entrant_id: f.home, away_entrant_id: f.away,
  home_slot_label: null, away_slot_label: null, lane: null, is_final: false, third_place: false, conditional: false, ext_key: null,
}));
const STAGES = [{ id: "s1", seq: 1, kind: "league", name: "Table" }];

function sheet(sitsOut: ReadonlyMap<number, readonly string[]> | undefined, dict: Dict = enUi as unknown as Dict, locale: "en" | "es" | "fr" | "nl" = "en"): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <RunSheet
        blocks={buildRunSheet({ fixtures: FIXTURES, stages: STAGES, tz: "UTC", nowMs: NOW_MS })}
        stages={STAGES}
        tz="UTC"
        orgTz="UTC"
        nowMs={NOW_MS}
        matchMinutes={60}
        entrantNames={NAMES}
        canEdit
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter="all"
        onFilter={() => {}}
        stageId="s1"
        embedded
        {...(sitsOut ? { sitsOut } : {})}
      />
    </DictProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const bars = (html: string): string[] =>
  [...html.matchAll(/<header[^>]*data-testid="run-sheet-round-bar"[^>]*>([\s\S]*?)<\/header>/g)].map((m) => text(m[1]!).replace(/\s+·/g, " ·"));
const lineOf = (loc: string, names: string) => ({ en: `Sits out: ${names}`, es: `Descansa: ${names}`, fr: `Au repos : ${names}`, nl: `Vrij: ${names}` })[loc]!;

describe("desk round bar: Sits out (X-SF-4)", () => {
  it("the empty case first: no sitsOut prop draws no line; the five bars still render", () => {
    const got = bars(sheet(undefined));
    expect(got).toHaveLength(5);
    for (const b of got) expect(b).not.toContain("Sits out");
  });

  it("each round's bar ends with its resting team, after 'x of y done' (derived from the engine's own byes)", () => {
    const got = bars(sheet(sitsOutByRound(BYES, NAMES, new Set())));
    expect(got).toHaveLength(5);
    SCHEDULE.rounds.forEach((r, i) => {
      expect(got[i], `round ${r.roundNo}`).toBe(`Round ${r.roundNo} · 0 of 2 done · Sits out: ${NAMES[r.bye!]}`);
    });
  });

  it("a withdrawn team's round has no line (the departed set is the caller's)", () => {
    const roundOfC = BYES.find((b) => b.entrant_id === "c")!.round_no;
    const got = bars(sheet(sitsOutByRound(BYES, NAMES, new Set(["c"]))));
    expect(got).toHaveLength(5);
    expect(got[roundOfC - 1], "Cy withdrew").toBe(`Round ${roundOfC} · 0 of 2 done`);
    expect(got.filter((b) => b.includes("Sits out")), "the other four are named").toHaveLength(4);
  });

  it("the line is in the viewer's words in all four locales", () => {
    let checked = 0;
    for (const [loc, dict] of [["en", enUi], ["es", esUi], ["fr", frUi], ["nl", nlUi]] as const) {
      const got = bars(sheet(sitsOutByRound(BYES, NAMES, new Set()), dict as unknown as Dict, loc));
      expect(got).toHaveLength(5);
      SCHEDULE.rounds.forEach((r, i) => {
        expect(got[i], `${loc} round ${r.roundNo}`).toContain(lineOf(loc, NAMES[r.bye!]!));
        checked += 1;
      });
    }
    expect(checked).toBe(20);
  });
});
