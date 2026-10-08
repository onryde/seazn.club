// `loadStreamPanelContext` — THE authority for the stream panel's per-page context (spec 2026-09-30 §2 "Shared context
// loader"). The context-level cases MOVED here from the division page's own test (stream-checkout-return.test.tsx, Task
// 14 G1/M4/P1/I2/N1/RT), re-targeted at the loader directly: the page no longer owns the reads, so the page test keeps
// only the case proving it CALLS the loader. Every assertion keeps its strength — reconcile before the balance read, the
// balance and currency read concurrently (M4), no credits read without a running relay (that read GRANTS), one signed
// overlay key per listed fixture, and none when the overlay is switched off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async () => ({ "overlay.vs": "vs", "stream.title": "not overlay" })),
  t: (_dict: unknown, key: string) => key,
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
}));

const relay = vi.hoisted(() => ({
  reconcile: vi.fn<(orgId: string, sessionId: string) => Promise<boolean>>(async () => true),
  balance: vi.fn<(auth: unknown, orgId: string) => Promise<number>>(async () => 0),
  // `relayCredits` answers the balance split by bucket + the plan's monthly allowance. Its double is COMPOSED over
  // `balance` above, so every G1/M4 case keeps witnessing the same read; `split` shapes the rest.
  split: vi.fn<(total: number) => { monthly: number; pack: number; monthlyAllowance: number }>((total) => ({ monthly: 0, pack: total, monthlyAllowance: 1 })),
}));
vi.mock("@/server/usecases/stream-credits-checkout", () => ({
  reconcileStreamCreditsCheckout: (orgId: string, sessionId: string) => relay.reconcile(orgId, sessionId),
}));
// P1: the currency the relay-checkout route charges — the loader resolves the SAME function for the same org.
const money = vi.hoisted(() => ({ preferredCurrency: vi.fn<(orgId: string | null, req?: Request) => Promise<string>>(async () => "gbp") }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: (orgId: string | null, req?: Request) => money.preferredCurrency(orgId, req) }));
// Capture QR v2 (carry 2, owner 2026-10-04): the PostHog flag that offers the phone-camera option. Doubled at the
// helper the loader calls, so a test reads WHAT it asked (flag, distinct id, org group, fallback) and decides the answer.
const flags = vi.hoisted(() => ({
  isServerFeatureEnabled: vi.fn<(flag: string, distinctId: string, opts?: { orgId?: string; fallback?: boolean }) => Promise<boolean>>(async () => false),
}));
vi.mock("@/lib/posthog-server", () => ({
  isServerFeatureEnabled: (flag: string, distinctId: string, opts?: { orgId?: string; fallback?: boolean }) =>
    flags.isServerFeatureEnabled(flag, distinctId, opts),
}));
vi.mock("@/server/usecases/stream-sessions", () => ({
  relayCredits: async (auth: unknown, orgId: string) => {
    const total = await relay.balance(auth, orgId);
    return { ...relay.split(total), total };
  },
}));

