// D2 (ruled 52): rosters are the FULL declared size — the engine's own catalog
// (resolvePositions: starting lineup + bench), capped at the entrant schema's
// 40 — so cricket's all-out (min(playersPerSide, order.length) − 1) means what
// the generated stream means, and every lineup passes the engine's
// validateLineup (Review Focus 1; rosters.test.ts sweeps every team preset and
// every committed team variant cfg). Members are synthetic (R14a):
// "Matrix Player <entrant>.<m>", squad 1..n, the first the captain.
import { resolvePositions, type PositionCatalog } from "@seazn/engine/sport";
import { inSquadOrder, type EntrantMember, type LineupSlotWire, type MemberInput } from "../driver/types.ts";
import { routeTo } from "../routing.ts";
import { sportModule } from "../sport-cfg.ts";

/** apps/web/src/server/api-v1/schemas.ts CreateEntrant `members .max(40)` (text-pinned by rosters.test.ts). */
export const ROSTER_MAX = 40;

/** Plan review 1 m-2, review 3 m-5: a variant whose players per side differs
 *  from its catalog's `lineup.size` — volleyball's beach (2 a side) gets the
 *  one 6-starter catalog, hockey's youth (7 a side) the 11-starter one. The
 *  roster follows the engine's catalog (D2), so it is not the harness's to
 *  correct: the engine declares a variant's side. rosters.test.ts pins the
 *  found list against cited rulebooks and reads its owner from here. */
export const SIDE_SIZE_ROUTE = routeTo("W2", "a variant whose side size differs from its catalog's lineup.size; the roster follows the catalog (D2), so the variant's own side size is the engine's to declare");
/** The `<sport>/<preset>` rows of that finding — exactly the list
 *  rosters.test.ts derives from the cited rulebooks. A starting-size lineup
 *  warning on one of them is the known finding (lineup-plan.ts
 *  judgeLineupWarnings reports it to each caller's sink, T3-R1), never a red. */
export const SIDE_SIZE_FOUND: readonly string[] = Object.freeze(["volleyball/beach", "hockey/youth"]);

/** The engine issue that states a side's starting count (catalog.ts
 *  LineupIssue): the one kind the side-size finding can show up as. */
export const SIDE_SIZE_KIND = "starting_size";

/** The product's text for each engine lineup issue (fixtures.ts
 *  formatLineupIssue, one template per LineupIssue kind; scenarios.test.ts
 *  renders every template from the product's source and pins each to its
 *  kind). */
export const LINEUP_ISSUE_TEXT: Readonly<Record<string, RegExp>> = Object.freeze({
  starting_size: /^Starting lineup has \d+ player\(s\), expected \d+$/,
  bench_size: /^Bench has \d+ player\(s\), maximum is \d+$/,
  duplicate_person: /^Person .+ appears more than once in the lineup$/,
  unknown_position: /^Person .+ is assigned an unknown position ".*"$/,
  role_unknown: /^Person .+ is assigned an unknown role ".*"$/,
  role_duplicate: /^Role ".*" is held by more than one person \(.*\)$/,
  role_missing: /^Required role ".*" is not filled by a starting player$/,
  group_min: /^Position group ".*" has \d+ starting player\(s\), minimum is \d+$/,
  group_max: /^Position group ".*" has \d+ starting player\(s\), maximum is \d+$/,
});

/** T3-R1: a lineup warning's issue KIND, never its words. The product formats
 *  each issue (LINEUP_ISSUE_TEXT); the fake answers the engine's issue as
 *  JSON (fake-driver.ts putLineup). null: a warning in neither shape. */
export function lineupWarningKind(warning: string): string | null {
  try {
    const issue: unknown = JSON.parse(warning);
    if (issue !== null && typeof issue === "object" && typeof (issue as { kind?: unknown }).kind === "string") return (issue as { kind: string }).kind;
  } catch {
    // Not JSON: the product's text.
  }
  for (const [kind, text] of Object.entries(LINEUP_ISSUE_TEXT)) if (text.test(warning)) return kind;
  return null;
}

/** The catalog that governs a cfg; injectable so a test can hand one in. */
export type CatalogOf = (sport: string, cfg: unknown) => PositionCatalog;
const engineCatalog: CatalogOf = (sport, cfg) => resolvePositions(sportModule(sport) as never, cfg as never);

