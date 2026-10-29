// W2b Task 10 (finding 2; spec §5.1 "every caller enumerated"; Appendix A X-RS-1) — the engine closed the forfeit
// vocabulary (`FORFEIT_REASONS`) and moved the reason to `award.reason`. The server refuses a `core.forfeit` whose
// reason is outside it, so a free-text reason ("no-show", "retired hurt") left in an e2e spec, a smoke script or a bench
// pack builder is a write the product now refuses 422. This scan reads every file in those scopes that names
// `core.forfeit` and checks each payload literal's reason against the engine's own declaration — never a list typed
// here. It is COUNTED: an empty file list, a regex that never matches, a read count below its floor or a forfeit write
// the regex cannot read is a failure, not a pass.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import { FORFEIT_REASONS } from "@seazn/engine/core";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle
// (pass-scoping-guard.test.ts). The type side is a type-only import, erased before vite sees it.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const ROOT = new URL("../../../../../", import.meta.url).pathname; // repo root from apps/web/src/server/__tests__
/** This file names both patterns itself (the shape fixtures below, the retired methods in the grep), so it is the one
 *  file the scans leave out. */
const SELF = new URL(import.meta.url).pathname.slice(ROOT.length);
const SCOPES = ["apps/web/src", "apps/web/e2e", "scripts", "tools/bench/packs/build-packs", `:!${SELF}`];

/** `git grep` exits 1 when nothing matches: that is "no hits", read as `[]`. Any other exit (a bad pathspec, not a
 *  repo) is a broken scan and throws, so a scan that cannot run never reads as clean. */
