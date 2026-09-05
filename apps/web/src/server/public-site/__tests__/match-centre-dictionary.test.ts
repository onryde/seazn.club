// Spectator surface W1, Task 8 — dictionary coverage for every key a
// match-centre builder or renderer can emit, across all four locales
// (`apps/web/src/dictionaries/{en,es,fr,nl}/public.json`).
//
// COVERAGE BY DERIVATION, never a typed list (task-8 dispatch ruling 1) —
// three sources, unioned into `DERIVED_KEYS` below:
//
//  (a) a SOURCE SCAN — every string literal matching
//      `/"(matchCentre|timeline|term)\.[A-Za-z0-9_.]+"/` under
//      `components/public-site/**`, `server/public-site/**` and
//      `lib/timeline-keys.ts` (this file's own `__tests__` directory
//      excluded, or the gate could satisfy itself from its own fixtures);
//
//  (b) the DYNAMIC FAMILIES no string literal can name, because the key is
//      built from a runtime enum: `matchCentre.dismissal.<k>` (the engine's
//      own wicket kinds), `matchCentre.result.<k>` (pinned — see
//      `RESULT_KINDS` below), `matchCentre.ball.<k>` (`glyphs.tsx`'s own
//      `GLYPH_KINDS`), `matchCentre.status.<s>` (the header status enum),
//      `matchCentre.tab.<id>` (the tab-id enum) and `matchCentre.band.<0-3>`
//      (the fidelity scale, closed at 0-3);
//
//  (c) `BUILDER_ONLY_KEYS` — the template-only keys Task 6's
//      `buildMatchCentre` (and Task 9's header/chase work) will emit that no
//      renderer names yet, read off `MatchCentreHeader`'s own schema comment.
//      Exported so that task's own parity test can retire members of this
//      list as its renderer starts naming them for real.
//
// A key ending in "." is filtered out of the source scan: the regex above
// also matches a bare PREFIX constant used for string concatenation
// (`const FOOTBALL = "timeline.football.";` in `lib/timeline-keys.ts`), and
// that can never be a real dictionary entry.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 8)
// ---------------------------------------------------------------------------
// Applied by hand, run, observed red, restored from a `cp` backup (never
// `git checkout`, which would restore the index over uncommitted work).
//
//  (a) Deleted `"matchCentre.dismissal.stumped"` from `fr/public.json`.
//      → RED: "fr has every derived …" naming
//        `matchCentre.dismissal.stumped` in its `missing` list. The other
//        three locale tests stayed green — the gate is genuinely per-locale.
//
//  (b) Renamed `{value}` to `{amount}` in nl's
//      `matchCentre.result.runs` template only.
//      → RED: the params-parity test, naming
//        `nl:matchCentre.result.runs — en=[value] nl=[amount]`.
//
//  (c) Commented out the `sourceFiles(...)` calls in `scanLiteralKeys` so it
//      returns `[]` (the source-scan glob finding nothing).
//      → RED (2): "the source scan actually found something" (0 < 60) and
//        the same test's `DERIVED_KEYS.length >= 100` floor (union collapses
//        from ~119 to ~49 once the ~73-key scan contribution is gone) — so
//        an empty scan cannot read as coverage by starving the union below
//        its floor, not just by an assertion on the scan in isolation.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CricketWicket } from "@seazn/engine/sports/cricket";
import { GLYPH_KINDS } from "@/components/public-site/match-centre/glyphs";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { MatchCentreHeader, MatchCentreTabId } from "../match-centre-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ -> public-site -> server -> src.
const SRC = join(HERE, "../../..");

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS: Record<(typeof LOCALES)[number], Dict> = { en, es, fr, nl } as unknown as Record<
  (typeof LOCALES)[number],
  Dict
>;

// --------------------------------------------------------------- (a) source scan

/** Every `.ts`/`.tsx` file under `dir`, `__tests__` excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The dispatch's own regex. A bare prefix constant used for string
 *  concatenation also matches (see header comment) — filtered in
 *  `scanLiteralKeys` by rejecting any match ending in ".". */
const KEY_LITERAL = /"((?:matchCentre|timeline|term)\.[A-Za-z0-9_.]+)"/g;

function scanLiteralKeys(): string[] {
  const files = [
    ...sourceFiles(join(SRC, "components/public-site")),
    ...sourceFiles(join(SRC, "server/public-site")),
    join(SRC, "lib/timeline-keys.ts"),
  ];
  const keys = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(KEY_LITERAL)) {
      const key = match[1]!;
      if (!key.endsWith(".")) keys.add(key);
    }
  }
  return [...keys];
}

