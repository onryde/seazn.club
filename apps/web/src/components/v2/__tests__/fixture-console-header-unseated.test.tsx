// R116-4 (W2b Task 16; owner ruling 116) — the organiser console's header, which every run-sheet row links to, read
// "Bye vs Bears of Brockley · forfeited" for a withdrawn winner's dead seat walked over by the side that arrived. The
// page reads her through `unseatedForfeitLoser` and hands down `*_unseated_name` (stream-mount.test.tsx pins that);
// this pins that the header PRINTS it in her seat, either side, before the seat's stored bye label — and that a seat
// with no such name keeps the label it always had (a genuine bye, a DQ'd winner's dead seat).
//
// single-sport: generic — the header's names are the seats and the page's name, never the sport.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { msg } from "@/lib/messages";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const sport: SportInfo = {
  key: "generic",
  config: {},
  scorerLabel: "Scorer",
  positionGroups: [],
  roles: [],
  lineupSize: 1,
  benchMax: 0,
};
const BYE_LABEL = { key: "bracket.slot.bye", params: {} };
/** The bye word as the en dictionary prints it — the copy, never a literal typed here. */
const BYE = msg("bracket.slot.bye");
const VS = msg("schedule.vs");
const WITHDRAWN = msg("entrants.status.withdrawn");

function header(seat: "home" | "away", unseatedName: string | null, reason = "withdrew"): string {
  return text(headerHtml(seat, unseatedName, reason));
}
/** The header's words: a tag is a word break (the chip is its own element beside the name). */
const text = (h1: string) => h1.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function headerHtml(seat: "home" | "away", unseatedName: string | null, reason = "withdrew"): string {
  const arrived: SideInfo = { id: "e-arrived", name: "Bears of Brockley", members: [], lineup: [] };
  const live: LiveState = {
    status: "forfeited",
    last_seq: 0,
    summary: null,
    state: null,
    outcome: { kind: "award", winner: "e-arrived", loser: unseatedName === null ? null : "e-gone", reason: unseatedName === null ? "bye" : reason },
  };
  const html = renderToStaticMarkup(
    <FixtureConsole
      fixture={{
        id: "f1",
        status: "forfeited",
        scheduled_at: null,
        venue_name: null,
        court_name: null,
        round_no: 2,
        home_slot_label: seat === "home" ? BYE_LABEL : null,
        away_slot_label: seat === "away" ? BYE_LABEL : null,
        ...(seat === "home" ? { home_unseated_name: unseatedName } : { away_unseated_name: unseatedName }),
      }}
      sport={sport}
      home={seat === "home" ? null : arrived}
      away={seat === "away" ? null : arrived}
      initialState={live}
      initialEvents={[]}
      canEdit
      canOrganise
      stageKind="knockout"
      recorderNames={{}}
      audit={null}
      viewerPlan="community"
    />,
  );
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
  if (h1 === undefined) throw new Error("the console rendered no header");
  return /<h1[^>]*>[\s\S]*?<\/h1>/.exec(html)![0];
}

describe("fixture-console header — R116-4: ruling 116's dead seat names her", () => {
  it("her name in her seat, either side; with no name the seat keeps its bye label", () => {
    const ROWS: [seat: "home" | "away", name: string | null, want: string][] = [
      ["home", "Charlie Gone", `Charlie Gone ${WITHDRAWN} ${VS} Bears of Brockley`],
      ["away", "Charlie Gone", `Bears of Brockley ${VS} Charlie Gone ${WITHDRAWN}`],
      ["home", null, `${BYE} ${VS} Bears of Brockley`],
      ["away", null, `Bears of Brockley ${VS} ${BYE}`],
    ];
    let checked = 0;
    for (const [seat, name, want] of ROWS) {
      expect(header(seat, name), `${seat}, ${name ?? "a bye"}`).toBe(want);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});

// Design review M-4 (audit 4.1 on the console): the side in that dead seat WITHDREW, and the header said only her name —
// the run sheet row that links here marks her muted with the entrant status's own word in a chip. The header now does
// the same, in the run sheet's composition (each name a `min-w-0 truncate` span, the chip and "vs" `shrink-0`, so at
// 320 a long name shortens and the chip stays whole). The pair: her name in a dead seat for any other reason (a
// walkover) gets no chip, and a header with no withdrawn seat keeps its one truncating line.
describe("fixture-console header — M-4: a withdrawn side wears the Withdrawn chip", () => {
  const CHIP = /<span data-testid="console-withdrawn" class="([^"]+)">([^<]+)<\/span>/g;
  // The run sheet's chip, READ from its source — never typed here, so the two cannot drift apart.
  const sheet = readFileSync(new URL("../desk/run-sheet-row.tsx", import.meta.url), "utf8");
  const sheetChips = [...sheet.matchAll(/data-testid="run-sheet-withdrawn" className="([^"]+)"/g)];
  if (sheetChips.length !== 1) throw new Error(`the run sheet's withdrawn chip: ${sheetChips.length} found, wanted 1`);
  const RUN_SHEET_CHIP = sheetChips[0]![1]!.split(/\s+/).sort();
  it("her seat, either side: muted name, the chip once; the run sheet's classes; the line composes for 320", () => {
    let checked = 0;
    for (const seat of ["home", "away"] as const) {
      const h1 = headerHtml(seat, "Charlie Gone");
      const chips = [...h1.matchAll(CHIP)];
      expect(chips.map((c) => c[2]), `${seat}: the chip, once`).toEqual([WITHDRAWN]);
      // The run sheet's chip, plus ONE closed-strip override: on its own line under the names (owner option A) it starts
      // flush, so its `ml-1.5` is cancelled below md.
      const own = chips[0]![1]!.split(" ");
      expect(own, `${seat}: flush on its own line`).toContain("max-md:ml-0");
      expect(own.filter((c) => c !== "max-md:ml-0").sort(), `${seat}: the run sheet's chip`).toEqual(RUN_SHEET_CHIP);
      expect(h1, `${seat}: the chip's line spans row 2 on the closed phone strip`).toContain(
        '<span class="shrink-0 max-md:col-span-full max-md:row-start-2"><span data-testid="console-withdrawn"',
      );
      expect(h1, `${seat}: her name muted`).toContain('<span class="min-w-0 max-md:truncate text-slate-500">Charlie Gone</span>');
      expect(h1, `${seat}: the opponent truncates on its own`).toContain('<span class="min-w-0 max-md:truncate">Bears of Brockley</span>');
      expect(/^<h1 class="[^"]*\bflex min-w-0 flex-wrap items-baseline max-md:grid max-md:grid-cols-\[minmax\(0,max-content\)_auto_minmax\(0,max-content\)_minmax\(0,1fr\)\]/.test(h1), `${seat}: a flex line; on the closed phone strip, a two-row grid`).toBe(true);
      expect(/^<h1 class="[^"]*max-md:truncate/.test(h1), `${seat}: no whole-line truncate (it cut the chip)`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("the pair: a walkover over her dead seat names her without a chip; a bye has none", () => {
    for (const seat of ["home", "away"] as const) {
      expect(headerHtml(seat, "Charlie Gone", "walkover"), `${seat}: walkover`).not.toContain("console-withdrawn");
      expect(headerHtml(seat, null), `${seat}: bye`).not.toContain("console-withdrawn");
      expect(/^<h1 class="[^"]*max-md:truncate/.test(headerHtml(seat, null)), `${seat}: bye keeps its truncating line`).toBe(true);
    }
  });
});

