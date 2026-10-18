// Capacity test 39 (spec §8.1, the re-review 2's M3): `left` travels only on a `queued` answer, with a fixed precedence. A stay is
// driven to each end and its player presses again behind a waiting stay: lapsed in silence -> "silent"; an admitted stay that kept
// asking until its hold ran out -> "camera"; both at once -> "silent"; never in line -> null; and a replacement that PASSES the gate
// carries no `line` (so no `left`) at all. Driven through the real gate with the time of each claim stated, plus one claim through
// the real route to prove `left` reaches the seat answer's `line`.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { ADMIT_HOLD_MS, LINE_ABANDON_AFTER_MS, LINE_RELEASE_GRACE_MS } from "@/server/external-play/seat-line";
import type { GateAnswer } from "@/server/external-play/seat-line";
import { configureRealtimeKit } from "./_external-play-rtk-fake";
import { claimAt, clearBucket, holdWaiting, putStay, sceneAt, seedBoard as sceneBoard, setBucket, stayRow, stubBucket } from "./_external-play-line";
import { MIN, SEC, claimRoom, dropWorlds, fund, inWindow, seedBoard, world } from "./_external-play-line-route";

const DB = !!process.env.DATABASE_URL;
const keys: string[] = [];
function scene(): string {
  configureRealtimeKit();
  const key = stubBucket();
  keys.push(key);
  return key;
}
afterEach(async () => {
  await dropWorlds();
  if (DB) for (const k of keys.splice(0)) await clearBucket(k);
  vi.unstubAllEnvs();
});
beforeEach(() => {
  configureRealtimeKit();
});
afterAll(async () => {
  if (DB) await sql.end();
});

/** What the answer says it `left`: "absent" when the answer has no `line` at all. */
const leftOf = (a: GateAnswer): "silent" | "camera" | null | "absent" => (a.kind === "queued" ? a.line.left : "absent");

type End = "silent" | "hold" | "both" | "never";
/** Drive a stay to `end`; returns the instant its player presses again (the claim that finds it over) and the board. */
async function driveStay(key: string, end: End) {
  const b = await sceneBoard();
  const T0 = 0;
  if (end === "silent") {
    // In line (held), then not a word for LINE_ABANDON_AFTER_MS.
    await putStay({ fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: key, firstClaimAt: sceneAt(T0), seenAt: sceneAt(T0), gate: "held", queuedAt: sceneAt(T0) });
    return { b, pressMs: T0 + LINE_ABANDON_AFTER_MS };
  }
  if (end === "never") {
    // Never held: an idle-line claim, then silence for the release grace.
    await setBucket(key, 1000, sceneAt(T0));
    const first = await claimAt(key, b, "home", sceneAt(T0));
    expect(first, "premise: the idle line lets it go and writes nothing").toEqual({ kind: "go", decision: "idle" });
    expect((await stayRow(b.fixtureId, b.home.personId))?.queued_at, "premise: never held").toBeNull();
    return { b, pressMs: T0 + LINE_RELEASE_GRACE_MS };
  }
  // An admitted stay.
  await putStay({ fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: key, firstClaimAt: sceneAt(T0), seenAt: sceneAt(T0), gate: "passed", queuedAt: sceneAt(T0), admittedAt: sceneAt(T0) });
  if (end === "hold") {
    // It KEEPS asking, every 10 s, so it is never silent; only the hold ends it.
    for (let ms = 10_000; ms < ADMIT_HOLD_MS; ms += 10_000) {
      const a = await claimAt(key, b, "home", sceneAt(ms));
      expect(a, `premise: the admitted stay's claim at ${ms}`).toEqual({ kind: "go", decision: "admitted" });
    }
    return { b, pressMs: ADMIT_HOLD_MS };
  }
  // "both": one claim early on, then silent through the grace AND past the hold.
  await claimAt(key, b, "home", sceneAt(5_000));
  return { b, pressMs: ADMIT_HOLD_MS + SEC };
}

