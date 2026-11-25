// Realtime push nudges, Task 13 (spec §4.2-4.3): the noticeboard slideshow
// joins PRIVATE `division:{id}` topics on the division family's client, after
// its competition's door token is set, and its safety-net poll once push is up
// drops from 5 minutes to 60 s (D-a's mitigation for a kiosk left on a silent
// topic).
//
// The door module (`lib/division-realtime-auth.ts`) is REAL, fed through a
// stubbed `fetch`; the division client is a recorder whose channels a test can
// drive (status, broadcast). `router.refresh` is the board's whole refresh.
//
// The SSR half drives the organiser board PAGE (`app/slideshow/divisions/[id]`)
// with its data seams stubbed, and asserts the token is nowhere in the page's
// props or HTML, against a positive pair: the same props mounted with effects
// DO deliver the token — to the client's `setAuth`, and nowhere else.
//
// Applies to another sport: N/A (no sport rules).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const router = vi.hoisted(() => ({ refreshes: 0, push: () => {}, refresh: () => void (router.refreshes += 1) }));
vi.mock("next/navigation", () => ({ useRouter: () => router, notFound: () => {}, permanentRedirect: () => {} }));

const rt = vi.hoisted(() => {
  interface Ch {
    name: string;
    private: boolean;
    handlers: Record<string, (m?: unknown) => void>;
    status: ((s: string) => void) | null;
    unsubscribed: number;
    on: (kind: string, opts: { event: string }, fn: (m?: unknown) => void) => Ch;
    subscribe: (cb: (s: string) => void) => Ch;
    unsubscribe: () => Promise<string>;
  }
  const channels: Ch[] = [];
  const log: string[] = [];
  const families: string[] = [];
  let status = "SUBSCRIBED";
  const client = {
    realtime: {
      setAuth: async (token: string) => {
        log.push(`setAuth ${token}`);
      },
    },
    channel: (name: string, params?: { config?: { private?: boolean } }) => {
      log.push(`channel ${name} private=${params?.config?.private === true}`);
      const ch: Ch = {
        name,
        private: params?.config?.private === true,
        handlers: {},
        status: null,
        unsubscribed: 0,
        on(_k, opts, fn) {
          ch.handlers[opts.event] = fn;
          return ch;
        },
        subscribe(cb) {
          ch.status = cb;
          cb(status);
          return ch;
        },
        async unsubscribe() {
          ch.unsubscribed += 1;
          return "ok";
        },
      };
      channels.push(ch);
      return ch;
    },
  };
  return {
    channels,
    log,
    families,
    client,
    reset: (s = "SUBSCRIBED") => {
      channels.length = 0;
      log.length = 0;
      families.length = 0;
      status = s;
    },
    setStatus: (s: string) => {
      status = s;
    },
  };
});
vi.mock("@/lib/supabase-browser", () => ({
  realtimeClient: (family: string) => {
    rt.families.push(family);
    return rt.client;
  },
}));

// The organiser division board page's data seams (the SSR half).
const seams = vi.hoisted(() => ({
  requireResourcePageAuth: vi.fn(),
  getDivision: vi.fn(),
  getCompetition: vi.fn(),
  buildDivisionSlides: vi.fn(),
  orgBoardChrome: vi.fn(),
  resolveSponsors: vi.fn(),
  hasFeature: vi.fn(),
}));
vi.mock("@/server/page-auth", () => ({ requireResourcePageAuth: seams.requireResourcePageAuth }));
vi.mock("@/server/usecases/divisions", () => ({ getDivision: seams.getDivision, listDivisions: vi.fn() }));
vi.mock("@/server/usecases/competitions", () => ({ getCompetition: seams.getCompetition }));
vi.mock("@/server/slideshow-data", () => ({
  buildDivisionSlides: seams.buildDivisionSlides,
  orgBoardChrome: seams.orgBoardChrome,
}));
vi.mock("@/server/usecases/sponsors", () => ({ resolveSponsors: seams.resolveSponsors }));
vi.mock("@/lib/entitlements", () => ({ hasFeature: seams.hasFeature }));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import {
  SLIDESHOW_POLL_MS,
  SLIDESHOW_SUBSCRIBED_POLL_MS,
  Slideshow,
} from "@/components/v2/slideshow";
import { slideshowLabels } from "@/server/slideshow-labels";
import {
  DIVISION_AUTH_BACKOFF_MS,
  DIVISION_TOKEN_REFRESH_MS,
  _resetDivisionRealtimeAuth,
  _setDivisionAuthRandom,
  acquireDivisionRealtime,
} from "@/lib/division-realtime-auth";
import DivisionSlideshowPage from "@/app/slideshow/divisions/[id]/page";

