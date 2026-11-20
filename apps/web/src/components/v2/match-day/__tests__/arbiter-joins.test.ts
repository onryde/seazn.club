// Match Day online, Task 9 - which meetings the board in focus asks for (`meetingKeysOf`) and the hook that keeps them joined
// (`useArbiterJoins`), driven through the REAL per-meeting chain (`makeArbiterSerial`, arbiter-watch.ts) over a fake join route and a fake SDK.
//
// Chess only: a meeting is one PLAYER's camera room of an online chess board (D16); no other sport has one, so the sport sweep this
// suite owes is the sweep over the reader x policy x state table below, not the sport registry.
//
// What is driven, in order: the pure key rule (empty case first), then the hook under the node-env hook harness (no DOM): opens and leaves
// counted at the SDK, POSTs counted at the join route, the busy ladder on a fake clock, the poll's re-open. Where an expected value comes
// from: the ladder is `ARBITER_RETRY_MS`'s own declaration (arbiter-camera.ts), the POST ceiling is the route's own `ARBITER_JOIN_LIMIT`,
// every other count is the scenario's (a side added is one POST). Anti-vacuity: every sweep says how many cells it checked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import type { Reader } from "@/lib/match-day/online";
import { ARBITER_JOIN_LIMIT } from "@/lib/rate-limit";
import { LIVE_POLL_MS } from "@/components/v2/desk/band-poll";
import { ARBITER_RETRY_MS, type ArbiterCameras } from "../online/arbiter-camera";
import { camerasOffered, createJoinEngine, defaultCameraMode, meetingKey, meetingKeysOf, useArbiterJoins, type MeetingKey } from "../online/arbiter-joins";
import { makeArbiterSerial, type ArbiterJoinAnswer, type ArbiterSide } from "../online/arbiter-watch";
import { done, held, live, meeting, present } from "./_online-fixtures";

const EDITOR: Reader = { editor: true, offered: true, frozen: false };
const FROZEN: Reader = { ...EDITOR, frozen: true };
const VIEWER: Reader = { ...EDITOR, editor: false };
const NOT_OFFERED: Reader = { ...EDITOR, offered: false };

/** A side whose player has arrived: the room is open and the loader calls it joinable. */
const joinable = (camera: "live" | "off" = "live") => ({ ...present(camera), joinable: true });
/** The room is open (a pre-minted room, or a player who has not been counted in) but the join would refuse it. */
const openNotJoinable = () => present("live");

const board = (over: Partial<ArbiterBoard> = {}): ArbiterBoard => live(7, { fixtureId: "fx-a", cameraPolicy: "required", sides: { home: joinable(), away: joinable() }, ...over });

// ---- the pure rule ------------------------------------------------------------------------------------------------------------------

