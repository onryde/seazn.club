// The roster seam (W1-driving Task 3, D2; Review Focus 1). A team cell's
// entrants carry the engine catalog's FULL roster (starting lineup + bench),
// and the lineup built from it must pass the engine's own validateLineup —
// otherwise 45+ cells read as product reds for a harness reason.
//
// State transitions, the empty case first:
//  - an entrant with no members: its lineup is refused by name, never an
//    empty PUT;
//  - a roster built and stored (addEntrants with members, read back through
//    entrantMembers), its lineup PUT;
//  - a SECOND PUT for the same fixture and entrant replaces the first, never
//    appends to it (fixtures.ts putLineup deletes, then inserts);
//  - a withdrawn entrant: its fixtures are no longer scheduled, so its
//    lineup is refused;
//  - another sport: every team preset (and every committed team variant cfg)
//    is swept, and the fake round trip runs on every team sport.
//
// Expected values come from the engine's declarations (resolvePositions,
// validateLineup), the product's text (schemas.ts' member cap) and the cited
// rulebooks (RULEBOOK_SIDE_SIZE) — never from rosters.ts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePositions, validateLineup, type PositionCatalog } from "@seazn/engine/sport";
import { forEachSport, forEachSportAsync } from "@seazn/engine/testkit";
import { describe, expect, it } from "vitest";
import { stagesForRow } from "../lib/catalogue.ts";
import { LineupUnchecked, RefusedCall, type EntrantMember, type LineupSlotWire } from "../lib/driver/types.ts";
import { WAVE_ID } from "../lib/routing.ts";
import { ROSTER_MAX, RosterTooLarge, SIDE_SIZE_ROUTE, lineupFor, rosterMembers, rosterSize } from "../lib/scenarios/rosters.ts";
import { entrantKindFor, resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault, offlineVariantOrder, type VariantCase } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { wireCodeFor } from "./product-text.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const asMembers = (n: number): EntrantMember[] => Array.from({ length: n }, (_, i) => ({ person_id: `p${i + 1}`, squad_number: i + 1, is_captain: i === 0 }));
/** The wire slots as the engine reads them. A slot with no order_no takes its
 *  index + 1, as the product stores it (fixtures.ts putLineup `s.order_no ?? i + 1`). */
const toEngine = (entrantId: string, slots: readonly LineupSlotWire[]) => ({
  entrantId,
  slots: slots.map((s, i) => ({ personId: s.person_id, slot: s.slot, ...(s.position_key !== undefined ? { positionKey: s.position_key } : {}), roles: [...(s.roles ?? [])], orderNo: s.order_no ?? i + 1 })),
});
const catalogOf = (sport: string, cfg: unknown): PositionCatalog => resolvePositions(sportModule(sport) as never, cfg as never);
const isTeam = (sport: string, cfg: unknown) => entrantKindFor(sport, cfg) === "team";
/** The sports that field teams at any preset, in registry order — derived
 *  from the engine (forEachSport + entrantKindFor), so every sweep below is
 *  pinned to the whole set rather than to "more than none" (m-8). */
function teamSports(): string[] {
  const out: string[] = [];
  forEachSport(({ key }) => { if (offlineVariantOrder(key).some((p) => isTeam(key, resolveSportCfg(key, p)))) out.push(key); });
  return out;
}

/** One committed rulebook row a table entry rests on: the file and the words it says. */
interface RulebookQuote { readonly file: string; readonly quote: string }
/** Every row names its source (fix round 1, m-7): a sized row its rule, an
 *  excluded row the committed rulebook words it rests on — both required, so
 *  a row without one does not compile (pinned below with @ts-expect-error). */
type SideRow =
  | { readonly size: number; readonly source: string; readonly rulebook?: RulebookQuote }
  | { readonly excluded: string; readonly rulebook: RulebookQuote };
// @ts-expect-error — an excluded row with no rulebook source must not compile (m-7).
const NO_SOURCE: SideRow = { excluded: "no reason given a source" };
void NO_SOURCE;

