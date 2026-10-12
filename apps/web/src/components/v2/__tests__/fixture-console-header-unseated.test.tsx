// R116-4 (W2b Task 16; owner ruling 116) — the organiser console's header, which every run-sheet row links to, read
// "Bye vs Bears of Brockley · forfeited" for a withdrawn winner's dead seat walked over by the side that arrived. The
// page reads her through `unseatedForfeitLoser` and hands down `*_unseated_name` (stream-mount.test.tsx pins that);
// this pins that the header PRINTS it in her seat, either side, before the seat's stored bye label — and that a seat
// with no such name keeps the label it always had (a genuine bye, a DQ'd winner's dead seat).
//
// single-sport: generic — the header's names are the seats and the page's name, never the sport.
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

function header(seat: "home" | "away", unseatedName: string | null): string {
  const arrived: SideInfo = { id: "e-arrived", name: "Bears of Brockley", members: [], lineup: [] };
  const live: LiveState = {
    status: "forfeited",
    last_seq: 0,
    summary: null,
    state: null,
    outcome: { kind: "award", winner: "e-arrived", loser: unseatedName === null ? null : "e-gone", reason: unseatedName === null ? "bye" : "withdrew" },
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
  return h1.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

describe("fixture-console header — R116-4: ruling 116's dead seat names her", () => {
  it("her name in her seat, either side; with no name the seat keeps its bye label", () => {
    const ROWS: [seat: "home" | "away", name: string | null, want: string][] = [
      ["home", "Charlie Gone", `Charlie Gone ${VS} Bears of Brockley`],
      ["away", "Charlie Gone", `Bears of Brockley ${VS} Charlie Gone`],
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
