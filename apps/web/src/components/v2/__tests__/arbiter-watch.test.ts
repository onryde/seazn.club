// D16 (§5.6.4, shape (b)) - the arbiter holds ONE player's meeting at a time and a switch is a serial chain:
// the SDK leave is awaited, then the server DELETE of the participant that open minted is awaited, and only then is the
// next join POSTed. React does not await an effect's cleanup, so the order lives in `makeArbiterSerial`, not in the
// panel. Driven through the REAL helper with deferred ports (every step is a promise the test settles by hand), so
// "DELETE answered BEFORE the next join is sent" is read off a log the test controls, not off the helper's own state.
import { describe, expect, it } from "vitest";
import { ArbiterGuardError, type ArbiterCameras } from "../arbiter-camera";
import { makeArbiterSerial, type ArbiterJoinAnswer, type ArbiterSide } from "../arbiter-watch";

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

type Gate = { promise: Promise<void>; open(): void; fail(e: unknown): void };
function gate(): Gate {
  let open!: () => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { promise, open, fail };
}

function fakeCameras(log: string[], name: string, leaveGate?: Gate): ArbiterCameras {
  return {
    tile: () => ({ present: true, live: true, track: null }),
    onChange: () => () => undefined,
    onFault: () => undefined,
    leave: async () => {
      log.push(`leave ${name}`);
      if (leaveGate) await leaveGate.promise;
      log.push(`left ${name}`);
    },
  } as unknown as ArbiterCameras;
}

/** The world the helper talks to: a join route, the SDK, and the DELETE, each logged and each holdable. */
function rig(
  o: {
    holdPost?: Record<string, Gate>;
    holdDelete?: Record<string, Gate>;
    holdLeave?: Record<string, Gate>;
    failDelete?: Set<string>;
    failPost?: Set<ArbiterSide>;
    connectFails?: Set<string>;
    stepTimeoutMs?: number;
  } = {},
) {
  const log: string[] = [];
  let seq = 0;
  const live = new Set<string>();
  let maxLive = 0;
  const idOf = new Map<string, string>(); // participant id -> label ("A1")
  const timeouts: Gate[] = [];
  const serial = makeArbiterSerial({
    stepTimeoutMs: o.stepTimeoutMs ?? 10_000,
    after: () => {
      const g = gate();
      timeouts.push(g);
      return g.promise;
    },
    async join(fixtureId, side) {
      const label = `${side}${(seq += 1)}`;
      log.push(`POST ${fixtureId} ${side}`);
      const held = o.holdPost?.[side];
      if (held) await held.promise;
      if (o.failPost?.has(side)) throw new Error(`join ${side} refused`);
      const participantId = `p-${label}`;
      idOf.set(participantId, label);
      live.add(participantId);
      maxLive = Math.max(maxLive, live.size);
      return { authToken: `t-${label}`, participantId, side, players: [`player-${side}`] } satisfies ArbiterJoinAnswer;
    },
    async connect(a) {
      // The SDK join is handed the token and the players only; the token names the mint (`t-<label>`).
      const label = a.authToken.slice(2);
      log.push(`connect ${label}`);
      if (o.connectFails?.has(label)) throw new ArbiterGuardError(new Error("audio"));
      return fakeCameras(log, label, o.holdLeave?.[label]);
    },
    async send(url, init) {
      const pid = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const label = idOf.get(pid) ?? pid;
      expect(init, "every DELETE outlives the page").toEqual({ method: "DELETE", keepalive: true });
      log.push(`DELETE ${label}`);
      const held = o.holdDelete?.[label];
      if (held) await held.promise;
      if (o.failDelete?.has(label)) throw new Error("vendor said no");
      live.delete(pid);
      log.push(`DELETE answered ${label}`);
    },
  });
  const cameras: string[] = [];
  const errors: unknown[] = [];
  const open = (fixtureId: string, side: ArbiterSide) =>
    serial.open(fixtureId, side, { onCameras: () => void cameras.push(`${fixtureId}:${side}`), onError: (e) => void errors.push(e) });
  return { log, open, cameras, errors, live, maxLive: () => maxLive, timeouts };
}