const GOALS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-goals-boards.md";

/** Players per side, per team preset, from the rulebook (plan review 3 m-5,
 *  review 4 m-c).
 *
 *  R9 reconciliation. R9 forbids an expected value typed into a test, and
 *  this is a table typed into a test. Four of the five team sports DO declare
 *  a side quantity — football `teamSize` (optional; football.ts says absent
 *  means 11), cricket `playersPerSide`, hockey `strength.base` (players on the
 *  pitch; youth 7) and icehockey `strength.base` (5 — SKATERS only, the
 *  goalkeeper not counted) — but volleyball declares none (the setbased
 *  kernel: beach differs from indoor only in its set targets), and the four
 *  that do declare one mean different things by it. No single engine
 *  declaration answers "players per side" for all five, and volleyball/beach,
 *  the finding the plan names, would vanish under any of them. So the oracle
 *  is the rulebook, which TEST-STRATEGY allows: one uniform source across all
 *  five sports, independent of the engine, against which hockey youth's own
 *  `strength.base` (7) and its 11-starter catalog plainly disagree. Every size below
 *  is a transcription of the cited rule, read from the document on
 *  2026-10-01, and NONE is read from the product's output — the catalog's
 *  `lineup.size` is what each row is compared WITH, never where it came from.
 *  A rule change moves a row only by re-reading its source.
 *
 *  A house variant (a product preset no federation defines) cites its
 *  committed W2 rulebook row, or is excluded by name with the reason. A
 *  preset with no row reds by name, so the table cannot silently skip one. */
