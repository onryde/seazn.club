// Cloudflare Turnstile, server half (server/turnstile.ts): the skip rule, the siteverify judgement, and the gate a route calls.
//
// Everything here is judged against Cloudflare's PUBLISHED behaviour (developers.cloudflare.com/turnstile: server-side
// validation + testing), never against what the helper happens to do:
//   * siteverify wants a urlencoded POST of secret + response (+ remoteip), and answers `success`, `action`, `hostname` and
//     `error-codes`; a token is single-use and a second redemption is `timeout-or-duplicate`; a token is at most 2048 chars;
//   * the published test secrets: 1x...AA always passes, 2x...AA always fails, 3x...AA answers "token already spent".
// `fakeSiteverify` below is that behaviour as a STATEFUL stand-in for the network (global `fetch` IS Cloudflare), so a replay is a
// real second call that the fake refuses, not a canned reply.
//
// Sport: not applicable. A bot check is sport-agnostic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { HttpError } from "@/lib/errors";
import { FAKE_DRIVER_ENV_NAMES } from "@/server/relay/config";
import { TURNSTILE_ACTIONS, TURNSTILE_ERROR_CODE, TURNSTILE_HEADER, TURNSTILE_TOKEN_MAX_LENGTH, isTurnstileRefusal } from "@/lib/turnstile";
import { SITEVERIFY_URL, requireTurnstile, turnstileMode, verifyTurnstile } from "../turnstile";

// Cloudflare's published test secrets (developers.cloudflare.com/turnstile/troubleshooting/testing).
const SECRET_PASS = "1x0000000000000000000000000000000AA";
const SECRET_FAIL = "2x0000000000000000000000000000000AA";
const SECRET_SPENT = "3x0000000000000000000000000000000AA";
const HOST = "stg.seazn.test";

const ENV = { TURNSTILE_SECRET: SECRET_PASS, TURNSTILE_HOSTNAMES: `seazn.test, ${HOST.toUpperCase()}` };

type Minted = { action: string; hostname: string; spent: boolean };
/** A Cloudflare stand-in. `mint` is the browser side (a widget rendered for an action on a host hands out a token); the
 *  fake is the server side, and it keeps the one fact that matters: a token is good once. */
function fakeSiteverify() {
  const minted = new Map<string, Minted>();
  let n = 0;
  const calls: { url: string; init: RequestInit; form: URLSearchParams }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    calls.push({ url: String(url), init: init ?? {}, form });
    const secret = form.get("secret") ?? "";
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (secret === SECRET_FAIL) return ok({ success: false, "error-codes": ["invalid-input-response"] });
    if (secret === SECRET_SPENT) return ok({ success: false, "error-codes": ["timeout-or-duplicate"] });
    if (secret !== SECRET_PASS) return ok({ success: false, "error-codes": ["invalid-input-secret"] });
    const t = minted.get(form.get("response") ?? "");
    if (!t) return ok({ success: false, "error-codes": ["invalid-input-response"] });
    if (t.spent) return ok({ success: false, "error-codes": ["timeout-or-duplicate"] });
    t.spent = true;
    return ok({ success: true, challenge_ts: "2026-11-05T10:00:00.000Z", hostname: t.hostname, "error-codes": [], action: t.action, cdata: "" });
  });
  return {
    impl,
    calls,
    mint(action: string, hostname = HOST): string {
      const token = `0.tok-${++n}-${action}`;
      minted.set(token, { action, hostname, spent: false });
      return token;
    },
  };
}

