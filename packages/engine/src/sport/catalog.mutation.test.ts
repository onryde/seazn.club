// Engine mutation debt (sport-free lane) — the PositionCatalog schemas (spec 02 §3) against the catalogs the shipped modules
// actually declare: every module's static `positions` and, where a module resolves one per config (`positionsFor`, W4 #407),
// the catalog of each of its named variants. A declared catalog must survive its own schema unchanged (zod strips keys a
// schema does not name, so a schema that lost a field would hand back a catalog without it), and the same catalog with a
// required field removed or a bound broken must be refused. Expected values are the declarations themselves, so a sport or
// variant added later is swept without an edit here.
import { describe, expect, it } from "vitest";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { PositionCatalog, PositionGroup, PositionRole, resolvePositions } from "./catalog.ts";

interface Declared {
  readonly where: string;
  readonly catalog: PositionCatalog;
}

function declaredCatalogs(): Declared[] {
  const out: Declared[] = [];
  const visited = forEachSport(({ key, module }) => {
    out.push({ where: `${key} positions`, catalog: module.positions });
    if (module.positionsFor === undefined) return;
    for (const [variant, raw] of Object.entries(module.variants)) {
      out.push({ where: `${key} variant ${variant}`, catalog: resolvePositions(module, module.configSchema.parse(raw)) });
    }
  });
  expect(visited).toBeGreaterThan(0);
  return out;
}

describe("PositionCatalog schemas against every declared catalog", () => {
  it("every declared catalog parses to itself, field for field — groups, roles and the lineup block included", () => {
    let catalogs = 0;
    let groups = 0;
    let roles = 0;
    let benchMaxes = 0;
    for (const { where, catalog } of declaredCatalogs()) {
      expect(PositionCatalog.parse(catalog), where).toStrictEqual(catalog);
      for (const group of catalog.groups) {
        expect(PositionGroup.parse(group), where).toStrictEqual(group);
        groups++;
      }
      for (const role of catalog.roles ?? []) {
        expect(PositionRole.parse(role), where).toStrictEqual(role);
        roles++;
      }
      if (catalog.lineup.benchMax !== undefined) benchMaxes++;
      catalogs++;
    }
    // Anti-vacuity: the sweep saw groups, roles and a bench bound, or it proved nothing about those schemas.
    expect(catalogs).toBeGreaterThan(0);
    expect(groups).toBeGreaterThan(0);
    expect(roles).toBeGreaterThan(0);
    expect(benchMaxes).toBeGreaterThan(0);
  });

  it("the same catalogs with a required field dropped, or a bound broken, are refused", () => {
    let refused = 0;
    const refuse = (where: string, candidate: unknown): void => {
      expect(PositionCatalog.safeParse(candidate).success, where).toBe(false);
      refused++;
    };
    for (const { where, catalog } of declaredCatalogs()) {
      const { groups: _groups, ...noGroups } = catalog;
      refuse(`${where} without groups`, noGroups);
      const { lineup: _lineup, ...noLineup } = catalog;
      refuse(`${where} without lineup`, noLineup);
      const { size: _size, ...noSize } = catalog.lineup;
      refuse(`${where} without lineup.size`, { ...catalog, lineup: noSize });
      refuse(`${where} lineup.size 0`, { ...catalog, lineup: { ...catalog.lineup, size: 0 } });
      refuse(`${where} lineup.benchMax -1`, { ...catalog, lineup: { ...catalog.lineup, benchMax: -1 } });
      for (const [i, group] of catalog.groups.entries()) {
        const swap = (g: unknown): unknown => ({ ...catalog, groups: catalog.groups.map((x, j) => (j === i ? g : x)) });
        const { key: _key, ...noKey } = group;
        const { name: _name, ...noName } = group;
        refuse(`${where} group ${group.key} without key`, swap(noKey));
        refuse(`${where} group ${group.key} without name`, swap(noName));
        refuse(`${where} group ${group.key} empty key`, swap({ ...group, key: "" }));
        refuse(`${where} group ${group.key} min -1`, swap({ ...group, min: -1 }));
        refuse(`${where} group ${group.key} max 1.5`, swap({ ...group, max: 1.5 }));
        expect(PositionGroup.safeParse({ ...group, key: "" }).success, where).toBe(false);
      }
      for (const [i, role] of (catalog.roles ?? []).entries()) {
        const swap = (r: unknown): unknown => ({ ...catalog, roles: (catalog.roles ?? []).map((x, j) => (j === i ? r : x)) });
        const { key: _key, ...noKey } = role;
        refuse(`${where} role ${role.key} without key`, swap(noKey));
        refuse(`${where} role ${role.key} unique "yes"`, swap({ ...role, unique: "yes" }));
        expect(PositionRole.safeParse({ ...role, key: "" }).success, where).toBe(false);
      }
    }
    expect(refused).toBeGreaterThan(0);
  });
});
