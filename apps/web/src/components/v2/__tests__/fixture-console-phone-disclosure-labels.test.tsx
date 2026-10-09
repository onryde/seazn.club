import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole, type SideInfo } from "@/components/v2/fixture-console";
import { lineupEditorApplies } from "@/components/v2/lineup-editor";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// Task 5 fix round 1 (2026-09-02) — the roster block (sports with NO lineup
// editor: carrom, boardgame, generic — see `fixture-console-lineup-gate.test.tsx`
// for the module-declared partition) reused the editor block's
// "Lineup"/"Show lineup"/"Hide lineup" copy for its phone disclosure toggle,
// so a scorer on a phone saw "Lineup" over a card that held no lineup, only
// an availability roster. The roster toggle now uses the already-translated
// `lineup.availabilityTitle` ("{name} availability") as BOTH its show and
// hide label, with `aria-expanded` alone carrying the open/closed state.
//
// Sports are picked from the module's own declaration (`lineupEditorApplies`
// over the resolved `lineupCatalogFor`), not a hardcoded pair, so this stays
// true if the partition ever shifts.
function applies(mod: (typeof builtinModules)[number]): boolean {
  const catalog = lineupCatalogFor(mod, {});
  return lineupEditorApplies({ lineupSize: catalog.lineup.size, benchMax: catalog.lineup.benchMax ?? 0 });
}
const editorModule = builtinModules.find((m) => applies(m))!;
const rosterModule = builtinModules.find((m) => !applies(m))!;

function side(id: string, name: string): SideInfo {
  return {
    id,
    name,
    kind: "team",
    members: [
      {
        person_id: "00000000-0000-0000-0000-000000000001",
        full_name: "Alex Stone",
        squad_number: 1,
        default_position_key: null,
        is_captain: false,
        roles: [],
      },
    ],
    lineup: [],
  };
}

function consoleHtml(sportKey: string): string {
  const mod = builtinModules.find((m) => m.key === sportKey)!;
  const catalog = lineupCatalogFor(mod, {});
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{
        id: "f1",
        status: "scheduled",
        scheduled_at: null,
        venue_name: null,
        court_name: null,
        round_no: 1,
      }}
      sport={{
        key: mod.key,
        config: {},
        scorerLabel: mod.officialLabel.scorer,
        positionGroups: catalog.groups,
        roles: catalog.roles ?? [],
        lineupSize: catalog.lineup.size,
        benchMax: catalog.lineup.benchMax ?? 0,
      }}
      home={side("e1", "Home")}
      away={side("e2", "Away")}
      initialState={{ status: "scheduled", last_seq: 0, summary: null, state: {}, outcome: null }}
      initialEvents={[]}
      canEdit={true}
      canOrganise={true}
      stageKind={null}
      viewerPlan="community"
    />,
  );
}

// The whole toggle — aria-label AND the visible aside text a sighted user
// reads beside the summary — is what a scorer perceives as this row's
// label. Checking aria-label alone would miss a stray `aside` still saying
// "Lineup" over a roster card, so this pulls the full `<button ...
// data-role="phone-disclosure-toggle" ...>…</button>` markup.
function toggleBlocks(html: string): string[] {
  return [...html.matchAll(/<button[^>]*data-role="phone-disclosure-toggle"[^>]*>.*?<\/button>/gs)].map((m) => m[0]);
}

describe("phone-disclosure toggle labels match what the card actually is", () => {
  it("a sport with a lineup editor labels its phone toggle with 'lineup'", () => {
    const blocks = toggleBlocks(consoleHtml(editorModule.key));
    expect(blocks.length).toBe(2); // one per side
    for (const block of blocks) expect(block.toLowerCase()).toContain("lineup");
  });

  it("a sport with NO lineup editor never says 'lineup' anywhere in its toggle — it reads as availability", () => {
    const blocks = toggleBlocks(consoleHtml(rosterModule.key));
    expect(blocks.length).toBe(2); // one per side
    for (const block of blocks) {
      expect(block.toLowerCase()).not.toContain("lineup");
      expect(block.toLowerCase()).toContain("availability");
    }
  });
});