let cf: ReturnType<typeof fakeSiteverify>;
beforeEach(() => {
  vi.clearAllMocks();
  cf = fakeSiteverify();
  vi.stubGlobal("fetch", cf.impl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("turnstileMode: must this process check at all", () => {
  // Typed from the rule (docstring of turnstileMode), one row per class of process. The empty / unset cases come first: nothing set
  // at all is a vitest/dev process and must skip; a production process with nothing set must NOT (it enforces, and with no secret
  // the verifier then refuses everything: see the requireTurnstile cases below).
  const CASES: { name: string; env: Record<string, string | undefined>; want: "skip" | "enforce" }[] = [
    { name: "empty environment (an unconfigured dev process)", env: {}, want: "skip" },
    { name: "vitest, no secret", env: { NODE_ENV: "test" }, want: "skip" },
    { name: "dev with the live secret in .env.local", env: { NODE_ENV: "development", TURNSTILE_SECRET: SECRET_PASS }, want: "skip" },
    { name: "production harness ci, no secret", env: { NODE_ENV: "production", ENV_NAME: "ci" }, want: "skip" },
    { name: "production harness local WITH the secret (seazn-env loads .env.local)", env: { NODE_ENV: "production", ENV_NAME: "local", TURNSTILE_SECRET: SECRET_PASS }, want: "skip" },
    { name: "harness name is trimmed", env: { NODE_ENV: "production", ENV_NAME: " ci ", TURNSTILE_SECRET: SECRET_PASS }, want: "skip" },
    { name: "prod with a secret", env: { NODE_ENV: "production", ENV_NAME: "prod", TURNSTILE_SECRET: SECRET_PASS }, want: "enforce" },
    { name: "stg with a secret", env: { NODE_ENV: "production", ENV_NAME: "stg", TURNSTILE_SECRET: SECRET_PASS }, want: "enforce" },
    { name: "production that lost its ENV_NAME, with a secret: NOT a harness", env: { NODE_ENV: "production", TURNSTILE_SECRET: SECRET_PASS }, want: "enforce" },
    { name: "prod with no secret: still enforces (the verifier fails closed)", env: { NODE_ENV: "production", ENV_NAME: "prod" }, want: "enforce" },
    { name: "stg with an empty secret", env: { NODE_ENV: "production", ENV_NAME: "stg", TURNSTILE_SECRET: "" }, want: "enforce" },
    { name: "stg with a whitespace secret", env: { NODE_ENV: "production", ENV_NAME: "stg", TURNSTILE_SECRET: "   " }, want: "enforce" },
    { name: "production with nothing at all", env: { NODE_ENV: "production" }, want: "enforce" },
    { name: "ENV_NAME is matched exactly, so CI (capitals) is not the harness", env: { NODE_ENV: "production", ENV_NAME: "CI" }, want: "enforce" },
  ];

  it.each(CASES)("$name -> $want", ({ env, want }) => {
    expect(turnstileMode(env)).toBe(want);
  });

  it("every ENV_NAME the relay honours a fake under skips in production with no secret (one authority, not a second list)", () => {
    let checked = 0;
    for (const name of FAKE_DRIVER_ENV_NAMES) {
      expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: name }), name).toBe("skip");
      expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: name, TURNSTILE_SECRET: SECRET_PASS }), name).toBe("skip");
      checked++;
    }
    expect(checked, "anti-vacuity: the harness names were swept").toBeGreaterThanOrEqual(2);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "stg");
    vi.stubEnv("TURNSTILE_SECRET", SECRET_PASS);
    expect(turnstileMode()).toBe("enforce");
    vi.stubEnv("ENV_NAME", "ci");
    expect(turnstileMode()).toBe("skip");
  });
});

