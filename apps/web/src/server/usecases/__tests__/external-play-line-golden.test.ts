// Capacity test 18 (spec §8.1): the line empty is today's path. One board, the check-in line EMPTY, driven through the real room claim
// against the e2e RealtimeKit fixture server, makes the same vendor calls, in the same order, as it did BEFORE the line existed - and
// the line writes nothing for it but the stay's own row (no `queued_at`, no `admitted_at`).
//
// The expected sequence is the committed fixture `__fixtures__/line/idle-board.golden.json`: recorded by running
// `_external-play-line-golden-driver.ts` UNCHANGED in a worktree of the pre-amendment commit `00e5179b6` (and of this branch's tip
// before the build, 467003930: the two recordings were byte-identical). Nothing in this repo writes it, and this file asserts that.
//
// Single sport, deliberately: online play exists only for `boardgame` (guard.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { startRealtimeKitFixtureServer, type RealtimeKitFixtureServer } from "../../../../e2e/realtimekit-fixture-server";
import { driveIdleBoard, driverSha256, ledgerOf, type GoldenRecord } from "./_external-play-line-golden-driver";

const DB = !!process.env.DATABASE_URL;
const GOLDEN = join(import.meta.dirname, "..", "..", "external-play", "__fixtures__", "line", "idle-board.golden.json");
type Golden = { header: { recordedFrom: string[]; driverSha256: string }; record: GoldenRecord };
const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  if (DB) fx = await startRealtimeKitFixtureServer(0);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (DB) {
    await fx.close();
    await sql.end();
  }
});

describe("the golden is the pre-amendment record, never regenerated from this tree (test 18)", () => {
  it("the header names the pre-amendment commit, and the driver is byte-for-byte the one that recorded it", () => {
    expect(golden.header.recordedFrom[0], "the commit the spec names").toMatch(/^00e5179b6[0-9a-f]{31}$/);
    expect(golden.header.recordedFrom.length, "recorded at two commits").toBe(2);
    expect(golden.header.driverSha256, "the driver changed since the golden was recorded: re-record it at a pre-amendment commit").toBe(driverSha256());
  });

  it("nothing writes the golden: no test or driver in the tree opens it for writing", () => {
    const own = readFileSync(new URL(import.meta.url), "utf8");
    const driver = readFileSync(join(import.meta.dirname, "_external-play-line-golden-driver.ts"), "utf8");
    for (const [name, text] of [["the golden test", own], ["the driver", driver]] as const) {
      // The call the check looks for is spelled by pieces so this very line does not trip it.
      expect(text.includes(["write", "FileSync"].join("")), `${name} writes a file`).toBe(false);
      expect(text.includes(["write", "File("].join("")), `${name} writes a file (async)`).toBe(false);
    }
  });

  it("the recorded sequence is not empty: 4 steps, each with vendor calls on a mint and on a seat (anti-vacuity)", () => {
    expect(golden.record.steps.length).toBe(4);
    for (const s of golden.record.steps) expect(s.calls.length, s.step).toBeGreaterThan(0);
  });
});

describe.skipIf(!DB)("one board, the line empty, makes the pre-amendment calls (test 18)", () => {
  it("the vendor calls the fixture server saw, step by step, equal the golden call for call; the line wrote no queued_at and no admitted_at", async () => {
    const { record, fixtureId } = await driveIdleBoard(fx);
    expect(record.steps.map((s) => s.step), "the same steps").toEqual(golden.record.steps.map((s) => s.step));
    for (const [i, want] of golden.record.steps.entries()) {
      // Compared as text so a failure prints BOTH sequences.
      expect(JSON.stringify(record.steps[i]), want.step).toBe(JSON.stringify(want));
    }
    expect(record.checkedIn, "both check-ins counted").toEqual(golden.record.checkedIn);
    const calls = record.steps.reduce((n, s) => n + s.calls.length, 0);
    expect(calls, "calls compared").toBe(golden.record.steps.reduce((n, s) => n + s.calls.length, 0));
    expect(calls, "anti-vacuity: calls compared").toBeGreaterThan(8);
    // The line's own writes: a stay per player (the upsert), held and admitted never.
    expect(await ledgerOf(fixtureId), "the ledger: the two stays and nothing else").toEqual({ rows: 2, queued: 0, admitted: 0 });
  }, 120_000);
});