const SCANNED_KEYS = scanLiteralKeys();

// ----------------------------------------------------- (b) the dynamic families

/** `CricketWicket.shape.kind.options` — the SAME zod-derived list
 *  `packages/engine/src/sports/cricket/cricket.ts:2478` uses for its own
 *  stat-model split, rather than a THIRD hand-copy of the ten dismissal
 *  modes (the schema itself and that stat-model split are the other two). */
const ENGINE_WICKET_KINDS: readonly string[] = CricketWicket.shape.kind.options;
/** Band 2 lines that carry no dismissal detail read `{ kind: "out_unknown" }`;
 *  an undismissed batter reads `{ kind: "not_out" }` — neither is a member of
 *  `CricketWicket.kind` (that schema only ever describes an ACTUAL wicket). */
const DISMISSAL_KINDS: readonly string[] = [...ENGINE_WICKET_KINDS, "not_out", "out_unknown"];

/**
 * No runtime enum exists for a cricket "how was this decided" margin kind —
 * pinned here per the task-8 ruling's own escape hatch ("if only a TS union
 * exists with no runtime list, pin the kinds in ONE constant with the
 * file:line comment"). `MatchOutcome.kind`
 * (`packages/engine/src/core/types.ts:115-132`) is a five-member
 * discriminated union (`win`/`draw`/`tie`/`no_result`/`award`) that is
 * SPORT-AGNOSTIC and does not split a `win` by margin; the margin unit
 * ("runs" vs "wickets" vs "an innings and N runs") and the deciding METHOD
 * ("regulation"/"dls"/"innings"/"super_over"/"boundary_count") are composed
 * as a plain `z.string()` (`core/types.ts:122`, comment: "sport modules may
 * extend, so plain string") at each `decideWin(...)` call site in
 * `packages/engine/src/sports/cricket/cricket.ts`: lines 894-895 (wickets,
 * regulation/dls chase), 902-904 (runs, regulation/dls chase), 921 (wickets,
 * two-innings), 925 (runs, two-innings), 936 (innings victory), 1112 & 1118
 * (runs, DLS par), 1750 & 1753 (Super Over), 1764 (boundary count) — plus the
 * bare-outcome branches at lines 876 (tie), 1120 (no_result) and 3330 (draw,
 * `cricket.match.close` time-expiry).
 *
 * The nine kinds below are read off that vocabulary: "runs" and "wickets"
 * are the two margin units a REGULATION win prints; "innings" is the
 * innings-victory margin; "dls" overrides the unit label when the target was
 * DLS-revised; "superover" and "boundarycount" are the two Super-Over
 * deciding methods; "tie"/"draw"/"no_result" are the three non-win outcomes
 * cricket actually reaches. Task 6's `buildMatchCentre` may spell these
 * differently once it exists — flagged in the task-8 report as a risk for
 * whichever task writes that builder's own dictionary parity test.
 */
const RESULT_KINDS: readonly string[] = [
  "runs",
  "wickets",
  "innings",
  "dls",
  "superover",
  "boundarycount",
  "tie",
  "draw",
  "no_result",
];

/** The ball-outcome categories `glyphs.tsx`'s own `classesFor` distinguishes
 *  — exported from there so the two cannot drift apart (see its header
 *  comment, added as this task's one sanctioned renderer edit). */
const BALL_GLYPH_KINDS: readonly string[] = GLYPH_KINDS;

/** The header status enum (`match-centre-schema.ts`) — `scheduled` and
 *  `decided` are already reachable from the source scan (`court-card.tsx`
 *  renders a chip for them), but `in_play` (the chip reads
 *  `matchCentre.status.live` instead — see `court-card.tsx`'s `statusChip`)
 *  and `other` (which renders NO chip; the schema comment says a later
 *  task's copy is expected to name the reason) are not literal anywhere
 *  today. Both are reachable at runtime the moment something switches on
 *  `header.status` directly, so both need a locale entry now rather than on
 *  whichever later task first reads the raw enum value. */
const HEADER_STATUS_KINDS: readonly string[] = MatchCentreHeader.shape.status.options;

/** The six tabs `tab-rail.tsx` renders via a template literal
 *  (`` `matchCentre.tab.${tab}` ``), invisible to the source scan. */
const TAB_IDS: readonly string[] = MatchCentreTabId.options;