describe("shape (b): a switch leaves, then deletes, then joins - each awaited", () => {
  it("the order on the happy path, three switches: leave, DELETE sent, DELETE ANSWERED, and only then the next POST; never more than one live participant", async () => {
    const r = rig();
    let a = r.open("fx", "home");
    await flush();
    expect(r.log).toEqual(["POST fx home", "connect home1"]);
    expect(r.live.size, "one participant after the first open").toBe(1);
    let switches = 0;
    for (const next of ["away", "home", "away"] as const) {
      a.close();
      a = r.open("fx", next);
      await flush();
      switches += 1;
    }
    expect(switches, "anti-vacuity: three switches driven").toBe(3);
    const sequence = r.log.filter((e) => !e.startsWith("connect"));
    expect(sequence).toEqual([
      "POST fx home",
      "leave home1", "left home1", "DELETE home1", "DELETE answered home1",
      "POST fx away",
      "leave away2", "left away2", "DELETE away2", "DELETE answered away2",
      "POST fx home",
      "leave home3", "left home3", "DELETE home3", "DELETE answered home3",
      "POST fx away",
    ]);
    expect(r.maxLive(), "at most ONE live participant at any instant on this path").toBe(1);
    expect(r.live.size, "and one at the end").toBe(1);
    expect(r.cameras, "each open handed its cameras to its own caller").toEqual(["fx:home", "fx:away", "fx:home", "fx:away"]);
  });

  it("the next POST is NOT sent while the DELETE is unanswered, and goes out the moment it is", async () => {
    const del = gate();
    const r = rig({ holdDelete: { home1: del } });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    r.open("fx", "away");
    await flush();
    expect(r.log).toContain("DELETE home1");
    expect(r.log, "premise: the DELETE was sent and is waiting").not.toContain("DELETE answered home1");
    expect(r.log.filter((e) => e.startsWith("POST")), "no second POST while the DELETE is out").toEqual(["POST fx home"]);
    del.open();
    await flush();
    expect(r.log.filter((e) => e.startsWith("POST")), "answered: now the POST").toEqual(["POST fx home", "POST fx away"]);
    expect(r.log.indexOf("DELETE answered home1")).toBeLessThan(r.log.indexOf("POST fx away"));
  });

  it("the SDK leave is awaited before the DELETE is sent", async () => {
    const leaving = gate();
    const r = rig({ holdLeave: { home1: leaving } });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    await flush();
    expect(r.log).toContain("leave home1");
    expect(r.log, "leave still pending: no DELETE yet").not.toContain("DELETE home1");
    leaving.open();
    await flush();
    expect(r.log.indexOf("left home1")).toBeLessThan(r.log.indexOf("DELETE home1"));
  });

  it("a FAILED DELETE does not stop the join: the next POST goes out and its cameras arrive (two live participants on this path - the claim is not made for it)", async () => {
    const r = rig({ failDelete: new Set(["home1"]) });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    r.open("fx", "away");
    await flush();
    expect(r.log.filter((e) => e.startsWith("POST"))).toEqual(["POST fx home", "POST fx away"]);
    expect(r.log).not.toContain("DELETE answered home1");
    expect(r.cameras).toEqual(["fx:home", "fx:away"]);
    expect(r.errors, "the failed DELETE is nobody's error").toEqual([]);
    expect(r.live.size, "the leftover is real: the sweep removes it, the helper cannot").toBe(2);
  });

  it("a leave or a DELETE that never answers is given up on after the step timeout, so one stuck step cannot wedge the switch", async () => {
    const leaving = gate(); // never opened
    const r = rig({ holdLeave: { home1: leaving } });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    r.open("fx", "away");
    await flush();
    expect(r.log.filter((e) => e.startsWith("POST")), "premise: wedged on the leave").toEqual(["POST fx home"]);
    expect(r.timeouts.length, "premise: the leave is racing a timer").toBeGreaterThan(0);
    r.timeouts.at(-1)!.open();
    await flush();
    expect(r.log, "the DELETE still went out after the leave was abandoned").toContain("DELETE home1");
    expect(r.log.filter((e) => e.startsWith("POST"))).toEqual(["POST fx home", "POST fx away"]);
  });
});