describe("meetingKeysOf: the meetings the board in focus asks for", () => {
  it("EMPTY CASE FIRST: no board has no keys at all (the hook opens nothing and POSTs nothing for an empty list)", () => {
    // The shell passes [] when nothing is focused; the rule's own empty case is a board with nothing to watch.
    expect(meetingKeysOf(board({ sides: { home: meeting(), away: meeting() } }), EDITOR)).toEqual([]);
  });

  it("an editor in an offered club on a required board with both players arrived: two keys, White's side first", () => {
    expect(meetingKeysOf(board(), EDITOR)).toEqual(["fx-a:home", "fx-a:away"]);
    // Colour decides the order, not the seat: with Black on the home seat, White's meeting is the away one.
    expect(meetingKeysOf(board({ whiteSide: "away" }), EDITOR)).toEqual(["fx-a:away", "fx-a:home"]);
  });

  it("(sweep) reader x camera policy x override x state: keys exactly when the reader may watch, the policy REQUIRES cameras and the board is still to be played", () => {
    const readers: [string, Reader, boolean][] = [
      ["editor offered", EDITOR, true],
      ["editor offered, frozen (watching writes nothing)", FROZEN, true],
      ["editor, club not offered", NOT_OFFERED, false],
      ["view-only member", VIEWER, false],
    ];
    const policies = ["required", "optional", "off"] as const;
    const states: [string, ArbiterBoard["state"], boolean][] = [
      ["live", { kind: "live", moveNo: 3 }, true],
      ["on hold", { kind: "on_hold" }, true],
      ["checking in", { kind: "checking_in" }, true],
      ["result", { kind: "result", score: "1-0", noResult: false }, false],
      ["cancelled", { kind: "cancelled" }, false],
    ];
    let checked = 0;
    let withKeys = 0;
    for (const [rlabel, reader, mayWatch] of readers) {
      for (const policy of policies) {
        for (const overridden of [false, true]) {
          for (const [slabel, state, toBePlayed] of states) {
            const keys = meetingKeysOf(board({ cameraPolicy: policy, videoOverridden: overridden, state }), reader);
            const expected = mayWatch && policy === "required" && !overridden && toBePlayed;
            expect(keys.length > 0, `${rlabel} / ${policy} / overridden ${overridden} / ${slabel}`).toBe(expected);
            if (expected) {
              expect(keys).toHaveLength(2);
              withKeys += 1;
            }
            checked += 1;
          }
        }
      }
    }
    expect(checked, "every cell was checked").toBe(4 * 3 * 2 * 5);
    // The sweep is not vacuous the other way: the cells that DO watch are the editors' two readers x required x not overridden x three states.
    expect(withKeys).toBe(2 * 1 * 1 * 3);
  });

  it("only a WATCHABLE side is a key: a room that is open but whose player has not arrived (the pre-minted room) makes none, the arrived side still does", () => {
    // Open, not joinable: the pre-minted room - a meeting row, a player participant on file, no counted check-in.
    expect(meetingKeysOf(board({ sides: { home: openNotJoinable(), away: openNotJoinable() } }), EDITOR)).toEqual([]);
    expect(meetingKeysOf(board({ sides: { home: joinable(), away: openNotJoinable() } }), EDITOR)).toEqual(["fx-a:home"]);
    expect(meetingKeysOf(board({ sides: { home: openNotJoinable(), away: joinable() } }), EDITOR)).toEqual(["fx-a:away"]);
    // An ended room and a side with no room are not watchable either, however the flag reads.
    expect(meetingKeysOf(board({ sides: { home: { ...joinable(), state: "ended" }, away: meeting({ joinable: true }) } }), EDITOR)).toEqual([]);
  });

  it("camerasOffered and defaultCameraMode: cameras for a watching reader on a required, not-let-go board; the default is cameras while there is something to watch", () => {
    expect(camerasOffered(board(), EDITOR)).toBe(true);
    expect(camerasOffered(board(), VIEWER)).toBe(false);
    expect(camerasOffered(board(), NOT_OFFERED)).toBe(false);
    expect(camerasOffered(board({ cameraPolicy: "optional" }), EDITOR)).toBe(false);
    expect(camerasOffered(board({ videoOverridden: true }), EDITOR)).toBe(false);
    expect(defaultCameraMode(board(), EDITOR)).toBe("cameras");
    expect(defaultCameraMode(board(), VIEWER)).toBe("board");
    expect(defaultCameraMode(board({ cameraPolicy: "optional" }), EDITOR)).toBe("board");
    // Offered but over: nothing to watch, so the board opens first (its tiles say "closed with the game" when asked for).
    const over = done("1-0", { cameraPolicy: "required" });
    expect(camerasOffered(over, EDITOR)).toBe(true);
    expect(defaultCameraMode(over, EDITOR)).toBe("board");
    // A held board still has something to watch.
    expect(defaultCameraMode(held(0, { cameraPolicy: "required" }), EDITOR)).toBe("cameras");
  });
});

// ---- the hook, over the real chain ------------------------------------------------------------------------------------------------------