/** The fidelity band scale is CLOSED at 0-3 — never a tier 4
 *  (`packages/engine/src/sport/module.ts:96`, `FIDELITY`). */
const BAND_LEVELS: readonly string[] = ["0", "1", "2", "3"];

// ------------------------------------------------- (c) builder-only keys

/**
 * Keys Task 6's `buildMatchCentre` (and Task 9's header/chase work) will
 * emit that no renderer names yet — read straight off `MatchCentreHeader`'s
 * own schema comment: `statusLine` ("Queens need 34 from 21" /
 * "Starts Sat 14:00") and `rateLine` ("CRR 8.44 · RRR 9.71" — numbers today,
 * but the abbreviations imply a labelled legend is coming). Exported so that
 * task's own parity test can import and retire members of this list as its
 * renderer starts naming them for real — a member still here after that
 * lands is a genuine gap, not a false positive this list is excusing.
 */
export const BUILDER_ONLY_KEYS = [
  "matchCentre.chase.need",
  "matchCentre.chase.needFrom",
  "matchCentre.status.startsAt",
  "matchCentre.rate.crr",
  "matchCentre.rate.rrr",
] as const;

// --------------------------------------------------------------- the union

const DERIVED_KEYS = [
  ...new Set([
    ...SCANNED_KEYS,
    ...DISMISSAL_KINDS.map((k) => `matchCentre.dismissal.${k}`),
    ...RESULT_KINDS.map((k) => `matchCentre.result.${k}`),
    ...BALL_GLYPH_KINDS.map((k) => `matchCentre.ball.${k}`),
    ...HEADER_STATUS_KINDS.map((k) => `matchCentre.status.${k}`),
    ...TAB_IDS.map((k) => `matchCentre.tab.${k}`),
    ...BAND_LEVELS.map((k) => `matchCentre.band.${k}`),
    ...BUILDER_ONLY_KEYS,
  ]),
].sort();

// ----------------------------------------------------------------- tests

describe("match-centre dictionary coverage (derived, never a typed list)", () => {
  it("the source scan and the derived union both found a real vocabulary, not an empty one", () => {
    // See mutant (c) in the task-8 report: disabling the scan drops
    // `SCANNED_KEYS` to 0 and the union from ~119 to ~49 — both floors below
    // exist so that collapse cannot read as coverage.
    expect(SCANNED_KEYS.length).toBeGreaterThanOrEqual(60);
    expect(DERIVED_KEYS.length).toBeGreaterThanOrEqual(100);
  });

  it("the dynamic families themselves are non-trivial", () => {
    expect(DISMISSAL_KINDS.length).toBe(12);
    expect(RESULT_KINDS.length).toBeGreaterThanOrEqual(9);
    expect(BALL_GLYPH_KINDS.length).toBeGreaterThanOrEqual(9);
    expect(HEADER_STATUS_KINDS).toEqual(
      expect.arrayContaining(["scheduled", "in_play", "decided", "other"]),
    );
    expect(TAB_IDS).toEqual(
      expect.arrayContaining(["summary", "scorecard", "commentary", "timeline", "sets", "info"]),
    );
  });

  for (const locale of LOCALES) {
    it(`${locale} has every derived match-centre/timeline/term key as a non-empty string`, () => {
      const dict = DICTS[locale];
      const missing: string[] = [];
      for (const key of DERIVED_KEYS) {
        const value = dict[key];
        if (typeof value !== "string" || value === "") missing.push(key);
      }
      expect(missing).toEqual([]);
    });
  }

  it("every {param} the English template names is present in every other locale's template for the same key", () => {
    const paramsOf = (s: string): string[] =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    const mismatches: string[] = [];
    for (const key of DERIVED_KEYS) {
      const enValue = DICTS.en[key];
      if (typeof enValue !== "string") continue; // reported by the existence test above
      const enParams = paramsOf(enValue);
      if (enParams.length === 0) continue;
      for (const locale of LOCALES) {
        if (locale === "en") continue;
        const value = DICTS[locale][key];
        if (typeof value !== "string") continue; // ditto
        const params = paramsOf(value);
        if (params.join(",") !== enParams.join(",")) {
          mismatches.push(`${locale}:${key} — en=[${enParams.join(",")}] ${locale}=[${params.join(",")}]`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("no key in any locale is `public.`-prefixed — the namespace is the FILE, not a key prefix", () => {
    for (const locale of LOCALES) {
      const prefixed = Object.keys(DICTS[locale]).filter((k) => k.startsWith("public."));
      expect(prefixed).toEqual([]);
    }
  });
});
