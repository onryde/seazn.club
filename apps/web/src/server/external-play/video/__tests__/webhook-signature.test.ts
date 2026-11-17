// Check-in capacity plan 1, Task 4 (spec §6.2, Global Constraints): RealtimeKit webhook signature verification and the key cache.
//
// The ONLY gate on a public, unauthenticated route (Task 7), so every refusal has its own case: a changed body, a re-serialized
// body, another key, a missing or garbage signature, an empty body, a key that does not import, a key served from the wrong
// origin, a failed fetch, and a forged-signature storm. Expected values come from the generated key pair, the brief's declared
// constants and the fixture's own record (its served key, its signed bodies), never from the module under test. Sweeps count
// what they checked; zero (or anything but the stated total) is a failure.
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type FixtureWebhook, type RealtimeKitFixtureServer,
} from "../../../../../e2e/realtimekit-fixture-server";
import { CF_BASE } from "../realtimekit";
import {
  REALTIMEKIT_WEBHOOK_KEY_URL,
  WEBHOOK_KEY_REFETCH_MIN_MS,
  WEBHOOK_KEY_TTL_MS,
  forgetWebhookKey,
  importWebhookPublicKey,
  verifyRealtimeKitSignature,
  webhookKeyUrl,
  webhookPublicKey,
} from "../webhook-signature";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();
const signed = (body: string) => sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64");

const FIXTURE_BASE = "http://127.0.0.1:4322";

/** A counting key-host stub. `serve` answers each request (a value is sent as the JSON body, an Error rejects the fetch, a
 *  Response is returned as is). Records the URL and init of every request. */
function keyHost(serve: () => unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const answer = serve();
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}
const doc = (publicKey: string) => ({ success: true, data: { publicKey } });

beforeEach(() => forgetWebhookKey());
afterEach(() => vi.unstubAllEnvs());