/** The world the joins talk to: a join route that answers by a script, and an SDK whose joins and leaves are logged. */
function world() {
  const log: string[] = [];
  /** POSTs by meeting key, in order. */
  const posts = new Map<string, number>();
  /** Connects not yet left, by meeting key: more than 1 is a double join. */
  const open = new Map<string, number>();
  let maxOpen = 0;
  /** What the route answers for the nth POST of a meeting (1-based); anything else is a token. */
  let script: (key: string, n: number) => Error | null = () => null;
  const faults: Record<string, () => void> = {};
  /** Meetings whose NEXT connect fails (a kept token the vendor no longer honours): the serial evicts it and POSTs again. */
  const failNextConnect = new Set<string>();
  /** POSTs (`key#n`) that do not answer until their gate opens: "in flight" is a state here. */
  const gates = new Map<string, Promise<void>>();
  const openers = new Map<string, () => void>();
  const serial = makeArbiterSerial({
    join: async (fixtureId, side) => {
      const key = `${fixtureId}:${side}`;
      const n = (posts.get(key) ?? 0) + 1;
      posts.set(key, n);
      log.push(`POST ${key}`);
      await gates.get(`${key}#${n}`);
      const refusal = script(key, n);
      if (refusal !== null) throw refusal;
      return { authToken: `tok|${key}|${n}`, participantId: `p-${key}-${n}`, side, players: ["pl"], reused: false } satisfies ArbiterJoinAnswer;
    },
    connect: async ({ authToken }) => {
      const key = authToken.split("|")[1]!;
      if (failNextConnect.delete(key)) throw new Error("token no longer honoured");
      const now = (open.get(key) ?? 0) + 1;
      open.set(key, now);
      maxOpen = Math.max(maxOpen, now);
      log.push(`connect ${key}`);
      let onFault: (() => void) | null = null;
      const cameras: ArbiterCameras = {
        tile: () => ({ present: true, live: true, track: null }),
        onChange: () => () => undefined,
        onFault: (cb) => {
          onFault = cb;
          faults[key] = () => onFault?.();
          return () => undefined;
        },
        leave: async () => {
          open.set(key, (open.get(key) ?? 1) - 1);
          log.push(`leave ${key}`);
        },
      };
      return cameras;
    },
    // No step ever times out here: the clock under test is the ladder's, not the chain's bound.
    after: () => new Promise<void>(() => undefined),
  });
  return {
    serial,
    log,
    posts: () => [...posts.values()].reduce((a, b) => a + b, 0),
    postsOf: (key: string) => posts.get(key) ?? 0,
    live: (key: string) => open.get(key) ?? 0,
    maxOpen: () => maxOpen,
    fault: (key: string) => faults[key]!(),
    failNextConnect: (key: string) => void failNextConnect.add(key),
    /** The nth POST of a meeting waits until `release` is called for it. */
    hold: (key: string, n: number) => {
      gates.set(
        `${key}#${n}`,
        new Promise<void>((res) => {
          openers.set(`${key}#${n}`, res);
        }),
      );
    },
    release: (key: string, n: number) => openers.get(`${key}#${n}`)!(),
    script: (f: (key: string, n: number) => Error | null) => {
      script = f;
    },
  };
}

const refused = (code: string, status = 409) => new ApiV1Error(code, status, code);
const BUSY = () => refused("VIDEO_BUSY", 503);
const NOT_STARTED = () => refused("VIDEO_MEETING_NOT_STARTED");
const A_HOME = "fx-a:home" as MeetingKey;
const A_AWAY = "fx-a:away" as MeetingKey;
const B_HOME = "fx-b:home" as MeetingKey;
const B_AWAY = "fx-b:away" as MeetingKey;

