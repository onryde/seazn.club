// The bench's per-row roster hooks, proven against a MULTI-player roster.
//
// This file exists because the same assertions in
// `register-stepper-interaction.test.tsx` were vacuous. That mount renders a
// single-player individual entry, so `data-player-row` hardcoded to `0` is
// indistinguishable from a correct per-row index — verified by mutation:
// stamping `{0}` on every row left the whole stepper suite green. Two rows is
// the smallest fixture that can witness it.
//
// Why the hooks exist at all: every field in a roster row was addressable only
// by an `aria-label` built from TRANSLATED strings, which is exactly the text
// selector this repo's e2e rule forbids. The bench's browser driver had no
// non-text way to fill the details step, and the details step is not optional —
// `validateDetails` requires every row's name, so an unfilled row leaves
// `goNext` silently refusing to advance.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { RosterTable } from "@/components/public-site/register/roster-table";
import type { CartEntry } from "@/components/public-site/register/types";

const EN_UI: Dict = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8"),
) as Dict;

// Same shape register-stepper-interaction.test.tsx uses: the real English
// catalog, so a missing key surfaces rather than being masked by a stub.
vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
}));

function entryWithPlayers(n: number): CartEntry {
  return {
    division_id: "div-team",
    entrant_kind: "team",
    team_name: "Riverside Lions",
    partner_name: null,
    free_agent: false,
    answers: {},
    self_player_index: null,
    players: Array.from({ length: n }, (_, i) => ({
      full_name: `Player ${i + 1}`,
      squad_number: "",
      dob: null,
      gender: null,
    })),
  } as unknown as CartEntry;
}

function mountRoster(players: number, opts?: { requiresDob?: boolean; requiresGender?: boolean }) {
  return renderIsland(RosterTable, {
    entry: entryWithPlayers(players),
    requiresDob: opts?.requiresDob ?? false,
    requiresGender: opts?.requiresGender ?? false,
    issuesByRow: new Map(),
    importText: "",
    onImportTextChange: () => {},
    onAddPlayer: () => {},
    onRemovePlayer: () => {},
    onUpdatePlayer: () => {},
    onImportPlayers: () => {},
  });
}

function hooked(island: ReturnType<typeof mountRoster>, testid: string) {
  return island.tree().filter((e) => propsOf(e)["data-testid"] === testid);
}

describe("RosterTable — bench hooks are addressable per player row", () => {
  it("stamps a dense, 0-based, unique data-player-row on every name field", () => {
    const island = mountRoster(3);
    const names = hooked(island, "reg-roster-name");
    expect(names, "expected one reg-roster-name per player").toHaveLength(3);

    const rows = names.map((e) => propsOf(e)["data-player-row"]);
    // The exact property a driver relies on to address player i. A hook that
    // stamped a constant would satisfy any presence check and still be
    // unusable — `[data-testid="reg-roster-name"][data-player-row="1"]` would
    // match nothing, or the selector without the index would match three
    // elements and trip Playwright's strict mode.
    expect(rows).toEqual([0, 1, 2]);
    expect(new Set(rows).size, "data-player-row repeats across rows").toBe(3);
  });

  it("each hooked field belongs to its own player — row i drives player i", () => {
    const island = mountRoster(3);
    const names = hooked(island, "reg-roster-name");
    // Values come from the fixture's own players, so a hook attached to the
    // wrong row shows up as the wrong name rather than as a missing element.
    expect(names.map((e) => propsOf(e).value)).toEqual(["Player 1", "Player 2", "Player 3"]);
  });

  it("the conditional fields carry the same per-row index when rendered", () => {
    const island = mountRoster(2, { requiresDob: true, requiresGender: true });
    for (const testid of ["reg-roster-dob", "reg-roster-gender"]) {
      const fields = hooked(island, testid);
      expect(fields, `${testid} did not render for a dob/gender-requiring division`).toHaveLength(2);
      expect(fields.map((e) => propsOf(e)["data-player-row"])).toEqual([0, 1]);
    }
    // Squad number is team-only and this fixture IS a team, so it renders too.
    const squads = hooked(island, "reg-roster-squad");
    expect(squads).toHaveLength(2);
    expect(squads.map((e) => propsOf(e)["data-player-row"])).toEqual([0, 1]);
  });

  it("does not render dob/gender hooks when the division does not require them", () => {
    // The negative pair. Without it, a hook that rendered unconditionally
    // would pass every assertion above while changing what the form asks of a
    // real registrant.
    const island = mountRoster(2);
    expect(hooked(island, "reg-roster-dob")).toHaveLength(0);
    expect(hooked(island, "reg-roster-gender")).toHaveLength(0);
  });
});

// Polish wave P5 (H-1): a solo sign-up's card shows ONE row - the solo player - with none of a team roster's controls (add, remove,
// squad number, paste). Its kind is "team" (the division's), so the table reads `free_agent`, not the kind.
describe("RosterTable — a solo sign-up's one row carries no team-roster controls", () => {
  function mountSolo(freeAgent: boolean) {
    return renderIsland(RosterTable, {
      entry: { ...entryWithPlayers(1), free_agent: freeAgent },
      requiresDob: true,
      requiresGender: true,
      issuesByRow: new Map(),
      importText: "",
      onImportTextChange: () => {},
      onAddPlayer: () => {},
      onRemovePlayer: () => {},
      onUpdatePlayer: () => {},
      onImportPlayers: () => {},
    });
  }
  const text = (island: ReturnType<typeof mountSolo>) => JSON.stringify(island.tree().map((e) => propsOf(e).children ?? null));

  it("the solo row has its name, dob and gender fields and no add / remove / squad / paste", () => {
    const solo = mountSolo(true);
    for (const testid of ["reg-roster-name", "reg-roster-dob", "reg-roster-gender"]) expect(hooked(solo, testid), testid).toHaveLength(1);
    expect(hooked(solo, "reg-roster-squad")).toHaveLength(0);
    for (const key of ["register.details.roster.addPlayer", "register.entries.cart.remove", "register.details.roster.import.summary"]) {
      expect(text(solo).includes(tRuntime(EN_UI, key)), key).toBe(false);
    }
    // The positive pair: the same one-row TEAM roster shows them.
    const team = mountSolo(false);
    expect(hooked(team, "reg-roster-squad")).toHaveLength(1);
    expect(text(team).includes(tRuntime(EN_UI, "register.details.roster.addPlayer"))).toBe(true);
  });
});