function gitGrep(args: string[], cwd = ROOT): string[] {
  try {
    return execFileSync("git", ["grep", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

const files = gitGrep(["-l", "-e", "core.forfeit", "--", ...SCOPES, ":!*.golden.json"]);
/** A `core.forfeit` literal followed by its payload's `reason` literal, in every shape this repo writes one: an
 *  envelope (`type: "core.forfeit", payload: {…}`), a positional call (`post(id, "core.forfeit", {…})`), a stream
 *  tuple (`["core.forfeit", {…}]`) and a keyed sample (`"core.forfeit": {…}`). The gap may not cross another quoted
 *  event type, so a reason-less forfeit never borrows the next event's reason (an abandon's "rain"). The brief's
 *  envelope-only regex read 33 payloads and missed 7 free-text reasons in the other three shapes. */
const PAYLOAD = /["'`]core\.forfeit["'`](?:(?!["'`][a-z]+\.[a-z_.]+["'`])[\s\S]){0,240}?reason:\s*["'`]([^"'`]+)["'`]/g;
/** A `core.forfeit` literal followed by its payload OBJECT — the same four shapes, without reading the reason. The
 *  literal's other uses (a comparison `e.type === "core.forfeit"`, a type list, a `toContain`) are not writes. It
 *  steps over comments ITSELF rather than leaning on `code()`, so a stripper that stops stripping leaves the writes
 *  counted and the reads short: a deficit, not two matching blind spots. */
const GAP_OR_COMMENT = String.raw`(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*`;
const WRITE = new RegExp(String.raw`["'\x60]core\.forfeit["'\x60]\s*[,:]${GAP_OR_COMMENT}(?:payload\s*:${GAP_OR_COMMENT})?\{`, "g");

/** The code with every comment removed, through the TypeScript printer — a parser, so a `//` inside a string or a quote
 *  inside a regex literal is never taken for a comment. A comment between a forfeit's type and its payload (org-posts'
 *  two-line W2b note) pushed the reason past the window, and the write read as no payload at all. JSON holds no
 *  comments and is read as it is. */
const printer = ts.createPrinter({ removeComments: true });
function code(path: string, text: string): string {
  if (path.endsWith(".json")) return text;
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return printer.printFile(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind));
}

/** One file's forfeit census: the reasons its payload literals carry, and how many of its forfeit WRITES the payload
 *  regex could not read (a reason that is a variable, a spread, or missing). */
function census(path: string, text: string): { reasons: string[]; unreadWrites: number } {
  const body = code(path, text);
  const reads = [...body.matchAll(PAYLOAD)];
  const readAt = new Set(reads.map((m) => m.index));
  const unreadWrites = [...body.matchAll(WRITE)].filter((m) => !readAt.has(m.index)).length;
  return { reasons: reads.map((m) => m[1]!), unreadWrites };
}

/** The payload literals the scan read on 2026-10-11 (77 before comments were stripped; org-posts' two in-play
 *  retirements are the difference). A floor, not a pin: a new forfeit literal raises the count, a regex or stripper
 *  that stops reading drops it below. */
const PAYLOAD_FLOOR = 79;
/** Every forfeit write whose reason is not a literal, so the scan cannot read it — COUNTED per file, each with why it is
 *  not a free-text reason. A writer the regex cannot read lands here as a deficit and reds until it is named; a named
 *  one that becomes readable, or goes, reds until its entry is deleted. */
const UNREAD_WRITERS: Record<string, { writes: number; why: string }> = {
  "apps/web/src/components/v2/fixture-console.tsx": { writes: 1, why: "`{ by, reason }` from the forfeit dialog's chips: a `WriterForfeitReason`, the engine's phase guard less PF-2's cascade-only reasons (Task 11)" },
  "apps/web/src/components/v2/scorepad/v3/__tests__/authority-only-tiles.test.ts": { writes: 1, why: "an empty `{}` tile payload, classified and never posted" },
  "apps/web/src/lib/__tests__/event-copy.test.ts": { writes: 1, why: "a reason-less copy fixture: rendered as a line, never posted" },
  "apps/web/src/lib/__tests__/event-copy-forfeit.test.ts": { writes: 1, why: "a reason-less legacy fixture (Task 12's fallback pair): rendered as a line, never posted" },
  "apps/web/src/lib/__tests__/forfeit-tag.test.ts": { writes: 1, why: "Task 13's per-reason fold: `reason` drawn from FORFEIT_REASONS itself, folded in memory, never posted" },
  "apps/web/src/server/api-v1/__tests__/http.test.ts": { writes: 1, why: "`reason` drawn from FORFEIT_REASONS itself (the phase-refusal sweep)" },
  "apps/web/src/server/engine-db/__tests__/awarded-state.test.ts": { writes: 1, why: "R116-2: an empty `{}` envelope handed to `awardedMatchState` for its id and time only — the award's own reason is folded, never posted" },
  "apps/web/src/server/engine-db/awarded-state.ts": { writes: 1, why: "R116-2: `reason: outcome.reason`, the stored award's own reason, folded in memory and never posted (the fold must re-decide that same award)" },
  "apps/web/src/components/public-site/match-room/room-snapshot.ts": { writes: 1, why: "chess T10: `{ by: a.by, reason: a.reason }`, a STORED core.forfeit's own payload (room.ts/arbiter.ts read it from the ledger), folded in memory for the game-over card and never posted" },
  "apps/web/src/components/public-site/match-room/__tests__/room-snapshot.test.ts": { writes: 1, why: "the room's per-reason fold sweep: `reason` drawn from FORFEIT_REASONS itself, folded in memory, never posted" },
  "apps/web/src/server/engine-db/__tests__/w2b-status.test.ts": { writes: 1, why: "`...both`, a spread `{ reason: \"walkover\" }`" },
  "apps/web/src/server/engine-db/__tests__/w2e-ending-sanction.test.ts": { writes: 6, why: "Task 2's D13 table sweep: `reason` is a `Reason` (`disqualified` | `retired`, an `Extract` of the engine's ForfeitReason) from the D13 rulebook rows or a `WRITER_REASONS` member (`satisfies readonly ForfeitReason[]`), both tsc-checked against FORFEIT_REASONS — each is a scorer's forfeit POSTed through the real route and the point is that it is refused or admitted per reason, so a literal per call would drop the sweep" },
  "apps/web/src/server/engine-db/__tests__/walkover-rule-award-db.test.ts": { writes: 2, why: "Task 16b's two `reason` parameters, each a literal union of FORFEIT_REASONS members that tsc checks (`\"walkover\" | \"withdrew\"` folded in memory for the division's own reading, never posted; `\"walkover\" | \"retired\" | \"disqualified\"` posted through the console's own write)" },
  "apps/web/src/server/public-site/__tests__/match-centre-forfeit.test.ts": { writes: 1, why: "Task 13's per-reason sentences: `reason` drawn from FORFEIT_REASONS itself, folded in memory, never posted" },
  "apps/web/src/server/public-site/__tests__/timeline.test.ts": { writes: 3, why: "Task 12's forfeit-copy sweeps: `reason` drawn from FORFEIT_REASONS itself (two), and a reason-less legacy fixture — rendered as timeline lines, never posted" },
  "apps/web/src/server/usecases/__tests__/organiser-only-events.test.ts": { writes: 1, why: "`reason: c.reason` from the authority case table" },
  "apps/web/src/server/usecases/withdrawal.ts": { writes: 1, why: "`REASON` (\"withdrew\"), the withdrawal cascade's own constant" },
  "scripts/smoke/suites/walkoverCredit.ts": { writes: 6, why: "walkoverCreditSuite's `reason: WALKOVER`, its constant \"walkover\" typed `ForfeitReason` (tsc refuses free text and \"bye\", which core.forfeit rejects) and checked against AWARD_REASONS at run time" },
};

/** The retired chess forfeit methods in every spelling a write could take: a keyed value (spaced or not, either quote,
 *  a quoted key), a bare entry on its own line of a method list, and an inline list holding one. */
const Q = "[\"'`]";
const RETIRED = [
  `["']?method["']?[[:space:]]*:[[:space:]]*${Q}(double_)?forfeit${Q}`,
  `^[[:space:]]*${Q}(double_)?forfeit${Q}[[:space:]]*,?[[:space:]]*(//.*)?$`,
  `\\[[^]]*${Q}(double_)?forfeit${Q}[^]]*\\]`,
];
const retiredGrep = (paths: string[], cwd = ROOT, extra: string[] = []): string[] =>
  gitGrep([...extra, "-n", "-E", ...RETIRED.flatMap((p) => ["-e", p]), "--", ...paths], cwd);

/** One `path:line:content` grep line, judged on its CONTENT alone — never its path, so a file whose NAME says legacy
 *  (`api-v1/conflict-detail-legacy.ts`) exempts nothing. A line whose code (comments removed) names no forfeit is
 *  prose describing the legacy fold; a deliberate legacy-replay row names itself "legacy" in its own line; anything
 *  else is a write. */
function classify(line: string): { path: string; kind: "prose" | "legacy" | "write" } {
  const m = /^([^:]+):\d+:(.*)$/.exec(line);
  if (m === null) throw new Error(`X-RS-1: unparseable grep line: ${line}`);
  const content = m[2]!;
  const codePart = /^\s*(\*|\/\*|\/\/)/.test(content) ? "" : content.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/.*$/, "");
  const kind = !/forfeit/.test(codePart) ? "prose" : /legacy/i.test(content) ? "legacy" : "write";
  return { path: m[1]!, kind };
}
/** Retired-method lines that are not writes of the method — named and COUNTED, so each reds the day its count moves.
 *  None is a debt any more: W2b Task 12 took forfeit / double_forfeit out of the chess dock (skins/boardgame.tsx
 *  DECISIVE_METHODS / DRAWN_METHODS) and deleted its entry, so a pad that offers either again reds this scan. */
const RETIRED_EXCEPTIONS: Record<string, { lines: number; why: string }> = {
  "apps/web/src/server/engine-db/append-event.ts": { lines: 1, why: "D15's refusal list (RETIRED_ON_WRITE_SPORT_EVENTS) names what it refuses" },
  "apps/web/src/server/public-site/match-centre.ts": { lines: 1, why: "RESULT_KINDS' public `forfeit` result kind, not a chess method" },
  "apps/web/src/server/public-site/__tests__/match-centre-dictionary.test.ts": { lines: 1, why: "the same public result kind, in its dictionary sweep" },
  // Chess T10 (rebase onto W2b, I-1): the match room's game-over card carries the ENGINE's summary method for a fold —
  // boardgame's `detail.method` after a `core.forfeit` is "forfeit" / "double_forfeit" (boardgame.ts applyForfeit) —
  // and words it ("Forfeit · 1–0"). Expected values read back from that fold, never a `boardgame.result` written.
  "apps/web/src/components/public-site/match-room/__tests__/room-snapshot.test.ts": { lines: 3, why: "forfeitResultFor's rulebook rows: the summary method the engine's fold of a core.forfeit reports, read back" },
  "apps/web/src/components/v2/scorepad/v3/skins/__tests__/boardgame.test.ts": { lines: 1, why: "Task 10 (BG-RS-1): `const retired = [\"forfeit\", \"double_forfeit\"]`, the exclusion list of the DECISIVE/DRAWN methods comparison — the methods W2b D15 retired on write, left OUT of the methods put to the strict fold; written to no event" },
  "apps/web/src/components/public-site/match-room/__tests__/room-shell.test.tsx": { lines: 2, why: "a RoomResult snapshot fixture carrying that same read-back summary method, painted on the card" },
};

describe("X-RS-1: every forfeit this repo writes outside the engine uses the closed vocabulary", () => {
  it("X-RS-1: the scan reads every call shape through comments, and never borrows a neighbouring event's reason", () => {
    const note = "// W2b: a note long enough that, left in, it pushes the reason past the regex's window ".repeat(2);
    const shapes = {
      envelope: `scoreEvent(auth, fx, { type: "core.forfeit", payload: { by: fx.away, reason: "no-show" } })`,
      positional: `post(f.id, "core.forfeit", { by: f.away_entrant_id, reason: "no-show" })`,
      tuple: `stream(start(), ["core.forfeit", { by: "H", reason: "no-show" }])`,
      keyed: `const SAMPLES = { "core.forfeit": { by: "e1", reason: "no-show" } };`,
      commented: `post(id, { type: "core.forfeit",\n ${note}\n ${note}\n payload: { by: "http://x", reason: "no-show" } })`,
    };
    let read = 0;
    for (const [shape, text] of Object.entries(shapes)) {
      expect(census("shape.ts", text), shape).toEqual({ reasons: ["no-show"], unreadWrites: 0 });
      read++;
    }
    expect(read).toBe(5);
    // The negative pair: a forfeit with no reason beside an abandon with one reads nothing — and counts as unread.
    expect(census("shape.ts", `stream(start(), ["core.forfeit", { by: "H" }], ["core.abandon", { reason: "rain" }])`)).toEqual({ reasons: [], unreadWrites: 1 });
    expect(census("shape.ts", `post(id, "core.forfeit", { by, reason })`)).toEqual({ reasons: [], unreadWrites: 1 });
    expect(census("shape.ts", `if (e.type === "core.forfeit") count++;`), "a comparison is not a write").toEqual({ reasons: [], unreadWrites: 0 });
  });

  it("X-RS-1: no core.forfeit payload literal carries a reason outside FORFEIT_REASONS; the scan is not vacuous", () => {
    let payloads = 0;
    const bad: string[] = [];
    for (const f of files) {
      for (const reason of census(f, readFileSync(ROOT + f, "utf8")).reasons) {
        payloads++;
        if (!(FORFEIT_REASONS as readonly string[]).includes(reason)) bad.push(`${f}: ${reason}`);
      }
    }
    expect(SELF, "the scans leave out exactly this file").toBe("apps/web/src/server/__tests__/forfeit-vocabulary-scan.test.ts");
    expect(files.length, `files scanned: ${files.length}`).toBeGreaterThan(0);
    // `code()` parses .ts/.tsx and passes .json through; any other kind would be parsed as TypeScript unchecked.
    expect(files.filter((f) => !/\.(tsx?|json)$/.test(f)), "every scanned file is TS, TSX or JSON").toEqual([]);
    expect(payloads, `payload literals checked: ${payloads} across ${files.length} files`).toBeGreaterThanOrEqual(PAYLOAD_FLOOR);
    expect(bad).toEqual([]);
  });

  it("X-RS-1: every forfeit write the scan cannot read is named, file by file, with why it is not free text", () => {
    const deficit: Record<string, number> = {};
    let censused = 0;
    for (const f of files) {
      const { unreadWrites } = census(f, readFileSync(ROOT + f, "utf8"));
      censused++;
      if (unreadWrites > 0) deficit[f] = unreadWrites;
    }
    expect(censused, `files censused: ${censused}`).toBeGreaterThan(0);
    expect(deficit).toEqual(Object.fromEntries(Object.entries(UNREAD_WRITERS).map(([f, e]) => [f, e.writes])));
  });

  it("X-RS-1: the retired chess forfeit methods are written only by legacy-replay rows and named, counted exceptions", () => {
    const hits = retiredGrep(SCOPES).map(classify);
    const writes: Record<string, number> = {};
    let legacy = 0;
    let prose = 0;
    for (const h of hits) {
      if (h.kind === "prose") prose++;
      else if (h.kind === "legacy") legacy++;
      else writes[h.path] = (writes[h.path] ?? 0) + 1;
    }
    // Not vacuous: the grep sees the legacy rows it exempts (pre-W2b streams, D15's refusal witnesses).
    expect(legacy, `retired-method lines: ${hits.length} (legacy ${legacy}, prose ${prose})`).toBeGreaterThan(0);
    expect(writes).toEqual(Object.fromEntries(Object.entries(RETIRED_EXCEPTIONS).map(([f, e]) => [f, e.lines])));
  });

  it("X-RS-1: the retired-method grep reads every spelling, and judges a line by its content, never its path", () => {
    const spellings = [
      `{ method: "forfeit" }`,
      `{ method:"double_forfeit" }`,
      `{ method: 'forfeit' }`,
      `{ "method": "forfeit" }`,
      `  "double_forfeit",`,
      `values: ["forfeit", "x"],`,
    ];
    const decoys = [`status: "forfeited",`, `tile("forfeitSheet"),`, `{ method: "walkover" }`];
    const dir = mkdtempSync(join(tmpdir(), "x-rs-1-"));
    writeFileSync(join(dir, "conflict-detail-legacy.ts"), [...spellings, ...decoys].join("\n") + "\n");
    const hits = retiredGrep(["conflict-detail-legacy.ts"], dir, ["--no-index"]);
    expect(hits.map((h) => h.replace(/^[^:]+:\d+:/, "")), `spellings read: ${hits.length}`).toEqual(spellings);
    expect(hits.map((h) => classify(h).kind), "the file's NAME says legacy; no line does").toEqual(spellings.map(() => "write"));
    expect(classify(`x.ts:3:  { method: "forfeit" }, // legacy row`).kind).toBe("legacy");
    expect(classify(`x.ts:4: *  folds to win{method:"forfeit"}`).kind).toBe("prose");
    expect(classify(`x.ts:5:  const n = 1; // win{method:"forfeit"}`).kind).toBe("prose");
    expect(classify(`x.ts:6:  { url: "http://x", method: "forfeit" }`).kind, "a `//` inside a string is not a comment").toBe("write");
  });

  it("X-RS-1: the grep wrapper reads no match as [] and a broken grep as a failure, never as a clean scan", () => {
    expect(gitGrep(["-l", "-e", "x-rs-1-no-file-holds-this-token", "--", "scripts"])).toEqual([]);
    expect(() => gitGrep(["--x-rs-1-not-a-git-grep-option"])).toThrow();
  });
});