export class RosterTooLarge extends Error {
  readonly sport: string;
  readonly declared: number;
  constructor(sport: string, declared: number) {
    super(`rosters: ${sport} declares ${declared} players (lineup + bench), above the entrant schema's ${ROSTER_MAX}`);
    this.name = "RosterTooLarge";
    this.sport = sport;
    this.declared = declared;
  }
}

/** Starting lineup + bench, as the catalog declares them; above ROSTER_MAX is refused by name. */
export function rosterSize(sport: string, cfg: unknown, catalogOf: CatalogOf = engineCatalog): number {
  const c = catalogOf(sport, cfg);
  const n = c.lineup.size + (c.lineup.benchMax ?? 0);
  if (n > ROSTER_MAX) throw new RosterTooLarge(sport, n);
  return n;
}

/** The synthetic name of the `n`-th entrant of a division of `kind` (W1d item 23): a team is "Matrix Team N", any
 *  other kind (an individual, a pair) "Matrix Player N". One authority for the scenario harness and the model, so the
 *  name says what the entrant is. A team's MEMBERS stay "Matrix Player <n>.<m>" (rosterMembers): they are people. */
export function entrantName(kind: "individual" | "pair" | "team", n: number): string {
  return kind === "team" ? `Matrix Team ${n}` : `Matrix Player ${n}`;
}

/** Entrant `entrantNo`'s roster: "Matrix Player <entrantNo>.<m>", squad m, m = 1 the captain. */
export function rosterMembers(sport: string, cfg: unknown, entrantNo: number, catalogOf: CatalogOf = engineCatalog): MemberInput[] {
  if (!(Number.isInteger(entrantNo) && entrantNo > 0)) throw new Error(`rosters: an entrant number is a positive whole number (a seed), got ${entrantNo}`);
  return Array.from({ length: rosterSize(sport, cfg, catalogOf) }, (_, i) => ({ fullName: `Matrix Player ${entrantNo}.${i + 1}`, squadNumber: i + 1, isCaptain: i === 0 }));
}

/** Starters = `lineup.size`, the lowest squad numbers; the bench the next
 *  `benchMax`. Each group's `min` is filled first (a football or hockey
 *  goalkeeper), then every other starter takes the first group with room
 *  under its `max`; each required role (cricket's wicketkeeper) goes to a
 *  distinct starter. Every slot carries its `order_no` (its index + 1, what
 *  the product would store for an omitted one). */
export function lineupFor(sport: string, cfg: unknown, members: readonly EntrantMember[], catalogOf: CatalogOf = engineCatalog): LineupSlotWire[] {
  if (members.length === 0) throw new Error(`rosters: ${sport} lineup from no members — seed the roster before the first event`);
  const c = catalogOf(sport, cfg);
  const size = c.lineup.size;
  const ordered = inSquadOrder(members);
  if (ordered.length < size) throw new Error(`rosters: ${sport} needs ${size} starters, roster has ${ordered.length}`);
  const mins = c.groups.reduce((n, g) => n + (g.min ?? 0), 0);
  if (mins > size) throw new Error(`rosters: ${sport} group minimums sum to ${mins}, above its ${size}-player lineup — no lineup holds them`);
  const required = (c.roles ?? []).filter((r) => r.required === true).map((r) => r.key);
  if (required.length > size) throw new Error(`rosters: ${sport} declares ${required.length} required roles for ${size} starters — each needs a distinct starter`);
  const count = new Map<string, number>();
  const positions: (string | undefined)[] = Array.from({ length: size }, () => undefined);
  const place = (i: number, key: string) => {
    positions[i] = key;
    count.set(key, (count.get(key) ?? 0) + 1);
  };
  let i = 0;
  for (const g of c.groups) for (let k = 0; k < (g.min ?? 0); k++) place(i++, g.key);
  for (; i < size; i++) {
    const g = c.groups.find((x) => x.max === undefined || (count.get(x.key) ?? 0) < x.max);
    if (g !== undefined) place(i, g.key);
  }
  const out: LineupSlotWire[] = ordered.slice(0, size).map((m, j) => ({
    person_id: m.person_id,
    slot: "starting",
    order_no: j + 1,
    ...(positions[j] !== undefined ? { position_key: positions[j] } : {}),
    roles: j < required.length ? [required[j]] : [],
  }));
  for (const m of ordered.slice(size, size + (c.lineup.benchMax ?? 0))) out.push({ person_id: m.person_id, slot: "bench", order_no: out.length + 1, roles: [] });
  return out;
}