type Props = { keys: readonly MeetingKey[]; pollKey: number | null };
function mount(w: ReturnType<typeof world>, initial: Props, retryMs: readonly number[] = ARBITER_RETRY_MS) {
  let seen: ReturnType<typeof useArbiterJoins> | null = null;
  const sink = (v: ReturnType<typeof useArbiterJoins>) => {
    seen = v;
  };
  function Probe(p: Props) {
    sink(useArbiterJoins(p.keys, p.pollKey, { serial: w.serial, retryMs }));
    return null;
  }
  const island = renderIsland(Probe, initial);
  return {
    island,
    now: () => seen!,
    kind: (key: MeetingKey) => seen!.views.get(key)?.kind ?? null,
    kinds: () => [...seen!.views.entries()].map(([k, v]) => `${k}=${v.kind}`),
  };
}
/** Let every settled promise run (the chain's steps are promises) and advance the fake clock. */
const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useArbiterJoins: one live join per key", () => {
  it("EMPTY CASE FIRST: no keys opens nothing and POSTs nothing, across renders and polls", async () => {
    const w = world();
    const m = mount(w, { keys: [], pollKey: null });
    await tick();
    m.island.rerender({ keys: [], pollKey: 1 });
    m.island.rerender({ keys: [], pollKey: 2 });
    await tick(60_000);
    expect(w.log).toEqual([]);
    expect(m.now().views.size).toBe(0);
  });

  it("two keys: one POST and one SDK join each, and both read `watching`", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME, A_AWAY], pollKey: 1 });
    await tick();
    expect(w.postsOf(A_HOME)).toBe(1);
    expect(w.postsOf(A_AWAY)).toBe(1);
    expect(w.live(A_HOME)).toBe(1);
    expect(w.live(A_AWAY)).toBe(1);
    expect(m.kind(A_HOME)).toBe("watching");
    expect(m.kind(A_AWAY)).toBe("watching");
    expect(m.now().views.size, "exactly the two keys").toBe(2);
  });

  it("keys unchanged across renders - a new array each time, as a poll's new board object gives - join nothing again", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME, A_AWAY], pollKey: null });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      m.island.rerender({ keys: [A_HOME, A_AWAY], pollKey: null });
      await tick();
    }
    expect(w.posts(), "the open count stays two").toBe(2);
    expect(w.log.filter((l) => l.startsWith("connect"))).toHaveLength(2);
    expect(w.log.filter((l) => l.startsWith("leave"))).toHaveLength(0);
  });

  it("a poll that changes nothing (a new pollKey, the same joined keys) re-joins nothing", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME, A_AWAY], pollKey: 1 });
    await tick();
    for (const pollKey of [2, 3, 4]) {
      m.island.rerender({ keys: [A_HOME, A_AWAY], pollKey });
      await tick();
    }
    expect(w.posts()).toBe(2);
    expect(w.log.filter((l) => l.startsWith("connect"))).toHaveLength(2);
  });

  it("a key removed closes (the SDK leave only), a key added opens: the other key is untouched", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME, A_AWAY], pollKey: null });
    await tick();
    m.island.rerender({ keys: [A_HOME], pollKey: null });
    await tick();
    expect(w.live(A_AWAY), "the removed side left").toBe(0);
    expect(w.live(A_HOME), "the kept side stayed joined").toBe(1);
    expect(m.kinds()).toEqual(["fx-a:home=watching"]);
    expect(w.postsOf(A_HOME)).toBe(1);
    m.island.rerender({ keys: [A_HOME, A_AWAY], pollKey: null });
    await tick();
    expect(w.live(A_AWAY)).toBe(1);
    expect(w.postsOf(A_AWAY), "a key coming back reuses the token its first join proved: no second POST").toBe(1);
  });

  it("SEQUENCE: board A, then B, then A again - never two live joins on one meeting, each side left once, and the return costs no POST", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME, A_AWAY], pollKey: 1 });
    await tick();
    m.island.rerender({ keys: [B_HOME, B_AWAY], pollKey: 1 });
    await tick();
    expect(w.live(A_HOME) + w.live(A_AWAY), "leaving A left both its meetings").toBe(0);
    expect(w.live(B_HOME) + w.live(B_AWAY)).toBe(2);
    m.island.rerender({ keys: [A_HOME, A_AWAY], pollKey: 1 });
    await tick();
    expect(w.live(B_HOME) + w.live(B_AWAY), "leaving B left both").toBe(0);
    expect(w.live(A_HOME) + w.live(A_AWAY)).toBe(2);
    expect(w.maxOpen(), "no meeting was ever joined twice at once").toBe(1);
    expect(w.posts(), "A: 2 POSTs, B: 2 POSTs, A again: none (the kept tokens)").toBe(4);
    expect(w.log.filter((l) => l.startsWith("connect"))).toHaveLength(6);
    expect(w.log.filter((l) => l.startsWith("leave"))).toHaveLength(4);
  });

  it("unmounting leaves every join (the SDK leave, no more POSTs)", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME, A_AWAY], pollKey: 1 });
    await tick();
    m.island.unmount();
    await tick();
    expect(w.live(A_HOME) + w.live(A_AWAY)).toBe(0);
    expect(w.posts()).toBe(2);
  });

  it("a key removed while its join is still out never connects (nothing to leave, nothing to show)", async () => {
    const w = world();
    // The first POST waits on a gate; the key is removed meanwhile.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const slow = makeArbiterSerial({
      join: async (fixtureId, side) => {
        await gate;
        return { authToken: `tok|${fixtureId}:${side}|1`, participantId: "p", side, players: [], reused: false };
      },
      connect: async () => {
        w.log.push("connect");
        return { tile: () => ({ present: true, live: true, track: null }), onChange: () => () => undefined, onFault: () => () => undefined, leave: async () => undefined } as ArbiterCameras;
      },
      after: () => new Promise<void>(() => undefined),
    });
    let seen: ReturnType<typeof useArbiterJoins> | null = null;
    const sink = (v: ReturnType<typeof useArbiterJoins>) => {
      seen = v;
    };
    function Probe(p: Props) {
      sink(useArbiterJoins(p.keys, p.pollKey, { serial: slow }));
      return null;
    }
    const island = renderIsland(Probe, { keys: [A_HOME], pollKey: null } as Props);
    await tick();
    island.rerender({ keys: [], pollKey: null });
    release();
    await tick();
    expect(w.log, "no SDK join for a key that left first").toEqual([]);
    expect(seen!.views.size).toBe(0);
  });
});