describe("the helper's other sequences", () => {
  it("closed while the POST is in flight: no connect, and the participant it minted is handed back", async () => {
    const post = gate();
    const r = rig({ holdPost: { home: post } });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    post.open();
    await flush();
    expect(r.log).toEqual(["POST fx home", "DELETE home1", "DELETE answered home1"]);
    expect(r.cameras).toEqual([]);
    expect(r.live.size).toBe(0);
  });

  it("opened and closed before its turn comes (an earlier open is still starting): it never POSTs at all", async () => {
    const post = gate();
    const r = rig({ holdPost: { home: post } });
    // The panel always closes the pane it leaves BEFORE it opens the next (effect cleanup, then effect).
    const a = r.open("fx", "home");
    await flush(); // A's POST is out and held
    a.close();
    const b = r.open("fx", "away");
    b.close(); // flipped again before B ever started
    const c = r.open("fx", "home");
    await flush();
    post.open();
    await flush();
    const posts = r.log.filter((e) => e.startsWith("POST"));
    expect(posts, "A's POST, then C's - never B's").toEqual(["POST fx home", "POST fx home"]);
    expect(r.log).not.toContain("POST fx away");
    expect(r.live.size, "A was handed back, C holds the one live participant").toBe(1);
    expect(r.maxLive(), "and they never overlapped").toBe(1);
    c.close();
    await flush();
    expect(r.live.size).toBe(0);
  });

  it("a refused POST is the caller's error, once; nothing was minted so nothing is deleted; the next open still works", async () => {
    const r = rig({ failPost: new Set(["away"] as const) });
    const a = r.open("fx", "away");
    await flush();
    expect(r.errors).toHaveLength(1);
    expect((r.errors[0] as Error).message).toBe("join away refused");
    a.close();
    r.open("fx", "home");
    await flush();
    expect(r.log.filter((e) => e.startsWith("DELETE"))).toEqual([]);
    expect(r.cameras).toEqual(["fx:home"]);
  });

  it("a guard fault in the SDK join is the caller's error and the participant is still handed back when the pane closes", async () => {
    const r = rig({ connectFails: new Set(["home1"]) });
    const a = r.open("fx", "home");
    await flush();
    expect(r.errors[0]).toBeInstanceOf(ArbiterGuardError);
    expect(r.cameras).toEqual([]);
    a.close();
    await flush();
    expect(r.log).toContain("DELETE answered home1");
    expect(r.live.size).toBe(0);
  });

  it("a caller whose error handler throws does not wedge the chain: the next open still POSTs and its cameras arrive", async () => {
    const log: string[] = [];
    const serial = makeArbiterSerial({
      join: async (fixtureId, side) => {
        log.push(`POST ${fixtureId} ${side}`);
        if (side === "home") throw new Error("refused");
        return { authToken: "t", participantId: `p-${side}`, side, players: [] };
      },
      connect: async () => fakeCameras(log, "x"),
      send: async () => void log.push("DELETE"),
    });
    const got: string[] = [];
    const a = serial.open("fx", "home", {
      onCameras: () => undefined,
      onError: () => {
        throw new Error("a handler bug");
      },
    });
    await flush();
    a.close();
    serial.open("fx", "away", { onCameras: () => void got.push("away"), onError: () => undefined });
    await flush();
    expect(log.filter((e) => e.startsWith("POST"))).toEqual(["POST fx home", "POST fx away"]);
    expect(got, "the chain survived the throw").toEqual(["away"]);
  });

  it("closing twice sends one DELETE", async () => {
    const r = rig();
    const a = r.open("fx", "home");
    await flush();
    a.close();
    a.close();
    await flush();
    expect(r.log.filter((e) => e.startsWith("DELETE ") && !e.includes("answered"))).toEqual(["DELETE home1"]);
  });

  it("the tab going away (pagehide) hands the participant back AT ONCE, without waiting for the chain; the close after it sends no second", async () => {
    const leaving = gate();
    const r = rig({ holdLeave: { home1: leaving } });
    const a = r.open("fx", "home");
    await flush();
    a.close(); // the chain is now wedged inside the SDK leave
    await flush();
    expect(r.log, "premise: wedged on the leave, nothing deleted").not.toContain("DELETE home1");
    a.release();
    await flush();
    expect(r.log, "the pagehide DELETE did not queue behind the leave").toContain("DELETE home1");
    expect(r.log).not.toContain("left home1");
    leaving.open();
    await flush();
    expect(r.log.filter((e) => e.startsWith("DELETE ") && !e.includes("answered")), "the close after the release adds none").toEqual(["DELETE home1"]);
  });

  it("a release before anything is minted sends nothing (the empty case)", async () => {
    const post = gate();
    const r = rig({ holdPost: { home: post } });
    const a = r.open("fx", "home");
    await flush();
    a.release();
    await flush();
    expect(r.log.filter((e) => e.startsWith("DELETE"))).toEqual([]);
    post.open();
    await flush();
    a.close();
    await flush();
    expect(r.log.filter((e) => e.startsWith("DELETE ") && !e.includes("answered"))).toEqual(["DELETE home1"]);
  });
});
