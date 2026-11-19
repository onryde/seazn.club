// The arbiter's browser side (plan 3 Task 2): one join chain PER MEETING, a token kept in memory once a connect with it has
// succeeded, and a close that is the SDK leave only - the browser sends no DELETE, ever. Driven through the REAL helper with
// deferred ports (every step a promise the test settles by hand), so order is read off a log the test controls.
import { describe, expect, it } from "vitest";
import { ArbiterGuardError, type ArbiterCameras } from "../arbiter-camera";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { makeArbiterSerial, type ArbiterJoinAnswer, type ArbiterSide } from "../arbiter-watch";

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

type Gate = { promise: Promise<void>; open(): void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((res) => {
    open = res;
  });
  return { promise, open };
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

/** The world the helper talks to: a join route and the SDK, each logged and each holdable or failable. */
function rig(
  o: {
    /** A POST (by fixture:side) that does not answer until its gate opens. */
    holdPost?: Record<string, Gate>;
    /** POSTs (by fixture:side) that are refused. */
    refusePost?: Set<string>;
    /** Connect labels (the mint's `t-<n>` without the `t-`) that reject. */
    connectFails?: Set<string>;
    /** Connects (by label) that never answer until their gate opens. */
    holdConnect?: Record<string, Gate>;
    holdLeave?: Record<string, Gate>;
  } = {},
) {
  const log: string[] = [];
  let seq = 0;
  const timeouts: Gate[] = [];
  const serial = makeArbiterSerial({
    stepTimeoutMs: 10_000,
    after: () => {
      const g = gate();
      timeouts.push(g);
      return g.promise;
    },
    async join(fixtureId, side) {
      const n = (seq += 1);
      log.push(`POST ${fixtureId}:${side}`);
      const held = o.holdPost?.[`${fixtureId}:${side}`];
      if (held) await held.promise;
      if (o.refusePost?.has(`${fixtureId}:${side}`)) throw new ApiV1Error("not started", 409, "VIDEO_MEETING_NOT_STARTED");
      return { authToken: `t-${n}`, participantId: `p-${n}`, side, players: [`player-${side}`], reused: false } satisfies ArbiterJoinAnswer;
    },
    async connect(a) {
      const label = a.authToken.slice(2);
      log.push(`connect ${a.authToken}`);
      if (o.connectFails?.has(label)) throw new ArbiterGuardError(new Error("dead token"));
      const held = o.holdConnect?.[label];
      if (held) await held.promise;
      return fakeCameras(log, a.authToken, o.holdLeave?.[label]);
    },
  });
  const cameras: string[] = [];
  const errors: unknown[] = [];
  const open = (fixtureId: string, side: ArbiterSide) =>
    serial.open(fixtureId, side, { onCameras: () => void cameras.push(`${fixtureId}:${side}`), onError: (e) => void errors.push(e) });
  const posts = () => log.filter((e) => e.startsWith("POST"));
  return { log, open, cameras, errors, timeouts, serial, posts };
}

describe("one chain per meeting", () => {
  it("two boards opened together proceed in parallel: board B connects while board A's POST is still pending", async () => {
    const post = gate();
    const r = rig({ holdPost: { "a:home": post } });
    r.open("a", "home");
    r.open("b", "home");
    await flush();
    expect(r.log, "premise: A's POST is out and held").toContain("POST a:home");
    expect(r.cameras, "B did not wait for A").toEqual(["b:home"]);
    post.open();
    await flush();
    expect(r.cameras.sort()).toEqual(["a:home", "b:home"]);
  });

  it("the two sides of one board are two meetings, so a side switch is parallel too", async () => {
    const post = gate();
    const r = rig({ holdPost: { "fx:home": post } });
    const a = r.open("fx", "home");
    a.close();
    r.open("fx", "away");
    await flush();
    expect(r.cameras).toEqual(["fx:away"]);
  });

  it("close then open of the SAME meeting runs in order on one chain: the leave resolves before the second connect starts", async () => {
    const leaving = gate();
    const r = rig({ holdLeave: { "1": leaving } });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    r.open("fx", "home");
    await flush();
    expect(r.log, "premise: wedged inside the leave").toContain("leave t-1");
    expect(r.log.filter((e) => e.startsWith("connect")), "no second connect while the leave is out").toEqual(["connect t-1"]);
    leaving.open();
    await flush();
    expect(r.log.indexOf("left t-1")).toBeLessThan(r.log.lastIndexOf("connect t-1"));
    expect(r.log.filter((e) => e.startsWith("connect"))).toEqual(["connect t-1", "connect t-1"]);
  });
});

describe("the token memory", () => {
  it("a close then an open of the same meeting POSTs nothing the second time and connects with the kept token", async () => {
    const r = rig();
    const a = r.open("fx", "home");
    await flush();
    a.close();
    r.open("fx", "home");
    await flush();
    expect(r.posts(), "one POST in all").toEqual(["POST fx:home"]);
    expect(r.log.filter((e) => e.startsWith("connect"))).toEqual(["connect t-1", "connect t-1"]);
    expect(r.cameras).toEqual(["fx:home", "fx:home"]);
    expect([...r.serial.tokens().keys()]).toEqual(["fx:home"]);
  });

  it("a close never sends a DELETE: through the real apiV1 over a mocked fetch, one POST on the first open, none on the second, no DELETE among the requests", async () => {
    const requests: { url: string; method: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(
        JSON.stringify({ ok: true, data: { authToken: "t", participantId: "p", side: "home", players: ["x"], reused: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const serial = makeArbiterSerial({
        join: (fixtureId, side) =>
          apiV1<ArbiterJoinAnswer>(`/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/arbiter`, { method: "POST", json: { side } }),
        connect: async () => fakeCameras([], "x"),
      });
      const h = { onCameras: () => undefined, onError: (e: unknown) => { throw e; } };
      const first = serial.open("fx", "home", h);
      await flush();
      first.close();
      serial.open("fx", "home", h);
      await flush();
    } finally {
      globalThis.fetch = real;
    }
    expect(requests.filter((q) => q.method === "POST"), "the positive count").toHaveLength(1);
    expect(requests.some((q) => q.method === "DELETE")).toBe(false);
    expect(requests.length, "and nothing else was sent").toBe(1);
  });
});

describe("a failed connect on a kept token", () => {
  it("evicts the token, POSTs once more and connects with the new one (join twice in all)", async () => {
    let calls = 0;
    const log: string[] = [];
    let n = 0;
    const serial = makeArbiterSerial({
      join: async () => {
        n += 1;
        log.push(`POST ${n}`);
        return { authToken: `t-${n}`, participantId: `p-${n}`, side: "home", players: ["x"], reused: false };
      },
      connect: async (a2) => {
        calls += 1;
        log.push(`connect ${a2.authToken}`);
        if (calls === 2) throw new Error("token expired"); // the kept token, on the return
        return fakeCameras(log, a2.authToken);
      },
    });
    const got: string[] = [];
    const h = { onCameras: () => void got.push("cameras"), onError: (e: unknown) => void got.push(`error ${(e as Error).message}`) };
    const first = serial.open("fx", "home", h);
    await flush();
    first.close();
    serial.open("fx", "home", h);
    await flush();
    expect(log.filter((e) => e.startsWith("POST")), "join called twice in all").toEqual(["POST 1", "POST 2"]);
    expect(log.filter((e) => e.startsWith("connect"))).toEqual(["connect t-1", "connect t-1", "connect t-2"]);
    expect(got).toEqual(["cameras", "cameras"]);
    expect(serial.tokens().get("fx:home")?.authToken, "the new token replaced the dead one").toBe("t-2");
  });

  it("the dead token is gone even when the re-POST is refused (a revoked organizer): the pane reads the refusal, tokens() lacks the key, the next open POSTs", async () => {
    let n = 0;
    let revoked = false;
    const log: string[] = [];
    const serial = makeArbiterSerial({
      join: async () => {
        n += 1;
        log.push(`POST ${n}`);
        if (revoked) throw new ApiV1Error("no", 409, "ARBITER_PLAYS_THIS_BOARD");
        return { authToken: `t-${n}`, participantId: `p-${n}`, side: "home", players: ["x"], reused: false };
      },
      connect: async (a) => {
        if (revoked) throw new Error("participant removed");
        return fakeCameras(log, a.authToken);
      },
    });
    const got: unknown[] = [];
    const h = { onCameras: () => void got.push("cameras"), onError: (e: unknown) => void got.push((e as ApiV1Error).code) };
    const first = serial.open("fx", "home", h);
    await flush();
    first.close();
    revoked = true;
    serial.open("fx", "home", h);
    await flush();
    expect(got).toEqual(["cameras", "ARBITER_PLAYS_THIS_BOARD"]);
    expect(serial.tokens().has("fx:home"), "the revoked token is not kept").toBe(false);
  });

  it("a second rejection is the pane's error with join called exactly twice, and the NEXT open starts the rule again (one more POST)", async () => {
    let n = 0;
    let phase: "ok" | "dead" = "ok";
    const log: string[] = [];
    const serial = makeArbiterSerial({
      join: async () => {
        n += 1;
        log.push(`POST ${n}`);
        return { authToken: `t-${n}`, participantId: `p-${n}`, side: "home", players: ["x"], reused: false };
      },
      connect: async (a) => {
        log.push(`connect ${a.authToken}`);
        if (phase === "dead") throw new Error("dead");
        return fakeCameras(log, a.authToken);
      },
    });
    const got: string[] = [];
    const h = { onCameras: () => void got.push("cameras"), onError: () => void got.push("error") };
    const first = serial.open("fx", "home", h);
    await flush();
    first.close();
    phase = "dead";
    const second = serial.open("fx", "home", h);
    await flush();
    expect(got).toEqual(["cameras", "error"]);
    expect(log.filter((e) => e.startsWith("POST")), "exactly twice").toEqual(["POST 1", "POST 2"]);
    expect(serial.tokens().has("fx:home"), "nothing kept after the double failure").toBe(false);
    second.close();
    serial.open("fx", "home", h);
    await flush();
    expect(log.filter((e) => e.startsWith("POST")), "the retry press starts again: one more POST, never a doomed reconnect").toEqual(["POST 1", "POST 2", "POST 3"]);
    expect(got.at(-1)).toBe("error");
  });

  it("a kept token whose connect never answers (TIMED_OUT) is evicted and re-POSTed once, too", async () => {
    const log: string[] = [];
    let calls = 0;
    const timeouts: Gate[] = [];
    let n = 0;
    const serial = makeArbiterSerial({
      after: () => {
        const g = gate();
        timeouts.push(g);
        return g.promise;
      },
      join: async () => {
        n += 1;
        log.push(`POST ${n}`);
        return { authToken: `t-${n}`, participantId: `p-${n}`, side: "home", players: ["x"], reused: false };
      },
      connect: (a) => {
        calls += 1;
        log.push(`connect ${a.authToken}`);
        return calls === 2 ? new Promise(() => undefined) : Promise.resolve(fakeCameras(log, a.authToken));
      },
    });
    const h = { onCameras: () => undefined, onError: () => undefined };
    const o1 = serial.open("fx", "home", h);
    await flush();
    o1.close();
    serial.open("fx", "home", h);
    await flush();
    expect(log.filter((e) => e.startsWith("POST")), "premise: the return is waiting on a silent connect").toEqual(["POST 1"]);
    timeouts.at(-1)!.open();
    await flush();
    expect(log.filter((e) => e.startsWith("POST"))).toEqual(["POST 1", "POST 2"]);
    expect(serial.tokens().get("fx:home")?.authToken).toBe("t-2");
  });
});

describe("what is never kept", () => {
  it("a FRESH token whose first connect rejects is the pane's error and is not kept: the next open POSTs again", async () => {
    const r = rig({ connectFails: new Set(["1"]) });
    const a = r.open("fx", "home");
    await flush();
    expect(r.errors).toHaveLength(1);
    expect(r.serial.tokens().has("fx:home")).toBe(false);
    a.close();
    r.open("fx", "home");
    await flush();
    expect(r.posts(), "one POST per open").toEqual(["POST fx:home", "POST fx:home"]);
    expect(r.cameras, "the second token worked").toEqual(["fx:home"]);
  });

  it("a POST the route refused (VIDEO_MEETING_NOT_STARTED) is never kept: the next open POSTs again", async () => {
    const r = rig({ refusePost: new Set(["fx:home"]) });
    const a = r.open("fx", "home");
    await flush();
    expect((r.errors[0] as ApiV1Error).code).toBe("VIDEO_MEETING_NOT_STARTED");
    expect(r.serial.tokens().has("fx:home")).toBe(false);
    a.close();
    r.open("fx", "home");
    await flush();
    expect(r.posts()).toEqual(["POST fx:home", "POST fx:home"]);
  });
});

describe("every step is bounded, and the chain's other sequences", () => {
  it("a join POST that never answers is the pane's one error after the step timeout, and the next open of that meeting still POSTs", async () => {
    const post = gate();
    const r = rig({ holdPost: { "fx:home": post } });
    r.open("fx", "home");
    await flush();
    expect(r.timeouts.length, "premise: the POST is racing a timer").toBe(1);
    r.timeouts[0]!.open();
    await flush();
    expect(r.errors).toHaveLength(1);
    expect((r.errors[0] as Error).message).toMatch(/timed out/);
    expect(r.serial.tokens().size).toBe(0);
  });

  it("an SDK join that never answers is the pane's error after the timeout; a late landing is left at once and never shown", async () => {
    const connecting = gate();
    const r = rig({ holdConnect: { "1": connecting } });
    r.open("fx", "home");
    await flush();
    expect(r.timeouts.length, "premise: POST timer and connect timer").toBe(2);
    r.timeouts[1]!.open();
    await flush();
    expect(r.errors).toHaveLength(1);
    connecting.open();
    await flush();
    expect(r.cameras).toEqual([]);
    expect(r.log, "the late join is left").toContain("left t-1");
    expect(r.serial.tokens().size, "a timed-out fresh connect is not kept").toBe(0);
  });

  it("a leave that never answers is given up on after the step timeout", async () => {
    const leaving = gate();
    const r = rig({ holdLeave: { "1": leaving } });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    r.open("fx", "home");
    await flush();
    expect(r.log.filter((e) => e.startsWith("connect")), "premise: wedged on the leave").toEqual(["connect t-1"]);
    r.timeouts.at(-1)!.open();
    await flush();
    expect(r.log.filter((e) => e.startsWith("connect"))).toEqual(["connect t-1", "connect t-1"]);
  });

  it("opened and closed before its turn comes: it never POSTs at all", async () => {
    const post = gate();
    const r = rig({ holdPost: { "fx:home": post } });
    const a = r.open("fx", "home");
    await flush();
    a.close();
    const b = r.open("fx", "home");
    b.close();
    post.open();
    await flush();
    expect(r.posts(), "only A's POST; B was closed before its turn").toEqual(["POST fx:home"]);
  });

  it("closing twice leaves once", async () => {
    const r = rig();
    const a = r.open("fx", "home");
    await flush();
    a.close();
    a.close();
    await flush();
    expect(r.log.filter((e) => e.startsWith("leave"))).toEqual(["leave t-1"]);
  });

  it("a caller whose error handler throws does not wedge the chain: the next open still works", async () => {
    const r = rig({ refusePost: new Set(["fx:home"]) });
    const a = r.serial.open("fx", "home", {
      onCameras: () => undefined,
      onError: () => {
        throw new Error("a handler bug");
      },
    });
    await flush();
    a.close();
    r.serial.open("fx", "home", { onCameras: () => void r.cameras.push("later"), onError: () => undefined });
    await flush();
    expect(r.posts()).toEqual(["POST fx:home", "POST fx:home"]);
  });
});