const COMP = "c-0001";
const D1 = "d-0001";
const D2 = "d-0002";

const door = { calls: [] as string[], answers: [] as { status: number; token?: string; divisionIds?: string[] }[], served: 0 };
function doorAnswers(...answers: typeof door.answers) {
  door.calls = [];
  door.served = 0;
  door.answers = answers;
}
async function fetchDoor(input: unknown) {
  door.calls.push(String(input));
  const a = door.answers[Math.min(door.served, door.answers.length - 1)]!;
  door.served += 1;
  if (a.status !== 200) return new Response(JSON.stringify({ ok: false }), { status: a.status });
  return new Response(
    JSON.stringify({ ok: true, data: { token: a.token, divisionIds: a.divisionIds, expiresAt: 0, url: "u", apikey: "k" } }),
    { status: 200 },
  );
}

function board(overrides: Partial<Parameters<typeof Slideshow>[0]> = {}): Parameters<typeof Slideshow>[0] {
  return {
    title: "Board",
    slides: [],
    backHref: "/b",
    liveHref: "/l",
    labels: slideshowLabels("en"),
    competitionId: COMP,
    divisionIds: [D1, D2],
    realtime: true,
    ...overrides,
  };
}

const ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("fetch", fetchDoor);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  _resetDivisionRealtimeAuth();
  // The backoff's jitter at its middle: every wait is exactly its rung.
  _setDivisionAuthRandom(() => 0.5);
  rt.reset();
  router.refreshes = 0;
  doorAnswers({ status: 200, token: "door-token-1", divisionIds: [D1, D2] });
});
afterEach(() => {
  _resetDivisionRealtimeAuth();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (ENV === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ENV;
});

describe("<Slideshow> realtime: the division door and private topics", () => {
  it("the poll cadences are the spec's: 45 s without push, 60 s with it (was 5 minutes)", () => {
    expect(SLIDESHOW_POLL_MS).toBe(45_000);
    expect(SLIDESHOW_SUBSCRIBED_POLL_MS).toBe(60_000);
  });

  it("a 200: the competition's door, setAuth first, one PRIVATE channel per division on the division client", async () => {
    renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);

    expect(door.calls).toEqual([`/api/v1/public/competitions/${COMP}/realtime-token`]);
    expect(rt.log[0]).toBe("setAuth door-token-1");
    expect(rt.log.slice(1).sort()).toEqual([
      `channel division:${D1} private=true`,
      `channel division:${D2} private=true`,
    ]);
    expect(new Set(rt.families)).toEqual(new Set(["division"]));
  });

  it("with push up the safety-net poll is 60 s: nothing at 45 s, one refresh at 60 s", async () => {
    renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SLIDESHOW_POLL_MS);
    expect(router.refreshes, "the 45 s poll ran on top of push").toBe(0);
    await vi.advanceTimersByTimeAsync(SLIDESHOW_SUBSCRIBED_POLL_MS - SLIDESHOW_POLL_MS);
    expect(router.refreshes).toBe(1);
  });

  for (const status of [403, 404]) {
    it(`a ${status}: no setAuth, no channel, and the board refreshes on its 45 s poll`, async () => {
      doorAnswers({ status });
      renderIsland(Slideshow, board());
      await vi.advanceTimersByTimeAsync(0);
      expect(door.calls).toHaveLength(1);
      expect(rt.log).toEqual([]);
      expect(rt.channels).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(SLIDESHOW_POLL_MS);
      expect(router.refreshes).toBe(1);
    });
  }

  it("a 503 at boot: the board polls at 45 s, the door is asked again at the first rung, and the topics join", async () => {
    doorAnswers({ status: 503 }, { status: 200, token: "door-token-late", divisionIds: [D1, D2] });
    renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toHaveLength(1);
    expect(rt.channels).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0] - 1);
    expect(door.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(door.calls).toHaveLength(2);
    expect(rt.log[0]).toBe("setAuth door-token-late");
    expect(rt.channels).toHaveLength(2);
  });

  it("unmounted while the door is down: the retries stop", async () => {
    doorAnswers({ status: 503 });
    const island = renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    const asked = door.calls.length;
    expect(asked).toBeGreaterThan(1);
    island.unmount();
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.reduce((a, b) => a + b, 0) * 2);
    expect(door.calls).toHaveLength(asked);
  });

  it("realtime={false} asks the door nothing and polls at 45 s (positive pair)", async () => {
    renderIsland(Slideshow, board({ realtime: false }));
    await vi.advanceTimersByTimeAsync(SLIDESHOW_POLL_MS);
    expect(door.calls).toEqual([]);
    expect(router.refreshes).toBe(1);
  });

  it("both broadcast events refresh the board, debounced into one refresh", async () => {
    renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    const ch = rt.channels[0]!;
    expect(Object.keys(ch.handlers).sort()).toEqual(["schedule_changed", "state_changed"]);
    ch.handlers.state_changed!();
    ch.handlers.schedule_changed!();
    await vi.advanceTimersByTimeAsync(999);
    expect(router.refreshes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(router.refreshes).toBe(1);
  });

  it("a division the token does not cover gets no channel (the poll covers it)", async () => {
    doorAnswers({ status: 200, token: "t", divisionIds: [D1] });
    renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels.map((c) => c.name)).toEqual([`division:${D1}`]);
  });

  it("a refresh that hands down the same divisions (a new array) neither rejoins nor re-asks the door", async () => {
    const island = renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    island.rerender(board({ divisionIds: [D1, D2] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(2);
    expect(rt.channels.every((c) => c.unsubscribed === 0)).toBe(true);
    expect(door.calls).toHaveLength(1);
  });

  it("a CHANGED division set rejoins on the token already held: no second door call", async () => {
    const island = renderIsland(Slideshow, board({ divisionIds: [D1] }));
    await vi.advanceTimersByTimeAsync(0);
    island.rerender(board({ divisionIds: [D1, D2] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toHaveLength(1);
    expect(rt.channels.filter((c) => c.unsubscribed === 0).map((c) => c.name).sort()).toEqual([
      `division:${D1}`,
      `division:${D2}`,
    ]);
  });

  it("CHANNEL_ERROR re-fetches the door after the backoff, and the board rejoins on the fresh token", async () => {
    rt.setStatus("CHANNEL_ERROR");
    doorAnswers({ status: 200, token: "door-token-1", divisionIds: [D1] }, { status: 200, token: "door-token-2", divisionIds: [D1] });
    renderIsland(Slideshow, board({ divisionIds: [D1] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toHaveLength(1);

    rt.setStatus("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toHaveLength(2);
    expect(rt.channels.map((c) => [c.name, c.unsubscribed])).toEqual([
      [`division:${D1}`, 1],
      [`division:${D1}`, 0],
    ]);
    expect(rt.log.indexOf("setAuth door-token-2")).toBeLessThan(rt.log.lastIndexOf(`channel division:${D1} private=true`));
  });

  it("the 50-minute refresh keeps the channels (nothing is left or rejoined)", async () => {
    doorAnswers({ status: 200, token: "door-token-1", divisionIds: [D1, D2] }, { status: 200, token: "door-token-2", divisionIds: [D1, D2] });
    renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DIVISION_TOKEN_REFRESH_MS);
    expect(door.calls).toHaveLength(2);
    expect(rt.channels).toHaveLength(2);
    expect(rt.channels.every((c) => c.unsubscribed === 0)).toBe(true);
  });

  it("unmount lets every channel go and asks the door nothing more", async () => {
    const island = renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    island.unmount();
    expect(rt.channels.every((c) => c.unsubscribed === 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * DIVISION_TOKEN_REFRESH_MS);
    expect(door.calls).toHaveLength(1);
  });

  it("unmounted before the door answers: the late session is handed back — no 50-minute refresh, and another competition can hold the client", async () => {
    const island = renderIsland(Slideshow, board());
    island.unmount(); // the door's answer is still on its way
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls, "premise: the door was asked").toHaveLength(1);
    expect(rt.channels).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DIVISION_TOKEN_REFRESH_MS);
    expect(door.calls, "a refresh ran for a board that has gone").toHaveLength(1);
    // The next page, for another competition, is not refused.
    doorAnswers({ status: 200, token: "door-token-next", divisionIds: [D1] });
    expect(await acquireDivisionRealtime("c-0002")).not.toBeNull();
  });

  it("a channel that fails after SUBSCRIBED puts the board back on the 45 s poll while the door refuses to renew", async () => {
    doorAnswers({ status: 200, token: "door-token-1", divisionIds: [D1, D2] }, { status: 429 });
    renderIsland(Slideshow, board());
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels.map((c) => c.name)).toEqual([`division:${D1}`, `division:${D2}`]);

    // Premise: push is up, so nothing refreshes at 45 s.
    await vi.advanceTimersByTimeAsync(SLIDESHOW_POLL_MS);
    expect(router.refreshes).toBe(0);
    // t = 45 s: one channel fails; the door's renewal is refused (429), so nothing rejoins it.
    rt.channels[0]!.status!("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(SLIDESHOW_POLL_MS - 1);
    expect(router.refreshes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    // Premise: the renewal was asked and refused (again on each backoff rung meanwhile).
    expect(door.calls.length).toBeGreaterThanOrEqual(2);
    expect(rt.channels, "premise: nothing rejoined").toHaveLength(2);
    expect(router.refreshes, "the board stayed on the 60 s push-up poll with a dead channel").toBe(1);
  });
});

// The JWT is a credential (spec §1 "Security"): never in SSR HTML or props.
describe("the organiser board page: the token is in no props and no HTML", () => {
  const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwdWJsaWMtY29tcGV0aXRpb24ifQ.SENTINEL-signature";
  const JWT_SHAPE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/;

  beforeEach(() => {
    doorAnswers({ status: 200, token: TOKEN, divisionIds: [D1] });
    seams.requireResourcePageAuth.mockResolvedValue({ auth: { orgId: "o1", userId: "u1" }, org: { slug: "riverside" } });
    seams.getDivision.mockResolvedValue({ id: D1, competition_id: COMP, name: "Open", slug: "open" });
    seams.getCompetition.mockResolvedValue({ id: COMP, name: "Autumn Cup", slug: "autumn-cup", branding: null });
    seams.buildDivisionSlides.mockResolvedValue([]);
    seams.orgBoardChrome.mockResolvedValue({ branding: null, logo: null, themed: false });
    seams.resolveSponsors.mockResolvedValue([]);
    seams.hasFeature.mockResolvedValue(true);
  });

  it("the page hands the board its competition, and neither its props nor its HTML carry a token", async () => {
    const element = await DivisionSlideshowPage({ params: Promise.resolve({ id: D1 }) });
    const props = propsOf(element) as Parameters<typeof Slideshow>[0];
    // The seam: the door is asked for THIS division's competition.
    expect(props.competitionId).toBe(COMP);
    expect(props.divisionIds).toEqual([D1]);
    expect(props.realtime).toBe(true);

    const serialised = JSON.stringify(props);
    const html = renderToStaticMarkup(element);
    expect(html.length).toBeGreaterThan(0);
    for (const [name, text] of [["props", serialised], ["html", html]] as const) {
      expect(text, `${name} carries the token`).not.toContain("SENTINEL");
      expect(JWT_SHAPE.test(text), `${name} carries a JWT`).toBe(false);
    }
    // The server never asked the door: the token is the browser's to fetch.
    expect(door.calls).toEqual([]);
  });

  it("positive pair: mounted with effects, the token reaches the client's setAuth — and still no rendered output", async () => {
    const element = await DivisionSlideshowPage({ params: Promise.resolve({ id: D1 }) });
    const island = renderIsland(Slideshow, propsOf(element) as Parameters<typeof Slideshow>[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.log).toContain(`setAuth ${TOKEN}`);
    const rendered = JSON.stringify(island.tree().map((el) => propsOf(el)), (_k, v) => (typeof v === "function" ? undefined : v));
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("SENTINEL");
    expect(JWT_SHAPE.test(rendered)).toBe(false);
    island.unmount();
  });
});