const RULEBOOK_SIDE_SIZE: Readonly<Record<string, SideRow>> = {
  "football/11-a-side": { size: 11, source: "IFAB Laws of the Game 2026/27, Law 3.1 (Number of players): \"A match is played by two teams, each with a maximum of eleven players; one must be the goalkeeper\" (read) — https://www.theifab.com/laws/latest/the-players/" },
  "football/mini-soccer": { excluded: "house variant: no committed W2 rulebook row gives its side size — the football settings row lists team size as a setting with no figure", rulebook: { file: GOALS, quote: "| Half length, halves/quarters, team size | default |" } },
  "football/small-sided": { excluded: "house variant: no committed W2 rulebook row gives its side size — the football settings row lists team size as a setting with no figure", rulebook: { file: GOALS, quote: "| Half length, halves/quarters, team size | default |" } },
  "football/youth": { excluded: "house variant: the committed W2 rulebook names football youth only for its shoot-out attempts, never its side size", rulebook: { file: GOALS, quote: "| Shoot-out attempts (5; youth 3) | default | ✔ | ✘ | ✘ |" } },
  "cricket/hundred": { size: 11, source: "ECB The Hundred Playing Conditions 2026, clause 1.1.1 (replacing Law 1.1): \"A match is played between two sides, each of eleven players, one of whom shall be captain\" (read) — https://resources.ecb.co.uk/ecb/document/2026/03/24/f8005182-b39c-4c25-83bd-1ffff0415b7a/The-Hundred-2026.pdf" },
  "cricket/odi": { size: 11, source: "ICC Men's One-Day International Playing Conditions (effective July 2025), clause 1.1 (Number of players): \"A match is played between two sides, each of eleven players\" (read) — https://images.icc-cricket.com/image/upload/prd/d25dbgishkx0kijb4jeu.pdf" },
  "cricket/t20": { size: 11, source: "ICC Men's Twenty20 International Playing Conditions (effective July 2025), clause 1.1 (Number of players): \"A match is played between two sides, each of eleven players\" (read) — https://images.icc-cricket.com/image/upload/prd/qfnsie8fz6vhyl1pmcli.pdf" },
  "cricket/test": { size: 11, source: "ICC Men's Test Match Playing Conditions (effective June 2025), clause 1.1 (Number of players): \"A match is played between two sides, each of eleven players\" (read) — https://images.icc-cricket.com/image/upload/prd/lm8owaz03i86m1eneb7m.pdf" },
  "volleyball/beach": { size: 2, source: "FIVB Official Beach Volleyball Rules 2025-2028, Rule 4.1.1 (Team composition): \"A team is composed exclusively of two players\" (read) — https://www.fivb.com/wp-content/uploads/2025/02/FIVB-BeachVolleyball_Rules2025_2028-EN-v01.pdf" },
  "volleyball/indoor": { size: 6, source: "FIVB Official Volleyball Rules 2025-2028, Rule 7.3.1 (Team starting line-up): \"There must always be six players per team in play\" (read) — https://www.fivb.com/wp-content/uploads/2025/01/FIVB-Volleyball_Rules2025_2028-EN-v05.pdf" },
  "icehockey/iihf": { size: 6, source: "IIHF Official Rulebook 2026/27 (v1.0, June 2026), Rule 5.1 (Eligible players), the nearest rule — a MINIMUM to start a game, not a side size; 6 is its five skaters plus one goalkeeper, the side on the ice at full strength: \"For a team to play a game, it must be able to put on the ice at least five (5) skaters and one (1) goalkeeper at the beginning of the game\" (read) — https://blob.iihf.com/iihf-media/iihfmvc/media/downloads/rule%20book/2026-27_iihf_rule_book.pdf" },
  "icehockey/recreational": { excluded: "house variant: the committed W2 rulebook calls it a product rule with no IIHF basis and gives only its overtime, draw and points rule — no side size", rulebook: { file: GOALS, quote: "product rule, no IIHF basis" } },
  "hockey/fih-outdoor": { size: 11, source: "FIH Rules of Hockey (effective 1 March 2026), Rule 2.1 (Composition of teams): \"A maximum of eleven players from each team take part in play at any particular time during the match\" (read) — https://www.fih.hockey/static-assets/pdf/fih-Rules-of-hockey-2026-final.pdf" },
  "hockey/fih-shootout": { size: 11, source: "FIH Rules of Hockey (effective 1 March 2026), Rule 2.1 (Composition of teams): \"A maximum of eleven players from each team take part in play at any particular time during the match\" (read) — https://www.fih.hockey/static-assets/pdf/fih-Rules-of-hockey-2026-final.pdf" },
  "hockey/youth": { size: 7, source: "house variant — committed W2 rulebook row, hockey settings: \"players per side (youth 7)\"", rulebook: { file: GOALS, quote: "| Quarter length, players per side (youth 7) | default | ✔ | ✔ |" } },
};