// The break-glass: `TURNSTILE=off` on a RUNNING deployment (a Fly secret) turns the check off without a rebuild, for the day
// Cloudflare or the widget is down or a mis-set site key locks every club out. The rule is typed from the brief: the switch is
// "off" and nothing else, compared case-insensitively after trimming. Every other value, the empty string and an unset variable
// enforce, so a typo ("false", "0", "no") never opens the door by accident.
describe("TURNSTILE=off: the break-glass is exactly 'off', and nothing else opens the door", () => {
  const DEPLOYED = { NODE_ENV: "production", ENV_NAME: "prod", TURNSTILE_SECRET: SECRET_PASS };
  const OFF = ["off", "OFF", "Off", "oFf", " off ", "\toff\n", "  OFF"];
  // Empty and unset first (the empty set answers "no" to everything and must land on enforce); then the near misses.
  const NOT_OFF: (string | undefined)[] = [undefined, "", " ", "false", "0", "no", "on", "ON", "1", "true", "of", "offf", "off off", "of f", "disabled", "off;", "o ff"];

  it.each(OFF)("TURNSTILE=%j skips, in production, on a named deployment, with its secret set", (value) => {
    expect(turnstileMode({ ...DEPLOYED, TURNSTILE: value })).toBe("skip");
  });

  it("it also skips a deployment that lost its secret or its ENV_NAME: the break-glass works exactly when the rest is broken", () => {
    expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: "stg", TURNSTILE: "off" })).toBe("skip");
    expect(turnstileMode({ NODE_ENV: "production", TURNSTILE: "off" })).toBe("skip");
    expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: "prod", TURNSTILE_SECRET: "", TURNSTILE: "off" })).toBe("skip");
  });

  it.each(NOT_OFF)("TURNSTILE=%j still enforces (production, prod, secret set)", (value) => {
    expect(turnstileMode({ ...DEPLOYED, TURNSTILE: value })).toBe("enforce");
  });

  it("anti-vacuity: both lists are real, and no value is on both", () => {
    expect(OFF.length).toBeGreaterThanOrEqual(6);
    expect(NOT_OFF.length).toBeGreaterThanOrEqual(15);
    expect(NOT_OFF).toContain(undefined);
    expect(NOT_OFF).toContain("");
    for (const v of OFF) expect(NOT_OFF.map((n) => n?.trim().toLowerCase()), JSON.stringify(v)).not.toContain(v.trim().toLowerCase());
  });

  it("only the variable TURNSTILE is the switch: 'off' in a neighbouring Turnstile variable does not turn the check off", () => {
    for (const key of ["TURNSTILE_SECRET", "TURNSTILE_HOSTNAMES", "NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_OFF", "turnstile", "ENV_NAME"]) {
      expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: "prod", [key]: "off" }), key).toBe("enforce");
    }
  });

  it("is read from process.env at call time, not captured at import (a Fly secret set on a running machine takes effect)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "prod");
    vi.stubEnv("TURNSTILE_SECRET", SECRET_PASS);
    vi.stubEnv("TURNSTILE_HOSTNAMES", HOST);
    const gate = (await import("../turnstile")).turnstileMode; // imported ONCE, before the switch exists
    expect(gate()).toBe("enforce");
    vi.stubEnv("TURNSTILE", "off");
    expect(gate()).toBe("skip");
    vi.stubEnv("TURNSTILE", "on");
    expect(gate(), "switching it back on enforces again").toBe("enforce");
  });
});

