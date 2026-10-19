// Capacity test 6, the source half (spec §8.1, §3.2.1): EVERY reader of a board's window asks `window.ts` with the BOARD's
// anchor, and the table of readers is closed.
//
// What it guards. A board's window hangs off its batch's start (`boardAnchor(roundOpenedAt, rank, staggered)`), not off the
// round's stamp. `windowFor`, `roomPhase` and `checkInCounts` take a branded `BoardAnchor`, so handing one the raw stamp is a
// TYPE error - this guard is the second line, for a cast, an `any`, or a new reader that computes `stamp + DEADLINE_AFTER_MS` by
// hand. It judges three things over the production tree:
//   1. THE CALL SITES. Every call of an anchor consumer (windowFor, roomPhase, checkInCounts, playableWindow, roomPhaseWire,
//      windowWire) is counted per file against a pinned table. A new reader, or a reader gone, fails the count and sends the
//      author here - where the reader table, and the per-reader test with its `[reader:<id>]` marker, are added together.
//   2. THE ARGUMENT. No consumer's argument names the round's stamp (`roundOpenedAt`, `openedAt`, `round_opened_at`) except
//      inside the call that turns it into an anchor (`boardAnchor(...)`, `anchorOfRow(...)`).
//   3. THE CONSTANTS. `DEADLINE_AFTER_MS`, `WINDOW_OPEN_LEAD_MS` and `EMAIL_LEAD_MS` are used in arithmetic nowhere but window.ts
//      (a reader may print `DEADLINE_AFTER_MS / 60_000` as a count of minutes, the one listed exception).
//   4. THE STAMP'S WRITERS. `stampFixtureCheckIn` (me.ts) keeps a COUNTED check-in only when it is handed the board's window; called
//      without one it re-stamps, and a late tap then moves a counted check-in past the deadline, so `noShow` forfeits by both
//      (the build review's I-1 shipped exactly so, from a second caller that never passed a window). Every production call is
//      counted per file against a pinned table, and each call's arguments must name `window`: a third caller fails the count, a
//      caller that drops the window fails the argument check. (me.ts's own call hands `{}` for a fixture whose round was never opened,
//      deliberately - a ternary on `open`; the check reads the call's text, so that branch is the one place it cannot see.)
// And the table of READERS (the spec names 15; the scan found a 16th - openRound's re-invite skip; the build's review found a 17th - the
// QR self check-in, which hands the stamp the board's window) is closed over the tests: each
// reader id appears in exactly one test title as `[reader:<id>]`, and no title carries an id that is not in the table.
//
// Anti-vacuity: every sweep reports what it scanned and zero is a failure; the scanner is tested on a fixture that must pass
// and on its mutants that must fail. Single-sport reason: no sport is involved - these are source files.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { lex, productionSources } from "./_video-source-scan";

/** `apps/web/src`. */
const SRC = join(import.meta.dirname, "..", "..", "..");

const CONSUMERS = ["windowFor", "roomPhase", "checkInCounts", "playableWindow", "roomPhaseWire", "windowWire"] as const;
type Consumer = (typeof CONSUMERS)[number];

/** Files that DEFINE the consumers or adapt one to the wire: their own calls are the plumbing, not readers of a board. */
const PLUMBING = new Set(["server/external-play/window.ts", "components/public-site/match-room/room-snapshot.ts"]);

/** The readers (spec §3.2.1 / §8.1 test 6). Each is served by the call sites below and owns one `[reader:<id>]` test title. */
const READERS = [
  "seat",
  "checkin-counts",
  "compose",
  "claim",
  "create",
  "dequeue",
  "expires-at",
  "sweep-window",
  "no-show",
  "mint-retry",
  "teardown",
  "expected-end",
  "invite",
  "resend",
  "open-round-view",
  "reinvite",
  "qr-checkin",
] as const;
type ReaderId = (typeof READERS)[number];