describe("rosters — the lineup builder against the engine", () => {
  it("empty case first: a lineup from no members is refused by name, never an empty PUT", () => {
    expect(() => lineupFor("football", resolveSportCfg("football", offlineVariantOrder("football")[0]!), [])).toThrow(/no members/);
  });

  it("every sport's lineup, at every team preset, passes the engine's validateLineup — counted", () => {
    let checked = 0;
    const seen: string[] = [];
    forEachSport(({ key }) => {
      for (const preset of offlineVariantOrder(key)) {
        const cfg = resolveSportCfg(key, preset);
        if (!isTeam(key, cfg)) continue;
        const catalog = catalogOf(key, cfg);
        const n = rosterSize(key, cfg);
        expect(n, `${key}/${preset}`).toBe(catalog.lineup.size + (catalog.lineup.benchMax ?? 0));
        const slots = lineupFor(key, cfg, asMembers(n));
        expect(validateLineup(catalog, toEngine("e1", slots)), `${key}/${preset}`).toEqual([]);
        expect(slots.filter((s) => s.slot === "starting").length, `${key}/${preset} starters`).toBe(catalog.lineup.size);
        seen.push(`${key}/${preset}`);
        checked++;
      }
    });
    expect(checked, "team presets checked").toBeGreaterThan(0);
    // The sweep reached every sport that fields teams (football's group
    // minimum and cricket's required role both among them).
    expect([...new Set(seen.map((s) => s.split("/")[0]))]).toEqual(["football", "cricket", "volleyball", "icehockey", "hockey"]);
  });

  it("Review Focus 1: every COMMITTED team variant cfg (variants.json) builds a lineup validateLineup answers [] for — counted", () => {
    const file = JSON.parse(read("scripts/matrix/catalogue/variants.json")) as { sports: { sport: string; cases: VariantCase[] }[] };
    let checked = 0;
    const sizes = new Set<number>();
    const sports = new Set<string>();
    for (const s of file.sports) {
      for (const vc of s.cases) {
        const cfg = resolveSportCfg(vc.sport, vc.preset, { ...vc.overrides });
        if (!isTeam(vc.sport, cfg)) continue;
        const catalog = catalogOf(vc.sport, cfg);
        const slots = lineupFor(vc.sport, cfg, asMembers(rosterSize(vc.sport, cfg)));
        expect(validateLineup(catalog, toEngine("e1", slots)), vc.id).toEqual([]);
        sizes.add(catalog.lineup.size);
        sports.add(vc.sport);
        checked++;
      }
    }
    expect(checked, "committed team variant cfgs checked").toBeGreaterThan(0);
    // m-8: the committed set reached every team sport, not merely one.
    expect(teamSports().length, "team sports").toBe(5);
    expect(sports).toEqual(new Set(teamSports()));
    // The committed set moves a catalog's size (football's teamSize override),
    // so this sweep proves the builder at sizes no preset has.
    const presetSizes = new Set<number>();
    forEachSport(({ key }) => {
      for (const p of offlineVariantOrder(key)) {
        const cfg = resolveSportCfg(key, p);
        if (isTeam(key, cfg)) presetSizes.add(catalogOf(key, cfg).lineup.size);
      }
    });
    expect([...sizes].filter((n) => !presetSizes.has(n)).length, "committed catalog sizes no preset has").toBeGreaterThan(0);
  });

  it("members are synthetic and numbered: Matrix Player <entrant>.<m>, squad 1..n, one captain", () => {
    const cfg = resolveSportCfg("cricket", "t20");
    const m = rosterMembers("cricket", cfg, 3);
    expect(m.length).toBe(rosterSize("cricket", cfg));
    expect(m[0]).toEqual({ fullName: "Matrix Player 3.1", squadNumber: 1, isCaptain: true });
    expect(m.at(-1)).toEqual({ fullName: `Matrix Player 3.${m.length}`, squadNumber: m.length, isCaptain: false });
    expect(m.filter((x) => x.isCaptain).length).toBe(1);
    expect(new Set(m.map((x) => x.fullName)).size).toBe(m.length);
    expect(m.map((x) => x.squadNumber)).toEqual(Array.from({ length: m.length }, (_, i) => i + 1));
  });

  it("an entrant number that is not a positive whole number is refused by name (no 'Matrix Player 0.1')", () => {
    const cfg = resolveSportCfg("cricket", "t20");
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => rosterMembers("cricket", cfg, bad), String(bad)).toThrow(/entrant number/);
  });

  it("ROSTER_MAX is the product's CreateEntrant member cap, read from schemas.ts", () => {
    const cap = /members: z\.array\(CreateEntrantMemberInput\)\.max\((\d+)\)/.exec(read("apps/web/src/server/api-v1/schemas.ts"))?.[1];
    expect(cap, "schemas.ts CreateEntrant no longer caps members in the expected shape").toBeDefined();
    expect(ROSTER_MAX).toBe(Number(cap));
  });

  it("a catalog above the schema's 40 is refused by name; exactly 40 is accepted", () => {
    const of = (size: number, benchMax: number) => () => ({ groups: [], lineup: { size, benchMax } });
    expect(() => rosterSize("x", {}, of(35, 6))).toThrow(RosterTooLarge);
    expect(rosterSize("x", {}, of(35, 5))).toBe(ROSTER_MAX);
  });

  it("the bench counts: a catalog with a bench sizes the roster above its starting lineup (and members past the bench are left out)", () => {
    const of = () => ({ groups: [], lineup: { size: 3, benchMax: 2 } });
    expect(rosterSize("x", {}, of)).toBe(5);
    const slots = lineupFor("x", {}, asMembers(7), of);
    expect(slots.map((s) => [s.person_id, s.slot])).toEqual([["p1", "starting"], ["p2", "starting"], ["p3", "starting"], ["p4", "bench"], ["p5", "bench"]]);
  });

  it("starters are the lowest squad numbers, whatever order the members arrive in", () => {
    const of = () => ({ groups: [], lineup: { size: 2, benchMax: 1 } });
    const members = [3, 1, 2].map((n) => ({ person_id: `p${n}`, squad_number: n, is_captain: n === 1 }));
    expect(lineupFor("x", {}, members, of).map((s) => [s.person_id, s.slot])).toEqual([["p1", "starting"], ["p2", "starting"], ["p3", "bench"]]);
  });

  // Every shipped catalog lists its minimum group (the goalkeeper) first, so
  // the presets sweep cannot tell "minimums first" from "first group with
  // room" (mutation M1 survived it). A catalog whose minimum group comes after
  // an open one can — judged by the engine's validateLineup, not by rosters.ts.
  it("a group minimum is met even when its group is listed after an open one, and a full group overflows to the next", () => {
    const late: PositionCatalog = { groups: [{ key: "OUT", name: "Outfield" }, { key: "GK", name: "Goalkeeper", min: 1, max: 1 }], lineup: { size: 3 } };
    const lateSlots = lineupFor("x", {}, asMembers(3), () => late);
    expect(validateLineup(late, toEngine("e1", lateSlots))).toEqual([]);
    // The GK count the catalog declares (min = max = 1), not the builder's pick.
    const gk = late.groups.find((g) => g.key === "GK")!;
    expect(lateSlots.filter((s) => s.position_key === "GK").length).toBe(gk.min);
    const capped: PositionCatalog = { groups: [{ key: "DEF", name: "Defence", max: 2 }, { key: "FWD", name: "Forward" }], lineup: { size: 4 } };
    const cappedSlots = lineupFor("x", {}, asMembers(4), () => capped);
    expect(validateLineup(capped, toEngine("e1", cappedSlots))).toEqual([]);
    // m-9: which starter takes which open group is the builder's choice, not a
    // rule — validateLineup (above) judges the caps; here, only that every
    // starter holds a position the catalog declares.
    const declared = new Set(capped.groups.map((g) => g.key));
    expect(cappedSlots.filter((s) => s.position_key === undefined || !declared.has(s.position_key)).map((s) => s.person_id)).toEqual([]);
  });

  it("guards: a roster short of the starting lineup, group minimums above the lineup, or more required roles than starters are refused by name", () => {
    expect(() => lineupFor("x", {}, asMembers(2), () => ({ groups: [], lineup: { size: 3 } }))).toThrow(/needs 3 starters, roster has 2/);
    expect(() => lineupFor("x", {}, asMembers(3), () => ({ groups: [{ key: "A", name: "A", min: 2 }, { key: "B", name: "B", min: 2 }], lineup: { size: 3 } }))).toThrow(/group minimums? .*4.*3/);
    const roles = [1, 2, 3].map((i) => ({ key: `r${i}`, required: true }));
    expect(() => lineupFor("x", {}, asMembers(2), () => ({ groups: [], roles, lineup: { size: 2 } }))).toThrow(/3 required roles?.*2 starters/);
  });
});