describe.skipIf(!DB)("`left` travels only on a queued answer, with a fixed precedence (test 39)", () => {
  const cases: { name: string; end: End; want: "silent" | "camera" | null }[] = [
    { name: "(a) the stay lapsed in silence", end: "silent", want: "silent" },
    { name: "(b) an admitted stay that kept asking, its hold ran out", end: "hold", want: "camera" },
    { name: "(c) silent AND past the hold at the claim that finds it", end: "both", want: "silent" },
    { name: "(d) a stay that was never in line and lapsed", end: "never", want: null },
  ];

  it("the replacement stay is queued behind a waiting stay and says why the old one left: (a) silent, (b) camera, (c) silent, (d) null; the next claim of the new stay does not repeat it (4 cases)", async () => {
    let checked = 0;
    for (const c of cases) {
      const key = scene();
      const { b, pressMs } = await driveStay(key, c.end);
      // A stay waiting ahead of the replacement (it has been asking all along), and a dry bucket.
      await holdWaiting(key, sceneAt(pressMs - 5_000), sceneAt(pressMs - 1_000));
      await setBucket(key, 0, sceneAt(pressMs));
      const before = await stayRow(b.fixtureId, b.home.personId);
      const got = await claimAt(key, b, "home", sceneAt(pressMs));
      const after = await stayRow(b.fixtureId, b.home.personId);
      expect(got.kind, `${c.name}: the replacement waits behind the line`).toBe("queued");
      expect(leftOf(got), c.name).toBe(c.want);
      expect(after?.first_claim_at, `${c.name}: a NEW stay, at the back`).toEqual(sceneAt(pressMs));
      expect(before?.first_claim_at?.getTime(), `${c.name}: premise: the old stay was older`).toBeLessThan(sceneAt(pressMs).getTime());
      const next = await claimAt(key, b, "home", sceneAt(pressMs + 3_000));
      expect(leftOf(next), `${c.name}: set once, on the claim that starts the replacement`).toBe(null);
      checked += 1;
    }
    expect(checked, "cases checked").toBe(4);
  }, 120_000);

  it("(e) a replacement whose first claim PASSES the gate (the line has drained) is answered with no `line` key at all - so no `left` - for each of (a), (b) and (c)", async () => {
    let checked = 0;
    for (const c of cases.filter((x) => x.want !== null)) {
      const key = scene();
      const { b, pressMs } = await driveStay(key, c.end);
      await setBucket(key, 1000, sceneAt(pressMs)); // nobody else in line
      const got = await claimAt(key, b, "home", sceneAt(pressMs));
      expect(got, `${c.name}: the replacement goes`).toEqual({ kind: "go", decision: "idle" });
      expect("line" in got, `${c.name}: no line key`).toBe(false);
      expect("left" in got, `${c.name}: no left key`).toBe(false);
      checked += 1;
    }
    expect(checked, "cases checked").toBe(3);
  }, 120_000);

  it("(f) a stay that was in line and then SERVED or ENDED (a seat, camera_blocked) is not a stay that left: its next press behind a waiting stay says nothing - `left` is null, not `camera` and not `silent`", async () => {
    let checked = 0;
    for (const how of ["served", "ended"] as const) {
      const key = scene();
      const b = await sceneBoard();
      const pressMs = 10_000; // inside the abandon window: the stay is neither silent nor past its hold
      await putStay({
        fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: key,
        firstClaimAt: sceneAt(0), seenAt: sceneAt(pressMs - 1_000), gate: "passed", queuedAt: sceneAt(0), admittedAt: sceneAt(1_000),
        servedAt: how === "served" ? sceneAt(pressMs - 1_000) : null,
        endedAt: how === "ended" ? sceneAt(pressMs - 1_000) : null,
      });
      await holdWaiting(key, sceneAt(pressMs - 5_000), sceneAt(pressMs - 1_000));
      await setBucket(key, 0, sceneAt(pressMs));
      const got = await claimAt(key, b, "home", sceneAt(pressMs));
      expect(got.kind, `${how}: the new stay waits behind the line`).toBe("queued");
      expect(leftOf(got), `${how}: it did not leave, it was finished`).toBe(null);
      expect((await stayRow(b.fixtureId, b.home.personId))?.first_claim_at, `${how}: a NEW stay`).toEqual(sceneAt(pressMs));
      checked += 1;
    }
    expect(checked, "cases checked").toBe(2);
  }, 120_000);

  it("through the real route: the seat answer's `line.left` is `silent` for a player who went quiet and pressed again behind a waiting stay", async () => {
    const w = world();
    const b = await seedBoard();
    const T = inWindow(3 * MIN);
    await fund(w.key, 0);
    await holdWaiting(w.key, new Date(T.getTime() - 2 * SEC), new Date(T.getTime() + 10 * SEC));
    const first = await claimRoom(w, b, "home", T);
    expect(first.seat, "queued behind the waiting stay").toMatchObject({ reason: "queued", line: { left: null } });
    const press = new Date(T.getTime() + LINE_ABANDON_AFTER_MS);
    await holdWaiting(w.key, new Date(press.getTime() - 5 * SEC), new Date(press.getTime() - SEC));
    const again = await claimRoom(w, b, "home", press);
    expect(again.seat, "the replacement says why the old one left").toMatchObject({ reason: "queued", line: { left: "silent" } });
  }, 60_000);
});