describe("useArbiterJoins: a refusal that the poll mends (VIDEO_MEETING_NOT_STARTED)", () => {
  it("SEQUENCE (plan 3's review row 1): refused NOT_STARTED -> the next poll says the side is joinable -> joined with no press; the join route is asked exactly twice", async () => {
    const w = world();
    w.script((key, n) => (n === 1 ? NOT_STARTED() : null));
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    expect(m.kind(A_HOME), "refused: the tile says the player has not arrived").toBe("notStarted");
    expect(w.postsOf(A_HOME)).toBe(1);
    // The same poll again (a re-render with the same pollKey): nothing is asked.
    m.island.rerender({ keys: [A_HOME], pollKey: 1 });
    await tick(60_000);
    expect(w.postsOf(A_HOME), "no timer and no re-render opens it: the poll is the cadence").toBe(1);
    // The next poll.
    m.island.rerender({ keys: [A_HOME], pollKey: 2 });
    await tick();
    expect(m.kind(A_HOME)).toBe("watching");
    expect(w.postsOf(A_HOME), "exactly twice").toBe(2);
    expect(w.live(A_HOME)).toBe(1);
  });

  it("a key that stays refused is asked once per poll - and not at all while the pollKey is unchanged", async () => {
    const w = world();
    w.script(() => NOT_STARTED());
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    expect(w.postsOf(A_HOME)).toBe(1);
    let polls = 0;
    for (const pollKey of [2, 3, 4, 5]) {
      m.island.rerender({ keys: [A_HOME], pollKey });
      await tick();
      polls += 1;
      expect(w.postsOf(A_HOME), `after poll ${pollKey}`).toBe(1 + polls);
      m.island.rerender({ keys: [A_HOME], pollKey });
      await tick(30_000);
      expect(w.postsOf(A_HOME), `poll ${pollKey} again: unchanged`).toBe(1 + polls);
    }
    expect(polls, "four polls were driven").toBe(4);
    expect(m.kind(A_HOME)).toBe("notStarted");
  });

  it("a poll that lands while the re-open it asked for is still out asks for nothing more (one attempt per poll, however fast the polls)", async () => {
    const w = world();
    w.script((key, n) => (n === 1 ? NOT_STARTED() : null));
    w.hold(A_HOME, 2);
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    m.island.rerender({ keys: [A_HOME], pollKey: 2 });
    await tick();
    expect(w.postsOf(A_HOME), "the poll's re-open is out and unanswered").toBe(2);
    m.island.rerender({ keys: [A_HOME], pollKey: 3 });
    m.island.rerender({ keys: [A_HOME], pollKey: 4 });
    await tick();
    expect(w.postsOf(A_HOME), "two more polls while it is out: no more POSTs").toBe(2);
    w.release(A_HOME, 2);
    await tick();
    expect(m.kind(A_HOME)).toBe("watching");
    expect(w.live(A_HOME)).toBe(1);
    expect(w.maxOpen(), "never two live joins on the meeting").toBe(1);
  });

  it("a side that becomes joinable on a poll simply appears in `keys` and opens (it was never POSTed before)", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    expect(w.postsOf(A_AWAY)).toBe(0);
    m.island.rerender({ keys: [A_HOME, A_AWAY], pollKey: 2 });
    await tick();
    expect(w.postsOf(A_AWAY)).toBe(1);
    expect(m.kind(A_AWAY)).toBe("watching");
    expect(w.postsOf(A_HOME), "the side already joined was not asked again").toBe(1);
  });
});