describe("rosters — players per side against the catalog (a W2 finding, plan review 3 m-5)", () => {
  it("every team preset has a cited row; the ones whose rulebook side size differs from the catalog's lineup.size are found, pinned by name — an empty list fails", () => {
    const visited: string[] = [];
    const found: { id: string; sideSize: number; lineupSize: number }[] = [];
    const excluded: string[] = [];
    let compared = 0;
    forEachSport(({ key }) => {
      for (const preset of offlineVariantOrder(key)) {
        const cfg = resolveSportCfg(key, preset);
        if (!isTeam(key, cfg)) continue;
        const id = `${key}/${preset}`;
        visited.push(id);
        const row = RULEBOOK_SIDE_SIZE[id];
        if (row === undefined) throw new Error(`no rulebook side size for ${id}`);
        if ("excluded" in row) {
          expect(row.excluded.trim(), `${id}: an exclusion names its reason`).not.toBe("");
          excluded.push(id);
          continue;
        }
        expect(row.source.trim(), `${id}: a row carries its source`).not.toBe("");
        const lineupSize = catalogOf(key, cfg).lineup.size;
        compared++;
        if (row.size !== lineupSize) found.push({ id, sideSize: row.size, lineupSize });
      }
    });
    expect(compared, "team presets compared with a rulebook side size").toBeGreaterThan(0);
    // No stale row: every row names a team preset the sweep visited.
    expect(Object.keys(RULEBOOK_SIDE_SIZE).filter((k) => !visited.includes(k))).toEqual([]);
    expect(visited.length, "team presets").toBe(15);
    // The finding cannot vanish (an empty list is a failure) or silently grow.
    expect(found.length, "side-size mismatches found").toBeGreaterThan(0);
    expect(found.map((m) => m.id)).toContain("volleyball/beach");
    expect(found).toEqual([
      { id: "volleyball/beach", sideSize: 2, lineupSize: 6 },
      { id: "hockey/youth", sideSize: 7, lineupSize: 11 },
    ]);
    expect(excluded).toEqual(["football/mini-soccer", "football/small-sided", "football/youth", "icehockey/recreational"]);
  });

  it("hockey/youth is engine-witnessed: its own strength.base (players on the pitch) agrees with its rulebook row and not with its catalog", () => {
    const base = (resolveSportCfg("hockey", "youth") as { strength?: { base?: unknown } }).strength?.base;
    expect(typeof base, "hockey youth declares strength.base").toBe("number");
    const row = RULEBOOK_SIDE_SIZE["hockey/youth"];
    expect(row !== undefined && "size" in row ? row.size : undefined).toBe(base);
    expect(catalogOf("hockey", resolveSportCfg("hockey", "youth")).lineup.size).not.toBe(base);
  });

  it("every row that rests on a committed W2 rulebook row quotes words that file still says", () => {
    const quoted = Object.entries(RULEBOOK_SIDE_SIZE).flatMap(([id, r]) => (r.rulebook === undefined ? [] : [{ id, ...r.rulebook }]));
    expect(quoted.length, "rows citing a committed rulebook").toBeGreaterThan(0);
    for (const q of quoted) expect(read(q.file).includes(q.quote), `${q.id}: ${q.file} no longer says ${JSON.stringify(q.quote)}`).toBe(true);
  });

  it("the finding is routed through the construct to the wave the plan names for it", () => {
    const planWave = /It is a \*\*(W[\w-]+) finding\*\*: "a variant whose side size differs from its catalog's `lineup\.size`"/.exec(read("docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md"))?.[1];
    expect(planWave, "the plan no longer names the side-size finding's wave").toBeDefined();
    expect(WAVE_ID.test(SIDE_SIZE_ROUTE.wave)).toBe(true);
    expect(SIDE_SIZE_ROUTE.wave).toBe(planWave);
    expect(SIDE_SIZE_ROUTE.why).toMatch(/side size/);
    expect(Object.isFrozen(SIDE_SIZE_ROUTE)).toBe(true);
  });
});

