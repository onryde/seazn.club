// W2b ruling 122, round 2 — the sweep guard for ONE appearance rule. "Who appeared in a match" was written twice (the
// career count and the public match lines) and the two drifted before anyone noticed (round 1). The rule now lives in
// `src/server/appearances.ts` alone; this scan reds when SQL anywhere else in apps/web/src credits a person through the
// shapes that rule is made of, so the next copy is argued before it ships, not found after.
//
// What it reads, in every non-test file under apps/web/src (TypeScript's own parser, so a comment never counts): each
// TAGGED TEMPLATE (a postgres.js query or fragment) whose text holds one of the rule's shapes —
//  - lineup-role:  `lineups` read with a `role = 'player' | 'coach' | 'staff'` predicate (the sheet's player rows);
//  - lane:         a `lane = 'player' | 'coach' | 'staff'` predicate (a person's registered lane);
//  - roster-side:  `entrant_members` read beside a fixture's `home_entrant_id` / `away_entrant_id` (a roster credited
//                  with a fixture);
//  - lineup-side:  `lineups` read beside a fixture's side columns (a sheet placed on a side).
// Each such site is THE RULE (in appearances.ts) or EXEMPT, by file and nearest named enclosing function, with the
// reason it credits no match and the NUMBER of sites it covers — a new query inside an exempt function is one more and
// reds, as a new function does; an exemption that covers fewer sites than it pins (a stale one) reds too. The readers
// of the rule are pinned the same way: exactly the two that interpolate `appearanceSide(`. Zero sites checked is a
// failure, and an independent census (a regex over the comment-stripped text, not the parser) must find the same
// number of role/lane predicates the parser found inside templates — SQL hidden in a plain string reds it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle
// (pass-scoping-guard.test.ts).
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const WEB = new URL("../../../", import.meta.url).pathname; // apps/web/ from apps/web/src/server/__tests__
const RULE_FILE = "src/server/appearances.ts";
const RULE_FN = "appearanceSide";

type Shape = "lineup-role" | "lane" | "roster-side" | "lineup-side";
const PREDICATE = /\b(?:role|lane)\s*(?:=|<>|!=)\s*'(?:player|coach|staff)'/g;
const SHAPES: readonly [Shape, (sql: string) => boolean][] = [
  ["lineup-role", (s) => /\blineups\b/.test(s) && /\brole\s*(?:=|<>|!=)\s*'(?:player|coach|staff)'/.test(s)],
  ["lane", (s) => /\blane\s*(?:=|<>|!=)\s*'(?:player|coach|staff)'/.test(s)],
  ["roster-side", (s) => /\bentrant_members\b/.test(s) && /\b(?:home|away)_entrant_id\b/.test(s)],
  ["lineup-side", (s) => /\blineups\b/.test(s) && /\b(?:home|away)_entrant_id\b/.test(s)],
];

/** The two readers of the rule — the career count and the public match lines (ruling 122, round 1). */
const READERS: readonly { file: string; fn: string }[] = [
  { file: "src/server/usecases/player-stats.ts", fn: "careerMatchesByDivision" },
  { file: "src/server/public-site/public-player-matches.ts", fn: "readPlayerMatchSeeds" },
];

