// Cloudflare Turnstile, the CLIENT side of six of the seven guarded routes, driven the way a browser would (join and register have
// their own interaction suites): login (auth-form), start (start-wizard), resend (resend-confirmation), and the three withdraw
// buttons (withdraw-by-ref, cancel-entry, registration-actions: by-ref and by-id are two routes under one action).
//
// A pure-builder suite is blind to wiring (apps/web vitest has no DOM): a form can build the right header in a unit test and still
// never send it, never reset the widget, or mount the widget for the wrong action. So each real island is mounted through
// _hook-harness.tsx's renderIsland, its REAL submit handler is invoked, the REAL `withTurnstile` runs, and what reaches the
// (mocked) network call is read back. Only the widget itself is a stand-in: a fake controller with the controller's own surface
// (token/reset), because the widget needs a browser. Its real half is lib/__tests__/turnstile-client.test.ts.
//
// Wire literals (`cf-turnstile-response`, `TURNSTILE_FAILED`) are typed here, not read from lib/turnstile.ts, so a rename on one
// side that the other did not follow is a red test and not a form that sends nothing.
const net = vi.hoisted(() => ({
  calls: [] as { fn: "api" | "apiV1"; url: string; method?: string; json?: unknown; headers?: Record<string, string> }[],
  response: undefined as unknown,
  rejection: null as unknown,
  refreshes: 0,
  confirm: true,
}));
const turnstileFake = vi.hoisted(() => ({
  token: null as string | null,
  resets: 0,
  controller: null as unknown as { token(): Promise<string | null>; reset(): void },
  actions: [] as string[],
}));

type Opts = { method?: string; json?: unknown; headers?: Record<string, string> };
function record(fn: "api" | "apiV1", url: string, options?: Opts) {
  net.calls.push({ fn, url, method: options?.method, json: options?.json, headers: options?.headers });
  if (net.rejection) {
    const e = net.rejection;
    net.rejection = null;
    return Promise.reject(e);
  }
  return Promise.resolve(net.response);
}
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return { ...actual, api: (url: string, options?: Opts) => record("api", url, options) };
});
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (url: string, options?: Opts) => record("apiV1", url, options) };
});
vi.mock("@/components/turnstile-widget", () => {
  turnstileFake.controller = {
    token: () => Promise.resolve(turnstileFake.token),
    reset: () => { turnstileFake.resets++; },
  };
  return {
    useTurnstile: (action: string) => { turnstileFake.actions.push(action); return turnstileFake.controller; },
    TurnstileWidget: function TurnstileWidgetStub() { return null; },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => { net.refreshes++; } }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => () => Promise.resolve(net.confirm) }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ApiError } from "@/lib/client";
import { ApiV1Error } from "@/lib/client-v1";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

const dict = (locale: string, file: string): Dict =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", locale, `${file}.json`), "utf8")) as Dict;
const EN_UI = dict("en", "ui");
/** What the real /start page provides (app/[lang]/(marketing)/start/page.tsx): the marketing catalog with `ui` merged over it. */
const START_PAGE_DICT: Dict = { ...dict("en", "marketing"), ...EN_UI };
const BOT_CHECK_SENTENCE = String(EN_UI["turnstile.error"]);

vi.mock("@/components/i18n/dict-provider", () => ({
  useMsg: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(START_PAGE_DICT, key, vars),
  useLocale: () => "en",
}));

import { AuthForm } from "../auth-form";
import { StartWizard } from "../start-wizard";
import { WithdrawByRef } from "../public-site/withdraw-by-ref";
import { ResendConfirmation } from "../../app/(public)/live/[orgSlug]/[competitionSlug]/register/status/resend-confirmation";
import { CancelEntry } from "../../app/(public)/live/[orgSlug]/[competitionSlug]/register/status/cancel-entry";
import { RegistrationActions } from "../public-site/registration-actions";

