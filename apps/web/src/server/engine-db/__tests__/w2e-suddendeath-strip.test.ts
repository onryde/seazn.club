// W2e Task 9 (spec §5.7, D4, D18; HK-SO-2 IH-SO-2) — `shootout.suddenDeath` is deleted from the period kernel. Stored rows
// lose the key in Task 13b's migration (D18); until it runs, and for a write from an older client during the deploy, the
// kernel's strict `shootout` object drops that one key before it parses. This proves the strip against the rows a
// pre-W2e server actually stored, not against a shape typed here: `fixtures/w2d-pin-before.json` is what a server built
// at W2D_BASE printed for the W2d pin scenario (a hockey fih-shootout and two ice hockey iihf divisions, with their
// fixtures' frozen snapshots and their match states). DB-free: it reads the fixture file and parses with the engine.
// (The engine's own package cannot hold this test: its tests run in a Stryker sandbox that holds packages/engine alone.)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";

type Row = Record<string, unknown>;
const PIN = JSON.parse(readFileSync(resolve(__dirname, "fixtures/w2d-pin-before.json"), "utf8")) as {
  rows: { divisions: Row[]; fixtures: Row[]; match_states: Row[] };
};
const KEY = "suddenDeath";
const SPORTS = ["hockey", "icehockey"] as const;
const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const spells = (v: unknown): boolean => JSON.stringify(v ?? null).includes(`"${KEY}"`);
/** Every path at which an object carries the key. */
const keyPaths = (v: unknown, path = "$"): string[] =>
  v === null || typeof v !== "object"
    ? []
    : Object.entries(v as Row).flatMap(([k, x]) => [...(k === KEY ? [`${path}.${k}`] : []), ...keyPaths(x, `${path}.${k}`)]);
const withoutKey = (v: unknown): unknown =>
  v === null || typeof v !== "object"
    ? v
    : Array.isArray(v)
      ? v.map(withoutKey)
      : Object.fromEntries(Object.entries(v as Row).filter(([k]) => k !== KEY).map(([k, x]) => [k, withoutKey(x)]));

describe("HK-SO-2 IH-SO-2 the stored pre-W2e hockey and ice hockey configs parse after W2e, with suddenDeath stripped (D18)", () => {
  const sportOfDivision = new Map(PIN.rows.divisions.map((d) => [d.id as string, d.sport_key as string]));
  const divisionOfFixture = new Map(PIN.rows.fixtures.map((f) => [f.id as string, f.division_id as string]));
  const carriers: { where: string; sport: string; cfg: unknown }[] = [
    ...PIN.rows.divisions.map((d) => ({ where: `division ${String(d.id)} config`, sport: d.sport_key as string, cfg: d.config })),
    ...PIN.rows.fixtures.map((f) => ({
      where: `fixture ${String(f.id)} config_snapshot`,
      sport: sportOfDivision.get(f.division_id as string) ?? "?",
      cfg: f.config_snapshot,
    })),
    ...PIN.rows.match_states.map((m) => ({
      where: `match_state ${String(m.fixture_id)} state.cfg`,
      sport: sportOfDivision.get(divisionOfFixture.get(m.fixture_id as string) ?? "") ?? "?",
      cfg: (m.state as { cfg?: unknown } | null)?.cfg,
    })),
  ].filter((c) => spells(c.cfg));

  it("the pin stores the key, only on hockey and ice hockey, and only under the shoot-out (the premise)", () => {
    expect(carriers.length, "anti-vacuity: stored configs carrying suddenDeath").toBeGreaterThan(0);
    for (const c of carriers) {
      expect(SPORTS as readonly string[], c.where).toContain(c.sport);
      expect(keyPaths(c.cfg), c.where).toEqual(["$.shootout.suddenDeath"]);
    }
    // Each kind of stored row is represented, so a loader that reads only one of them is not all this proves.
    expect(new Set(carriers.map((c) => c.where.split(" ")[0])).size).toBe(3);
    expect(new Set(carriers.map((c) => c.sport))).toEqual(new Set(SPORTS));
  });

  it("every one parses through its sport's schema; the key is gone and the rest of the stored shoot-out is kept", () => {
    let parsed = 0;
    for (const c of carriers) {
      const result = moduleOf(c.sport).configSchema.safeParse(c.cfg);
      expect(result.success, `${c.where}: ${result.success ? "" : JSON.stringify(result.error.issues).slice(0, 300)}`).toBe(true);
      if (!result.success) continue;
      expect(keyPaths(result.data), c.where).toEqual([]);
      // The stored shoot-out, minus the one key, is what the parse kept. (Only the shoot-out: the same rows carry keys W2d
      // already strips, `points.shootoutWin/shootoutLoss`, which are not this test's.)
      const stored = (c.cfg as { shootout: Row }).shootout;
      expect((result.data as { shootout: unknown }).shootout, c.where).toEqual(withoutKey(stored));
      parsed += 1;
    }
    expect(parsed).toBe(carriers.length);
  });

  it("the strip is that one key: the same stored shoot-out with any other unknown key is still refused", () => {
    let refused = 0;
    for (const c of carriers) {
      const so = (c.cfg as { shootout: Row }).shootout;
      const misspelt = { ...(c.cfg as Row), shootout: { ...withoutKey(so) as Row, suddenDeat: true } };
      expect(moduleOf(c.sport).configSchema.safeParse(misspelt).success, c.where).toBe(false);
      refused += 1;
    }
    expect(refused).toBe(carriers.length);
  });
});
