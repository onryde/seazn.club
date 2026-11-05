// Cloudflare Turnstile, browser half (lib/turnstile-client.ts): the controller around the widget, `withTurnstile`, and the script
// loader. `apps/web` vitest is environment "node" (no DOM), which is exactly why the logic lives in a file with no React: the
// widget is a stateful fake of Cloudflare's `window.turnstile` (documented: render / reset / remove, and the callbacks), and the
// DOM the loader needs is a minimal stand-in.
//
// What these prove, in sequence and not just once: a token is SINGLE-USE, so the second request after a first must carry a fresh
// token and never the spent one; the reset happens after a failed request as much as a successful one; and a widget that is slow,
// failed, expired or absent never wedges the form.
//
// Sport: not applicable. A bot check is sport-agnostic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURNSTILE_ACTIONS, TURNSTILE_HEADER } from "@/lib/turnstile";
import {
  FLEXIBLE_MIN_WIDTH,
  TOKEN_WAIT_MS,
  TURNSTILE_SCRIPT_SRC,
  createTurnstileController,
  withTurnstile,
  type TurnstileApi,
  type TurnstileRenderParams,
} from "../turnstile-client";

/** A stateful stand-in for Cloudflare's `window.turnstile`: `render` stores the callbacks; `solve` plays the widget finishing its
 *  challenge. `reset` is Cloudflare's documented "clear the token, run a fresh challenge", so it queues the NEXT token itself. */