beforeEach(() => {
  net.calls = [];
  net.response = undefined;
  net.rejection = null;
  net.refreshes = 0;
  net.confirm = true;
  turnstileFake.token = null;
  turnstileFake.resets = 0;
  turnstileFake.actions = [];
});

/** What the assertions read of a mounted island (not `rerender`, whose props type differs per island). */
type Island = Pick<ReturnType<typeof renderIsland>, "tree" | "text">;
const widgets = (island: Island) => island.tree().filter((e) => typeof e.type === "function" && e.type.name === "TurnstileWidgetStub");
const byType = (island: Island, type: string) => island.tree().filter((e) => e.type === type);
const BOT_CHECK_REFUSAL = (Ctor: typeof ApiError | typeof ApiV1Error) => new Ctor("Verification failed. Reload the page and try again.", 403, "TURNSTILE_FAILED");

/** One surface: how to mount it, drive its submit to the network call, and read what it showed. */
interface Surface {
  name: string;
  action: string;
  fn: "api" | "apiV1";
  url: string;
  Err: typeof ApiError | typeof ApiV1Error;
  /** Mount and run the submit once; resolves when the request has settled. */
  run(): Promise<Island>;
  /** The widget is on the page from the start (login, start) or only once the person has pressed the control (resend, withdraw). */
  widgetOnMount: boolean;
  /** Mount only (no submit), with the widget's presence readable. */
  mount(): Island;
  /** The page text after a request. */
  text(island: Island): string;
}

const noop = () => undefined;
const evt = { preventDefault: noop };

function mountAuth(): Island {
  return renderIsland(AuthForm, {});
}
async function runAuth() {
  const island = mountAuth();
  const field = island.tree().find((e) => propsOf(e).type === "email");
  expect(field, "the email field").toBeTruthy();
  (propsOf(field!).onChange as (v: string) => void)("player@example.com");
  const form = byType(island, "form")[0]!;
  await (propsOf(form).onSubmit as (e: typeof evt) => Promise<void>)(evt);
  return island;
}

function mountStart(): Island {
  return renderIsland(StartWizard, { initial: { sport: "Badminton", entrants: 16 } });
}
async function runStart() {
  const island = mountStart();
  (propsOf(byType(island, "form")[0]!).onSubmit as (e: typeof evt) => void)(evt); // step 0 -> 1
  const looksRight = byType(island, "button").find((b) => textOf(b).includes(String(START_PAGE_DICT["start.wizard.looksRight"])));
  expect(looksRight, "step 1's continue button").toBeTruthy();
  (propsOf(looksRight!).onClick as () => void)(); // step 1 -> 2
  const email = island.tree().find((e) => e.type === "input" && propsOf(e).type === "email");
  expect(email, "step 2's email field").toBeTruthy();
  (propsOf(email!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "player@example.com" } });
  const form = byType(island, "form")[0]!;
  await (propsOf(form).onSubmit as (e: typeof evt) => Promise<void>)(evt);
  return island;
}

function mountResend(): Island {
  return renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
}
async function runResend() {
  const island = mountResend();
  await (propsOf(byType(island, "button")[0]!).onClick as () => Promise<void>)();
  return island;
}

