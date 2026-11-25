// Realtime push nudges, Task 13: the division door's browser side
// (`lib/division-realtime-auth.ts`).
//
// The door (`GET /api/v1/public/competitions/{id}/realtime-token`, Task 12)
// answers `{token, divisionIds, expiresAt, url, apikey}` with a 60-minute TTL.
// This module fetches it, hands the token to the DIVISION family's client with
// `setAuth`, re-fetches at 50 minutes (spec §4.1: "The client re-fetches at
// about 50 min, or on CHANNEL_ERROR/CLOSED, with backoff"), and answers null
// for every refusal — 403 and 429 above all (spec §4.1 "403 and 429 both mean
// poll") — so the page polls with no error UI.
//
// The token is a credential: it stays inside this module and the client. The
// tests assert that a session object never exposes it.
//
// `fetch` is stubbed with the door's real envelope; the division client is a
// recorder. Timers are fake throughout.
//
// Applies to another sport: N/A (no sport rules).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rt = vi.hoisted(() => {
  const families: string[] = [];
  const setAuth: string[] = [];
  /** Runs inside `realtimeClient(...)`: between the door's answer and `setAuth`. */
  const hook = { onClient: null as null | (() => void) };
  const client = {
    realtime: {
      setAuth: async (token: string) => {
        setAuth.push(token);
      },
    },
    channel: () => ({}),
  };
  return { families, setAuth, client, hook };
});
vi.mock("@/lib/supabase-browser", () => ({
  realtimeClient: (family: string) => {
    rt.families.push(family);
    const run = rt.hook.onClient;
    rt.hook.onClient = null;
    run?.();
    return rt.client;
  },
}));

import {
  DIVISION_AUTH_BACKOFF_JITTER,
  DIVISION_AUTH_BACKOFF_MS,
  DIVISION_TOKEN_REFRESH_MS,
  _resetDivisionRealtimeAuth,
  _setDivisionAuthRandom,
  acquireDivisionRealtime,
  divisionRealtimeTokenPath,
} from "../division-realtime-auth";

const COMP = "0b6a3d3e-2f5c-4e43-9b1f-0d6a5c3b9e01";
const OTHER_COMP = "0b6a3d3e-2f5c-4e43-9b1f-0d6a5c3b9e02";
const D1 = "7c1f0d2a-6b4e-4a3c-8d2f-1e0a9b8c7d01";
const D2 = "7c1f0d2a-6b4e-4a3c-8d2f-1e0a9b8c7d02";
const D3 = "7c1f0d2a-6b4e-4a3c-8d2f-1e0a9b8c7d03";

type Answer = { status: number; token?: string; divisionIds?: string[] } | "network";