/** Call sites of the consumers, per production file (under `src`). `readers` names who they serve. */
const SITES: readonly { file: string; fn: Consumer; times: number; readers: readonly ReaderId[] }[] = [
  // The check-in line (spec §5.7.8) took the seat's, the create's and the dequeue's question "is this board's window open?" and
  // mint-retry's deadline test into ONE reader, `boardPhase`: the window's own answer, held open past the deadline (until the
  // cap) for a protected player. Its two call sites into window.ts are the readers' now.
  { file: "server/external-play/seat-line.ts", fn: "roomPhase", times: 1, readers: ["seat", "create", "dequeue", "mint-retry"] },
  { file: "server/external-play/seat-line.ts", fn: "windowFor", times: 1, readers: ["seat", "create", "dequeue", "mint-retry"] },
  // The counted check-ins moved out of room.ts into their own module (the sweep's no-show and the create read them too).
  { file: "server/usecases/external-play/check-ins.ts", fn: "checkInCounts", times: 2, readers: ["checkin-counts"] },
  { file: "server/usecases/external-play/room.ts", fn: "roomPhaseWire", times: 2, readers: ["compose", "claim"] },
  { file: "server/usecases/external-play/room.ts", fn: "windowWire", times: 1, readers: ["compose"] },
  // claimRoomSeat hands the check-in stamp its board's window, so a counted check-in is never re-stamped out of it (test 28).
  { file: "server/usecases/external-play/room.ts", fn: "windowFor", times: 1, readers: ["claim"] },
  // The QR self check-in (`checkInToFixture`) hands the check-in stamp the board's window too, for any fixture whose round was opened, so a
  // late scan cannot move a counted check-in out of it (test 28, the build review's I-1).
  { file: "server/usecases/me.ts", fn: "windowFor", times: 1, readers: ["qr-checkin"] },
  // The ready row's `expires_at`: the deadline, or the cap when the game was created past the deadline (twice in one expression).
  { file: "server/usecases/external-play/create-game.ts", fn: "windowFor", times: 2, readers: ["expires-at"] },
  // The one definition; its three consumers below are the sweep's readers (mint-retry now asks `boardPhase`).
  { file: "server/usecases/external-play/sweep.ts", fn: "windowFor", times: 1, readers: ["sweep-window"] },
  { file: "server/usecases/external-play/sweep.ts", fn: "playableWindow", times: 3, readers: ["no-show", "teardown", "expected-end"] },
  { file: "server/usecases/external-play/invite.ts", fn: "windowFor", times: 1, readers: ["invite"] },
  { file: "server/usecases/external-play/invite.ts", fn: "roomPhase", times: 1, readers: ["resend"] },
  { file: "server/usecases/external-play/open-round.ts", fn: "roomPhase", times: 1, readers: ["reinvite"] },
  { file: "server/usecases/external-play/open-round-view.ts", fn: "roomPhase", times: 2, readers: ["open-round-view"] },
  { file: "server/usecases/external-play/open-round-view.ts", fn: "windowFor", times: 2, readers: ["open-round-view"] },
];