describe("rosters — the seam through the fake product (members stored, read back, PUT)", () => {
  /** A league of four team entrants in `sport`'s builder-default variant, rosters seeded inline. */
  async function seeded(sport: string): Promise<{ d: FakeLeagueDriver; cfg: unknown }> {
    const d = new FakeLeagueDriver();
    await d.createCompetition({ name: "Matrix", slug: "m" });
    const variant = offlineBuilderDefault(sport);
    await d.createDivision("c1", { name: "Matrix", slug: "d", sportKey: sport, variantKey: variant });
    await d.postStages("d1", stagesForRow("league").slice(0, 1));
    const cfg = resolveSportCfg(sport, variant);
    await d.addEntrants("d1", [1, 2, 3, 4].map((n) => ({ displayName: `Matrix Team ${n}`, seed: n, kind: "team" as const, members: rosterMembers(sport, cfg, n) })));
    await d.start();
    return { d, cfg };
  }

  it("every team sport: the roster is stored at the catalog's size, read back in squad order, and its lineup PUT is stored, answered checked with no warning, and passes validateLineup — counted", async () => {
    const driven: string[] = [];
    await forEachSportAsync(async ({ key }) => {
      const cfg0 = resolveSportCfg(key, offlineBuilderDefault(key));
      if (!isTeam(key, cfg0)) return;
      const { d, cfg } = await seeded(key);
      const f = d.fixtures[0]!;
      const home = f.home_entrant_id!;
      const members = await d.entrantMembers(home);
      expect(members.length, key).toBe(rosterSize(key, cfg));
      expect(members.map((m) => m.squad_number), key).toEqual(Array.from({ length: members.length }, (_, i) => i + 1));
      const slots = lineupFor(key, cfg, members);
      // I-1: the fake answers as the product does — checked, warnings from
      // the engine's validateLineup on the division's stored cfg.
      expect(await d.putLineup(f.id, home, slots), key).toEqual({ checked: true, warnings: [] });
      const stored = d.lineups.get(`${f.id}|${home}`);
      expect(stored, key).toEqual(slots);
      expect(validateLineup(catalogOf(key, cfg), toEngine(home, stored!)), key).toEqual([]);
      driven.push(key);
    });
    // m-8: pinned to the whole team-sport set, derived from the engine.
    expect(driven.length, "team sports driven through the fake").toBe(teamSports().length);
    expect(driven).toEqual(teamSports());
  });

  // One sport for the transitions: each is the fake's own rule, sport-blind
  // (the sweeps above own "another sport").
  it("empty case: an entrant added without members reads back an empty roster, and its lineup is refused by name before any PUT", async () => {
    const d = new FakeLeagueDriver();
    await d.createDivision("c1", { name: "M", slug: "d", sportKey: "football", variantKey: "11-a-side" });
    await d.postStages("d1", stagesForRow("league").slice(0, 1));
    await d.addEntrants("d1", [1, 2].map((n) => ({ displayName: `Matrix Team ${n}`, seed: n, kind: "team" as const })));
    await d.start();
    expect(await d.entrantMembers("e1")).toEqual([]);
    const before = d.calls.filter((c) => c === "putLineup").length;
    expect(() => lineupFor("football", d.cfg, [])).toThrow(/no members/);
    expect(d.calls.filter((c) => c === "putLineup").length).toBe(before);
  });

  it("a second PUT for the same fixture and entrant replaces the first, never appends", async () => {
    const { d, cfg } = await seeded("football");
    const f = d.fixtures[0]!;
    const home = f.home_entrant_id!;
    const members = await d.entrantMembers(home);
    await d.putLineup(f.id, home, lineupFor("football", cfg, members));
    const second = lineupFor("football", cfg, members).filter((s) => s.slot === "starting");
    await d.putLineup(f.id, home, second);
    expect(d.lineups.get(`${f.id}|${home}`)).toEqual(second);
    expect(d.calls.filter((c) => c === "putLineup").length).toBe(2);
  });

  it("a lineup the engine flags is SAVED and answered checked with the engine's warnings, as the product's warning-only PUT does (I-1)", async () => {
    const { d, cfg } = await seeded("football");
    const f = d.fixtures[0]!;
    const home = f.home_entrant_id!;
    const short = lineupFor("football", cfg, await d.entrantMembers(home)).filter((s) => s.slot === "starting").slice(1);
    const issues = validateLineup(catalogOf("football", cfg), toEngine(home, short));
    expect(issues.length, "the engine flags a starting lineup one short").toBeGreaterThan(0);
    const check = await d.putLineup(f.id, home, short);
    expect(check.checked).toBe(true);
    // The fake's warning text is its own (JSON of the issue); the issues are the engine's.
    expect(check.warnings.map((w) => JSON.parse(w) as unknown)).toEqual(issues);
    expect(d.lineups.get(`${f.id}|${home}`)).toEqual(short);
  });

  it("a lineup whose check crashes is SAVED and refused by name as unchecked — the product's checked: false, as HttpDriver reads it", async () => {
    // No division: the fake product has no sport to resolve a catalog from.
    const d = new FakeLeagueDriver();
    await d.addEntrants("d1", [1, 2].map((n) => ({ displayName: `Matrix Team ${n}`, seed: n, kind: "team" as const, members: [{ fullName: `Matrix Player ${n}.1`, squadNumber: 1, isCaptain: true }] })));
    const f = d.seat(1, "e1", "e2");
    const slots = (await d.entrantMembers("e1")).map((m, i) => ({ person_id: m.person_id, slot: "starting" as const, order_no: i + 1, roles: [] }));
    const e = await d.putLineup(f.id, "e1", slots).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LineupUnchecked);
    expect((e as LineupUnchecked).reason).toBe("UnknownSport");
    expect(d.lineups.get(`${f.id}|e1`)).toEqual(slots);
  });

  it("refusals: a person who is not the entrant's member, an entrant who is not a side, and a fixture past scheduled — after a withdrawal — are 422s by name", async () => {
    const { d, cfg } = await seeded("football");
    const f = d.fixtures[0]!;
    const [home, away] = [f.home_entrant_id!, f.away_entrant_id!];
    const homeSlots = lineupFor("football", cfg, await d.entrantMembers(home));
    // The away side's people under the home side.
    const awaySlots = lineupFor("football", cfg, await d.entrantMembers(away));
    const notMine = await d.putLineup(f.id, home, awaySlots).catch((e: unknown) => e);
    expect(notMine).toBeInstanceOf(RefusedCall);
    expect([(notMine as RefusedCall).status, (notMine as RefusedCall).method]).toEqual([422, "PUT"]);
    expect((notMine as RefusedCall).message).toMatch(/not a member of the entrant/);
    const other = d.entrants.map((e) => e.id).find((id) => id !== home && id !== away)!;
    const notSide = await d.putLineup(f.id, other, lineupFor("football", cfg, await d.entrantMembers(other))).catch((e: unknown) => e);
    expect((notSide as RefusedCall).message).toMatch(/not a side of this fixture/);
    // m-3: a person twice is refused (fixtures.ts:503-506) — and BEFORE the
    // member check, as the product orders them: an away person twice under
    // home reads "duplicate", not "not a member".
    const twice = [homeSlots[0]!, { ...homeSlots[0]!, slot: "bench" as const }];
    const dup = await d.putLineup(f.id, home, twice).catch((e: unknown) => e);
    expect((dup as RefusedCall).status).toBe(422);
    expect((dup as RefusedCall).message).toMatch(/: duplicate person in lineup$/);
    const awayTwice = [awaySlots[0]!, awaySlots[0]!];
    expect(((await d.putLineup(f.id, home, awayTwice).catch((e: unknown) => e)) as RefusedCall).message).toMatch(/: duplicate person in lineup$/);
    // Every refusal carries the wire code a codeless 422 reaches the product's wire with (m-2).
    for (const e of [notMine, notSide, dup]) expect((e as RefusedCall).code).toBe(wireCodeFor(422));
    expect(d.lineups.size).toBe(0);
    // Withdrawal: every fixture of the withdrawn entrant leaves `scheduled`.
    await d.withdraw(home);
    expect(f.status).not.toBe("scheduled");
    const locked = await d.putLineup(f.id, home, homeSlots).catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(RefusedCall);
    expect((locked as RefusedCall).message).toMatch(new RegExp(`locked once a fixture is ${f.status}`));
    expect(d.lineups.size).toBe(0);
  });
});