/** The door, scripted per call. Past the script it keeps answering the last entry. */
function door(...answers: Answer[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let n = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const a = answers[Math.min(n, answers.length - 1)]!;
    n += 1;
    if (a === "network") throw new TypeError("Failed to fetch");
    if (a.status !== 200) {
      return new Response(JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "no" } }), { status: a.status });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          token: a.token ?? `tok-${n}`,
          divisionIds: a.divisionIds ?? [D1, D2],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          url: "https://proj.supabase.co",
          apikey: "anon",
        },
        requestId: "r",
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
beforeEach(() => {
  vi.useFakeTimers();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  rt.families.length = 0;
  rt.setAuth.length = 0;
  rt.hook.onClient = null;
  _resetDivisionRealtimeAuth();
  // The backoff's jitter at its middle: every wait is exactly its rung. The jitter has its own tests below.
  _setDivisionAuthRandom(() => 0.5);
});
afterEach(() => {
  _resetDivisionRealtimeAuth();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (ENV === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ENV;
});

describe("acquireDivisionRealtime: the first fetch", () => {
  it("a 200 sets the token on the DIVISION family's client, and the session covers exactly the door's divisions", async () => {
    const d = door({ status: 200, token: "tok-A", divisionIds: [D1, D2] });
    const s = await acquireDivisionRealtime(COMP);

    expect(s).not.toBeNull();
    expect(d.calls.map((c) => c.url)).toEqual([divisionRealtimeTokenPath(COMP)]);
    expect(divisionRealtimeTokenPath(COMP)).toBe(`/api/v1/public/competitions/${COMP}/realtime-token`);
    // Never a cached answer: the door is `private, no-store`, and so is the ask.
    expect(d.calls[0]!.init?.cache).toBe("no-store");
    // The official path is a cookie session (the board, the organiser slideshow).
    expect(d.calls[0]!.init?.credentials).toBe("same-origin");
    expect(rt.families).toEqual(["division"]);
    expect(rt.setAuth).toEqual(["tok-A"]);
    expect(s!.covers(D1)).toBe(true);
    expect(s!.covers(D2)).toBe(true);
    expect(s!.covers(D3)).toBe(false); // positive pair
  });

  it("the session never exposes the token, in any property or its JSON", async () => {
    door({ status: 200, token: "tok-SECRET-xyz" });
    const s = await acquireDivisionRealtime(COMP);
    expect(s).not.toBeNull();
    const own = Object.getOwnPropertyNames(s);
    expect(own.length).toBeGreaterThan(0);
    for (const k of own) {
      const v = (s as unknown as Record<string, unknown>)[k];
      if (typeof v === "string") expect(v).not.toContain("tok-SECRET");
    }
    expect(JSON.stringify(s)).not.toContain("tok-SECRET");
  });

  // A FINAL refusal is "poll", and the door is never asked again: 403 (no_divisions, too_many_divisions, not
  // entitled), 404 (private/unknown), any other 4xx. None of them touches the client.
  const finalRefusals: [string, Answer][] = [
    ["403", { status: 403 }],
    ["404", { status: 404 }],
    ["400", { status: 400 }],
    ["401", { status: 401 }],
  ];
  for (const [name, answer] of finalRefusals) {
    it(`a ${name} answers null, sets no token, and is NEVER retried`, async () => {
      const d = door(answer);
      const s = await acquireDivisionRealtime(COMP);
      expect(s).toBeNull();
      expect(d.calls).toHaveLength(1);
      expect(rt.setAuth).toEqual([]);
      // The whole ladder, and then some: not one more ask.
      await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.reduce((a, b) => a + b, 0) * 2);
      expect(d.calls).toHaveLength(1);
    });
  }

  it("a 200 whose body is not the door's is FINAL too (not retried)", async () => {
    const fn = vi.fn(async () => new Response("<html>captive portal</html>", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    expect(await acquireDivisionRealtime(COMP)).toBeNull();
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0] * 10);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a 200 without a token string, or with an empty division list, answers null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { divisionIds: [D1] } }), { status: 200 })),
    );
    expect(await acquireDivisionRealtime(COMP)).toBeNull();
    _resetDivisionRealtimeAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { token: "t", divisionIds: [] } }), { status: 200 })),
    );
    expect(await acquireDivisionRealtime(COMP)).toBeNull();
    expect(rt.setAuth).toEqual([]);
  });

  it("CI's stub project: the door is still asked, but no client is made and nothing dials", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
    const d = door({ status: 200 });
    expect(await acquireDivisionRealtime(COMP)).toBeNull();
    expect(d.calls).toHaveLength(1);
    expect(rt.families).toEqual([]);
  });
});