describe("verifyTurnstile: one token, one action, one host", () => {
  it("accepts a fresh token minted for this action on an allowed host, and sends Cloudflare the documented request", async () => {
    const token = cf.mint("login");
    expect(await verifyTurnstile({ token, action: "login", ip: "203.0.113.9", env: ENV })).toEqual({ ok: true });
    expect(cf.calls).toHaveLength(1);
    const [call] = cf.calls;
    expect(call!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(call!.url).toBe(SITEVERIFY_URL);
    expect(call!.init.method).toBe("POST");
    expect(call!.init.body).toBeInstanceOf(URLSearchParams); // urlencoded, one of the two bodies Cloudflare accepts
    expect(Object.fromEntries(call!.form)).toEqual({ secret: SECRET_PASS, response: token, remoteip: "203.0.113.9" });
    expect(call!.init.signal, "a hung Cloudflare must not hang the request").toBeInstanceOf(AbortSignal);
  });

  // The signal is what keeps a hung Cloudflare from hanging a login. Its VALUE is a decision: 10 s is long enough for a slow
  // siteverify and short enough that a request still answers inside a gateway's own timeout. 0 aborts every check (the whole site
  // locked out); minutes lets one dead upstream pin every in-flight request. Typed here, not read from SITEVERIFY_TIMEOUT_MS.
  it("the siteverify call is bounded by AbortSignal.timeout(10_000), and that very signal is the one fetch gets", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await verifyTurnstile({ token: cf.mint("login"), action: "login", env: ENV });
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(cf.calls).toHaveLength(1);
      expect(cf.calls[0]!.init.signal, "the signal handed to fetch is the one the timeout made").toBe(timeout.mock.results[0]!.value);
    } finally {
      timeout.mockRestore();
    }
  });

  it("omits remoteip when the address is unknown, empty or absent", async () => {
    for (const ip of [undefined, null, "", "unknown"]) {
      await verifyTurnstile({ token: cf.mint("login"), action: "login", ip, env: ENV });
    }
    expect(cf.calls).toHaveLength(4);
    for (const c of cf.calls) expect([...c.form.keys()].sort(), `ip arg`).toEqual(["response", "secret"]);
  });

  it("matches the hostname case-insensitively against a comma list (both entries, whitespace ignored)", async () => {
    let checked = 0;
    for (const hostname of ["seazn.test", "SEAZN.test", "stg.seazn.test", "Stg.Seazn.Test"]) {
      expect(await verifyTurnstile({ token: cf.mint("join", hostname), action: "join", env: ENV }), hostname).toEqual({ ok: true });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("refuses a token minted on a host that is not listed: a look-alike, a suffix, a prefix, a subdomain, localhost", async () => {
    const BAD = ["evil-seazn.test", "seazn.test.evil.example", "www.seazn.test", "x.stg.seazn.test", "localhost", "127.0.0.1", ""];
    for (const hostname of BAD) {
      expect(await verifyTurnstile({ token: cf.mint("join", hostname), action: "join", env: ENV }), JSON.stringify(hostname)).toEqual({ ok: false, reason: "wrong_hostname" });
    }
    expect(BAD.length).toBeGreaterThanOrEqual(7);
  });

  it("refuses a token whose response carries no hostname at all", async () => {
    cf.impl.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, action: "join" })));
    expect(await verifyTurnstile({ token: "t", action: "join", env: ENV })).toEqual({ ok: false, reason: "wrong_hostname" });
  });

  it("refuses a token minted for another action (a login token is not a registration), for every ordered pair of actions", async () => {
    let checked = 0;
    for (const minted of TURNSTILE_ACTIONS) {
      for (const asked of TURNSTILE_ACTIONS) {
        const got = await verifyTurnstile({ token: cf.mint(minted), action: asked, env: ENV });
        expect(got, `${minted} spent as ${asked}`).toEqual(minted === asked ? { ok: true } : { ok: false, reason: "wrong_action" });
        checked++;
      }
    }
    expect(checked).toBe(TURNSTILE_ACTIONS.length ** 2);
  });

  it("refuses a response with no action when one is expected", async () => {
    cf.impl.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, hostname: HOST })));
    expect(await verifyTurnstile({ token: "t", action: "login", env: ENV })).toEqual({ ok: false, reason: "wrong_action" });
  });

  it("refuses when Cloudflare says success:false and keeps its error codes for the log (the 2x test secret always fails)", async () => {
    const got = await verifyTurnstile({ token: cf.mint("login"), action: "login", env: { ...ENV, TURNSTILE_SECRET: SECRET_FAIL } });
    expect(got).toEqual({ ok: false, reason: "rejected", errorCodes: ["invalid-input-response"] });
  });

  it("success must be exactly the boolean true: a string, a number, an object or nothing is a refusal", async () => {
    for (const success of ["true", 1, {}, [], null, undefined]) {
      cf.impl.mockImplementationOnce(async () => new Response(JSON.stringify({ success, action: "login", hostname: HOST })));
      expect(await verifyTurnstile({ token: "t", action: "login", env: ENV }), JSON.stringify(success)).toMatchObject({ ok: false, reason: "rejected" });
    }
  });

  it("a replayed token is refused (Cloudflare: timeout-or-duplicate), and a good verdict is never cached", async () => {
    const token = cf.mint("register");
    expect(await verifyTurnstile({ token, action: "register", env: ENV })).toEqual({ ok: true });
    expect(await verifyTurnstile({ token, action: "register", env: ENV })).toEqual({ ok: false, reason: "rejected", errorCodes: ["timeout-or-duplicate"] });
    expect(cf.impl, "the second use went to Cloudflare again; nothing was remembered locally").toHaveBeenCalledTimes(2);
  });

  it("the 3x test secret (token already spent) refuses even a first use", async () => {
    expect(await verifyTurnstile({ token: cf.mint("login"), action: "login", env: { ...ENV, TURNSTILE_SECRET: SECRET_SPENT } })).toEqual({
      ok: false,
      reason: "rejected",
      errorCodes: ["timeout-or-duplicate"],
    });
  });

  describe("input guards: nothing is sent to Cloudflare for a token that cannot be one", () => {
    it.each([
      ["undefined", undefined, "no_token"],
      ["null", null, "no_token"],
      ["empty string", "", "no_token"],
      ["a number", 123, "bad_token"],
      ["an object", { a: 1 }, "bad_token"],
      ["an array", ["x"], "bad_token"],
      ["one char past the bound", "x".repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1), "bad_token"],
    ])("%s", async (_name, token, reason) => {
      expect(await verifyTurnstile({ token, action: "login", env: ENV })).toEqual({ ok: false, reason });
      expect(cf.impl).not.toHaveBeenCalled();
    });

    it("a token exactly at Cloudflare's 2048-char bound is still sent", async () => {
      cf.impl.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, action: "login", hostname: HOST })));
      expect(await verifyTurnstile({ token: "x".repeat(2048), action: "login", env: ENV })).toEqual({ ok: true });
      expect(TURNSTILE_TOKEN_MAX_LENGTH).toBe(2048); // the documented bound, typed independently of the constant's use above
    });
  });

  describe("configuration guards: fail closed, and before any network call", () => {
    it.each([
      ["TURNSTILE_SECRET unset", { TURNSTILE_HOSTNAMES: "seazn.test" }, "secret_unset"],
      ["TURNSTILE_SECRET blank", { TURNSTILE_SECRET: "  ", TURNSTILE_HOSTNAMES: "seazn.test" }, "secret_unset"],
      ["TURNSTILE_HOSTNAMES unset", { TURNSTILE_SECRET: SECRET_PASS }, "hostnames_unset"],
      ["TURNSTILE_HOSTNAMES empty", { TURNSTILE_SECRET: SECRET_PASS, TURNSTILE_HOSTNAMES: "" }, "hostnames_unset"],
      ["TURNSTILE_HOSTNAMES only separators", { TURNSTILE_SECRET: SECRET_PASS, TURNSTILE_HOSTNAMES: " , ,, " }, "hostnames_unset"],
    ])("%s", async (_name, env, reason) => {
      expect(await verifyTurnstile({ token: cf.mint("login"), action: "login", env })).toEqual({ ok: false, reason });
      expect(cf.impl).not.toHaveBeenCalled();
    });

    it("an empty hostname entry never matches an empty hostname in the response", async () => {
      // `seazn.test,,` has a blank entry; a response with hostname "" must not slip through it.
      const env = { TURNSTILE_SECRET: SECRET_PASS, TURNSTILE_HOSTNAMES: "seazn.test,," };
      expect(await verifyTurnstile({ token: cf.mint("login", ""), action: "login", env })).toEqual({ ok: false, reason: "wrong_hostname" });
    });
  });

  describe("Cloudflare misbehaving: every failure mode is a refusal", () => {
    it("a network error", async () => {
      cf.impl.mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await verifyTurnstile({ token: "t", action: "login", env: ENV })).toEqual({ ok: false, reason: "unreachable" });
    });

    it("a timeout (the abort the 10 s signal raises)", async () => {
      cf.impl.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      expect(await verifyTurnstile({ token: "t", action: "login", env: ENV })).toEqual({ ok: false, reason: "unreachable" });
    });

    it("a non-2xx, even when its body says success", async () => {
      for (const status of [400, 429, 500, 502, 503]) {
        cf.impl.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, action: "login", hostname: HOST }), { status }));
        expect(await verifyTurnstile({ token: "t", action: "login", env: ENV }), String(status)).toEqual({ ok: false, reason: "unreachable" });
      }
    });

    it("a body that is not JSON (a proxy's HTML page)", async () => {
      cf.impl.mockImplementationOnce(async () => new Response("<html>Bad gateway</html>", { status: 200 }));
      expect(await verifyTurnstile({ token: "t", action: "login", env: ENV })).toEqual({ ok: false, reason: "bad_response" });
    });

    it("JSON that is not an object", async () => {
      for (const body of ["null", '"ok"', "42", "true"]) {
        cf.impl.mockImplementationOnce(async () => new Response(body, { status: 200 }));
        expect(await verifyTurnstile({ token: "t", action: "login", env: ENV }), body).toEqual({ ok: false, reason: "bad_response" });
      }
    });

    it("error codes are kept as short strings only, capped", async () => {
      cf.impl.mockImplementationOnce(
        async () => new Response(JSON.stringify({ success: false, "error-codes": ["a", 7, { x: 1 }, "b".repeat(200), ...Array.from({ length: 20 }, (_, i) => `c${i}`)] })),
      );
      const got = await verifyTurnstile({ token: "t", action: "login", env: ENV });
      expect(got.ok).toBe(false);
      const codes = (got as { errorCodes: string[] }).errorCodes;
      expect(codes).toHaveLength(8);
      expect(codes.every((c) => typeof c === "string" && c.length <= 64)).toBe(true);
      expect(codes.slice(0, 2)).toEqual(["a", "b".repeat(64)]);
    });
  });
});

