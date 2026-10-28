// The recorder behind SMOKE_MANIFEST: one { suite, checks } per run() in call order, plus a final "(inline)" for checks
// made outside any run. `total` is faked as a counter the test bumps itself, so every expected count below is the number
// of bumps the test performed, never a value read back from the recorder.
import { describe, expect, it } from "vitest";
import { SmokeManifestError, diffSmokeManifests, parseSmokeManifest } from "../smoke-manifest-diff.ts";
import { createManifestRecorder } from "../smoke-manifest.ts";

function rig() {
  let n = 0;
  const bump = (times = 1) => {
    for (let i = 0; i < times; i++) n++;
  };
  return { rec: createManifestRecorder(() => n), bump };
}

describe("createManifestRecorder", () => {
  it("records one entry per run in call order", async () => {
    const { rec, bump } = rig();
    await rec.run("v1", async () => bump(2));
    await rec.run("arbiter", async () => bump(5));
    await rec.run("matchRoom", async () => bump(1));
    expect(rec.entries()).toEqual([
      { suite: "v1", checks: 2 },
      { suite: "arbiter", checks: 5 },
      { suite: "matchRoom", checks: 1 },
      { suite: "(inline)", checks: 0 },
    ]);
  });

  it("checks is the total() delta, so a suite that runs 3 checks reports 3", async () => {
    const { rec, bump } = rig();
    bump(10); // total() is already 10 when the suite starts: the entry must be the delta, not the running total
    await rec.run("three", async () => {
      bump();
      await Promise.resolve();
      bump(2); // checks made after an await still land in the suite
    });
    expect(rec.entries()[0]).toEqual({ suite: "three", checks: 3 });
  });

  it("a suite that makes no checks records 0, not nothing", async () => {
    const { rec } = rig();
    await rec.run("quiet", async () => undefined);
    expect(rec.entries()).toEqual([
      { suite: "quiet", checks: 0 },
      { suite: "(inline)", checks: 0 },
    ]);
  });

  it("(inline) holds checks made outside any run", async () => {
    const { rec, bump } = rig();
    bump(2); // before the first suite
    await rec.run("a", async () => bump(3));
    bump(4); // between suites
    await rec.run("b", async () => bump(5));
    bump(1); // after the last suite
    expect(rec.entries()).toEqual([
      { suite: "a", checks: 3 },
      { suite: "b", checks: 5 },
      { suite: "(inline)", checks: 2 + 4 + 1 },
    ]);
  });

  it("with no runs at all, (inline) is the whole total, and still present at 0", () => {
    const some = rig();
    some.bump(4);
    expect(some.rec.entries()).toEqual([{ suite: "(inline)", checks: 4 }]);
    const none = rig();
    expect(none.rec.entries()).toEqual([{ suite: "(inline)", checks: 0 }]);
  });

  it("run resolves to the value fn resolved to", async () => {
    const { rec } = rig();
    await expect(rec.run("v", async () => ({ ok: 42 }))).resolves.toEqual({ ok: 42 });
  });

  it("a run that throws still records its partial delta, then rethrows", async () => {
    const { rec, bump } = rig();
    const boom = new Error("suite blew up");
    await expect(
      rec.run("flaky", async () => {
        bump(2);
        throw boom;
      }),
    ).rejects.toBe(boom); // the very error, not a wrapper
    await rec.run("after", async () => bump(3)); // the recorder is usable after a throw
    expect(rec.entries()).toEqual([
      { suite: "flaky", checks: 2 },
      { suite: "after", checks: 3 },
      { suite: "(inline)", checks: 0 },
    ]);
  });

  it("a synchronous throw from fn is recorded and rethrown the same way", async () => {
    const { rec, bump } = rig();
    const boom = new Error("sync");
    await expect(
      rec.run("sync", () => {
        bump(1);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(rec.entries()[0]).toEqual({ suite: "sync", checks: 1 });
  });

  it("a name used twice throws, before fn runs and without a second entry", async () => {
    const { rec, bump } = rig();
    await rec.run("dup", async () => bump(2));
    let ran = false;
    await expect(
      rec.run("dup", async () => {
        ran = true;
        bump(9);
      }),
    ).rejects.toThrow(SmokeManifestError);
    expect(ran).toBe(false);
    expect(rec.entries()).toEqual([
      { suite: "dup", checks: 2 },
      { suite: "(inline)", checks: 0 },
    ]);
  });

  it("a name stays taken after its run threw", async () => {
    const { rec } = rig();
    await expect(rec.run("once", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(rec.run("once", async () => undefined)).rejects.toThrow(SmokeManifestError);
  });

  it("(inline) is reserved: a suite may not take the name entries() appends", async () => {
    const { rec } = rig();
    let ran = false;
    await expect(
      rec.run("(inline)", async () => {
        ran = true;
      }),
    ).rejects.toThrow(SmokeManifestError);
    expect(ran).toBe(false);
  });

  it("nested and concurrent runs are refused (their deltas would double count), and the recorder recovers", async () => {
    const { rec, bump } = rig();
    let innerRan = false;
    await expect(
      rec.run("outer", async () => {
        bump(1);
        await rec.run("inner", async () => {
          innerRan = true;
        });
      }),
    ).rejects.toThrow(SmokeManifestError);
    expect(innerRan).toBe(false);

    const slow = rec.run("slow", async () => {
      await new Promise((r) => setTimeout(r, 5));
      bump(2);
    });
    await expect(rec.run("overlap", async () => undefined)).rejects.toThrow(SmokeManifestError);
    await slow;

    await rec.run("next", async () => bump(4)); // a refusal or a throw does not leave the recorder wedged
    expect(rec.entries()).toEqual([
      { suite: "outer", checks: 1 },
      { suite: "slow", checks: 2 },
      { suite: "next", checks: 4 },
      { suite: "(inline)", checks: 0 },
    ]);
  });

  it("entries() is a snapshot: calling it twice agrees, editing the result changes nothing, later runs still count", async () => {
    const { rec, bump } = rig();
    await rec.run("a", async () => bump(1));
    const first = rec.entries();
    expect(rec.entries()).toEqual(first);
    first.length = 0;
    await rec.run("b", async () => bump(2));
    expect(rec.entries()).toEqual([
      { suite: "a", checks: 1 },
      { suite: "b", checks: 2 },
      { suite: "(inline)", checks: 0 },
    ]);
  });

  it("its output is what the diff script reads: parses, and diffs against itself and against a changed run", async () => {
    const make = async (arbiterChecks: number) => {
      const { rec, bump } = rig();
      await rec.run("v1", async () => bump(12));
      await rec.run("arbiter", async () => bump(arbiterChecks));
      await rec.run("quiet", async () => undefined); // a zero-count suite must still parse
      bump(3);
      return parseSmokeManifest(JSON.stringify(rec.entries()));
    };
    const before = await make(7);
    expect(before).toHaveLength(4);
    expect(diffSmokeManifests(before, await make(7))).toEqual([]);
    expect(diffSmokeManifests(before, await make(6))).toEqual(["checks changed: arbiter 7 -> 6"]);
  });
});