// A TEMPORARY refusal (429, any 5xx, the network) is not the door saying no. The acquire stays PENDING (the page
// polls meanwhile) while the door is asked again on the backoff ladder, jittered; a kiosk that met one 503 at
// boot joins as soon as the door is back, instead of polling all day (final-review m2).
describe("acquireDivisionRealtime: a temporary refusal is retried on the backoff ladder", () => {
  /** An acquire whose settlement can be read without awaiting it. */
  function watch(signal?: AbortSignal) {
    const out: { state: "pending" | "settled"; value: Awaited<ReturnType<typeof acquireDivisionRealtime>> | undefined } = {
      state: "pending",
      value: undefined,
    };
    const p = acquireDivisionRealtime(COMP, signal ? { signal } : {}).then((v) => {
      out.state = "settled";
      out.value = v;
      return v;
    });
    return { out, p };
  }

  const temporaries: [string, Answer][] = [
    ["503", { status: 503 }],
    ["500", { status: 500 }],
    ["502", { status: 502 }],
    ["429", { status: 429 }],
    ["network failure", "network"],
  ];
  for (const [name, answer] of temporaries) {
    it(`a ${name}: pending (no token, nothing sets) until the first rung, then the retry joins`, async () => {
      const d = door(answer, { status: 200, token: "tok-late", divisionIds: [D1] });
      const { out } = watch();
      await vi.advanceTimersByTimeAsync(0);
      expect(d.calls).toHaveLength(1);
      expect(out.state, "the acquire answered null on a temporary refusal").toBe("pending");
      expect(rt.setAuth).toEqual([]);

      // One ms short of the first rung (jitter pinned at its middle): not asked yet.
      await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0] - 1);
      expect(d.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(d.calls).toHaveLength(2);
      expect(out.state).toBe("settled");
      expect(out.value).not.toBeNull();
      expect(rt.setAuth).toEqual(["tok-late"]);
      expect(out.value!.covers(D1)).toBe(true);
      // Joined: nothing is asked for again.
      await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[1]);
      expect(d.calls).toHaveLength(2);
    });
  }

  it("a second temporary failure goes UP the ladder: 1 s, then 5 s, then 30 s", async () => {
    const d = door({ status: 503 }, { status: 503 }, { status: 429 }, { status: 200, token: "tok-4", divisionIds: [D1] });
    const { out } = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    expect(d.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[1] - 1);
    expect(d.calls, "the second retry came before its 5 s rung").toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(3);
    expect(out.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[2] - 1);
    expect(d.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(4);
    expect(out.value).not.toBeNull();
    expect(rt.setAuth).toEqual(["tok-4"]);
  });

  it("the last rung repeats: a door down for hours is asked every ~5 minutes, not never", async () => {
    const d = door({ status: 503 });
    watch();
    const last = DIVISION_AUTH_BACKOFF_MS.at(-1)!;
    // Walk the whole ladder, then three more rungs.
    for (const rung of DIVISION_AUTH_BACKOFF_MS) await vi.advanceTimersByTimeAsync(rung);
    expect(d.calls).toHaveLength(1 + DIVISION_AUTH_BACKOFF_MS.length);
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(last);
    expect(d.calls).toHaveLength(1 + DIVISION_AUTH_BACKOFF_MS.length + 3);
  });

  it("each wait is jittered into [rung x 0.5, rung x 1.5): the extremes, and one ms outside", async () => {
    const rung = DIVISION_AUTH_BACKOFF_MS[0];
    const lo = Math.round(rung * (1 - DIVISION_AUTH_BACKOFF_JITTER));
    expect(lo).toBeLessThan(rung);
    // random() = 0: the shortest wait.
    _setDivisionAuthRandom(() => 0);
    let d = door({ status: 503 });
    watch();
    await vi.advanceTimersByTimeAsync(lo - 1);
    expect(d.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(2);
    _resetDivisionRealtimeAuth();
    // random() just under 1: the longest.
    _setDivisionAuthRandom(() => 0.999999);
    d = door({ status: 503 });
    watch();
    const hi = Math.round(rung * (1 + DIVISION_AUTH_BACKOFF_JITTER * 0.999998));
    await vi.advanceTimersByTimeAsync(hi - 2);
    expect(d.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3);
    expect(d.calls).toHaveLength(2);
  });

  it("a temporary refusal and then a FINAL one ends it: null, and nothing more is asked", async () => {
    const d = door({ status: 503 }, { status: 403 });
    const { out } = watch();
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    expect(d.calls).toHaveLength(2);
    expect(out.state).toBe("settled");
    expect(out.value).toBeNull();
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.reduce((a, b) => a + b, 0));
    expect(d.calls).toHaveLength(2);
  });

  it("the ladder starts over once the door has answered: a channel failing after a late join waits the FIRST rung", async () => {
    const d = door({ status: 503 }, { status: 503 }, { status: 200, token: "tok-3", divisionIds: [D1] }, { status: 200, token: "tok-4", divisionIds: [D1] });
    const { out } = watch();
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0] + DIVISION_AUTH_BACKOFF_MS[1]);
    expect(out.value).not.toBeNull();
    expect(d.calls).toHaveLength(3);

    out.value!.channelStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0] - 1);
    expect(d.calls, "the failure re-fetch waited a later rung: the first fetch's attempts were carried over").toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(4);
  });

  it("an aborted wait (the page went) resolves null and stops asking", async () => {
    const d = door({ status: 503 });
    const ac = new AbortController();
    const { out } = watch(ac.signal);
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0] * 3);
    expect(d.calls.length).toBeGreaterThan(1);
    expect(out.state).toBe("pending");

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.state).toBe("settled");
    expect(out.value).toBeNull();
    const asked = d.calls.length;
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.reduce((a, b) => a + b, 0) * 2);
    expect(d.calls, "the door was asked after its only caller had gone").toHaveLength(asked);
  });

  it("an abort that comes BEFORE the call settles it null without leaving a retry running", async () => {
    const d = door({ status: 503 });
    const ac = new AbortController();
    ac.abort();
    const { out } = watch(ac.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(out.value).toBeNull();
    const asked = d.calls.length;
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[2]);
    expect(d.calls).toHaveLength(asked);
  });

  it("one caller going does not strand another waiting on the same door", async () => {
    const d = door({ status: 503 }, { status: 200, token: "tok-2", divisionIds: [D1] });
    const ac = new AbortController();
    watch(ac.signal);
    const second = watch();
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    expect(d.calls).toHaveLength(2);
    expect(second.out.value).not.toBeNull();
  });
});