describe("useArbiterJoins: VIDEO_BUSY is waiting for capacity, not an error", () => {
  it("reads `busy`, retries on ARBITER_RETRY_MS[0] on the fake clock, then joins", async () => {
    const w = world();
    w.script((key, n) => (n === 1 ? BUSY() : null));
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    expect(m.kind(A_HOME)).toBe("busy");
    expect(w.postsOf(A_HOME)).toBe(1);
    await tick(ARBITER_RETRY_MS[0] - 1);
    expect(w.postsOf(A_HOME), "not before the ladder's first step").toBe(1);
    await tick(1);
    expect(w.postsOf(A_HOME)).toBe(2);
    expect(m.kind(A_HOME)).toBe("watching");
  });

  it("walks the whole ladder, then HOLDS `busy` with no more POSTs until the next poll (declared steps: the ladder's own length)", async () => {
    const w = world();
    w.script(() => BUSY());
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    let at = 0;
    let steps = 0;
    for (const wait of ARBITER_RETRY_MS) {
      await tick(wait - 1);
      expect(w.postsOf(A_HOME), `before step ${steps + 1} (${wait} ms)`).toBe(1 + steps);
      await tick(1);
      steps += 1;
      at += wait;
      expect(w.postsOf(A_HOME), `at step ${steps}`).toBe(1 + steps);
    }
    expect(steps, "the whole ladder was walked").toBe(ARBITER_RETRY_MS.length);
    const afterLadder = w.postsOf(A_HOME);
    expect(afterLadder).toBe(1 + ARBITER_RETRY_MS.length);
    expect(at).toBe(ARBITER_RETRY_MS.reduce((a, b) => a + b, 0));
    expect(m.kind(A_HOME), "held busy").toBe("busy");
    await tick(10 * 60_000);
    expect(w.postsOf(A_HOME), "ten minutes of silence: no POST until the next poll").toBe(afterLadder);
  });

  it("the next poll re-opens a held `busy` key ONCE, and the ladder does not restart (one attempt per poll)", async () => {
    const w = world();
    w.script(() => BUSY());
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick(ARBITER_RETRY_MS.reduce((a, b) => a + b, 0) + 1);
    const held = w.postsOf(A_HOME);
    expect(held).toBe(1 + ARBITER_RETRY_MS.length);
    m.island.rerender({ keys: [A_HOME], pollKey: 2 });
    await tick(60_000);
    expect(w.postsOf(A_HOME), "one more POST for the poll, and no ladder after it").toBe(held + 1);
    m.island.rerender({ keys: [A_HOME], pollKey: 3 });
    await tick(60_000);
    expect(w.postsOf(A_HOME)).toBe(held + 2);
    expect(m.kind(A_HOME)).toBe("busy");
  });

  it("a poll that arrives while a retry is waiting does not add a second POST (the ladder's timer owns the key)", async () => {
    const w = world();
    w.script(() => BUSY());
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    expect(w.postsOf(A_HOME)).toBe(1);
    m.island.rerender({ keys: [A_HOME], pollKey: 2 });
    await tick(ARBITER_RETRY_MS[0] - 1);
    expect(w.postsOf(A_HOME), "the poll did not jump the queue").toBe(1);
    await tick(1);
    expect(w.postsOf(A_HOME)).toBe(2);
  });

  it("a minute of a busy vendor costs 5 + 3 POSTs a side (the ladder and one per poll at the live cadence), inside the route's 12", async () => {
    const w = world();
    w.script(() => BUSY());
    const m = mount(w, { keys: [A_HOME], pollKey: 0 });
    let polls = 0;
    // One poll every LIVE_POLL_MS for a minute.
    for (let elapsed = 0; elapsed < 60_000; elapsed += LIVE_POLL_MS) {
      await tick(LIVE_POLL_MS);
      polls += 1;
      m.island.rerender({ keys: [A_HOME], pollKey: polls });
    }
    await tick();
    expect(polls, "the minute held this many polls").toBe(Math.ceil(60_000 / LIVE_POLL_MS));
    // First POST + the 5 ladder steps (all inside the first poll interval) + one per poll after the ladder was spent.
    const expected = 1 + ARBITER_RETRY_MS.length + polls;
    expect(w.postsOf(A_HOME)).toBeLessThanOrEqual(expected);
    expect(w.postsOf(A_HOME), "inside ARBITER_JOIN_LIMIT's per-minute ceiling").toBeLessThanOrEqual(ARBITER_JOIN_LIMIT.max);
  });

  it("\"Try again\" after a busy spell starts the ladder over: the first rung again, not the one the earlier spell had reached", async () => {
    const w = world();
    // POSTs 1 and 2 are busy (two rungs used), 3 joins, 4 is busy again.
    w.script((key, n) => (n === 1 || n === 2 || n === 4 ? BUSY() : null));
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick(ARBITER_RETRY_MS[0] + ARBITER_RETRY_MS[1]);
    expect(m.kind(A_HOME)).toBe("watching");
    expect(w.postsOf(A_HOME)).toBe(3);
    // The guard drops the meeting; the kept token is no longer honoured, so the press re-POSTs - and the vendor is busy again.
    w.fault(A_HOME);
    await tick();
    expect(m.kind(A_HOME)).toBe("fault");
    w.failNextConnect(A_HOME);
    m.now().retry(A_HOME);
    await tick();
    expect(m.kind(A_HOME)).toBe("busy");
    expect(w.postsOf(A_HOME)).toBe(4);
    await tick(ARBITER_RETRY_MS[0] - 1);
    expect(w.postsOf(A_HOME), "the first rung has not elapsed").toBe(4);
    await tick(1);
    expect(w.postsOf(A_HOME), "the first rung again (the third would have waited longer)").toBe(5);
    expect(m.kind(A_HOME)).toBe("watching");
  });

  it("a key removed while it waits on its retry is never POSTed again", async () => {
    const w = world();
    w.script(() => BUSY());
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    m.island.rerender({ keys: [], pollKey: 1 });
    await tick(10 * 60_000);
    expect(w.postsOf(A_HOME)).toBe(1);
    expect(m.now().views.size).toBe(0);
  });
});