interface Exemption {
  readonly file: string;
  readonly fn: string;
  readonly sites: number;
  readonly reason: string;
}
const EXEMPT: readonly Exemption[] = [
  // The career count's DIVISION scope — the one place outside the rule that reads a sheet's player rows.
  {
    file: "src/server/usecases/player-stats.ts",
    fn: "placedDivisions",
    sites: 1,
    reason:
      "the career count's candidate DIVISIONS, not its matches: which fixtures count is appearanceSide's, asked by careerMatchesByDivision over these divisions; a sheet player row only lets the scope reach a division its player has since left the roster of (ruling 122, round 1)",
  },
  // Reads of what is coming, not of what was played.
  { file: "src/server/public-site/public-player-matches.ts", fn: "readPlayerUpcoming", sites: 1, reason: "a player's UPCOMING matches: `status = 'scheduled'`, nothing played or credited" },
  {
    file: "src/server/usecases/me.ts",
    fn: "listMyFixtures",
    sites: 2,
    reason:
      "/me's upcoming duties (scheduled/in_play) and 'Recent results' — a TEAM's results feed (entrant v opponent, the team a coach follows too), not a count of matches the person played",
  },
  { file: "src/server/usecases/me.ts", fn: "myPersonOnFixture", sites: 1, reason: "authorises a claimed person's availability write on their entrant's fixture; credits nothing" },
  // Scores credited per pair member — the rule's own answer for a pair side.
  { file: "src/server/usecases/americano.ts", fn: "personalPointsLeaderboard", sites: 1, reason: "americano/mexicano personal points over PAIR entrants, where the rule's roster stands in for every member anyway" },
  { file: "src/server/usecases/stages.ts", fn: "americanoGen", sites: 1, reason: "mexicano's next-round pairing by per-person points over PAIR entrants (the rule's own roster answer); credits nothing" },
  // A candidate set ranked by the stats fold's own figure.
  {
    file: "src/server/usecases/org-posts.ts",
    fn: "assembleDigestClaimed",
    sites: 1,
    reason: "the digest highlight's candidate set; it ranks by the stats fold's figure and skips a value <= 0, which a coach or a non-player never earns",
  },
  // Inputs, pickers and invalidation — they place people, never count a match.
  { file: "src/server/usecases/player-stats.ts", fn: "playerStatsInputsMd5", sites: 1, reason: "the stats cache key's inputs (rosters, sheets): a digest, credits nothing" },
  { file: "src/server/engine-db/lineups.ts", fn: "loadLineupPairsForDivision", sites: 1, reason: "the fold's lineup inputs for the engine; credits nothing" },
  { file: "src/app/score/[token]/page.tsx", fn: "ScorePadPage", sites: 1, reason: "the device pad's fixture and squads; credits nothing" },
  { file: "src/server/usecases/match-reports.ts", fn: "myFixtureSquad", sites: 1, reason: "the official's match-report person picker over both squads; credits nothing" },
  { file: "src/server/public-site/revalidate.ts", fn: "firePersonRevalidate", sites: 1, reason: "cache invalidation: every fixture naming the person, over-inclusive by design; credits nothing" },
  // Online chess (external play): who sits at a board, or whose Lichess game a fixture is — never who appeared.
  {
    file: "src/server/usecases/external-play/seated.ts",
    fn: "fixturesSeating",
    sites: 1,
    reason: "D7 safeguarding: does this user PLAY on these boards (so the arbiter panel never shows a player their opponent's camera); broad on purpose, credits nothing",
  },
  {
    file: "src/server/usecases/external-play/create-game.ts",
    fn: "findSentGame",
    sites: 1,
    reason: "Lichess create recovery: another fixture of the same two players with a create in flight (a peer), so an ambiguous challenge is held, never adopted; credits nothing",
  },
  {
    file: "src/server/usecases/external-play/account-changed.ts",
    fn: "holdBoardsOnAccountChange",
    sites: 1,
    reason:
      "final review P11: a re-link to a different Lichess account (account_changed) OR an unlink (token_revoked, P11 (4)) finds the boards this user SITS AT whose game is live or mid-create, to hold them for the organiser; who appeared is never asked, credits nothing",
  },
  {
    file: "src/server/usecases/external-play/preflight.ts",
    fn: "issuePlayerToken",
    sites: 1,
    reason:
      "final re-review 2, R2-2: under the meeting row's lock, is this person still a member of one of the board's two entrants NOW — a video participant is stored only for the pairing the meeting was made for; who appeared is never asked, credits nothing",
  },
  // Registration finds a person in the player lane (persons_org_user_lane_uq).
  { file: "src/server/usecases/registrations.ts", fn: "resolvePlayerPerson", sites: 1, reason: "registration's person lookup in the player lane; credits nothing" },
  { file: "src/server/usecases/registrations.ts", fn: "findPlayerPersonByEmail", sites: 1, reason: "registration's person lookup in the player lane; credits nothing" },
  { file: "src/server/usecases/registrations.ts", fn: "playerPersonConsentsByEmail", sites: 1, reason: "registration's consent lookup in the player lane; credits nothing" },
  { file: "src/server/usecases/registrations.ts", fn: "findOrCreatePlayerPerson", sites: 1, reason: "registration's person lookup in the player lane; credits nothing" },
];

interface Site {
  readonly file: string;
  readonly line: number;
  readonly fn: string;
  readonly shapes: readonly Shape[];
}

function gitFiles(): string[] {
  return execFileSync("git", ["ls-files", "--", "src/**/*.ts", "src/**/*.tsx"], { cwd: WEB, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes("/__tests__/") && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
}

/** The nearest NAMED enclosing declaration: a function, a method, or a variable/property holding a function. */
function enclosingName(node: TS.Node): string {
  for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      const p = n.parent;
      if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.name) return p.name.getText();
    }
  }
  return "<module>";
}

