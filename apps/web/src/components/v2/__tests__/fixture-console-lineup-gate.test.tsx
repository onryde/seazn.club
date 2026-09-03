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
    />,
  );
}

describe("lineupEditorApplies — the declaration, swept over every shipped sport", () => {
  for (const mod of builtinModules) {
    const catalog = lineupCatalogFor(mod, {});
    const expected = !HIDDEN.has(mod.key);
    it(`${mod.key}: ${expected ? "has" : "has no"} lineup to edit`, () => {
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

// Each column is gated on what the module DECLARES, and the sweep runs over
// every sport that still shows an editor rather than over the wave's three.
// The partition is real on both axes, which is what stops these assertions
// being decoration: the racquet family declares an EMPTY position catalog and
// no roles at all, while volleyball declares five groups and a libero and the
// keeper sports declare a captain.
describe("lineup columns render only where the module declares them", () => {
  const VISIBLE = [
    "football",
    "cricket",
    "hockey",
    "icehockey",
    "tennis",
    "badminton",
    "tabletennis",
    "volleyball",
  ];
  const POSITION = 'data-testid="lineup-position-select"';
  const ROLE_FLAG = 'data-testid="lineup-role-flag"';

  for (const key of VISIBLE) {
    const mod = builtinModules.find((m) => m.key === key)!;
    const catalog = lineupCatalogFor(mod, {});
    const hasGroups = catalog.groups.length > 0;
    const hasRoles = (catalog.roles ?? []).length > 0;

    it(`${key}: position column ${hasGroups ? "present" : "absent"}`, () => {
      const html = consoleHtml(key);
      if (hasGroups) expect(html).toContain(POSITION);
      else expect(html).not.toContain(POSITION);
    });

    it(`${key}: role flags ${hasRoles ? "present" : "absent"}`, () => {
      const html = consoleHtml(key);
      if (hasRoles) expect(html).toContain(ROLE_FLAG);
      else expect(html).not.toContain(ROLE_FLAG);
    });
  }

  it("the sweep is not vacuous — both columns differ across the shipped sports", () => {
    // Guards the whole block above: if every visible sport happened to agree,
    // each assertion would hold under a gate that had been deleted.
    const groups = VISIBLE.map(
      (k) => lineupCatalogFor(builtinModules.find((m) => m.key === k)!, {}).groups.length > 0,
    );
    const roles = VISIBLE.map(
      (k) => (lineupCatalogFor(builtinModules.find((m) => m.key === k)!, {}).roles ?? []).length > 0,
    );
    expect(new Set(groups).size).toBe(2);
    expect(new Set(roles).size).toBe(2);
  });

  it("the pair-order column follows the ENTRANT's declared kind, not the sport", () => {
    // `isPairShaped` reads `entrants.kind`; a team-shaped side of the same
    // sport must not get a doubles order control.
    expect(consoleHtml("tennis")).not.toContain('data-testid="lineup-pairorder-select"');
  });
});

// R7/D follow-up — FOUND BY CI (`e2e/player-accounts.spec.ts:156`), not here,
// and the reason is the point of this block.
//
// R7/B's gate stopped rendering `<LineupEditor>` for a module declaring
// `lineup.size <= 1 && benchMax === 0`. That reasoning was about the lineup
// CONTROLS — a position dropdown, a Captain checkbox and bench controls for a
// competitor with no team — and it was right about them.
//
// AVAILABILITY merely lived in the same component. So the gate silently took
// away the only surface telling an organiser that a player had RSVP'd out, for
// every individual-entrant sport at once. The gate's own tests could not see
// it: they assert what the gate DOES, never what it takes with it.
//
// The controls stay gone; the information comes back as `AvailabilityRoster`.
describe("a fixture with no lineup to pick still shows the roster's availability", () => {
  it("renders the availability roster exactly where the editor is gated off", () => {
    // `generic` is the real case from the e2e: `{lineupSize: 1, benchMax: 0}`,
    // individual entrants, one member a side.
    const html = consoleHtml("generic");
    expect(html, "the editor must still be gated off — that part was correct").not.toContain(
      'data-testid="lineup-slot-row"',
    );
    expect(html, "but the roster's availability has to have a home").toContain(
      'data-testid="availability-roster"',
    );
    expect(html, "and the chip itself must render, which is the thing the e2e asserts").toContain(
      'data-testid="availability-chip"',
    );
  });

  it("a sport that DOES have a lineup keeps the editor and grows no second roster", () => {
    const html = consoleHtml("football");
    expect(html).not.toContain('data-testid="availability-roster"');
  });

  // Review fix (final wave, MINOR 5) — `AvailabilityRoster` itself returns
  // null for a side with no members (`lineup-editor.tsx`'s own
  // `if (side.members.length === 0) return null`), but the console used to
  // wrap it in a `PhoneDisclosure` unconditionally: a phone would show a
  // tappable "… availability" row that opened onto nothing. The wrapper is
  // now gated on the same `members.length > 0` condition.
  it("renders no phone disclosure row at all when a side has no members to show availability for", () => {
    const mod = builtinModules.find((m) => m.key === "generic")!;
    const catalog = lineupCatalogFor(mod, {});
    const emptySide = (id: string, name: string): SideInfo => ({
      id,
      name,
      kind: "team",
      members: [],
      lineup: [],
    });
    const html = renderToStaticMarkup(
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
          fidelityTiers: [],
        }}
        home={emptySide("e1", "Home")}
        away={emptySide("e2", "Away")}
        initialState={{ status: "scheduled", last_seq: 0, summary: null, state: {}, outcome: null }}
        initialEvents={[]}
        canEdit={true}
      />,
    );
    expect(html).not.toContain('data-testid="availability-roster"');
    expect(html, "no toggle with nothing behind it either").not.toContain('data-role="phone-disclosure-toggle"');
  });
});