describe("requireTurnstile: the gate a route calls", () => {
  const prod = (over: Record<string, string> = {}) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "stg");
    vi.stubEnv("TURNSTILE_SECRET", SECRET_PASS);
    vi.stubEnv("TURNSTILE_HOSTNAMES", HOST);
    for (const [k, v] of Object.entries(over)) vi.stubEnv(k, v);
  };
  const req = (headers: Record<string, string> = {}) => new Request("https://x.test/api/any", { method: "POST", headers });
  const refusal = async (p: Promise<void>): Promise<HttpError> => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  };

  it("the header name is Cloudflare's own field name", () => {
    expect(TURNSTILE_HEADER).toBe("cf-turnstile-response");
  });

  it("skip mode (vitest, dev, a harness server): resolves without a token and never calls Cloudflare", async () => {
    await expect(requireTurnstile(req(), "login")).resolves.toBeUndefined(); // NODE_ENV is "test" here
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "ci");
    await expect(requireTurnstile(req(), "login")).resolves.toBeUndefined();
    expect(cf.impl).not.toHaveBeenCalled();
  });

  describe("TURNSTILE=off", () => {
    it("a deployed server resolves with NO token and never calls Cloudflare, for every action", async () => {
      prod({ TURNSTILE: "off" });
      let checked = 0;
      for (const action of TURNSTILE_ACTIONS) {
        await expect(requireTurnstile(req(), action), action).resolves.toBeUndefined();
        checked++;
      }
      expect(checked).toBe(TURNSTILE_ACTIONS.length);
      expect(cf.impl).not.toHaveBeenCalled();
    });

    it("' off ' and 'OFF' skip; 'false', '0', 'no', the empty string and unset still refuse a request with no token (403 TURNSTILE_FAILED)", async () => {
      let checked = 0;
      for (const [value, skips] of [[" off ", true], ["OFF", true], ["false", false], ["0", false], ["no", false], ["", false], [undefined, false]] as const) {
        vi.unstubAllEnvs();
        prod();
        if (value !== undefined) vi.stubEnv("TURNSTILE", value);
        const verdict = requireTurnstile(req(), "register");
        if (skips) await expect(verdict, JSON.stringify(value)).resolves.toBeUndefined();
        else expect((await refusal(verdict)).code, JSON.stringify(value)).toBe(TURNSTILE_ERROR_CODE);
        checked++;
      }
      expect(checked).toBe(7);
    });

    it("warns loudly ONCE per process, however many requests it lets through, and the warning names the switch", async () => {
      vi.resetModules(); // a fresh module is a fresh process: the once-flag is module state
      const fresh = await import("../turnstile");
      prod({ TURNSTILE: "off" });
      for (let i = 0; i < 5; i++) await fresh.requireTurnstile(req(), "login");
      expect(logMock.warn, "one warning for five requests").toHaveBeenCalledTimes(1);
      const [fields, message] = logMock.warn.mock.calls[0]!;
      expect(message).toContain("TURNSTILE=off");
      expect(String(message).toLowerCase()).toContain("disabled");
      expect(fields).toMatchObject({ env_name: "stg" });
      expect(logMock.error).not.toHaveBeenCalled();
      expect(cf.impl).not.toHaveBeenCalled();
    });

    it("says nothing when it is not what skipped the check (a harness or a dev process skips anyway)", async () => {
      vi.resetModules();
      const fresh = await import("../turnstile");
      await fresh.requireTurnstile(req(), "login"); // vitest: NODE_ENV test
      vi.stubEnv("TURNSTILE", "off");
      await fresh.requireTurnstile(req(), "login"); // still NODE_ENV test
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENV_NAME", "ci");
      await fresh.requireTurnstile(req(), "login"); // a harness server
      expect(logMock.warn).not.toHaveBeenCalled();
    });

    it("takes effect on a running process and is reversible: refuses, then lets through once switched off, then refuses again", async () => {
      prod();
      expect((await refusal(requireTurnstile(req(), "join"))).status).toBe(403);
      vi.stubEnv("TURNSTILE", "off");
      await expect(requireTurnstile(req(), "join")).resolves.toBeUndefined();
      vi.stubEnv("TURNSTILE", "");
      expect((await refusal(requireTurnstile(req(), "join"))).status).toBe(403);
    });

    it("a token sent anyway is not even looked at while it is off (the widget still runs, the server just does not enforce)", async () => {
      prod({ TURNSTILE: "off" });
      await requireTurnstile(req({ [TURNSTILE_HEADER]: "garbage" }), "withdraw");
      await requireTurnstile(req({ [TURNSTILE_HEADER]: cf.mint("withdraw") }), "withdraw");
      expect(cf.impl).not.toHaveBeenCalled();
    });
  });

  it("a deployment with NO secret: 403 TURNSTILE_FAILED even for a plausible token, no call to Cloudflare, logged as an error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENV_NAME", "prod");
    vi.stubEnv("TURNSTILE_SECRET", "");
    const err = await refusal(requireTurnstile(req({ [TURNSTILE_HEADER]: cf.mint("login") }), "login"));
    expect(err.status).toBe(403);
    expect(err.code).toBe(TURNSTILE_ERROR_CODE);
    expect(cf.impl).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });

  it("enforce mode: a good token resolves; the same token a second time is a 403", async () => {
    prod();
    const token = cf.mint("withdraw");
    await expect(requireTurnstile(req({ [TURNSTILE_HEADER]: token }), "withdraw")).resolves.toBeUndefined();
    const err = await refusal(requireTurnstile(req({ [TURNSTILE_HEADER]: token }), "withdraw"));
    expect([err.status, err.code]).toEqual([403, TURNSTILE_ERROR_CODE]);
    expect(cf.impl).toHaveBeenCalledTimes(2);
  });

  it("enforce mode: no header, an empty header, an oversize header, a wrong-action token and a wrong-host token are all 403 with the same public message", async () => {
    prod();
    const messages = new Set<string>();
    const cases: Record<string, Request> = {
      "no header": req(),
      "empty header": req({ [TURNSTILE_HEADER]: "" }),
      oversize: req({ [TURNSTILE_HEADER]: "x".repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1) }),
      "wrong action": req({ [TURNSTILE_HEADER]: cf.mint("login") }),
      "wrong host": req({ [TURNSTILE_HEADER]: cf.mint("start", "evil.example") }),
      "unknown token": req({ [TURNSTILE_HEADER]: "never-minted" }),
    };
    for (const [name, r] of Object.entries(cases)) {
      const err = await refusal(requireTurnstile(r, "start"));
      expect([name, err.status, err.code]).toEqual([name, 403, TURNSTILE_ERROR_CODE]);
      messages.add(err.message);
    }
    expect(messages.size, "the caller is never told WHICH check failed").toBe(1);
    expect(Object.keys(cases)).toHaveLength(6);
  });

  it("enforce mode with TURNSTILE_HOSTNAMES missing: 403 and the operator sees an error, not a warning", async () => {
    prod({ TURNSTILE_HOSTNAMES: "" });
    const err = await refusal(requireTurnstile(req({ [TURNSTILE_HEADER]: cf.mint("login") }), "login"));
    expect(err.status).toBe(403);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(cf.impl).not.toHaveBeenCalled();
  });

  it("a refused token is a warning with the reason and the action, and the token and secret are never logged", async () => {
    prod();
    const token = cf.mint("login");
    await refusal(requireTurnstile(req({ [TURNSTILE_HEADER]: token }), "join"));
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls[0]![0]).toMatchObject({ action: "join", reason: "wrong_action" });
    const everything = JSON.stringify([logMock.warn.mock.calls, logMock.error.mock.calls]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(SECRET_PASS);
  });

  // The visitor's address is the shared reader's (`lib/client-ip.ts`, the one every per-IP limiter keys on), not a copy of its
  // chain: behind Cloudflare the TCP peer Fly sees is a shared edge, and siteverify's `remoteip` must be the visitor.
  const seenIp = async (headers: Record<string, string>) => {
    await requireTurnstile(req({ ...headers, [TURNSTILE_HEADER]: cf.mint("login") }), "login");
    return cf.calls.at(-1)!.form.get("remoteip");
  };
  // 173.245.48.0/20 is the first range on https://www.cloudflare.com/ips-v4 (a Cloudflare edge); 203.0.113.0/24 is TEST-NET-3.
  const CF_EDGE = "173.245.48.7";
  const VISITOR = "203.0.113.50";

  it("outside Fly (local, CI): first x-forwarded-for hop, else x-real-ip, else no remoteip", async () => {
    prod();
    expect(await seenIp({ "x-forwarded-for": "203.0.113.5, 10.0.0.1", "x-real-ip": "198.51.100.1" })).toBe("203.0.113.5");
    expect(await seenIp({ "x-real-ip": "198.51.100.1" })).toBe("198.51.100.1");
    expect(await seenIp({})).toBeNull();
    expect(await seenIp({ "x-forwarded-for": "" })).toBeNull();
  });

  it("behind Cloudflare and Fly: remoteip is the VISITOR (CF-Connecting-IP), not the shared Cloudflare edge Fly saw", async () => {
    prod();
    vi.stubEnv("CF_ORIGIN_SECRET", "");
    expect(await seenIp({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR })).toBe(VISITOR);
    // the old chain read x-forwarded-for first; Fly APPENDS to it, so a forged first hop must not win over the vouched header
    expect(await seenIp({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "x-forwarded-for": "198.51.100.99" })).toBe(VISITOR);
  });

  it("reaching Fly directly: a forged CF-Connecting-IP or x-forwarded-for is not believed, Fly's own peer is sent", async () => {
    prod();
    vi.stubEnv("CF_ORIGIN_SECRET", "");
    const DIRECT = "198.51.100.23"; // TEST-NET-2: not a Cloudflare range
    expect(await seenIp({ "fly-client-ip": DIRECT, "cf-connecting-ip": "203.0.113.200", "x-forwarded-for": "203.0.113.201" })).toBe(DIRECT);
  });

  it("a Cloudflare Worker's subrequest (cf-worker) is not believed either: the edge itself is sent", async () => {
    prod();
    vi.stubEnv("CF_ORIGIN_SECRET", "");
    expect(await seenIp({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "cf-worker": "evil.example" })).toBe(CF_EDGE);
  });

  it("with the origin secret set, a Cloudflare peer without our stamp is not believed; with it, the visitor is", async () => {
    prod();
    const SECRET_STAMP = "stamp-secret-not-a-real-one-0123456789abcdef";
    vi.stubEnv("CF_ORIGIN_SECRET", SECRET_STAMP);
    expect(await seenIp({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR })).toBe(CF_EDGE);
    expect(await seenIp({ "fly-client-ip": CF_EDGE, "cf-connecting-ip": VISITOR, "x-seazn-origin-secret": SECRET_STAMP })).toBe(VISITOR);
    // the stamp is a secret: it never reaches siteverify, and the mismatch report (a log line) never carries it
    expect(String(cf.calls.at(-1)!.init.body)).not.toContain(SECRET_STAMP);
    expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain(SECRET_STAMP);
  });
});