describe("verifyRealtimeKitSignature", () => {
  it("verifies a signature over the exact bytes and refuses a changed body, another key, and garbage", () => {
    expect(verifyRealtimeKitSignature("{}", signed("{}"), pem)).toBe(true);
    expect(verifyRealtimeKitSignature("{} ", signed("{}"), pem)).toBe(false);
    expect(verifyRealtimeKitSignature("{}", signed("{}"), otherPem)).toBe(false);
    expect(verifyRealtimeKitSignature("{}", "not base64!", pem)).toBe(false);
    expect(verifyRealtimeKitSignature("{}", signed("{}"), "not a pem")).toBe(false);
  });

  it("a signature over the vendor's bytes does not survive re-serialization: the raw body verifies, a re-stringified one refuses", () => {
    const raw = '{"event":"meeting.ended","meeting":{"id":"mtg-1","sessionId":"s-1","endedAt":"2026-11-17T10:00:00.000Z"}}';
    const sig = signed(raw);
    const reserialized = [JSON.stringify(JSON.parse(raw), null, 2), JSON.stringify(JSON.parse(raw), Object.keys(JSON.parse(raw)).reverse())];
    // anti-vacuity: each re-serialization is a real change of bytes, else the refusal below proves nothing
    for (const r of reserialized) expect(r).not.toBe(raw);
    expect(verifyRealtimeKitSignature(raw, sig, pem)).toBe(true);
    expect(reserialized.map((r) => verifyRealtimeKitSignature(r, sig, pem))).toEqual([false, false]);
  });

  it("refuses a missing header, an empty signature, an empty body and a signature made by another key; never throws (9 hostile cases counted)", () => {
    const otherSigned = sign("RSA-SHA256", Buffer.from("{}"), other.privateKey).toString("base64");
    const hostile: [string, unknown, unknown, unknown][] = [
      ["missing header (null)", "{}", null, pem],
      ["missing header (undefined)", "{}", undefined, pem],
      ["empty signature", "{}", "", pem],
      ["empty body under a signature of another body", "", signed("{}"), pem],
      ["signed by another private key", "{}", otherSigned, pem],
      ["signature truncated", "{}", signed("{}").slice(0, 40), pem],
      ["empty key", "{}", signed("{}"), ""],
      ["non-string key", "{}", signed("{}"), 42],
      ["non-string body", { not: "a string" }, signed("{}"), pem],
    ];
    let checked = 0;
    for (const [name, body, sig, key] of hostile) {
      let out: unknown;
      expect(() => {
        out = verifyRealtimeKitSignature(body as string, sig as string, key as string);
      }, name).not.toThrow();
      expect(out, name).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(9);
    // positive pair: the same harness accepts the one honest case, so the refusals above are not a harness that refuses all
    expect(verifyRealtimeKitSignature("", signed(""), pem)).toBe(true);
  });
});

describe("importWebhookPublicKey", () => {
  it("imports the key in every shape a vendor may serve: SPKI PEM, PKCS#1 PEM, a PEM with escaped newlines, bare base64 DER; and not garbage (6 cases counted)", () => {
    const pkcs1 = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
    const shapes: [string, string][] = [
      ["SPKI PEM", pem],
      ["PKCS#1 PEM", pkcs1],
      ["SPKI PEM, escaped newlines", pem.replace(/\n/g, "\\n")],
      ["PKCS#1 PEM, escaped newlines", pkcs1.replace(/\n/g, "\\n")],
      ["bare base64 DER (SPKI)", publicKey.export({ type: "spki", format: "der" }).toString("base64")],
    ];
    // anti-vacuity: the escaped shapes really carry no newline, the PKCS#1 one really is PKCS#1, the DER one has no armour
    expect(shapes[1][1]).toContain("BEGIN RSA PUBLIC KEY");
    expect(shapes[2][1]).not.toContain("\n");
    expect(shapes[3][1]).not.toContain("\n");
    expect(shapes[4][1]).not.toContain("BEGIN");

    let checked = 0;
    for (const [name, served] of shapes) {
      const key = importWebhookPublicKey(served);
      expect(key, name).not.toBeNull();
      // the SAME key, whatever the shape: compared through its canonical SPKI export against the generated key's
      expect(key!.export({ type: "spki", format: "pem" }).toString(), name).toBe(pem);
      expect(verifyRealtimeKitSignature("{}", signed("{}"), served), name).toBe(true);
      checked += 1;
    }
    expect(importWebhookPublicKey("not a key")).toBeNull();
    checked += 1;
    expect(checked).toBe(5 + 1);
  });

  it("refuses what is not a public key in any of the shapes: empty, whitespace, non-base64, a truncated PEM, DER of nothing (5 counted)", () => {
    const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const garbage = ["", "   \n ", "%%% not base64 %%%", pem.slice(0, 120), der.slice(0, 32)];
    let checked = 0;
    for (const g of garbage) {
      expect(importWebhookPublicKey(g), JSON.stringify(g.slice(0, 30))).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

describe("webhookKeyUrl", () => {
  it("the key URL: Cloudflare's base reads Cloudflare's published key; a fixture base reads its own origin", () => {
    expect(webhookKeyUrl(CF_BASE)).toBe(REALTIMEKIT_WEBHOOK_KEY_URL);
    expect(webhookKeyUrl(`${CF_BASE}/`)).toBe(REALTIMEKIT_WEBHOOK_KEY_URL);
    expect(webhookKeyUrl("http://127.0.0.1:4322")).toBe("http://127.0.0.1:4322/.well-known/webhooks.json");
    expect(webhookKeyUrl("http://127.0.0.1:4322/some/path/")).toBe("http://127.0.0.1:4322/.well-known/webhooks.json");
  });

  it("the constants are the spec's: Cloudflare's published URL, a day's TTL, a minute's refetch floor", () => {
    expect(REALTIMEKIT_WEBHOOK_KEY_URL).toBe("https://api.realtime.cloudflare.com/.well-known/webhooks.json");
    expect(WEBHOOK_KEY_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(WEBHOOK_KEY_REFETCH_MIN_MS).toBe(60 * 1000);
    // Cloudflare's base is what realtimekit.ts meters by; the key host is a DIFFERENT host, named only by the constant above
    expect(CF_BASE).toBe("https://api.cloudflare.com/client/v4");
  });
});

describe("webhookPublicKey", () => {
  it("caches for the TTL, refetches after it and on force, floors forced refetches on Cloudflare's base, keeps the old key across a failed refetch", async () => {
    let failing = false;
    const host = keyHost(() => (failing ? new Error("key host down") : doc(pem)));
    const ask = (now: number, force = false) => webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now, force });

    expect([await ask(0), await ask(0)]).toEqual([
      { key: pem, fetched: true },
      { key: pem, fetched: false },
    ]);
    expect(host.calls.length).toBe(1);
    expect(await ask(WEBHOOK_KEY_TTL_MS)).toEqual({ key: pem, fetched: true });
    expect(host.calls.length).toBe(2);
    expect(await ask(WEBHOOK_KEY_TTL_MS, true)).toEqual({ key: pem, fetched: true });
    expect(host.calls.length).toBe(3);
    expect(await ask(WEBHOOK_KEY_TTL_MS + 1_000, true)).toEqual({ key: pem, fetched: false }); // floored
    expect(host.calls.length).toBe(3);
    expect(await ask(WEBHOOK_KEY_TTL_MS + WEBHOOK_KEY_REFETCH_MIN_MS, true)).toEqual({ key: pem, fetched: true });
    expect(host.calls.length).toBe(4);
    failing = true;
    expect(await ask(WEBHOOK_KEY_TTL_MS + 2 * WEBHOOK_KEY_REFETCH_MIN_MS, true)).toEqual({ key: pem, fetched: false });
    expect(host.calls.length).toBe(5);
    // every request went to Cloudflare's published key URL, never the API base's origin
    expect(new Set(host.calls.map((c) => c.url))).toEqual(new Set([REALTIMEKIT_WEBHOOK_KEY_URL]));
  });

  it("a fixture base has no floor: two forced asks one second apart fetch twice, and the second returns the NEW key the stub now serves", async () => {
    let served = pem;
    const host = keyHost(() => doc(served));
    expect(await webhookPublicKey({ fetch: host.fetch, baseUrl: FIXTURE_BASE, now: 0, force: true })).toEqual({ key: pem, fetched: true });
    served = otherPem;
    expect(await webhookPublicKey({ fetch: host.fetch, baseUrl: FIXTURE_BASE, now: 1_000, force: true })).toEqual({ key: otherPem, fetched: true });
    expect(host.calls.map((c) => c.url)).toEqual([`${FIXTURE_BASE}/.well-known/webhooks.json`, `${FIXTURE_BASE}/.well-known/webhooks.json`]);
  });

  it("with no cached key a failed fetch throws", async () => {
    forgetWebhookKey();
    const failing = keyHost(() => new Error("key host down"));
    await expect(webhookPublicKey({ fetch: failing.fetch, baseUrl: CF_BASE, now: 0 })).rejects.toThrow();
    expect(failing.calls.length).toBe(1);
  });

  it("a forged-signature storm on Cloudflare's base calls out once per floor window: forced asks every second for 3 minutes fetch 4 times (181 asks counted)", async () => {
    const host = keyHost(() => doc(pem));
    await webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now: 0 }); // the routine first fetch
    let asks = 0;
    let fresh = 0;
    for (let t = 0; t <= 180_000; t += 1_000) {
      const r = await webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now: t, force: true });
      expect(r.key).toBe(pem);
      if (r.fetched) fresh += 1;
      asks += 1;
    }
    expect(asks).toBe(181);
    // one forced fetch per floor window: t = 0, 60, 120, 180 s (the floor constant, stated by the spec as one minute)
    const windows = Math.floor(180_000 / WEBHOOK_KEY_REFETCH_MIN_MS) + 1;
    expect(windows).toBe(4);
    expect(fresh).toBe(windows);
    expect(host.calls.length).toBe(1 + windows);
  });

  it("while the key host is down, a storm with no cached key calls out once per floor window and every ask throws (Cloudflare's base)", async () => {
    const host = keyHost(() => new Error("key host down"));
    let threw = 0;
    for (let t = 0; t < 2 * WEBHOOK_KEY_REFETCH_MIN_MS; t += 5_000) {
      await webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now: t, force: t % 10_000 === 0 }).then(
        () => expect.unreachable("no key was ever fetched"),
        () => void (threw += 1),
      );
    }
    expect(threw).toBe(24);
    expect(host.calls.length).toBe(2); // t = 0 and t = 60 s
  });

  it("while the key host is down, an expired cache keeps answering the old key and calls out once per floor window (Cloudflare's base)", async () => {
    let failing = false;
    const host = keyHost(() => (failing ? new Error("key host down") : doc(pem)));
    await webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now: 0 });
    failing = true;
    const answers = [];
    for (const t of [WEBHOOK_KEY_TTL_MS, WEBHOOK_KEY_TTL_MS + 1_000, WEBHOOK_KEY_TTL_MS + 30_000, WEBHOOK_KEY_TTL_MS + WEBHOOK_KEY_REFETCH_MIN_MS]) {
      answers.push(await webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now: t }));
    }
    expect(answers).toEqual(Array(4).fill({ key: pem, fetched: false }));
    expect(host.calls.length).toBe(1 + 2); // the first fetch, then TTL and TTL + 60 s
  });

  it("concurrent asks with no cached key share ONE fetch (10 asks counted), and all of them got a fresh key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const slow = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      await gate;
      return new Response(JSON.stringify(doc(pem)), { status: 200 });
    }) as typeof fetch;
    const asks = Array.from({ length: 10 }, () => webhookPublicKey({ fetch: slow, baseUrl: CF_BASE, now: 0 }));
    release();
    const answers = await Promise.all(asks);
    expect(answers.length).toBe(10);
    expect(answers).toEqual(Array(10).fill({ key: pem, fetched: true }));
    expect(calls.length).toBe(1);
  });

  it("a key cached for one base is never served for another: a fixture's key does not answer for Cloudflare's base, nor the reverse", async () => {
    const fixtureHost = keyHost(() => doc(otherPem));
    const cfHost = keyHost(() => doc(pem));
    expect(await webhookPublicKey({ fetch: fixtureHost.fetch, baseUrl: FIXTURE_BASE, now: 0 })).toEqual({ key: otherPem, fetched: true });
    expect(await webhookPublicKey({ fetch: cfHost.fetch, baseUrl: CF_BASE, now: 1 })).toEqual({ key: pem, fetched: true });
    expect(cfHost.calls.map((c) => c.url)).toEqual([REALTIMEKIT_WEBHOOK_KEY_URL]);
    expect(await webhookPublicKey({ fetch: fixtureHost.fetch, baseUrl: FIXTURE_BASE, now: 2 })).toEqual({ key: otherPem, fetched: true });
    expect(fixtureHost.calls.length).toBe(2);
  });

  it("a key document answered from another origin (a redirect off Cloudflare's key host) is never used", async () => {
    const offOrigin = () => {
      const res = new Response(JSON.stringify(doc(otherPem)), { status: 200 });
      Object.defineProperty(res, "url", { value: "https://attacker.example/.well-known/webhooks.json" });
      return res;
    };
    const host = keyHost(offOrigin);
    await expect(webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now: 0 })).rejects.toThrow();
    expect(host.calls.length).toBe(1);
    // with a good key cached, the off-origin answer is ignored and the cached key stands
    const good = keyHost(() => doc(pem));
    await webhookPublicKey({ fetch: good.fetch, baseUrl: CF_BASE, now: WEBHOOK_KEY_REFETCH_MIN_MS });
    expect(await webhookPublicKey({ fetch: host.fetch, baseUrl: CF_BASE, now: 2 * WEBHOOK_KEY_REFETCH_MIN_MS, force: true })).toEqual({ key: pem, fetched: false });
    // positive pair: a same-origin answer with the url set is accepted
    const sameOrigin = keyHost(() => {
      const res = new Response(JSON.stringify(doc(pem)), { status: 200 });
      Object.defineProperty(res, "url", { value: REALTIMEKIT_WEBHOOK_KEY_URL });
      return res;
    });
    forgetWebhookKey();
    expect(await webhookPublicKey({ fetch: sameOrigin.fetch, baseUrl: CF_BASE, now: 0 })).toEqual({ key: pem, fetched: true });
  });

  it("a key document that is not a usable key is a failed fetch, never cached: non-200, no publicKey, a key that does not import (4 counted)", async () => {
    const bad: [string, () => unknown][] = [
      ["503", () => new Response(JSON.stringify(doc(pem)), { status: 503 })],
      ["no data", () => ({ success: true })],
      ["publicKey not a string", () => ({ success: true, data: { publicKey: 42 } })],
      ["publicKey does not import", () => doc("not a key")],
    ];
    let checked = 0;
    for (const [name, serve] of bad) {
      forgetWebhookKey();
      const host = keyHost(serve);
      await expect(webhookPublicKey({ fetch: host.fetch, baseUrl: FIXTURE_BASE, now: 0 }), name).rejects.toThrow();
      // and with a good key cached, a bad document leaves the good key in place
      const good = keyHost(() => doc(pem));
      await webhookPublicKey({ fetch: good.fetch, baseUrl: FIXTURE_BASE, now: 0 });
      expect(await webhookPublicKey({ fetch: host.fetch, baseUrl: FIXTURE_BASE, now: 1, force: true }), name).toEqual({ key: pem, fetched: false });
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("reads the vendor base AT CALL TIME: REALTIMEKIT_BASE_URL set reads the fixture's origin, unset reads Cloudflare's key URL", async () => {
    const host = keyHost(() => doc(pem));
    vi.stubEnv("REALTIMEKIT_BASE_URL", `${FIXTURE_BASE}/client/v4`);
    await webhookPublicKey({ fetch: host.fetch, now: 0 });
    vi.stubEnv("REALTIMEKIT_BASE_URL", undefined);
    await webhookPublicKey({ fetch: host.fetch, now: 0 });
    expect(host.calls.map((c) => c.url)).toEqual([`${FIXTURE_BASE}/.well-known/webhooks.json`, REALTIMEKIT_WEBHOOK_KEY_URL]);
    // every fetch is bounded in time: a hanging key host must not hang the public route
    for (const c of host.calls) expect(c.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

// AGENTS.md failure class 1: proven against the fixture's REAL served key and REAL signed bodies, over HTTP, not a hand-made pair.
describe("against the fixture vendor (Task 1): its served key verifies its own signed webhooks", () => {
  let fx: RealtimeKitFixtureServer;
  const got: FixtureWebhook[] = [];
  beforeAll(async () => {
    fx = await startRealtimeKitFixtureServer(0, { webhooks: async (w) => void got.push(w) });
  });
  afterAll(() => fx.close());

  it("fetches the fixture's key from its own origin, then verifies every webhook it signs and refuses each one re-serialized", async () => {
    const answer = await webhookPublicKey({ baseUrl: `${fx.url}/client/v4`, now: 0 });
    expect(answer).toEqual({ key: fx.publicKeyPem, fetched: true });

    const auth = { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json" };
    const m = (await (await fetch(`${fx.url}${fx.kitPath}/meetings`, { method: "POST", headers: auth, body: JSON.stringify({ title: "sig-seam" }) })).json()) as {
      data: { id: string };
    };
    const p = (await (
      await fetch(`${fx.url}${fx.kitPath}/meetings/${m.data.id}/participants`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ custom_participant_id: "person-sig", preset_name: REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_PLAYER_PRESET }),
      })
    ).json()) as { data: { id: string } };
    fx.setLivePublisher(p.data.id, true);
    fx.setLivePublisher(p.data.id, false);
    await fx.webhooksSettled();

    // anti-vacuity: the fixture's own record says join, leave, end
    expect(got.map((w) => w.event)).toEqual(["meeting.participantJoined", "meeting.participantLeft", "meeting.ended"]);
    let checked = 0;
    for (const w of got) {
      expect(verifyRealtimeKitSignature(w.body, w.signature, answer.key), w.event).toBe(true);
      const pretty = JSON.stringify(JSON.parse(w.body), null, 1);
      expect(pretty).not.toBe(w.body);
      expect(verifyRealtimeKitSignature(pretty, w.signature, answer.key), w.event).toBe(false);
      // and another start's key (a different key pair) refuses it
      expect(verifyRealtimeKitSignature(w.body, w.signature, otherPem), w.event).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

// The operator's staging check (plan 1 Task 12 step 3), run only when the fetched document is handed in; skipped in CI and in every
// normal run. Usage: RTK_WEBHOOK_KEY_DOC="$(curl -s https://api.realtime.cloudflare.com/.well-known/webhooks.json)" npx vitest run <this file>
it.skipIf(!process.env.RTK_WEBHOOK_KEY_DOC)("the live key document imports (Task 12 step 3)", () => {
  const live = JSON.parse(process.env.RTK_WEBHOOK_KEY_DOC!) as { data?: { publicKey?: unknown } };
  expect(typeof live.data?.publicKey).toBe("string");
  expect(importWebhookPublicKey(live.data!.publicKey as string)).not.toBeNull();
});