function fakeWidget(opts: { autoSolve?: boolean } = {}) {
  const autoSolve = opts.autoSolve ?? true;
  let n = 0;
  const widgets = new Map<string, TurnstileRenderParams>();
  const api = {
    render: vi.fn((_container: HTMLElement, params: TurnstileRenderParams) => {
      const id = `w${widgets.size + 1}`;
      widgets.set(id, params);
      if (autoSolve) queueMicrotask(() => params.callback(`tok-${++n}`));
      return id;
    }),
    reset: vi.fn((id: string) => {
      const p = widgets.get(id);
      if (p && autoSolve) queueMicrotask(() => p.callback(`tok-${++n}`));
    }),
    remove: vi.fn((id: string) => void widgets.delete(id)),
  } satisfies TurnstileApi;
  return {
    api,
    widgets,
    params: (id = "w1") => widgets.get(id)!,
    solve: (token: string, id = "w1") => widgets.get(id)!.callback(token),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const CONTAINER = {} as HTMLElement;
const VIEW = { language: "en", width: 400 };

function controller(over: Partial<Parameters<typeof createTurnstileController>[0]> = {}, widget = fakeWidget()) {
  const load = vi.fn(async () => widget.api);
  const c = createTurnstileController({ siteKey: "1x00000000000000000000AA", action: "login", load, ...over });
  return { c, widget, load };
}

describe("withTurnstile: one guarded request", () => {
  it("hands the request the token under the documented header name, then resets the widget (after the request, not before)", async () => {
    const order: string[] = [];
    const source = {
      token: vi.fn(async () => (order.push("token"), "tok-1")),
      reset: vi.fn(() => void order.push("reset")),
    };
    const seen: Record<string, string>[] = [];
    const out = await withTurnstile(source, async (headers) => {
      order.push("send");
      seen.push(headers);
      return "response";
    });
    expect(out).toBe("response");
    expect(seen).toEqual([{ "cf-turnstile-response": "tok-1" }]);
    expect(TURNSTILE_HEADER).toBe("cf-turnstile-response");
    expect(order).toEqual(["token", "send", "reset"]);
  });

  it("resets after a request that FAILS too, and rethrows the failure untouched", async () => {
    const boom = new Error("403");
    const source = { token: async () => "tok-1", reset: vi.fn() };
    await expect(withTurnstile(source, async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(source.reset).toHaveBeenCalledTimes(1);
  });

  it("with no token the request carries NO header at all (not an empty one), and the widget is still reset", async () => {
    const source = { token: async () => null, reset: vi.fn() };
    const seen: Record<string, string>[] = [];
    await withTurnstile(source, async (headers) => void seen.push(headers));
    expect(seen).toEqual([{}]);
    expect(Object.keys(seen[0]!)).toHaveLength(0);
    expect(source.reset).toHaveBeenCalledTimes(1);
  });

  it("with no widget at all (null or undefined) the request still goes, headerless", async () => {
    for (const source of [null, undefined]) {
      const seen: Record<string, string>[] = [];
      await withTurnstile(source, async (headers) => void seen.push(headers));
      expect(seen).toEqual([{}]);
    }
  });

  it("an empty-string token is not sent as a header", async () => {
    const seen: Record<string, string>[] = [];
    await withTurnstile({ token: async () => "", reset: () => {} }, async (headers) => void seen.push(headers));
    expect(seen).toEqual([{}]);
  });
});

describe("the sequence through a real controller: a token is single-use", () => {
  it("request 1 sends token A and spends it; request 2 sends a FRESH token B, never A; every request resets the widget once", async () => {
    const { c, widget } = controller();
    c.mount(CONTAINER, VIEW);
    await flush();
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) {
      await withTurnstile(c, async (headers) => void sent.push(headers[TURNSTILE_HEADER]!));
      await flush(); // the widget finishes the fresh challenge the reset started
    }
    expect(sent).toEqual(["tok-1", "tok-2", "tok-3"]);
    expect(new Set(sent).size, "no token is ever sent twice").toBe(3);
    expect(widget.api.reset).toHaveBeenCalledTimes(3);
    expect(widget.api.reset).toHaveBeenCalledWith("w1");
  });

  it("a request that fails still spends the token: the retry gets a new one", async () => {
    const { c } = controller();
    c.mount(CONTAINER, VIEW);
    await flush();
    const sent: string[] = [];
    await withTurnstile(c, async (headers) => {
      sent.push(headers[TURNSTILE_HEADER]!);
      throw new Error("server said no");
    }).catch(() => {});
    await flush();
    await withTurnstile(c, async (headers) => void sent.push(headers[TURNSTILE_HEADER]!));
    expect(sent).toEqual(["tok-1", "tok-2"]);
  });

  it("a click that arrives while the invisible check is still running WAITS for the token instead of sending without one", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await flush();
    const seen: Record<string, string>[] = [];
    const pending = withTurnstile(c, async (headers) => void seen.push(headers));
    await flush();
    expect(seen, "nothing is sent while the token is pending").toEqual([]);
    widget.solve("tok-late");
    await pending;
    expect(seen).toEqual([{ [TURNSTILE_HEADER]: "tok-late" }]);
  });

  it("a click BEFORE the widget is mounted (resend and withdraw mount on the first click) waits for it", async () => {
    const { c } = controller();
    const seen: Record<string, string>[] = [];
    const pending = withTurnstile(c, async (headers) => void seen.push(headers));
    await flush();
    expect(seen).toEqual([]);
    c.mount(CONTAINER, VIEW);
    await pending;
    expect(seen).toEqual([{ [TURNSTILE_HEADER]: "tok-1" }]);
  });
});

describe("a widget that is slow, failed, expired or absent never wedges the form", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives up after TOKEN_WAIT_MS and resolves null (the request then goes without a token and the server answers for it)", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    let settled: string | null | undefined;
    void c.token().then((t) => (settled = t));
    await vi.advanceTimersByTimeAsync(TOKEN_WAIT_MS - 1);
    expect(settled, "still waiting one ms before the bound").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
    expect(TOKEN_WAIT_MS).toBe(20_000);
  });

  it("the wait timer is cleared once a token arrives (no stray timer left behind)", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    const p = c.token();
    widget.solve("tok-x");
    expect(await p).toBe("tok-x");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the widget's error-callback releases a waiting request at once with null", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    const p = c.token();
    widget.params()["error-callback"]("300030");
    expect(await p).toBeNull();
    expect(await c.token(), "and a later request is not made to wait again").toBeNull();
  });

  it("after reset() the SPENT token is never handed out again: a request that comes before the fresh challenge finishes waits for the new one", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    widget.solve("tok-A");
    expect(await c.token()).toBe("tok-A");
    c.reset(); // the request that spent tok-A is done; the widget is running a new challenge that has not finished
    let got: string | null | undefined;
    void c.token().then((t) => (got = t));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(got, "still waiting, and not answered with the spent token").toBeUndefined();
    widget.solve("tok-B");
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBe("tok-B");
  });

  it("a good token after an error clears the failure: when it later expires the next request waits for the refresh instead of going without", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    widget.params()["error-callback"]();
    widget.solve("tok-after-retry");
    widget.params()["expired-callback"]();
    let got: string | null | undefined;
    void c.token().then((t) => (got = t));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(got, "waiting for Cloudflare's auto-refresh, not released as failed").toBeUndefined();
    widget.solve("tok-refreshed");
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBe("tok-refreshed");
  });

  it("a token that arrives after an error (Cloudflare retried on its own) is used", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    widget.params()["error-callback"]();
    expect(await c.token()).toBeNull();
    widget.solve("tok-after-retry");
    expect(await c.token()).toBe("tok-after-retry");
  });

  it("an expired token is forgotten (never sent), and the next one the widget produces is used", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    widget.solve("tok-old");
    expect(await c.token()).toBe("tok-old");
    widget.params()["expired-callback"]();
    const p = c.token();
    widget.solve("tok-new");
    expect(await p).toBe("tok-new");
  });

  it("an interactive challenge the visitor never solved (timeout-callback) drops the token", async () => {
    const widget = fakeWidget({ autoSolve: false });
    const { c } = controller({}, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    widget.solve("tok-1");
    widget.params()["timeout-callback"]();
    const p = c.token();
    await vi.advanceTimersByTimeAsync(TOKEN_WAIT_MS);
    expect(await p).toBeNull();
  });

  it("a script that fails to load (a content blocker) releases waiters with null and later calls do not wait", async () => {
    const { c } = controller({ load: vi.fn(async () => Promise.reject(new Error("blocked"))) });
    const p = c.token();
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBeNull();
    expect(await c.token()).toBeNull();
    c.reset(); // nothing to reset, and it must not throw
  });

  it("with no site key (dev, e2e) there is no widget: nothing is loaded or rendered and token() is null at once", async () => {
    const widget = fakeWidget();
    const { c, load } = controller({ siteKey: "" }, widget);
    c.mount(CONTAINER, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).not.toHaveBeenCalled();
    expect(widget.api.render).not.toHaveBeenCalled();
    expect(await c.token()).toBeNull();
    expect(vi.getTimerCount(), "no wait timer for a widget that does not exist").toBe(0);
    c.reset();
    c.unmount();
    expect(widget.api.reset).not.toHaveBeenCalled();
    expect(widget.api.remove).not.toHaveBeenCalled();
  });
});