import { CAPTURE_FLAG_TTL_MS, forgetCaptureFlagCache, loadStreamPanelContext } from "../stream-panel-context";
import { getDictionary } from "@/lib/i18n";
import { hasFeature } from "@/lib/entitlements";
import { disabledRelayDrivers, relayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { verifyOverlayKey } from "@/server/overlay/overlay-key";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { AUTO_STOP_AFTER_RESULT_SECONDS, PHONE_LOST_LIVE_MINUTES } from "@/server/relay/config";
import type { AuthCtx } from "@/server/api-v1/auth";

const AUTH = { orgId: "org-1", userId: "user-1", role: "owner", via: "session", keyId: null } as unknown as AuthCtx;
const args = {
  auth: AUTH,
  competitionId: "comp-1",
  sportKey: "generic",
  fixtureIds: ["fx-1"] as readonly string[],
  locale: "en" as const,
  offered: true,
};
type Checkout = { status?: string; sessionId?: string };
const load = (checkout?: Checkout, over: Partial<typeof args> = {}) => loadStreamPanelContext({ ...args, ...over, checkout });

beforeEach(() => {
  relay.reconcile.mockReset().mockResolvedValue(true);
  relay.balance.mockReset().mockResolvedValue(0);
  relay.split.mockReset().mockImplementation((total) => ({ monthly: 0, pack: total, monthlyAllowance: 1 }));
  money.preferredCurrency.mockReset().mockResolvedValue("gbp");
  vi.mocked(hasFeature).mockReset().mockImplementation(async () => true);
  vi.mocked(getDictionary).mockClear();
  flags.isServerFeatureEnabled.mockReset().mockResolvedValue(false);
  vi.stubEnv("CAPTURE_QR_V2_ALWAYS", undefined);
  forgetCaptureFlagCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the gate: offered:false reads NOTHING (review #11 — the scorer's and spectator's refresh stays free)", () => {
  it("offered:false reads NOTHING — no entitlement query, no reconcile, no credits, no currency, no dictionary (a read-only viewer or a frozen page)", async () => {
    const got = await load({ status: "success", sessionId: "cs_1" }, { offered: false });
    expect(got).toBeUndefined();
    const deps = [hasFeature, relay.reconcile, relay.balance, money.preferredCurrency, getDictionary, flags.isServerFeatureEnabled] as const;
    let checked = 0;
    for (const dep of deps) {
      expect(dep).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("the loader's reads: offered:true calls each dependency AT MOST once per render (hasFeature exactly twice, both competition-scoped) — the count cannot grow unnoticed", async () => {
    relay.balance.mockResolvedValue(3);
    const got = await load({ status: "success", sessionId: "cs_reads" });
    expect(got, "the positive pair: offered reads and returns a context").toBeDefined();
    expect(hasFeature).toHaveBeenCalledTimes(2);
    // An Event Pass grants for the competition it was bought for, so an org-wide resolve would deny the pass holder.
    expect(vi.mocked(hasFeature).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["streaming.overlay", "comp-1"],
      ["streaming.relay", "comp-1"],
    ]);
    const once = [relay.reconcile, relay.balance, money.preferredCurrency, getDictionary, flags.isServerFeatureEnabled] as const;
    let checked = 0;
    for (const dep of once) {
      expect(dep).toHaveBeenCalledTimes(1);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("the checkout return reconciles the session BEFORE the Phone tab's balance is read (G1)", () => {
  it("?checkout=success&session_id=… reconciles THAT session for THIS page's org, then reads the balance — and hands the tab the post-reconcile number", async () => {
    // The balance double answers 0 until the reconcile has run and the purchase's credits after — so the number the tab
    // receives can only be the fresh one if the ORDER is right (an order-blind test would pass on either).
    let reconciled = false;
    relay.reconcile.mockImplementation(async () => { reconciled = true; return true; });
    relay.balance.mockImplementation(async () => (reconciled ? 5 : 0));
    const balance = (await load({ status: "success", sessionId: "cs_test_return_1" }))?.streamBalance;
    expect(relay.reconcile).toHaveBeenCalledTimes(1);
    expect(relay.reconcile).toHaveBeenCalledWith(AUTH.orgId, "cs_test_return_1");
    expect(relay.reconcile.mock.invocationCallOrder[0]!).toBeLessThan(relay.balance.mock.invocationCallOrder[0]!);
    expect(balance, "the tab was handed the pre-reconcile balance").toBe(5);
  });

  it("an ordinary visit — no checkout, a cancelled checkout, a success without its session id — makes NO Stripe reconcile", async () => {
    relay.balance.mockResolvedValue(2);
    let checked = 0;
    for (const checkout of [undefined, { status: "cancel", sessionId: "cs_test_x" }, { status: "success" }] as (Checkout | undefined)[]) {
      // The positive half of the pair: the loader still hands the tab the balance it read (G4's seam, witnessed here).
      expect((await load(checkout))?.streamBalance, JSON.stringify(checkout)).toBe(2);
      checked++;
    }
    expect(checked).toBe(3);
    expect(relay.reconcile).not.toHaveBeenCalled();
  });
});

// Task 14b (R3b/R4): the balance is read through `relayCredits` — which grants this month's free credits first — and the
// Phone tab gets the chip's total, the split behind it and the plan's monthly allowance, from that ONE read.
describe("Task 14b: the Phone tab is handed the split and the monthly allowance from the loader's one credits read", () => {
  it("passes the total as the chip, the split behind it and the allowance — each a value no default could produce", async () => {
    relay.balance.mockResolvedValue(7);
    relay.split.mockReturnValue({ monthly: 2, pack: 5, monthlyAllowance: 20 });
    const stream = await load();
    expect(relay.balance).toHaveBeenCalledTimes(1);
    expect(relay.balance.mock.calls[0]![1]).toBe(AUTH.orgId);
    expect(stream?.streamBalance).toBe(7);
    expect(stream?.streamSplit).toEqual({ monthly: 2, pack: 5, total: 7 });
    expect(stream?.monthlyAllowance).toBe(20);
  });

  it("I2: a deployment with NO relay (R5's disabled drivers) tells the tab so, and reads no credits — that read GRANTS; the relay back on reads them again", async () => {
    relay.balance.mockResolvedValue(3);
    relay.split.mockReturnValue({ monthly: 1, pack: 2, monthlyAllowance: 1 });
    setRelayDriversForTest(disabledRelayDrivers());
    try {
      const off = await load();
      expect(off).toMatchObject({ relayEntitled: true, relayDisabled: true, streamBalance: 0, streamSplit: null });
      expect(relay.balance, "no grant-and-read on a relay-less deployment").not.toHaveBeenCalled();
    } finally {
      setRelayDriversForTest(null);
    }
    // The positive pair: the default (fake) drivers — the tab is live and the credits are read.
    expect(await load()).toMatchObject({ relayEntitled: true, relayDisabled: false, streamBalance: 3 });
    expect(relay.balance).toHaveBeenCalledTimes(1);
  });

  it("N1 + m1: a LIVE deployment missing a Cloudflare secret tells the Phone tab the relay is unavailable — no credits read; with both secrets it is live", async () => {
    // N1: the page asks "can this deployment stream?" on every render; answered by constructing the drivers, a live
    // deploy without CLOUDFLARE_* threw here for every org. m1: answered "yes" there, the tab offered Go live and buy
    // tiles on a deployment where every start fails.
    relay.balance.mockResolvedValue(4);
    try {
      vi.stubEnv("RELAY_DRIVERS", "live");
      vi.stubEnv("ENV_NAME", "prod");
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", "tok");
      setRelayDriversForTest(null);
      expect(() => relayDrivers(), "premise: constructing the drivers here throws").toThrow(/CLOUDFLARE_ACCOUNT_ID/);
      setRelayDriversForTest(null);
      expect(await load()).toMatchObject({ relayEntitled: true, relayDisabled: true, streamBalance: 0 });
      expect(relay.balance, "no grant-and-read on a deployment that cannot stream").not.toHaveBeenCalled();
      // The positive pair: the missing secret supplied — the tab is live and the credits are read.
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
      setRelayDriversForTest(null);
      expect(await load()).toMatchObject({ relayEntitled: true, relayDisabled: false, streamBalance: 4 });
      expect(relay.balance).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      setRelayDriversForTest(null);
    }
  });

  it("without the relay: no credits read, and the tab gets no split and no allowance — the empty case", async () => {
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.relay");
    const stream = await load();
    expect(relay.balance).not.toHaveBeenCalled();
    expect(stream).toMatchObject({ streamBalance: 0, streamSplit: null, monthlyAllowance: 0 });
  });
});

// P1 (Task 14 fix round 2): the tiles quoted GBP while `/api/billing/relay-checkout` charged `preferredCurrency(orgId,
// req)`. The loader resolves the same function for the same org and hands the Phone tab the result.
describe("P1: the Phone tab is handed the currency the checkout will charge", () => {
  beforeEach(() => {
    relay.balance.mockReset().mockResolvedValue(3);
  });

  it("resolves preferredCurrency for THIS org and passes it through — every non-GBP currency, not just one", async () => {
    // m10: the house list, not a typed copy — a currency added to SUPPORTED_CURRENCIES is swept here without an edit.
    // GBP is left out because it is the tiles' old default: a GBP case passes whether or not the loader passes anything.
    const nonGbp = SUPPORTED_CURRENCIES.filter((c) => c !== "gbp");
    expect(nonGbp.length, "premise: the house sells in more than GBP").toBeGreaterThan(0);
    let checked = 0;
    for (const currency of nonGbp) {
      money.preferredCurrency.mockClear().mockResolvedValue(currency);
      expect((await load())?.currency, currency).toBe(currency);
      expect(money.preferredCurrency).toHaveBeenCalledTimes(1);
      expect(money.preferredCurrency.mock.calls[0]![0]).toBe(AUTH.orgId);
      checked++;
    }
    expect(checked).toBe(nonGbp.length);
  });

  // M4 (fix round 4): the balance and the currency are independent reads, so neither may wait for the other.
  it("M4: the balance and the currency are read CONCURRENTLY — the second is asked before the first has answered", async () => {
    let checked = 0;
    for (const slow of ["balance", "currency"] as const) {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      relay.balance.mockReset().mockImplementation(async () => { if (slow === "balance") await gate; return 4; });
      money.preferredCurrency.mockReset().mockImplementation(async () => { if (slow === "currency") await gate; return "usd"; });
      const pending = load();
      await vi.waitFor(() => expect(slow === "balance" ? relay.balance : money.preferredCurrency).toHaveBeenCalledTimes(1));
      // The slow one is still pending: the other must already have been asked.
      expect(slow === "balance" ? money.preferredCurrency : relay.balance, `${slow} held the other back`).toHaveBeenCalledTimes(1);
      release();
      const stream = await pending;
      expect(stream?.streamBalance, slow).toBe(4);
      expect(stream?.currency, slow).toBe("usd");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("M4: without the relay neither is read — the tab gets 0 and gbp, and the page keeps its query budget", async () => {
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.relay");
    money.preferredCurrency.mockReset().mockResolvedValue("usd");
    const stream = await load();
    expect(stream?.relayEntitled, "premise: overlay yes, relay no").toBe(false);
    expect(stream?.streamBalance).toBe(0);
    expect(stream?.currency).toBe("gbp");
    expect(relay.balance).not.toHaveBeenCalled();
    expect(money.preferredCurrency).not.toHaveBeenCalled();
  });
});

// RT (lane-close fix, ruled 2026-09-29): the loader mints each listed fixture's signed overlay key for the OBS URL its
// panel copies. Folded through the REAL key module on both ends: what the loader hands the panel must be what the
// route's `verifyOverlayKey` accepts, for THAT fixture only.
describe("RT: the loader hands the panel one signed overlay key per listed fixture — and only with the panel", () => {
  const IDS = ["0b6c3a55-0000-4000-8000-000000000001", "0b6c3a55-0000-4000-8000-000000000002", "0b6c3a55-0000-4000-8000-000000000003"];
  const keysOf = async () => (await load(undefined, { fixtureIds: IDS }))?.overlayKeys;
  beforeEach(() => {
    relay.balance.mockReset().mockResolvedValue(1);
    vi.stubEnv("AUTH_SECRET", "rt-page-unit-secret-0123456789abcdef");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("every listed fixture gets a key the route verifies for IT and for no other listed fixture", async () => {
    const keys = await keysOf();
    expect(Object.keys(keys ?? {}).sort(), "one key per fixture, none missing").toEqual([...IDS].sort());
    let own = 0;
    let crossed = 0;
    for (const a of IDS) {
      for (const b of IDS) {
        expect(verifyOverlayKey(b, keys![a]), `${a}'s key on ${b}`).toBe(a === b);
        if (a === b) own++; else crossed++;
      }
    }
    expect(own).toBe(IDS.length);
    expect(crossed).toBe(IDS.length * (IDS.length - 1));
  });

  it("no panel (overlay switched off) → no keys and no overlay dictionary on the flight; no signing secret → no keys, and the context still loads", async () => {
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.overlay");
    const off = await load(undefined, { fixtureIds: IDS });
    expect(off?.entitled, "premise: switched off").toBe(false);
    expect(off?.overlayKeys, "switched off").toEqual({});
    expect(off?.overlayDict, "switched off: not a byte of the public dictionary").toEqual({});
    expect(getDictionary, "switched off: the public dictionary is not even loaded").not.toHaveBeenCalled();
    vi.mocked(hasFeature).mockImplementation(async () => true);
    vi.stubEnv("AUTH_SECRET", "");
    expect(await keysOf(), "no AUTH_SECRET").toEqual({});
    // The positive pair, the secret back: the keys are back — and the dictionary is sliced to `overlay.*` alone.
    vi.stubEnv("AUTH_SECRET", "rt-page-unit-secret-0123456789abcdef");
    const on = await load(undefined, { fixtureIds: IDS });
    expect(Object.keys(on?.overlayKeys ?? {})).toHaveLength(IDS.length);
    expect(on?.overlayDict).toEqual({ "overlay.vs": "vs" });
  });
});

// Capture QR v2 (carry 2, owner 2026-10-04): `capture-qr-v2` offers the phone-camera option, UI-only. Evaluated on the
// server with `fallback: false` (PostHog unconfigured or down → hidden), against the `organization` group keyed by the
// org; `CAPTURE_QR_V2_ALWAYS=1` forces it on (CI, e2e). Not NODE_ENV. Routes are not gated (routes.test.ts's).
describe("capture-qr-v2: the phone-camera option follows the flag, and CAPTURE_QR_V2_ALWAYS=1 forces it", () => {
  it("flag OFF → hidden; flag ON → shown — and the flag is asked for THIS user, in THIS org's group, falling back to off", async () => {
    let checked = 0;
    for (const on of [false, true]) {
      flags.isServerFeatureEnabled.mockReset().mockResolvedValue(on);
      forgetCaptureFlagCache();   // a fresh evaluation per case, never the last case's cached answer (m-2)
      expect((await load())?.phoneCapture, `flag ${on}`).toBe(on);
      expect(flags.isServerFeatureEnabled.mock.calls).toEqual([["capture-qr-v2", "user-1", { orgId: "org-1", fallback: false }]]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the override: CAPTURE_QR_V2_ALWAYS=1 with the flag OFF → shown (the flag is not even asked); any other value → follows the flag", async () => {
    vi.stubEnv("CAPTURE_QR_V2_ALWAYS", "1");
    expect((await load())?.phoneCapture).toBe(true);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
    let checked = 0;
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      vi.stubEnv("CAPTURE_QR_V2_ALWAYS", value);
      for (const on of [false, true]) {
        flags.isServerFeatureEnabled.mockReset().mockResolvedValue(on);
        forgetCaptureFlagCache();
        expect((await load())?.phoneCapture, `override ${JSON.stringify(value)}, flag ${on}`).toBe(on);
        expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(1);
        checked++;
      }
    }
    expect(checked).toBe(12);
  });

  it("not NODE_ENV: a development or test build with the flag off and no override is still hidden", async () => {
    let checked = 0;
    for (const env of ["development", "test", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      expect((await load())?.phoneCapture, env).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the flag outranks nothing else: off with the relay on still reads the credits (the OBS tab and the stop probe need none, but the loader's other reads are unchanged)", async () => {
    relay.balance.mockResolvedValue(2);
    const got = await load();
    expect(got).toMatchObject({ phoneCapture: false, relayEntitled: true, streamBalance: 2 });
  });

  it("no panel (overlay off) asks no flag — the switched-off org costs one entitlement query, as before", async () => {
    vi.mocked(hasFeature).mockImplementation(async () => false);
    vi.stubEnv("CAPTURE_QR_V2_ALWAYS", undefined);
    expect((await load())?.phoneCapture).toBe(false);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });

  it("an API-key caller (no user) is asked by its org — the flag is org-targeted", async () => {
    flags.isServerFeatureEnabled.mockResolvedValue(true);
    const keyAuth = { ...AUTH, userId: null, via: "api_key" } as unknown as AuthCtx;
    expect((await load(undefined, { auth: keyAuth }))?.phoneCapture).toBe(true);
    expect(flags.isServerFeatureEnabled.mock.calls[0]).toEqual(["capture-qr-v2", "org-1", { orgId: "org-1", fallback: false }]);
  });
});

// B8 review m-2: the flag is a remote call on every fixture-page render. One answer per org for CAPTURE_FLAG_TTL_MS.
describe("capture-qr-v2: the flag is asked once per org per minute, not once per render", () => {
  it("two loads inside the TTL make ONE call and agree; at the TTL a second call; another org asks for itself", async () => {
    vi.useFakeTimers();
    try {
      flags.isServerFeatureEnabled.mockResolvedValue(true);
      expect((await load())?.phoneCapture).toBe(true);
      // PostHog flips the flag off: renders inside the minute keep the kept answer…
      flags.isServerFeatureEnabled.mockResolvedValue(false);
      vi.advanceTimersByTime(CAPTURE_FLAG_TTL_MS - 1);
      expect((await load())?.phoneCapture, "inside the TTL: the kept answer").toBe(true);
      expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(1);
      // …and the first render at the TTL asks again.
      vi.advanceTimersByTime(1);
      expect((await load())?.phoneCapture, "at the TTL: asked again").toBe(false);
      expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(2);
      // Keyed by org: another club inside the same minute is asked for itself.
      const other = { ...AUTH, orgId: "org-2" } as unknown as AuthCtx;
      await load(undefined, { auth: other });
      expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(3);
      expect(flags.isServerFeatureEnabled.mock.calls[2]![2]).toEqual({ orgId: "org-2", fallback: false });
    } finally {
      vi.useRealTimers();
    }
  });

  // B8 re-review n-3: the flag is asked for a (distinct id, org group) PAIR, so an answer is kept per pair — never one
  // user's answer served to their whole org, nor one org's to the same user in another. Correct today only because the
  // live flag is org-aggregated; this holds it if the flag is ever re-targeted by person.
  it("kept per (org, user): two users in one org, and one user in two orgs, never share an answer inside the TTL", async () => {
    flags.isServerFeatureEnabled.mockImplementation(async (_f, distinctId, opts) => distinctId === "user-1" && opts?.orgId === "org-1");
    const as = (orgId: string, userId: string | null) => ({ ...AUTH, orgId, userId }) as unknown as AuthCtx;
    const PAIRS: [AuthCtx, boolean][] = [
      [as("org-1", "user-1"), true],
      [as("org-1", "user-2"), false],   // another user, the same org
      [as("org-2", "user-1"), false],   // the same user, another org
      [as("org-1", null), false],       // an API-key caller in org-1: asked as the org
    ];
    let checked = 0;
    for (const round of [1, 2]) {
      for (const [auth, want] of PAIRS) {
        expect((await load(undefined, { auth }))?.phoneCapture, `round ${round}: ${auth.orgId}/${auth.userId}`).toBe(want);
        checked++;
      }
      // Round 1 asks once per pair; round 2 (inside the TTL) is served from the cache, each pair its OWN answer.
      expect(flags.isServerFeatureEnabled, `after round ${round}`).toHaveBeenCalledTimes(PAIRS.length);
    }
    expect(flags.isServerFeatureEnabled.mock.calls.map(([, d, o]) => `${o?.orgId}/${d}`).sort()).toEqual(
      ["org-1/user-1", "org-1/user-2", "org-2/user-1", "org-1/org-1"].sort(),
    );
    expect(checked).toBe(2 * PAIRS.length);
  });

  it("concurrent renders before the first answer share ONE call", async () => {
    let release!: (v: boolean) => void;
    flags.isServerFeatureEnabled.mockImplementation(() => new Promise<boolean>((r) => { release = r; }));
    const both = Promise.all([load(), load()]);
    await vi.waitFor(() => expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(1));
    release(true);
    expect((await both).map((c) => c?.phoneCapture)).toEqual([true, true]);
    expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(1);
  });

  it("the override still answers without the cache or the flag", async () => {
    vi.stubEnv("CAPTURE_QR_V2_ALWAYS", "1");
    expect((await load())?.phoneCapture).toBe(true);
    expect((await load())?.phoneCapture).toBe(true);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });
});

// W19 (§6.8.5): the ended chip names the window the tick ends a lost phone by. The loader hands the panel that window as
// the server reads it — config.ts's declaration through `tunable`, the expression the tick judges with — so an override
// the tick honours (the e2e's 1 minute) is the number the organiser reads, and one it ignores (prod) is not.
describe("W19: the panel is handed the phone-lost window the tick judges by", () => {
  it("the declared default; a ci/local override; never an override on a named deployment — and whether or not the relay runs", async () => {
    expect(PHONE_LOST_LIVE_MINUTES, "premise: the override below differs from the default").not.toBe(7);
    expect((await load())?.phoneLostMinutes, "no override: the declaration").toBe(PHONE_LOST_LIVE_MINUTES);
    let checked = 0;
    for (const envName of ["ci", "local"]) {
      vi.stubEnv("ENV_NAME", envName);
      vi.stubEnv("PHONE_LOST_LIVE_MINUTES", "7");
      expect((await load())?.phoneLostMinutes, `ENV_NAME=${envName} honours the override`).toBe(7);
      checked++;
    }
    for (const envName of ["stg", "prod"]) {
      vi.stubEnv("ENV_NAME", envName);
      expect((await load())?.phoneLostMinutes, `ENV_NAME=${envName} ignores it`).toBe(PHONE_LOST_LIVE_MINUTES);
      checked++;
    }
    // The relay off (a switched-off org): still the window — a stream left over from before can still end phone_lost.
    vi.stubEnv("ENV_NAME", "ci");
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.relay");
    const off = await load();
    expect(off?.relayEntitled, "premise: the relay is off").toBe(false);
    expect(off?.phoneLostMinutes).toBe(7);
    checked++;
    expect(checked).toBe(5);
  });
});

// PR-2 T10 (§7.1): the switch's caption and Live's read-only line say "stops about 3 minutes after the result". The figure is
// the auto stop's own delay — config.ts's AUTO_STOP_AFTER_RESULT_SECONDS through `tunable`, the expression the tick judges
// with — in whole minutes, never a `3` typed into the panel. An override the tick honours (the walkthrough's seconds) is the
// figure shown, rounded, and never below 1: "about 0 minutes" is not a sentence.
describe("§7.1: the panel is handed the auto stop's delay the tick judges by, in whole minutes", () => {
  it("the declared default; ci/local overrides rounded (never below 1); never an override on a named deployment; with the relay off too", async () => {
    expect(AUTO_STOP_AFTER_RESULT_SECONDS % 60, "premise: the declaration is a whole number of minutes").toBe(0);
    expect((await load())?.autoStopMinutes, "no override: the declaration in minutes").toBe(AUTO_STOP_AFTER_RESULT_SECONDS / 60);
    // [override seconds, the figure]: whole minutes; a part-minute rounds; seconds under a half-minute still say "about 1".
    const rows: [string, number][] = [["300", 5], ["150", 3], ["20", 1], ["1", 1]];
    let checked = 0;
    for (const envName of ["ci", "local"]) {
      for (const [raw, want] of rows) {
        vi.stubEnv("ENV_NAME", envName);
        vi.stubEnv("AUTO_STOP_AFTER_RESULT_SECONDS", raw);
        expect((await load())?.autoStopMinutes, `ENV_NAME=${envName} AUTO_STOP_AFTER_RESULT_SECONDS=${raw}`).toBe(want);
        checked++;
      }
    }
    for (const envName of ["stg", "prod"]) {
      vi.stubEnv("ENV_NAME", envName);
      vi.stubEnv("AUTO_STOP_AFTER_RESULT_SECONDS", "300");
      expect((await load())?.autoStopMinutes, `ENV_NAME=${envName} ignores it`).toBe(AUTO_STOP_AFTER_RESULT_SECONDS / 60);
      checked++;
    }
    vi.stubEnv("ENV_NAME", "ci");
    vi.stubEnv("AUTO_STOP_AFTER_RESULT_SECONDS", "300");
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.relay");
    const off = await load();
    expect(off?.relayEntitled, "premise: the relay is off").toBe(false);
    expect(off?.autoStopMinutes).toBe(5);
    checked++;
    expect(checked).toBe(2 * rows.length + 3);
  });
});