describe.skipIf(!DB)("`released_at`: the last time the gate let a claim spend (spec §5.7.2, §5.7.3 steps 3 and 5)", () => {
  it("an idle pass writes nothing, an admission stamps it, an admitted stay's next claim moves it, and a restart clears it (4 readings)", async () => {
    const key = scene();
    const b = await sceneBoard();
    let checked = 0;
    const released = async () => (await stayRow(b.fixtureId, b.home.personId))?.released_at ?? null;

    // The idle line: today's path, nothing written but the upsert.
    await setBucket(key, 1000, sceneAt(0));
    expect(await claimAt(key, b, "home", sceneAt(0)), "premise: the idle line lets it go").toEqual({ kind: "go", decision: "idle" });
    expect(await released(), "an idle pass writes nothing").toBeNull();
    checked += 1;

    // A stay held alone, then funded: admitted, and the admission is the gate letting a claim spend.
    await putStay({ fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: key, firstClaimAt: sceneAt(1_000), seenAt: sceneAt(1_000), gate: "held", queuedAt: sceneAt(1_000) });
    await setBucket(key, 1000, sceneAt(8_000));
    expect(await claimAt(key, b, "home", sceneAt(8_000)), "premise: funded, the held stay is admitted").toEqual({ kind: "go", decision: "admit" });
    expect(await released(), "an admission stamps it").toEqual(sceneAt(8_000));
    checked += 1;

    // The admitted stay's next claim goes with no level check and moves the stamp.
    expect(await claimAt(key, b, "home", sceneAt(12_000)), "premise: an admitted stay goes").toEqual({ kind: "go", decision: "admitted" });
    expect(await released(), "the admitted stay's next claim moves it").toEqual(sceneAt(12_000));
    checked += 1;

    // Silent for the release grace, then back behind a waiting stay with a dry bucket: a NEW stay, held, never yet released.
    const pressMs = 12_000 + LINE_RELEASE_GRACE_MS;
    await holdWaiting(key, sceneAt(pressMs - 5_000), sceneAt(pressMs - 1_000));
    await setBucket(key, 0, sceneAt(pressMs));
    expect((await claimAt(key, b, "home", sceneAt(pressMs))).kind, "premise: the replacement waits").toBe("queued");
    expect((await stayRow(b.fixtureId, b.home.personId))?.first_claim_at, "premise: a new stay").toEqual(sceneAt(pressMs));
    expect(await released(), "a restart clears it: the new stay has not spent").toBeNull();
    checked += 1;
    expect(checked, "readings checked").toBe(4);
  }, 120_000);
});