describe("acquireDivisionRealtime: sharing and the second call", () => {
  it("a second acquire for the same competition shares the token: no second fetch, no second setAuth", async () => {
    const d = door({ status: 200, token: "tok-A" });
    const a = await acquireDivisionRealtime(COMP);
    const b = await acquireDivisionRealtime(COMP);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(d.calls).toHaveLength(1);
    expect(rt.setAuth).toEqual(["tok-A"]);
  });

  it("a release followed by an acquire in the same tick (an effect re-run) does not re-fetch", async () => {
    const d = door({ status: 200 });
    const a = await acquireDivisionRealtime(COMP);
    a!.release();
    const b = await acquireDivisionRealtime(COMP);
    expect(b).not.toBeNull();
    expect(d.calls).toHaveLength(1);
  });

  it("after the last release has settled, the next acquire fetches a fresh token", async () => {
    const d = door({ status: 200, token: "tok-A" }, { status: 200, token: "tok-B" });
    const a = await acquireDivisionRealtime(COMP);
    a!.release();
    await vi.advanceTimersByTimeAsync(0);
    const b = await acquireDivisionRealtime(COMP);
    expect(b).not.toBeNull();
    expect(d.calls).toHaveLength(2);
    expect(rt.setAuth).toEqual(["tok-A", "tok-B"]);
  });

  // One division client, one socket-wide token: two competitions at once
  // would overwrite each other. The second is refused (it polls) rather than
  // silently breaking the first.
  it("a second competition while the first is held answers null and leaves the first's token alone", async () => {
    const d = door({ status: 200, token: "tok-A" });
    const a = await acquireDivisionRealtime(COMP);
    const b = await acquireDivisionRealtime(OTHER_COMP);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(d.calls).toHaveLength(1);
    expect(rt.setAuth).toEqual(["tok-A"]);
  });

  // A page navigated to competition B before A's door answered: A's caller can only release once the answer
  // lands, so A still has a reference. A set nothing yet, so B gets its own fetch rather than null for the
  // life of the page.
  it("a competition still WAITING on its door gives way to the next one: its own fetch, its token; the first answers null", async () => {
    const d = door({ status: 200, token: "tok-A" }, { status: 200, token: "tok-B", divisionIds: [D3] });
    const first = acquireDivisionRealtime(COMP);
    const second = acquireDivisionRealtime(OTHER_COMP);
    const [a, b] = await Promise.all([first, second]);

    expect(d.calls.map((c) => c.url)).toEqual([divisionRealtimeTokenPath(COMP), divisionRealtimeTokenPath(OTHER_COMP)]);
    expect(a).toBeNull();
    expect(b).not.toBeNull();
    expect(b!.covers(D3)).toBe(true);
    expect(rt.setAuth, "the first competition's token reached the socket").toEqual(["tok-B"]);
    // B is now the holder: its refresh runs, and a second ask for B shares it.
    expect(await acquireDivisionRealtime(OTHER_COMP)).not.toBeNull();
    expect(d.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DIVISION_TOKEN_REFRESH_MS);
    expect(d.calls.at(-1)!.url).toBe(divisionRealtimeTokenPath(OTHER_COMP));
  });

  it("superseded between the door's answer and setAuth (the client module still loading), the first never sets its token", async () => {
    door({ status: 200, token: "tok-A" }, { status: 200, token: "tok-B" });
    let second: Promise<unknown> | null = null;
    // A's answer is in; while A builds its client, the page asks for B.
    rt.hook.onClient = () => {
      second = acquireDivisionRealtime(OTHER_COMP);
    };
    const a = await acquireDivisionRealtime(COMP);
    expect(second, "premise: B was asked inside A's window").not.toBeNull();
    const b = await second!;
    expect(a).toBeNull();
    expect(b).not.toBeNull();
    expect(rt.setAuth).toEqual(["tok-B"]);
  });
});