describe("mount and unmount", () => {
  it("renders with the site key, the form's own action, interaction-only appearance and the page language", async () => {
    let checked = 0;
    for (const action of TURNSTILE_ACTIONS) {
      const { c, widget } = controller({ action });
      c.mount(CONTAINER, { language: "nl", width: 400 });
      await flush();
      expect(widget.api.render).toHaveBeenCalledTimes(1);
      expect(widget.api.render.mock.calls[0]![0]).toBe(CONTAINER);
      expect(widget.params()).toMatchObject({ sitekey: "1x00000000000000000000AA", action, appearance: "interaction-only", language: "nl" });
      checked++;
    }
    expect(checked).toBe(TURNSTILE_ACTIONS.length);
  });

  it("picks `compact` for a container narrower than Cloudflare's 300px floor for `flexible`, and `flexible` at and above it", async () => {
    expect(FLEXIBLE_MIN_WIDTH).toBe(300); // the documented minimum width of size "flexible"
    const sizes: string[] = [];
    for (const width of [0, 150, 288, 299, 300, 301, 600]) {
      const { c, widget } = controller();
      c.mount(CONTAINER, { language: "en", width });
      await flush();
      sizes.push(`${width}:${widget.params().size}`);
    }
    expect(sizes).toEqual(["0:compact", "150:compact", "288:compact", "299:compact", "300:flexible", "301:flexible", "600:flexible"]);
  });

  it("unmount removes the widget; mounting again (React strict mode, a step that leaves and returns) renders a new one", async () => {
    const { c, widget } = controller();
    c.mount(CONTAINER, VIEW);
    await flush();
    c.unmount();
    expect(widget.api.remove).toHaveBeenCalledWith("w1");
    c.mount(CONTAINER, VIEW);
    await flush();
    expect(widget.api.render).toHaveBeenCalledTimes(2);
    expect(await c.token(), "the second widget's token, not the first's").toBe("tok-2");
  });

  it("an unmount that lands BEFORE the script finished loading renders nothing (no widget leaks into a torn-down container)", async () => {
    let release!: (api: TurnstileApi) => void;
    const widget = fakeWidget();
    const load = vi.fn(() => new Promise<TurnstileApi>((r) => (release = r)));
    const { c } = controller({ load }, widget);
    c.mount(CONTAINER, VIEW);
    c.unmount();
    release(widget.api);
    await flush();
    expect(widget.api.render).not.toHaveBeenCalled();
    expect(widget.api.remove).not.toHaveBeenCalled();
  });

  it("strict-mode order mount, unmount, mount while the script is loading renders exactly ONE widget", async () => {
    let release!: (api: TurnstileApi) => void;
    const widget = fakeWidget();
    const load = vi.fn(() => new Promise<TurnstileApi>((r) => (release = r)));
    const { c } = controller({ load }, widget);
    c.mount(CONTAINER, VIEW);
    c.unmount();
    c.mount(CONTAINER, VIEW);
    release(widget.api);
    await flush();
    expect(widget.api.render).toHaveBeenCalledTimes(1);
  });

  it("unmount releases a request that was waiting, with null, at once (not when the 20 s wait runs out)", async () => {
    vi.useFakeTimers();
    try {
      const widget = fakeWidget({ autoSolve: false });
      const { c } = controller({}, widget);
      c.mount(CONTAINER, VIEW);
      await vi.advanceTimersByTimeAsync(0);
      let got: string | null | undefined;
      void c.token().then((t) => (got = t));
      expect(got).toBeUndefined();
      c.unmount();
      await vi.advanceTimersByTimeAsync(0); // microtasks only: no wait time has passed
      expect(got).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadTurnstileApi: the script tag", () => {
  type FakeScript = { src: string; async: boolean; defer: boolean; onload?: () => void; onerror?: () => void; remove: () => void };
  let scripts: FakeScript[];
  let win: { turnstile?: TurnstileApi };

  async function freshLoader() {
    vi.resetModules();
    return await import("../turnstile-client");
  }

  beforeEach(() => {
    scripts = [];
    win = {};
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      createElement: () => {
        const s: FakeScript = { src: "", async: false, defer: false, remove: () => {} };
        scripts.push(s);
        return s;
      },
      head: { appendChild: () => {} },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the script is Cloudflare's api.js with explicit rendering, exactly as documented", () => {
    expect(TURNSTILE_SCRIPT_SRC).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  });

  it("injects ONE script however many forms ask, and resolves with window.turnstile once it loads", async () => {
    const { loadTurnstileApi } = await freshLoader();
    const a = loadTurnstileApi();
    const b = loadTurnstileApi();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({ src: TURNSTILE_SCRIPT_SRC, async: true, defer: true });
    const api = fakeWidget().api;
    win.turnstile = api;
    scripts[0]!.onload!();
    expect(await a).toBe(api);
    expect(await b).toBe(api);
  });

  it("when the page already has window.turnstile no script is added", async () => {
    const { loadTurnstileApi } = await freshLoader();
    win.turnstile = fakeWidget().api;
    expect(await loadTurnstileApi()).toBe(win.turnstile);
    expect(scripts).toHaveLength(0);
  });

  it("a failed load rejects, is NOT cached, and the next mount tries again", async () => {
    const { loadTurnstileApi } = await freshLoader();
    const first = loadTurnstileApi();
    scripts[0]!.onerror!();
    await expect(first).rejects.toThrow(/failed to load/);
    const second = loadTurnstileApi();
    expect(scripts, "a second attempt injects a second script").toHaveLength(2);
    win.turnstile = fakeWidget().api;
    scripts[1]!.onload!();
    await expect(second).resolves.toBe(win.turnstile);
  });

  it("a script that loads without defining window.turnstile rejects and is not cached", async () => {
    const { loadTurnstileApi } = await freshLoader();
    const first = loadTurnstileApi();
    scripts[0]!.onload!();
    await expect(first).rejects.toThrow(/without window.turnstile/);
    void loadTurnstileApi();
    expect(scripts).toHaveLength(2);
  });
});