/** A template's SQL as written: its literal parts, each substitution standing as `${…}` (never its expression text, so
 *  an interpolated name cannot fake or hide a shape). */
function templateSql(t: TS.TemplateLiteral): string {
  return ts.isNoSubstitutionTemplateLiteral(t) ? t.text : [t.head.text, ...t.templateSpans.map((sp) => `\${…}${sp.literal.text}`)].join("");
}

function scan(): { files: number; templates: number; sites: Site[]; readers: { file: string; fn: string }[]; predicates: number } {
  const files = gitFiles();
  const sites: Site[] = [];
  const readers: { file: string; fn: string }[] = [];
  let templates = 0;
  let predicates = 0;
  for (const file of files) {
    const text = readFileSync(join(WEB, file), "utf8");
    if (!/entrant_members|lineups|\blane\b|appearanceSide/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const walk = (n: TS.Node) => {
      if (ts.isTaggedTemplateExpression(n)) {
        templates++;
        const sql = templateSql(n.template);
        predicates += (sql.match(PREDICATE) ?? []).length;
        const shapes = SHAPES.filter(([, has]) => has(sql)).map(([shape]) => shape);
        if (shapes.length > 0) sites.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, fn: enclosingName(n), shapes });
        if (!ts.isNoSubstitutionTemplateLiteral(n.template)) {
          for (const span of n.template.templateSpans) {
            const e = span.expression;
            if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === RULE_FN) readers.push({ file, fn: enclosingName(n) });
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return { files: files.length, templates, sites, readers, predicates };
}

/** The census: role/lane predicates in the comment-stripped TEXT of every file — a regex, never the parser. */
function census(files: readonly string[]): number {
  let n = 0;
  for (const file of files) {
    const stripped = readFileSync(join(WEB, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    n += (stripped.match(PREDICATE) ?? []).length;
  }
  return n;
}

describe("ruling 122, round 2: the appearance rule has ONE home", () => {
  const result = scan();
  const outside = result.sites.filter((s) => s.file !== RULE_FILE);
  const where = (s: Site) => `${s.file}:${s.line} ${s.fn} [${s.shapes.join(",")}]`;

  it("anti-vacuity: the scan read the tree and found the rule's own sites", () => {
    expect(result.files, "files scanned").toBeGreaterThan(500);
    expect(result.templates, "tagged templates read").toBeGreaterThan(500);
    expect(result.sites.length, `${result.sites.length} sites checked`).toBeGreaterThan(0);
    // The rule itself: one fragment, every shape in it.
    expect(result.sites.filter((s) => s.file === RULE_FILE).map((s) => [s.fn, s.shapes])).toEqual([
      [RULE_FN, ["lineup-role", "lane", "roster-side", "lineup-side"]],
    ]);
  });

  it("every site outside appearances.ts is an exemption, by file and function, with the count it pins", () => {
    const unexempt = outside.filter((s) => !EXEMPT.some((e) => e.file === s.file && e.fn === s.fn)).map(where);
    expect(unexempt, `${outside.length} sites outside the rule checked`).toEqual([]);
    const covered = Object.fromEntries(EXEMPT.map((e) => [`${e.file} ${e.fn}`, outside.filter((s) => s.file === e.file && s.fn === e.fn).length]));
    expect(covered, "each exemption covers exactly the sites it pins — a new query there is one more").toEqual(
      Object.fromEntries(EXEMPT.map((e) => [`${e.file} ${e.fn}`, e.sites])),
    );
    for (const e of EXEMPT) expect(e.reason.length, `${e.file} ${e.fn}: a reason`).toBeGreaterThan(20);
    expect(outside.length).toBe(EXEMPT.reduce((n, e) => n + e.sites, 0));
  });

  it("the rule's readers are exactly the career count and the public match lines", () => {
    expect(result.readers).toEqual(expect.arrayContaining([...READERS]));
    expect(result.readers.length, "each reader interpolates the rule once").toBe(READERS.length);
  });

  it("census: every role/lane predicate in the tree sits inside a template the parser read", () => {
    expect(result.predicates, "predicates the parser found").toBeGreaterThan(0);
    expect(census(gitFiles()), "predicates in the comment-stripped text").toBe(result.predicates);
  });
});