describe("refresh at 50 minutes", () => {
  it("the refresh constant is the spec's 50 minutes, inside the door's 60-minute TTL", () => {
    expect(DIVISION_TOKEN_REFRESH_MS).toBe(50 * 60_000);
    expect(DIVISION_TOKEN_REFRESH_MS).toBeLessThan(3600 * 1000);
  });

  it("re-fetches at 50 minutes, not a millisecond before, sets the new token, and again 50 minutes later", async () => {
    const d = door({ status: 200, token: "tok-1" }, { status: 200, token: "tok-2" }, { status: 200, token: "tok-3" });
    const s = await acquireDivisionRealtime(COMP);
    expect(s).not.toBeNull();

    await vi.advanceTimersByTimeAsync(50 * 60_000 - 1);
    expect(d.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(2);
    expect(rt.setAuth).toEqual(["tok-1", "tok-2"]);

    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(d.calls).toHaveLength(3);
    expect(rt.setAuth).toEqual(["tok-1", "tok-2", "tok-3"]);
  });

  it("a refresh widens what the session covers (a division created after the first mint)", async () => {
    door({ status: 200, divisionIds: [D1] }, { status: 200, divisionIds: [D1, D3] });
    const s = await acquireDivisionRealtime(COMP);
    expect(s!.covers(D3)).toBe(false);
    await vi.advanceTimersByTimeAsync(DIVISION_TOKEN_REFRESH_MS);
    expect(s!.covers(D3)).toBe(true);
  });

  it("onRenewed fires after each fresh token is SET, and not before", async () => {
    door({ status: 200, token: "tok-1" }, { status: 200, token: "tok-2" });
    const s = await acquireDivisionRealtime(COMP);
    const seen: string[][] = [];
    s!.onRenewed(() => seen.push([...rt.setAuth]));
    await vi.advanceTimersByTimeAsync(DIVISION_TOKEN_REFRESH_MS);
    expect(seen).toEqual([["tok-1", "tok-2"]]);
  });

  it("re-acquired in the same commit (an effect re-run), the refresh keeps its ORIGINAL 50-minute deadline", async () => {
    const d = door({ status: 200 });
    const a = await acquireDivisionRealtime(COMP);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    a!.release();
    const b = await acquireDivisionRealtime(COMP);
    expect(b).not.toBeNull();
    expect(d.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(d.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(2);
  });

  it("the last release stops every timer at once (none outlives the page)", async () => {
    door({ status: 200 });
    const s = await acquireDivisionRealtime(COMP);
    s!.channelStatus("CHANNEL_ERROR");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    s!.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after the last release, nothing refreshes any more (a closed page asks for nothing)", async () => {
    const d = door({ status: 200 });
    const s = await acquireDivisionRealtime(COMP);
    s!.release();
    await vi.advanceTimersByTimeAsync(3 * DIVISION_TOKEN_REFRESH_MS);
    expect(d.calls).toHaveLength(1);
  });
});

describe("CHANNEL_ERROR / CLOSED re-fetch with backoff", () => {
  // Cross-tab jitter: N tabs behind one NAT, failing together, must not all hit the door's shared 120/min bucket
  // at +1 s. Each rung waits rung × (1 − J + 2J·random()); both ends are pinned with an injected random source.
  it("the jitter is ±50% of each rung", () => {
    expect(DIVISION_AUTH_BACKOFF_JITTER).toBe(0.5);
  });

  const ends: [string, () => number, (rung: number) => number][] = [
    ["low end (random 0): half the rung", () => 0, (rung) => rung / 2],
    ["high end (random → 1): one and a half rungs", () => 1 - 1e-9, (rung) => rung * 1.5],
  ];
  for (const [name, source, expected] of ends) {
    it(`${name}, on every rung, not a millisecond before`, async () => {
      _setDivisionAuthRandom(source);
      const d = door({ status: 200 });
      const s = await acquireDivisionRealtime(COMP);
      let checked = 0;
      for (const rung of DIVISION_AUTH_BACKOFF_MS) {
        const before = d.calls.length;
        s!.channelStatus("CHANNEL_ERROR");
        await vi.advanceTimersByTimeAsync(expected(rung) - 1);
        expect(d.calls.length, `rung ${rung}: re-fetched early`).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(d.calls.length, `rung ${rung}: no re-fetch at ${expected(rung)} ms`).toBe(before + 1);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every rung").toBe(DIVISION_AUTH_BACKOFF_MS.length);
    });
  }

  it("two tabs failing together re-fetch at different instants (a real spread, not one burst)", async () => {
    const draws = [0.1, 0.9];
    const at: number[] = [];
    for (const r of draws) {
      _resetDivisionRealtimeAuth();
      _setDivisionAuthRandom(() => r);
      const t0 = Date.now();
      const d = door({ status: 200 });
      const s = await acquireDivisionRealtime(COMP);
      s!.channelStatus("CHANNEL_ERROR");
      while (d.calls.length < 2) await vi.advanceTimersByTimeAsync(10);
      at.push(Date.now() - t0);
    }
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(DIVISION_AUTH_BACKOFF_MS[0] * 0.8 - 10);
  });

  it("the backoff ladder grows and is bounded", () => {
    expect(DIVISION_AUTH_BACKOFF_MS.length).toBeGreaterThan(1);
    for (let i = 1; i < DIVISION_AUTH_BACKOFF_MS.length; i += 1) {
      expect(DIVISION_AUTH_BACKOFF_MS[i]!).toBeGreaterThan(DIVISION_AUTH_BACKOFF_MS[i - 1]!);
    }
    // Never faster than the poll it stands beside: the last rung is at least a minute.
    expect(DIVISION_AUTH_BACKOFF_MS.at(-1)!).toBeGreaterThanOrEqual(60_000);
  });

  for (const status of ["CHANNEL_ERROR", "CLOSED"] as const) {
    it(`${status} re-fetches after the first rung, not before, and sets the new token`, async () => {
      const d = door({ status: 200, token: "tok-1" }, { status: 200, token: "tok-2" });
      const s = await acquireDivisionRealtime(COMP);
      s!.channelStatus(status);
      await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0] - 1);
      expect(d.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(d.calls).toHaveLength(2);
      expect(rt.setAuth).toEqual(["tok-1", "tok-2"]);
    });
  }

  it("SUBSCRIBED and TIMED_OUT re-fetch nothing (positive pair)", async () => {
    const d = door({ status: 200 });
    const s = await acquireDivisionRealtime(COMP);
    s!.channelStatus("SUBSCRIBED");
    s!.channelStatus("TIMED_OUT");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.at(-1)!);
    expect(d.calls).toHaveLength(1);
  });

  it("failures in a row climb the ladder; a SUBSCRIBED in between puts it back on the first rung", async () => {
    const d = door({ status: 200 });
    const s = await acquireDivisionRealtime(COMP);
    const at: number[] = [];
    const t0 = Date.now();
    d.fn.mockImplementation(async () => {
      at.push(Date.now() - t0);
      return new Response(
        JSON.stringify({ ok: true, data: { token: "t", divisionIds: [D1], expiresAt: 0, url: "u", apikey: "k" } }),
        { status: 200 },
      );
    });

    // Three failures in a row, each after the previous renewal landed.
    let elapsed = 0;
    for (let i = 0; i < 3; i += 1) {
      s!.channelStatus("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[i]!);
      elapsed += DIVISION_AUTH_BACKOFF_MS[i]!;
      expect(at.at(-1)).toBe(elapsed);
    }
    expect(at).toHaveLength(3);

    // A channel came up: the next failure starts from the first rung again.
    s!.channelStatus("SUBSCRIBED");
    s!.channelStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    expect(at).toHaveLength(4);
    expect(at.at(-1)).toBe(elapsed + DIVISION_AUTH_BACKOFF_MS[0]);
  });

  it("the ladder stops at its last rung (no faster than that, for ever)", async () => {
    const d = door({ status: 200 });
    const s = await acquireDivisionRealtime(COMP);
    for (let i = 0; i < DIVISION_AUTH_BACKOFF_MS.length + 2; i += 1) {
      s!.channelStatus("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[Math.min(i, DIVISION_AUTH_BACKOFF_MS.length - 1)]!);
    }
    const before = d.calls.length;
    s!.channelStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.at(-1)! - 1);
    expect(d.calls).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(before + 1);
  });

  it("many channels failing at once cost ONE re-fetch", async () => {
    const d = door({ status: 200 });
    const s = await acquireDivisionRealtime(COMP);
    for (let i = 0; i < 5; i += 1) s!.channelStatus("CHANNEL_ERROR");
    s!.channelStatus("CLOSED");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    expect(d.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.at(-1)!);
    expect(d.calls).toHaveLength(2);
  });

  it("a renewal the door refuses (429) tries again on the next rung, and keeps the old token meanwhile", async () => {
    const d = door({ status: 200, token: "tok-1" }, { status: 429 }, { status: 200, token: "tok-3" });
    const s = await acquireDivisionRealtime(COMP);
    s!.channelStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    expect(d.calls).toHaveLength(2);
    expect(rt.setAuth).toEqual(["tok-1"]);
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[1] - 1);
    expect(d.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.calls).toHaveLength(3);
    expect(rt.setAuth).toEqual(["tok-1", "tok-3"]);
  });

  it("a status reported after release is ignored", async () => {
    const d = door({ status: 200 });
    const s = await acquireDivisionRealtime(COMP);
    s!.release();
    s!.channelStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.at(-1)!);
    expect(d.calls).toHaveLength(1);
  });
});