function mountWithdraw(): Island {
  return renderIsland(WithdrawByRef, { refCode: "SZ-REF-1", token: "tok", entryId: "e1", divisionName: "Doubles" });
}
async function runWithdraw() {
  const island = mountWithdraw();
  // The button's onClick is `() => void withdraw()`: it returns at once, so let the confirm, the request and the reset settle.
  (propsOf(byType(island, "button")[0]!).onClick as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return island;
}

function mountCancel(): Island {
  return renderIsland(CancelEntry, { entryId: "e1", token: "tok", divisionName: "Doubles", refundable: true, refundAmountFormatted: "$10.00" });
}
async function runCancel() {
  const island = mountCancel();
  (propsOf(byType(island, "button")[0]!).onClick as () => void)(); // `onClick={cancel}` returns the promise, but settle the same way
  await new Promise((resolve) => setTimeout(resolve, 0));
  return island;
}

// paymentDue=false: the pay button is not rendered, so the one button is withdraw (pay is deliberately not bot-checked).
function mountActions(): Island {
  return renderIsland(RegistrationActions, { registrationId: "reg-1", token: "tok", status: "confirmed", paymentDue: false });
}
async function runActions() {
  const island = mountActions();
  (propsOf(byType(island, "button")[0]!).onClick as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return island;
}

const SURFACES: Surface[] = [
  {
    name: "login (auth-form)", action: "login", fn: "api", url: "/api/auth/magic-link", Err: ApiError,
    run: runAuth, mount: mountAuth, widgetOnMount: true, text: (i) => textOf(i.tree()),
  },
  {
    name: "start (start-wizard)", action: "start", fn: "api", url: "/api/funnel/start", Err: ApiError,
    run: runStart, mount: mountStart, widgetOnMount: false, text: (i) => textOf(i.tree()),
  },
  {
    name: "resend (resend-confirmation)", action: "resend", fn: "apiV1", url: "/api/v1/public/registrations/groups/grp-1/resend", Err: ApiV1Error,
    run: runResend, mount: mountResend, widgetOnMount: false, text: (i) => textOf(i.tree()),
  },
  {
    name: "withdraw (withdraw-by-ref)", action: "withdraw", fn: "apiV1", url: "/api/v1/public/registrations/by-ref/SZ-REF-1/withdraw", Err: ApiV1Error,
    run: runWithdraw, mount: mountWithdraw, widgetOnMount: false, text: (i) => textOf(i.tree()),
  },
  {
    name: "withdraw (cancel-entry, status page)", action: "withdraw", fn: "apiV1", url: "/api/v1/public/registrations/e1/withdraw", Err: ApiV1Error,
    run: runCancel, mount: mountCancel, widgetOnMount: false, text: (i) => textOf(i.tree()),
  },
  {
    name: "withdraw (registration-actions, by id)", action: "withdraw", fn: "apiV1", url: "/api/v1/public/registrations/reg-1/withdraw", Err: ApiV1Error,
    run: runActions, mount: mountActions, widgetOnMount: false, text: (i) => textOf(i.tree()),
  },
];

describe("the six surfaces send the widget's token, reset it, and say the bot check's own sentence when it refuses", () => {
  it("anti-vacuity: the sweep covers six surfaces on four actions, three of them withdraw", () => {
    expect(SURFACES).toHaveLength(6);
    expect(SURFACES.map((s) => s.action).sort()).toEqual(["login", "resend", "start", "withdraw", "withdraw", "withdraw"]);
    expect(new Set(SURFACES.map((s) => s.url)).size, "six distinct request URLs").toBe(6);
  });

  for (const s of SURFACES) {
    describe(s.name, () => {
      it(`asks for the "${s.action}" widget and, once it is on the page, mounts exactly one wired to the controller that sends the request`, async () => {
        const island = s.widgetOnMount ? s.mount() : await s.run();
        expect(turnstileFake.actions.length, "anti-vacuity: the hook ran").toBeGreaterThan(0);
        expect(turnstileFake.actions.every((a) => a === s.action), `every useTurnstile call asks for "${s.action}"`).toBe(true);
        const found = widgets(island);
        expect(found, "one widget").toHaveLength(1);
        expect(propsOf(found[0]!).controller).toBe(turnstileFake.controller);
      });

      it("a held token travels in the cf-turnstile-response header (never in the body), and the widget is reset after", async () => {
        turnstileFake.token = "tok-from-widget";
        net.response = { sent: true, message: "ok" };
        await s.run();
        const posts = net.calls.filter((c) => c.method === "POST");
        expect(posts, "anti-vacuity: the request was made").toHaveLength(1);
        expect(posts[0]!.fn).toBe(s.fn);
        expect(posts[0]!.url).toBe(s.url);
        expect(posts[0]!.headers).toEqual({ "cf-turnstile-response": "tok-from-widget" });
        expect(JSON.stringify(posts[0]!.json)).not.toContain("tok-from-widget");
        expect(turnstileFake.resets).toBe(1);
      });

      it("no token (no site key, dev, e2e): the request goes with NO header at all and the widget is still reset", async () => {
        net.response = { sent: true, message: "ok" };
        await s.run();
        const posts = net.calls.filter((c) => c.method === "POST");
        expect(posts).toHaveLength(1);
        expect(posts[0]!.headers).toEqual({});
        expect(turnstileFake.resets).toBe(1);
      });

      it("a second attempt after a failure carries the widget's NEW token: the first one was spent (sequence)", async () => {
        turnstileFake.token = "tok-1";
        net.rejection = new s.Err("boom", 500, "ERROR");
        await s.run();
        turnstileFake.token = "tok-2"; // what the reset widget fetched
        net.response = { sent: true, message: "ok" };
        await s.run();
        const posts = net.calls.filter((c) => c.method === "POST");
        expect(posts.map((c) => c.headers)).toEqual([{ "cf-turnstile-response": "tok-1" }, { "cf-turnstile-response": "tok-2" }]);
        expect(turnstileFake.resets, "a reset after each of the two requests").toBe(2);
      });

      it("403 TURNSTILE_FAILED shows the dictionary's bot-check sentence, not the server's English, and resets the spent token", async () => {
        turnstileFake.token = "tok-refused";
        net.rejection = BOT_CHECK_REFUSAL(s.Err);
        const island = await s.run();
        expect(s.text(island)).toContain(BOT_CHECK_SENTENCE);
        expect(s.text(island)).not.toContain("Verification failed. Reload the page");
        expect(turnstileFake.resets).toBe(1);
      });

      it("a 403 with another code is NOT the bot-check sentence (the pair)", async () => {
        net.rejection = new s.Err("Forbidden", 403, "FORBIDDEN");
        const island = await s.run();
        expect(s.text(island)).not.toContain(BOT_CHECK_SENTENCE);
      });
    });
  }

  for (const w of [
    { name: "withdraw-by-ref", run: runWithdraw },
    { name: "cancel-entry", run: runCancel },
    { name: "registration-actions", run: runActions },
  ]) {
    it(`${w.name}: the widget is armed by the press, BEFORE the confirm dialog resolves, and a declined confirm sends nothing`, async () => {
      net.confirm = false;
      const island = await w.run();
      expect(net.calls, "declined: no request").toHaveLength(0);
      expect(widgets(island), "armed even though the person declined: the check had started while they read the dialog").toHaveLength(1);
      expect(turnstileFake.resets, "nothing was sent, so there is nothing to reset").toBe(0);
    });
  }

  it("resend and the three withdraws do NOT mount a widget until pressed (a status page with ten withdraw buttons runs one check, not ten)", () => {
    expect(widgets(mountResend())).toHaveLength(0);
    expect(widgets(mountWithdraw())).toHaveLength(0);
    expect(widgets(mountCancel())).toHaveLength(0);
    expect(widgets(mountActions())).toHaveLength(0);
  });

  it("login and start mount theirs on the form itself (start: on the step that submits, not before)", () => {
    expect(widgets(mountAuth())).toHaveLength(1);
    expect(widgets(mountStart()), "start's step 0 has no widget").toHaveLength(0);
  });

  it("anti-vacuity: the refusal sentence is real English copy, not an empty string or the key", () => {
    expect(BOT_CHECK_SENTENCE.length).toBeGreaterThan(40);
    expect(BOT_CHECK_SENTENCE).not.toBe("turnstile.error");
  });
});