describe("isTurnstileRefusal: what a client does with the error it caught", () => {
  const err = (status: number, code?: string) => Object.assign(new Error("x"), { status, code });
  it("is the 403 that carries the fixed code, and nothing else", () => {
    expect(isTurnstileRefusal(err(403, TURNSTILE_ERROR_CODE))).toBe(true);
    for (const e of [err(403), err(403, "FORBIDDEN"), err(500, TURNSTILE_ERROR_CODE), err(409, TURNSTILE_ERROR_CODE), new Error("x"), "TURNSTILE_FAILED", null, undefined, { status: 403, code: TURNSTILE_ERROR_CODE }]) {
      expect(isTurnstileRefusal(e), String(e)).toBe(false);
    }
  });
});

// The wire contract, typed from Cloudflare's published names and the decisions in lib/turnstile.ts: every other test reads these
// constants from the module, so only a literal here makes a rename a deliberate act. The client side (turnstile-client.test.ts,
// turnstile-surfaces-wiring.test.tsx, the join and register interaction tests) types the same two strings independently.
describe("the wire contract between the browser and the server", () => {
  it("the token travels in `cf-turnstile-response` and a refusal carries `TURNSTILE_FAILED`", () => {
    expect(TURNSTILE_HEADER).toBe("cf-turnstile-response");
    expect(TURNSTILE_ERROR_CODE).toBe("TURNSTILE_FAILED");
    expect(TURNSTILE_TOKEN_MAX_LENGTH, "Cloudflare: 'Maximum length: 2048 characters'").toBe(2048);
  });

  it("the six declared actions are exactly these (seven routes: withdraw is shared), and every one is a legal Cloudflare action (A-Za-z0-9_-, 32 chars at most)", () => {
    expect([...TURNSTILE_ACTIONS].sort()).toEqual(["join", "login", "register", "resend", "start", "withdraw"]);
    let checked = 0;
    for (const a of TURNSTILE_ACTIONS) {
      expect(a, a).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(6);
  });
});
