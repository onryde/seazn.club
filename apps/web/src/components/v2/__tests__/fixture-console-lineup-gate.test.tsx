import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole, type SideInfo } from "@/components/v2/fixture-console";
import { lineupEditorApplies } from "@/components/v2/lineup-editor";
import { lineupCatalogFor } from "@/server/usecases/lineup-catalog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// R7 Task B (D-1, D-18) — the console gated `<LineupEditor>` on
// `{home && away}` alone, so every sport got a lineup table: chess, carrom
// singles and generic each rendered a one-slot team sheet with a Captain
// checkbox for a competitor who has no team.
//
// The gate is the module's own declaration, not a sport-key list:
// `lineup.size <= 1 && benchMax === 0` says "this sport has no lineup to
// edit". Read from the RESOLVED catalog (`lineupCatalogFor`, R7 B2) so a
// competition that shrinks its own squad is read correctly.
//
// The partition below is enumerated over EVERY shipped module rather than
// spot-checked on the three this wave converts — one sample is not a parity
// sweep, and a predicate that happens to be right for chess and wrong for
// tennis would take the doubles order editor away with it.
const HIDDEN = new Set(["boardgame", "carrom", "generic"]);
const EDITOR = 'data-testid="lineup-editor"';

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
  const module = builtinModules.find((m) => m.key === sportKey)!;
  const catalog = lineupCatalogFor(module, {});
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
        key: module.key,
        config: {},
        scorerLabel: module.officialLabel.scorer,
        positionGroups: catalog.groups,
        roles: catalog.roles ?? [],
        lineupSize: catalog.lineup.size,
        benchMax: catalog.lineup.benchMax ?? 0,
        fidelityTiers: [],
      }}
      home={side("e1", "Home")}
      away={side("e2", "Away")}
      initialState={{ status: "scheduled", last_seq: 0, summary: null, state: {}, outcome: null }}
      initialEvents={[]}
      canEdit={true}
    />,
  );
}

describe("lineupEditorApplies — the declaration, swept over every shipped sport", () => {
  for (const module of builtinModules) {
    const catalog = lineupCatalogFor(module, {});
    const expected = !HIDDEN.has(module.key);
    it(`${module.key}: ${expected ? "has" : "has no"} lineup to edit`, () => {
      expect(
        lineupEditorApplies({
          lineupSize: catalog.lineup.size,
          benchMax: catalog.lineup.benchMax ?? 0,
        }),
      ).toBe(expected);
    });
  }

  it("BOTH halves are load-bearing: a one-unit sport WITH a bench still edits", () => {
    // tennis is size 1 / benchMax 1 — a predicate reduced to `size <= 1`
    // would take the doubles pair-order editor away from the whole racquet
    // family.
    expect(lineupEditorApplies({ lineupSize: 1, benchMax: 1 })).toBe(true);
    expect(lineupEditorApplies({ lineupSize: 2, benchMax: 0 })).toBe(true);
    expect(lineupEditorApplies({ lineupSize: 1, benchMax: 0 })).toBe(false);
  });
});

describe("FixtureConsole renders the lineup editor only where the module declares one", () => {
  // The ABSENCE is the assertion, so every probe is anchored on `="`:
  // React serialises an omitted prop as "$undefined", and a bare `data-*`
  // substring passes in both states.
  for (const key of ["boardgame", "carrom", "generic"]) {
    it(`${key}: no lineup table at all`, () => {
      expect(consoleHtml(key)).not.toContain(EDITOR);
    });
  }

  for (const key of ["football", "cricket", "hockey", "icehockey", "tennis", "volleyball"]) {
    it(`${key}: the lineup table is still rendered`, () => {
      // Both sides, not just one — the gate wraps the two-column grid.
      expect(consoleHtml(key).split(EDITOR).length - 1).toBe(2);
    });
  }
});
