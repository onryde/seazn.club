// "Score in app" on the quick match home's hero (owner 2026-11-26, two taps; spec 2026-11-25 open-in-app §5.6), the
// client island `QuickMatchHeroScore`. No DOM here (vitest `environment: "node"`): the island is driven through the
// no-DOM `renderIsland` harness. What the server answers is the route's test (app/q/[token]/__tests__/score-route.test.ts);
// what a browser does with the anchor, the CSS and the network is e2e/quick-match-open-in-app.spec.ts.
//
// THE SECRET IS A LIVE SCORING CREDENTIAL on a page that runs analytics. So: it is held in this island's memory only, it
// is painted in ONE place (the block's anchor href, inside `ph-no-capture`), nothing navigates to it by itself, and it
// belongs to the match it was asked for.
//
// Sport: not applicable (the control posts a path; it knows no sport).
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { OpenInAppBlock, OpenInAppHint } from "@/components/v2/open-in-app";
import en from "@/dictionaries/en/ui.json";
import { QUICK_MATCH_APP_HEADER } from "@/lib/quick-match-constants";
import { QuickMatchHeroScore, type QuickMatchHeroScoreProps } from "../hero-score";
import { QuickMatchScoreForm } from "../score-form";

const ORIGIN = "https://stg.seazn.club";
const TOKEN = `qm_${"T".repeat(43)}`;
const FIXTURE_A = "00000000-0000-4000-8000-00000000000a";
const FIXTURE_B = "00000000-0000-4000-8000-00000000000b";
const SECRET_A = `dl_${"a".repeat(43)}`;
const SECRET_B = `dl_${"b".repeat(43)}`;
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";

const actionOf = (fixtureId: string) => `/q/${TOKEN}/score/${fixtureId}`;
const props = (fixtureId = FIXTURE_A): QuickMatchHeroScoreProps => ({
  action: actionOf(fixtureId),
  fixtureId,
  label: "Score this match",
  failed: en["quickMatch.flash.generic"],
});

// ── the browser, as far as the island touches it ─────────────────────────────────────────────────────────────────────

let width: number;
let assigned: string[];
let historyWrites: number;
let storageWrites: number;
let pageListeners: Map<string, Set<(e: unknown) => void>>;

/** One fetch the island made, answered by hand so a case can act while it is in flight. */
interface Call {
  url: string;
  init: RequestInit;
  answer: (body: unknown, over?: Partial<{ ok: boolean; status: number; type: string }>) => Promise<void>;
  raw: (res: unknown) => Promise<void>;
  fail: () => Promise<void>;
}
let calls: Call[];

const settle = async () => {
  for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
};

function stubBrowser(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("window", {
    location: { origin: ORIGIN, assign: (to: string) => void assigned.push(to) },
    history: { pushState: () => void historyWrites++, replaceState: () => void historyWrites++ },
    matchMedia: (query: string) => {
      const min = /\(min-width:\s*(\d+)px\)/.exec(query)?.[1];
      if (!min) throw new Error(`unexpected media query ${query}`);
      return { matches: width >= Number(min), addEventListener: () => {}, removeEventListener: () => {} };
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!pageListeners.has(type)) pageListeners.set(type, new Set());
      pageListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => pageListeners.get(type)?.delete(fn),
  });
  const storage = { setItem: () => void storageWrites++, getItem: () => null, removeItem: () => {} };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
}