describe("useArbiterJoins: a failure the pane retries by hand", () => {
  it("an `error` is not asked again by a poll (a stuck SDK costs one POST per press, never one per poll); `retry` asks once", async () => {
    const w = world();
    w.script((key, n) => (n === 1 ? new Error("network") : null));
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    expect(m.kind(A_HOME)).toBe("error");
    for (const pollKey of [2, 3, 4]) {
      m.island.rerender({ keys: [A_HOME], pollKey });
      await tick(30_000);
    }
    expect(w.postsOf(A_HOME), "three polls, no POST").toBe(1);
    m.now().retry(A_HOME);
    await tick();
    expect(w.postsOf(A_HOME)).toBe(2);
    expect(m.kind(A_HOME)).toBe("watching");
  });

  it("the guard leaving the meeting reads `fault`, stays until a retry, and a poll does not undo it", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    await tick();
    w.fault(A_HOME);
    await tick();
    expect(m.kind(A_HOME)).toBe("fault");
    m.island.rerender({ keys: [A_HOME], pollKey: 2 });
    await tick(30_000);
    expect(m.kind(A_HOME)).toBe("fault");
    expect(w.postsOf(A_HOME)).toBe(1);
  });

  it("retry for a key that is not live, or that is mid-open, does nothing", async () => {
    const w = world();
    const m = mount(w, { keys: [A_HOME], pollKey: 1 });
    m.now().retry(B_HOME);
    m.now().retry(A_HOME);
    await tick();
    expect(w.posts(), "one join, never doubled by a press on a key that was opening").toBe(1);
  });

  it("each refusal reads as ITS state, not a generic error (the answer the tile's word is built from)", async () => {
    const cases: [string, Error, string][] = [
      ["unavailable", refused("VIDEO_UNAVAILABLE", 503), "unavailable"],
      ["not in use", refused("VIDEO_NOT_IN_USE"), "none"],
      ["overridden", refused("VIDEO_OVERRIDDEN"), "overridden"],
      ["ended", refused("VIDEO_MEETING_ENDED"), "ended"],
      ["own board", refused("ARBITER_PLAYS_THIS_BOARD", 403), "own"],
      ["over", refused("FIXTURE_NOT_PLAYABLE"), "over"],
      ["rate limit", refused("RATE_LIMITED", 429), "error"],
    ];
    let checked = 0;
    for (const [label, err, kind] of cases) {
      const w = world();
      w.script(() => err);
      const m = mount(w, { keys: [A_HOME], pollKey: 1 });
      await tick();
      expect(m.kind(A_HOME), label).toBe(kind);
      checked += 1;
    }
    expect(checked).toBe(7);
  });
});