/** The text of a call's argument list, from the `(` at `open`, balanced; null if it never closes. */
function argsAt(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

/** `text` with every `boardAnchor(...)` / `anchorOfRow(...)` call removed: what is left is what the consumer was handed besides an anchor. */
function withoutAnchorCalls(text: string): string {
  let out = text;
  for (;;) {
    const m = /\b(boardAnchor|anchorOfRow)\(/.exec(out);
    if (!m) return out;
    const open = m.index + m[0].length - 1;
    const inner = argsAt(out, open);
    if (inner === null) return out.slice(0, m.index);
    out = out.slice(0, m.index) + "ANCHOR" + out.slice(open + inner.length + 2);
  }
}

type Call = { fn: Consumer; args: string; line: number };

/** Every consumer call in `src` (definitions excluded), from comment-stripped source. */
export function consumerCalls(src: string): Call[] {
  const { live } = lex(src);
  const out: Call[] = [];
  const re = new RegExp(`\\b(${CONSUMERS.join("|")})\\(`, "g");
  for (let m = re.exec(live); m !== null; m = re.exec(live)) {
    const before = live.slice(Math.max(0, m.index - 24), m.index);
    if (/function\s+$/.test(before)) continue; // a definition
    const open = m.index + m[0].length - 1;
    const args = argsAt(live, open);
    if (args === null) continue;
    out.push({ fn: m[1] as Consumer, args, line: live.slice(0, m.index).split("\n").length });
  }
  return out;
}

const STAMP = /\b(roundOpenedAt|openedAt|round_opened_at)\b/;

/** Every production file that calls `stampFixtureCheckIn`, with its pinned count (the definition in me.ts is not a call). */
const STAMP_WRITERS: readonly { file: string; calls: number }[] = [
  { file: "server/usecases/external-play/room.ts", calls: 1 },
  { file: "server/usecases/me.ts", calls: 1 },
];

/** Every call of `stampFixtureCheckIn` in `src` (definition and comments excluded), with its balanced argument text. */
export function stampCalls(src: string): { args: string; line: number }[] {
  const { live } = lex(src);
  const out: { args: string; line: number }[] = [];
  const re = /\bstampFixtureCheckIn\(/g;
  for (let m = re.exec(live); m !== null; m = re.exec(live)) {
    if (/function\s+$/.test(live.slice(Math.max(0, m.index - 24), m.index))) continue; // the definition
    const args = argsAt(live, m.index + m[0].length - 1);
    if (args === null) continue;
    out.push({ args, line: live.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Calls whose argument names the round's stamp outside an anchor-making call. */
export function rawStampCalls(src: string): Call[] {
  return consumerCalls(src).filter((c) => STAMP.test(withoutAnchorCalls(c.args)));
}

/** Production lines that do window arithmetic with a lead/deadline constant: `<expr> +|- CONSTANT` or `CONSTANT +|-`. */
export function windowArithmetic(src: string): number[] {
  // `live`, not `code`: a statement's `${...}` sits inside a template literal, which `code` blanks out.
  const { live } = lex(src);
  const lines = live.split("\n");
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (/\b(DEADLINE_AFTER_MS|WINDOW_OPEN_LEAD_MS|EMAIL_LEAD_MS)\b\s*[-+]|[-+]\s*\b(DEADLINE_AFTER_MS|WINDOW_OPEN_LEAD_MS|EMAIL_LEAD_MS)\b/.test(l)) hits.push(i + 1);
  });
  return hits;
}

/** Only a file that names a consumer or a window constant is lexed (the lexer reads SQL-bearing server code; JSX text is not its
 *  business, and a file that names neither has nothing to judge). A .tsx that DID name one would fail the lexer loudly. */
const MENTIONS = /\b(windowFor|roomPhase|checkInCounts|playableWindow|roomPhaseWire|windowWire|DEADLINE_AFTER_MS|WINDOW_OPEN_LEAD_MS|EMAIL_LEAD_MS)\b/;
const allSources = productionSources(SRC);
const sources = allSources.filter((rel) => MENTIONS.test(readFileSync(join(SRC, rel), "utf8")));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("the scanner (anti-vacuity: it must see what it guards)", () => {
  const GOOD = `
    const a = boardAnchor(open.roundOpenedAt, rank, open.staggered);
    const p = roomPhase(now, a);
    const w = windowFor(boardAnchor(f.open.roundOpenedAt, i * 10, staggered)).deadline;
    export function windowFor(anchor) { return anchor; }
    // roomPhase(now, openedAt) in a comment is nothing
  `;
  it("counts the live calls, skips the definition and the comment, and passes a fixture that only hands anchors over", () => {
    const calls = consumerCalls(GOOD);
    expect(calls.map((c) => c.fn)).toEqual(["roomPhase", "windowFor"]);
    expect(rawStampCalls(GOOD)).toEqual([]);
  });
  it("its mutants fail: a consumer handed the raw stamp, a stamp + the deadline by hand", () => {
    expect(rawStampCalls("const p = roomPhase(now, open.roundOpenedAt);").map((c) => c.fn)).toEqual(["roomPhase"]);
    expect(rawStampCalls("windowFor(row.round_opened_at)").map((c) => c.fn)).toEqual(["windowFor"]);
    expect(rawStampCalls("windowFor(boardAnchor(a, 1, true), openedAt)").map((c) => c.fn), "a stamp beside the anchor").toEqual(["windowFor"]);
    expect(windowArithmetic("const d = new Date(opened.getTime() + DEADLINE_AFTER_MS);")).toEqual([1]);
    expect(windowArithmetic("const d = t - WINDOW_OPEN_LEAD_MS;")).toEqual([1]);
    expect(windowArithmetic("windowMinutes: DEADLINE_AFTER_MS / 60_000,"), "a count of minutes is no arithmetic on a stamp").toEqual([]);
  });
});

describe("the check-in stamp's writers: the scanner (it must see what it guards)", () => {
  const GOOD = `
    import { stampFixtureCheckIn } from "@/server/usecases/me";
    export async function stampFixtureCheckIn(person, fixture, org, opts = {}) { return opts; }
    // stampFixtureCheckIn(p, f, o) in a comment is nothing
    await stampFixtureCheckIn(p, f, o, { at: now, window: { opensAt, deadline } });
    return stampFixtureCheckIn(p, f, o, open ? { window: windowFor(open.anchor) } : {});
  `;
  it("counts the live calls, skips the definition, the import and the comment, and passes a fixture that hands a window", () => {
    const calls = stampCalls(GOOD);
    expect(calls.length, "calls seen").toBe(2);
    for (const c of calls) expect(c.args, `line ${c.line}`).toMatch(/\bwindow\b/);
  });
  it("its mutants fail: a call with no options, with only `at`, and with an empty object name no window", () => {
    for (const bad of ["stampFixtureCheckIn(p, f, o);", "stampFixtureCheckIn(p, f, o, { at: now });", "stampFixtureCheckIn(p, f, o, {});"]) {
      const calls = stampCalls(bad);
      expect(calls.length, bad).toBe(1);
      expect(calls[0]!.args, bad).not.toMatch(/\bwindow\b/);
    }
  });
});

describe("the production tree", () => {
  it("every stampFixtureCheckIn call is in the pinned table and hands the board's window (a new writer, or a dropped window, fails here)", () => {
    const found = new Map<string, number>();
    const unwindowed: string[] = [];
    let calls = 0;
    for (const rel of allSources) {
      const src = read(rel);
      if (!/\bstampFixtureCheckIn\b/.test(src)) continue;
      for (const c of stampCalls(src)) {
        found.set(rel, (found.get(rel) ?? 0) + 1);
        calls += 1;
        if (!/\bwindow\b/.test(c.args)) unwindowed.push(`${rel}:${c.line}`);
      }
    }
    expect(Object.fromEntries([...found].sort())).toEqual(Object.fromEntries(STAMP_WRITERS.map((w) => [w.file, w.calls] as const).sort()));
    expect(unwindowed, "calls that name no window").toEqual([]);
    expect(calls, "anti-vacuity: the scan saw the calls").toBe(STAMP_WRITERS.reduce((n, w) => n + w.calls, 0));
    expect(calls).toBeGreaterThan(0);
  });

  it("every consumer call site is in the pinned table, with its pinned count (a new reader fails here)", () => {
    let calls = 0;
    const found = new Map<string, number>();
    for (const rel of sources) {
      if (PLUMBING.has(rel)) continue;
      for (const c of consumerCalls(read(rel))) {
        const key = `${rel}::${c.fn}`;
        found.set(key, (found.get(key) ?? 0) + 1);
        calls += 1;
      }
    }
    const pinned = new Map(SITES.map((s) => [`${s.file}::${s.fn}`, s.times] as const));
    expect(Object.fromEntries([...found].sort())).toEqual(Object.fromEntries([...pinned].sort()));
    expect(calls, "consumer calls scanned").toBe(SITES.reduce((n, s) => n + s.times, 0));
    expect(calls, "anti-vacuity: the scan saw calls").toBeGreaterThan(10);
  });

  it("no consumer is handed the round's stamp, only an anchor", () => {
    let checked = 0;
    const bad: string[] = [];
    for (const rel of sources) {
      for (const c of consumerCalls(read(rel))) {
        checked += 1;
        if (STAMP.test(withoutAnchorCalls(c.args))) bad.push(`${rel}:${c.line} ${c.fn}(${c.args.trim().slice(0, 60)})`);
      }
    }
    expect(bad).toEqual([]);
    expect(checked, "consumer calls judged").toBeGreaterThan(10);
  });

  it("no production file but window.ts does arithmetic on a stamp with the lead or deadline constants", () => {
    const bad: string[] = [];
    for (const rel of sources) {
      if (rel === "server/external-play/window.ts") continue;
      for (const line of windowArithmetic(read(rel))) bad.push(`${rel}:${line}`);
    }
    expect(bad).toEqual([]);
    expect(allSources.length, "production files in the tree").toBeGreaterThan(1000);
    expect(sources.length, "files that name a consumer or a constant, all judged").toBeGreaterThan(8);
  });
});

describe("the reader table is closed over the tests", () => {
  /** Test titles (`it(`/`describe(` lines, in any variant) over the whole source tree, test files included. */
  function titles(): { file: string; line: number; text: string }[] {
    const out: { file: string; line: number; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (/\.test\.tsx?$/.test(name)) {
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((text, i) => {
              if (/^\s*(it|describe|test)(\.\w+(\([^)]*\))?)*\(\s*["'`]/.test(text) && /\[reader:[a-z-]+\]/.test(text)) {
                out.push({ file: relative(SRC, full), line: i + 1, text });
              }
            });
        }
      }
    };
    walk(SRC);
    return out;
  }

  it(`${READERS.length} readers, each named by exactly one test title; no title names a reader that is not in the table`, () => {
    const all = titles();
    const seen = new Map<string, number>();
    for (const t of all) for (const m of t.text.matchAll(/\[reader:([a-z-]+)\]/g)) seen.set(m[1]!, (seen.get(m[1]!) ?? 0) + 1);
    expect(READERS.length, "readers in the table (the spec's 15, openRound's re-invite and the QR self check-in)").toBe(17);
    expect([...seen.keys()].sort(), "ids in titles = ids in the table").toEqual([...READERS].sort());
    for (const id of READERS) expect(seen.get(id), `[reader:${id}] in test titles`).toBe(1);
    expect(all.length, "titled tests found").toBeGreaterThanOrEqual(READERS.length - 6);
  });

  it("every reader in the table is served by at least one pinned call site, and every site serves a reader in the table", () => {
    const served = new Set(SITES.flatMap((s) => s.readers));
    expect([...served].sort()).toEqual([...READERS].sort());
    for (const s of SITES) {
      expect(s.readers.length, `${s.file} ${s.fn}`).toBeGreaterThan(0);
      for (const r of s.readers) expect(READERS, `${s.file} serves ${r}`).toContain(r);
    }
  });
});
