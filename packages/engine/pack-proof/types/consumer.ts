// What a TypeScript consumer of the PACKED tarball sees, compiled with `skipLibCheck: false` (so a broken .d.ts is an error, not
// something quietly skipped) under both `bundler` and `nodenext` resolution, by the repo's TS 7 and TS 6.
//
// With skipLibCheck on, an unresolved specifier inside a declaration file silently becomes `any` and everything below still
// compiles. Three things here make that impossible to miss: the not-any assertions (they fail to compile on `any`), the two
// `@ts-expect-error` lines (an error that never fires is itself an error, TS2578), and `skipLibCheck: false` itself.
import { EngineError, foldMatch, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { createRegistry, type SportRegistry } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { generateRoundRobin, type RoundRobinSchedule } from "@seazn/engine/scheduling";
import { defaultLineupPair, sportCases, TEST_INSTANT, type SportCase } from "@seazn/engine/testkit";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;

// not-any: each of these is `true` only when the type is real
export type FoldMatchIsTyped = Assert<IsAny<typeof foldMatch> extends false ? true : false>;
export type RegistryIsTyped = Assert<IsAny<SportRegistry> extends false ? true : false>;
export type ScheduleIsTyped = Assert<IsAny<RoundRobinSchedule> extends false ? true : false>;
export type EnvelopeIsTyped = Assert<IsAny<EventEnvelope> extends false ? true : false>;
export type SportCaseIsTyped = Assert<IsAny<SportCase> extends false ? true : false>;
export type InstantIsTyped = Assert<IsAny<typeof TEST_INSTANT> extends false ? true : false>;

const registry: SportRegistry = createRegistry();
const first = builtinModules[0];
if (first === undefined) throw new EngineError("MODULE_NOT_FOUND", "no builtin module");
registry.register(first);

const schedule: RoundRobinSchedule = generateRoundRobin({ entrants: ["a", "b", "c", "d"] });
export const fixtureCount: number = schedule.fixtures.length;

const lineups: LineupPair = defaultLineupPair(first.positions);
export const cases: SportCase[] = sportCases();
export const folded: unknown = foldMatch(first, first.configSchema.parse({}), lineups, []);

// @ts-expect-error - roundNo is a number, so this is not assignable to a string: the declarations are real, not `any`
export const wrongRoundNo: string = schedule.rounds[0]?.roundNo;

// @ts-expect-error - an entrant id is a string, so a number is refused: the same proof from the argument side
generateRoundRobin({ entrants: [1, 2] });