describe("createJoinEngine: a camera that changes nothing publishes nothing", () => {
  it("a track event that leaves the tile as it was is not a new view (no re-render per SDK notification); a real change is", async () => {
    let notify: () => void = () => undefined;
    let tile: ReturnType<ArbiterCameras["tile"]> = { present: true, live: true, track: null };
    const serial = makeArbiterSerial({
      join: async (fixtureId, side) => ({ authToken: "t", participantId: "p", side, players: [], reused: false, ...{ fixtureId } }) as ArbiterJoinAnswer,
      connect: async () =>
        ({
          tile: () => tile,
          onChange: (cb: () => void) => {
            notify = cb;
            return () => undefined;
          },
          onFault: () => () => undefined,
          leave: async () => undefined,
        }) as unknown as ArbiterCameras,
      after: () => new Promise<void>(() => undefined),
    });
    const published: number[] = [];
    const engine = createJoinEngine({ serial, retryMs: ARBITER_RETRY_MS, publish: (v) => void published.push(v.size) });
    engine.reconcile([A_HOME]);
    await tick();
    const afterJoin = published.length;
    expect(afterJoin, "the join published").toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) notify();
    expect(published.length, "five notifications, the same tile: nothing published").toBe(afterJoin);
    tile = { present: true, live: false, track: null };
    notify();
    expect(published.length, "the camera went off: published").toBe(afterJoin + 1);
    // The same face on a NEW track (the player's camera restarted): the video element needs the new stream, so it is a new view.
    tile = { ...tile, track: {} as MediaStreamTrack };
    notify();
    expect(published.length, "a new track under the same face: published").toBe(afterJoin + 2);
    engine.closeAll();
  });
});

describe("the shared chain", () => {
  it("meetingKey is the spelling the serial chains on (fixture:side)", () => {
    const sides: ArbiterSide[] = ["home", "away"];
    expect(sides.map((s) => meetingKey("fx-a", s))).toEqual(["fx-a:home", "fx-a:away"]);
  });
});