beforeEach(() => {
  width = 390;
  assigned = [];
  historyWrites = 0;
  storageWrites = 0;
  pageListeners = new Map();
  calls = [];
  vi.stubEnv("NEXT_PUBLIC_OPEN_IN_APP", "1");
  stubBrowser(ANDROID);
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    let resolve!: (r: unknown) => void;
    let reject!: (e: unknown) => void;
    const pending = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const raw = async (res: unknown) => {
      resolve(res);
      await settle();
    };
    calls.push({
      url,
      init,
      raw,
      answer: (body, over = {}) => raw({ ok: true, status: 200, type: "basic", json: async () => body, ...over }),
      fail: async () => {
        reject(new TypeError("Failed to fetch"));
        await settle();
      },
    });
    return pending;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const firePageshow = (persisted: boolean) => [...(pageListeners.get("pageshow") ?? [])].forEach((fn) => fn({ persisted }));

// ── reading the island ───────────────────────────────────────────────────────────────────────────────────────────────

type Island = ReturnType<typeof renderIsland<QuickMatchHeroScoreProps>>;
const mount = (fixtureId = FIXTURE_A): Island => renderIsland(QuickMatchHeroScore, props(fixtureId), undefined, { clientMount: true });

const only = (i: Island, test: (el: ReactElement) => boolean): ReactElement | null => {
  const found = i.tree().filter(test);
  expect(found.length, "at most one").toBeLessThanOrEqual(1);
  return found[0] ?? null;
};
const formOf = (i: Island) => {
  const form = only(i, (el) => el.type === QuickMatchScoreForm);
  expect(form, "the browser's Score is always there").not.toBeNull();
  return propsOf(form!) as unknown as { action: string; label: string; place: string; tone?: string };
};
const startOf = (i: Island) => only(i, (el) => propsOf(el)["data-testid"] === "qm-score-in-app");
const blockOf = (i: Island) => only(i, (el) => el.type === OpenInAppBlock);
const alertOf = (i: Island) => only(i, (el) => propsOf(el).role === "alert");
const tapStart = async (i: Island) => {
  const button = startOf(i);
  expect(button, "premise: Score in app is offered").not.toBeNull();
  (propsOf(button!).onClick as () => void)();
  await settle();
};
/** State 1 as the person sees it: the lime Score with the page's words, the Score in app button, idle, no link. */
function expectIdle(i: Island, fixtureId = FIXTURE_A) {
  expect(formOf(i)).toMatchObject({ action: actionOf(fixtureId), label: "Score this match", place: "hero", tone: "lime" });
  expect(blockOf(i)).toBeNull();
  expect(startOf(i)).not.toBeNull();
  expect(propsOf(startOf(i)!)["aria-disabled"]).toBeUndefined();
}

// ── who sees it ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("who is offered Score in app: the flag, an Android browser, below md", () => {
  it("only all three together offer it; every other case is the plain lime Score alone, and nothing is fetched", () => {
    let checked = 0;
    let offered = 0;
    for (const flag of ["1", "0", ""]) {
      for (const ua of [ANDROID, IPHONE, DESKTOP]) {
        for (const w of [320, 767, 768, 1280]) {
          vi.stubEnv("NEXT_PUBLIC_OPEN_IN_APP", flag);
          stubBrowser(ua);
          width = w;
          const i = mount();
          const expected = flag === "1" && ua === ANDROID && w < 768;
          expect(startOf(i) !== null, `flag=${flag} ${ua.slice(13, 30)} ${w}`).toBe(expected);
          expect(formOf(i)).toMatchObject({ label: "Score this match", tone: "lime" });
          expect(blockOf(i)).toBeNull();
          if (expected) offered++;
          checked++;
        }
      }
    }
    expect(checked).toBe(36);
    expect(offered, "premise: the offer itself was reached").toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("the server renders the browser's Score form only, even for an Android browser with the flag on", () => {
    const html = renderToStaticMarkup(<QuickMatchHeroScore {...props()} />);
    expect(html).toContain('data-testid="qm-score"');
    expect(html).not.toContain("qm-score-in-app");
    expect(html).not.toContain("open-in-app");
    expect(html).not.toContain("dl_");
  });

  it("state 1 is a plain button that says Score in app, 44px or more, with nothing fetched before the tap", () => {
    const i = mount();
    expectIdle(i);
    const button = startOf(i)!;
    expect(button.type).toBe("button");
    expect(propsOf(button).type).toBe("button");
    expect(String(propsOf(button).className).split(/\s+/)).toEqual(expect.arrayContaining(["min-h-12", "w-full"]));
    expect(propsOf(button).children).toBe(en["openApp.scoreInApp"]);
    expect(calls).toHaveLength(0);
  });
});

// ── tap one ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("tap one asks the same Score URL for the link", () => {
  it("one same-origin POST to the form's own action, asking for JSON: no body, no cache, no redirect followed", async () => {
    const i = mount();
    await tapStart(i);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(actionOf(FIXTURE_A));
    const { signal, ...init } = calls[0]!.init;
    expect(init).toEqual({
      method: "POST",
      headers: { [QUICK_MATCH_APP_HEADER]: "1" },
      redirect: "manual",
      cache: "no-store",
    });
    expect(signal, "a hung request ends").toBeInstanceOf(AbortSignal);
  });

  it("while it is in flight the button is busy, never disabled; more taps ask nothing; the browser's Score stands", async () => {
    const i = mount();
    await tapStart(i);
    expect(propsOf(startOf(i)!)["aria-disabled"]).toBe(true);
    expect(propsOf(startOf(i)!).disabled).toBeUndefined();
    for (let k = 0; k < 3; k++) await tapStart(i);
    expect(calls).toHaveLength(1);
    expect(formOf(i)).toMatchObject({ label: "Score this match", tone: "lime" });
  });

  it("two clicks in one render (before the busy state paints) still ask once", async () => {
    const i = mount();
    const click = propsOf(startOf(i)!).onClick as () => void;
    click();
    click();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("the answer: the block takes the slot with the app link, no or-scan line, the one-more-tap hint tied to the anchor", async () => {
    const i = mount();
    await tapStart(i);
    await calls[0]!.answer({ secret: SECRET_A });
    expect(startOf(i)).toBeNull();
    const block = propsOf(blockOf(i)!);
    expect(block.href).toBe(`${ORIGIN}/app/score#${SECRET_A}`);
    expect(block.orScan).toBe(false);
    const hint = only(i, (el) => el.type === OpenInAppHint)!;
    expect(propsOf(hint).hint).toBe("openApp.tapAgain");
    expect(typeof propsOf(hint).id).toBe("string");
    expect(block.describedBy).toBe(propsOf(hint).id);
    expect(formOf(i), "Score is now the quieter browser way, and still the same form").toMatchObject({
      action: actionOf(FIXTURE_A),
      label: en["openApp.scoreInBrowser"],
      tone: "outline",
      place: "hero",
    });
    expect(alertOf(i)).toBeNull();
  });

  it("nothing opens by itself: no navigation, no history entry, nothing stored; focus moves to the anchor", async () => {
    const i = mount();
    await tapStart(i);
    await calls[0]!.answer({ secret: SECRET_A });
    expect(assigned).toEqual([]);
    expect(historyWrites).toBe(0);
    expect(storageWrites, "the link is not held across a reload").toBe(0);
    const anchorRef = propsOf(blockOf(i)!).anchorRef as (el: unknown) => void;
    let focused = 0;
    let clicked = 0;
    anchorRef({ focus: () => void focused++, click: () => void clicked++ });
    anchorRef(null);
    expect([focused, clicked]).toEqual([1, 0]);
  });

  it("the secret is painted in ONE place, the block's href, which OpenInAppBlock keeps inside ph-no-capture", async () => {
    const i = mount();
    await tapStart(i);
    await calls[0]!.answer({ secret: SECRET_A });
    const holders: string[] = [];
    let checked = 0;
    for (const el of i.tree()) {
      for (const [name, value] of Object.entries(propsOf(el))) {
        if (name === "children" && typeof value !== "string") continue;
        if (typeof value === "string") {
          checked++;
          if (value.includes("dl_")) holders.push(`${typeof el.type === "function" ? el.type.name : String(el.type)}.${name}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(holders).toEqual(["OpenInAppBlock.href"]);
    // The real block with that href: everything holding it is under one ph-no-capture root.
    const html = renderToStaticMarkup(<OpenInAppBlock href={propsOf(blockOf(i)!).href as string} />).replace(/^<link [^>]*\/>/, "");
    expect(html.match(/^<div\b[^>]*class="([^"]*)"/)?.[1]?.split(/\s+/)).toContain("ph-no-capture");
    expect(html.split("dl_")).toHaveLength(2);
  });

  it("a viewport that grows to md puts the page's own lime Score back with no link; narrow again, the link returns", async () => {
    const i = mount();
    await tapStart(i);
    await calls[0]!.answer({ secret: SECRET_A });
    width = 844;
    i.rerender(props());
    expect(blockOf(i)).toBeNull();
    expect(startOf(i)).toBeNull();
    expect(formOf(i)).toMatchObject({ label: "Score this match", tone: "lime" });
    width = 390;
    i.rerender(props());
    expect(propsOf(blockOf(i)!).href).toBe(`${ORIGIN}/app/score#${SECRET_A}`);
  });
});

// ── the link belongs to its match ────────────────────────────────────────────────────────────────────────────────────

describe("the link belongs to the match it was asked for", () => {
  it("the hero moves to another match: no link under it, its own Score in app, which asks for ITS link", async () => {
    const i = mount();
    await tapStart(i);
    await calls[0]!.answer({ secret: SECRET_A });
    i.rerender(props(FIXTURE_B));
    expectIdle(i, FIXTURE_B);
    await tapStart(i);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(actionOf(FIXTURE_B));
    await calls[1]!.answer({ secret: SECRET_B });
    expect(propsOf(blockOf(i)!).href).toBe(`${ORIGIN}/app/score#${SECRET_B}`);
  });

  it("the hero moves while tap one is in flight: the late answer shows nothing, and the new match's button is not busy", async () => {
    const i = mount();
    await tapStart(i);
    i.rerender(props(FIXTURE_B));
    expectIdle(i, FIXTURE_B);
    await calls[0]!.answer({ secret: SECRET_A });
    expectIdle(i, FIXTURE_B);
  });

  it("asked for both, answered out of order: the older answer never replaces the newer match's link", async () => {
    const i = mount();
    await tapStart(i);
    i.rerender(props(FIXTURE_B));
    await tapStart(i);
    expect(calls).toHaveLength(2);
    await calls[1]!.answer({ secret: SECRET_B });
    await calls[0]!.answer({ secret: SECRET_A });
    expect(propsOf(blockOf(i)!).href).toBe(`${ORIGIN}/app/score#${SECRET_B}`);
  });

  it("a late refusal for the match the person has left, after a newer tap, moves them nowhere", async () => {
    const i = mount();
    await tapStart(i);
    i.rerender(props(FIXTURE_B));
    await tapStart(i);
    await calls[0]!.answer({ location: `/q/${TOKEN}?e=QUICK_MATCH_NOT_PLAYED` });
    expect(assigned).toEqual([]);
    expect(propsOf(startOf(i)!)["aria-disabled"], "the newer ask is still out").toBe(true);
  });
});

// ── when tap one does not give a link ────────────────────────────────────────────────────────────────────────────────

describe("a refused or failed tap one leaves no dead control", () => {
  it("a refusal goes where the form's 303 would have: the home, which prints its flash", async () => {
    const i = mount();
    await tapStart(i);
    const location = `/q/${TOKEN}?e=QUICK_MATCH_LINK_LIMITED`;
    await calls[0]!.answer({ location });
    expect(assigned).toEqual([location]);
    expect(blockOf(i)).toBeNull();
    expect(alertOf(i)).toBeNull();
  });

  it("every other failure: state 1 again with the generic line, nowhere navigated, and the next tap asks again", async () => {
    const answers: [string, (c: Call) => Promise<void>][] = [
      ["network error", (c) => c.fail()],
      ["403", (c) => c.answer({ secret: SECRET_A }, { ok: false, status: 403 })],
      ["500", (c) => c.answer({ location: "/q/x" }, { ok: false, status: 500 })],
      ["an unfollowed redirect", (c) => c.raw({ ok: false, status: 0, type: "opaqueredirect", json: async () => ({}) })],
      ["not JSON", (c) => c.raw({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError("no")) })],
      ["null body", (c) => c.answer(null)],
      ["empty body", (c) => c.answer({})],
      ["a short secret", (c) => c.answer({ secret: `dl_${"a".repeat(42)}` })],
      ["a long secret", (c) => c.answer({ secret: `dl_${"a".repeat(44)}` })],
      ["not a device link", (c) => c.answer({ secret: `md_${"a".repeat(43)}` })],
      ["a secret with a tail", (c) => c.answer({ secret: `${SECRET_A}\n` })],
      ["another origin", (c) => c.answer({ location: "https://evil.example/q" })],
      ["protocol relative", (c) => c.answer({ location: "//evil.example/q" })],
      ["backslash", (c) => c.answer({ location: "/\\evil.example" })],
      ["a script URL", (c) => c.answer({ location: "javascript:alert(1)" })],
    ];
    let checked = 0;
    for (const [name, answer] of answers) {
      calls = [];
      const i = mount();
      await tapStart(i);
      await answer(calls[0]!);
      expect(blockOf(i), name).toBeNull();
      expectIdle(i);
      expect(alertOf(i), name).not.toBeNull();
      expect(propsOf(alertOf(i)!).children, name).toBe(en["quickMatch.flash.generic"]);
      expect(assigned, name).toEqual([]);
      await tapStart(i);
      expect(calls, name).toHaveLength(2);
      expect(alertOf(i), `${name}: the line clears while asking again`).toBeNull();
      await calls[1]!.answer({ secret: SECRET_A });
      expect(blockOf(i), name).not.toBeNull();
      checked++;
    }
    expect(checked).toBe(answers.length);
  });

  it("the failure line is the match's own: a hero that moves on shows none", async () => {
    const i = mount();
    await tapStart(i);
    await calls[0]!.fail();
    i.rerender(props(FIXTURE_B));
    expect(alertOf(i)).toBeNull();
  });
});

// ── back and forward ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("a page restored from the back-forward cache starts again", () => {
  it("drops the link on a restore only", async () => {
    const i = mount();
    await tapStart(i);
    await calls[0]!.answer({ secret: SECRET_A });
    firePageshow(false);
    expect(blockOf(i), "an ordinary pageshow is not a restore").not.toBeNull();
    firePageshow(true);
    expectIdle(i);
  });

  it("restored mid-flight: the button works again, and the answer from before the restore is ignored", async () => {
    const i = mount();
    await tapStart(i);
    firePageshow(true);
    expectIdle(i);
    await calls[0]!.answer({ secret: SECRET_A });
    expectIdle(i);
    await tapStart(i);
    expect(calls).toHaveLength(2);
  });

  it("removes its listener when it goes", () => {
    const i = mount();
    expect(pageListeners.get("pageshow")?.size).toBe(1);
    i.unmount();
    expect(pageListeners.get("pageshow")?.size).toBe(0);
  });
});
