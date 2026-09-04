// B03r tasks 9+10 — the `--entry` wiring into `runTinySuite` and `_tiny`'s
// new `d-registration` division. Two things this file proves that no other
// file does:
//
//  1. `selectedDivisionExposures` reduces the REAL committed `_tiny.json`
//     into exactly the shape `lib/env.ts`'s `runPreflight` needs, and that
//     shape genuinely drives its Chromium/Stripe escalation the right way —
//     the task's own acceptance criterion ("`_tiny` under `--entry admin`
//     must still run Stripe-free AND Chromium-free... verify the pre-
//     flight's selection logic actually yields 'no Chromium needed'").
//     `env.test.ts` (B03r task 7, already complete) exhaustively proves
//     `runPreflight`'s OWN escalation logic against hand-built
//     `SelectedDivisionExposure` fixtures — this file's job is narrower and
//     complementary: prove `_tiny`'s pack, reduced through THIS session's
//     own new function, actually PRODUCES those fixture shapes.
//  2. `runTinySuite` actually DRIVES the registration division end to end —
//     removing the registration loop in `lib/suites/tiny.ts`, or its
//     `--entry admin` skip, or the report-population tally, reds a test
//     here (AGENTS.md recurring-failure class 1 — "the inert seam"). A FAKE
//     `registrationDrivers` is injected throughout (never a real browser or
//     HTTP call to the public register/hub routes — those have no
//     meaningful unit test at all, design §9); `makeFakeServer` (exported
//     from `tiny-suite.test.ts` for exactly this reuse) covers the REST of
//     `_tiny`'s admin-seeded surface (d-tiny/d-badminton) the SAME way it
//     already does for every other test in that file.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { loadPackValue } from "../pack-io.ts";
import type { Pack } from "../pack-schema.ts";
import { runPreflight, type PreflightProbes, type SelectedDivisionExposure } from "../env.ts";
import type { Captain, EntryOutcome, Organiser, Player } from "../drivers/types.ts";
import {
  registrationDivisionsOf,
  runTinySuite,
  selectedDivisionExposures,
  TINY_PACK_PATH,
  type RegistrationDriverContext,
  type RegistrationDriverSet,
} from "../suites/tiny.ts";
// Reused rather than duplicated (tiny-suite.test.ts's own header comment on
// `makeFakeServer`'s export: "so tiny-suite-registration.test.ts can drive
// the SAME comprehensive fake ... rather than duplicating ~170 lines of
// route handling").
import { makeFakeServer } from "./tiny-suite.test.ts";

const silent = pino({ level: "silent" });
const TINY_TEXT = readFileSync(TINY_PACK_PATH, "utf8");

function tinyPack(): Pack {
  const load = loadPackValue(JSON.parse(TINY_TEXT) as unknown, TINY_PACK_PATH);
  if (!load.ok) throw new Error("the committed _tiny.json no longer loads");
  return load.pack;
}

// `makeFakeServer`'s own division-creation handler mints `div-<slug(name)>`
// — the same convention `d-registration`'s pack-declared name
// ("Registration UI Proof") slugs to. Not re-derived via a copy of that
// file's private `slug()` helper: pinned as a literal here, so a rename of
// either the division's `name` or the slug algorithm reds this file loudly
// rather than silently drifting.
const REGISTRATION_DIVISION_ID = "div-registration-ui-proof";

// ---------------------------------------------------------------------------
// selectedDivisionExposures — pure reduction, no I/O
// ---------------------------------------------------------------------------

describe("registrationDivisionsOf", () => {
  it("finds _tiny's one registration-carrying division (d-registration) and no others (d-tiny/d-badminton carry no registration block)", () => {
    const divisions = registrationDivisionsOf(tinyPack());
    expect(divisions).toHaveLength(1);
    expect(divisions[0]?.ref).toBe("d-registration");
  });
});

describe("selectedDivisionExposures — _tiny reduced to env.ts's SelectedDivisionExposure shape", () => {
  it("no --entry flag: the pack's own declared entry wins — 'registration-ui', the daily floor design §9 asks for", () => {
    expect(selectedDivisionExposures(tinyPack(), undefined)).toEqual([
      { entry: "registration-ui", pay: false },
    ] satisfies SelectedDivisionExposure[]);
  });

  it("--entry admin: forces 'admin' — this is the acceptance criterion itself (no Chromium, no Stripe needed)", () => {
    expect(selectedDivisionExposures(tinyPack(), "admin")).toEqual([
      { entry: "admin", pay: false },
    ] satisfies SelectedDivisionExposure[]);
  });

  it("--entry registration: resolves to 'registration-api', NOT 'registration-ui' — _tiny's own suite key ('_tiny') is not SUITE_13_KEY ('club-open'), the one named exception `resolveEntryMode` carves out", () => {
    expect(selectedDivisionExposures(tinyPack(), "registration")).toEqual([
      { entry: "registration-api", pay: false },
    ] satisfies SelectedDivisionExposure[]);
  });

  it("pay is always false — d-registration is free (feeCents:0, every entry pay:false)", () => {
    for (const cliEntry of [undefined, "admin", "registration"] as const) {
      expect(selectedDivisionExposures(tinyPack(), cliEntry)[0]?.pay).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The literal acceptance criterion: feed _tiny's OWN reduced selection
// through the REAL `runPreflight` (env.ts, untouched — out of this task's
// file set) with Chromium/Stripe both ABSENT, and confirm --entry admin
// passes clean while the default --entry (registration-ui) refuses.
// ---------------------------------------------------------------------------

function fakeProbes(): PreflightProbes {
  return {
    checkOwnDatabase: async () => ({ ok: true, detail: "ok", dataDirectory: "/data/bench", port: 54329 }),
    checkOwnPort: async () => ({ ok: true, detail: "ok", pid: 1 }),
    checkPlacementHealth: async () => ({ status: "absent", detail: "n/a" }),
    checkSportsCatalogSynced: async () => ({ ok: true, detail: "ok" }),
    checkAppHealth: async () => ({ ok: true, detail: "ok" }),
    // Both ABSENT — the exact environment the acceptance criterion describes:
    // "must still run Stripe-free AND Chromium-free."
    checkStripeConfig: async () => ({
      testModeKeyPresent: false,
      liveKeyDetected: false,
      connectTestAccountPresent: false,
      webhookSecretPresent: false,
      webhookListenerLive: null,
      webhookListenerDetail: "not configured",
    }),
    checkChromiumInstalled: async () => ({ ok: false, detail: "no chromium binary on disk" }),
  };
}

describe("runPreflight against _tiny's OWN selection — the acceptance criterion", () => {
  it("--entry admin: passes clean — neither Chromium nor Stripe escalates to a refusal", async () => {
    const selection = selectedDivisionExposures(tinyPack(), "admin");
    const result = await runPreflight("http://localhost:54301", fakeProbes(), selection);
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
  });

  it("no --entry flag (the pack's own registration-ui default): Chromium missing IS a refusal — proves the selection genuinely reaches runPreflight's escalation, not just that admin happens to pass", async () => {
    const selection = selectedDivisionExposures(tinyPack(), undefined);
    const result = await runPreflight("http://localhost:54301", fakeProbes(), selection);
    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain("registration_ui_chromium_missing");
    // Stripe is NOT escalated — d-registration's pay is false regardless of
    // entry mode (the escalation rule is keyed on `pay`, never on entry mode
    // alone).
    expect(result.refusals.map((r) => r.reason)).not.toContain("stripe_secret_key_missing_or_invalid");
  });
});

// ---------------------------------------------------------------------------
// runTinySuite — driving d-registration end to end via a FAKE
// registrationDrivers (never a real browser/HTTP call to the public
// register/hub routes).
// ---------------------------------------------------------------------------

interface RecordedDriverCall {
  readonly kind: "configureRegistration" | "act" | "enter" | "pay" | "join";
  readonly detail: unknown;
}

/** Simulates the REAL product's manual-approval-division shape: both
 *  captains submit and land "pending" (manual approval never auto-confirms
 *  at submit time — registration-submit.ts's own submit-time vocabulary,
 *  mirrored by both drivers' `mapSubmitStatus`); the organiser's ONE
 *  "approve" action (the pack's own `organiser: [{action:"approve",
 *  target: reg-cap1}]`) is recorded but does NOT itself change what THIS
 *  fake's `enter()` already returned — `fetchFinalRows` (via
 *  `server.registrationRowsByDivisionId`, set by the caller) is the thing
 *  that actually tells `evaluateFunnel` the FINAL state, exactly like a
 *  real server's `GET .../registrations` read-back would after the real
 *  approve took effect. */
function fakeRegistrationDrivers(calls: RecordedDriverCall[]): (
  resolvedEntry: "registration-api" | "registration-ui",
  ctx: RegistrationDriverContext,
) => Promise<RegistrationDriverSet> {
  return async (resolvedEntry, ctx) => {
    calls.push({ kind: "enter", detail: { resolvedEntry, note: "driver-set constructed", entryExtKeys: ctx.entryExtKeys } });
    const organiser: Organiser = {
      async configureRegistration(divisionId, block) {
        calls.push({ kind: "configureRegistration", detail: { divisionId, block } });
      },
      async act(action) {
        calls.push({ kind: "act", detail: action });
      },
    };
    const makeCaptain = (entryExtKey: string): Captain => ({
      async enter(entry, division): Promise<EntryOutcome> {
        calls.push({ kind: "enter", detail: { entryExtKey, entry, division } });
        return { status: "pending", ref: `reg-${entryExtKey}` };
      },
      async pay(entry) {
        calls.push({ kind: "pay", detail: entry });
      },
    });
    const makePlayer = (personRef: string): Player => ({
      async join(entry, joinCode, consent) {
        calls.push({ kind: "join", detail: { personRef, entry, joinCode, consent } });
      },
    });
    return {
      organiser,
      makeCaptain,
      makePlayer,
      dispose: async () => {},
    };
  };
}

/** What the BACKEND mints, deliberately different from the pack's declared
 *  `org.slug` ("bench-tiny-club"). The two must differ in this fixture or the
 *  suite cannot witness the defect these tests exist for: `tiny.ts` used to
 *  address every public URL with the PACK's slug, which 404s. A fixture where
 *  the two agree passes either way. Observed live as `my-organization-2`. */
const SERVER_ORG_SLUG = "my-organization-2";

/** Read from the committed pack rather than retyped. A literal here would go
 *  stale the moment `_tiny.json`'s org slug changed, and a stale literal in a
 *  `not.toBe` assertion passes for the wrong reason — it would compare against
 *  a slug nothing uses and never fail again. */
const TINY_PACK_DECLARED_ORG_SLUG = tinyPack().org.slug;

describe("runTinySuite — d-registration driven via a fake registrationDrivers", () => {
  it("submits both entries, records exactly the pack's one approve action, and reports a green funnel", async () => {
    const server = makeFakeServer();
    // The FINAL read-back `fetchFinalRows` returns — reg-cap1 approved
    // (confirmed, free — nothing to pay), reg-cap2 left pending (never
    // approved). Both classify as "entrant" (register.ts's own
    // `classifyFunnelOutcome`: pending/paid/confirmed all do) — see this
    // test file's own note below on why the funnel gate CANNOT witness the
    // approve action by itself.
    server.registrationRowsByDivisionId.set(REGISTRATION_DIVISION_ID, [
      { id: "reg-reg-cap1", status: "confirmed", amount_cents: 0, entry_payment_intent_id: null },
      { id: "reg-reg-cap2", status: "pending", amount_cents: 0, entry_payment_intent_id: null },
    ]);
    const driverCalls: RecordedDriverCall[] = [];

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      transport: server.transport,
      registrationDrivers: fakeRegistrationDrivers(driverCalls),
      resolveOrgSlug: async () => SERVER_ORG_SLUG,
    });

    expect(report.gate).toBe("green");
    expect(report.errors).toBeUndefined();
    expect(report.registration).toEqual([
      {
        divisionRef: "d-registration",
        entries: 2,
        entrants: 2,
        waitlisted: 0,
        rejectedEligibility: 0,
        rejectedManual: 0,
        paidCents: 0,
        organiserForceEligibilityProven: false,
        funnelWallMs: expect.any(Number),
      },
    ]);

    // The division was created directly (never through seedSuite/generate —
    // see build-packs/_tiny.ts's own comment on why).
    const divisionPosts = server.calls.filter(
      (c) => c.method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(c.path),
    );
    expect(divisionPosts.some((c) => (c.body as { name: string }).name === "Registration UI Proof")).toBe(true);

    // Both captains actually submitted, with the pack's own contact/consent
    // shape (buildRegistrationEntry's individual-kind, self-registering
    // shape — register.ts, out of this task's scope, already unit-tested
    // there; this just proves the WIRING reaches it with the real pack data).
    const enters = driverCalls.filter(
      (c): c is RecordedDriverCall & { detail: { entryExtKey: string; entry: { contact: { name: string }; registeringSelf?: boolean; privacyConsent: boolean } } } =>
        c.kind === "enter" && typeof (c.detail as { entryExtKey?: string }).entryExtKey === "string",
    );
    expect(enters.map((c) => c.detail.entryExtKey).sort()).toEqual(["reg-cap1", "reg-cap2"]);
    const priyaEntry = enters.find((c) => c.detail.entryExtKey === "reg-cap1")!;
    expect(priyaEntry.detail.entry.contact.name).toBe("Priya Kapoor");
    expect(priyaEntry.detail.entry.registeringSelf).toBe(true);
    expect(priyaEntry.detail.entry.privacyConsent).toBe(true);

    // MUTATION FINDING (recorded, not fixed — register.ts is out of this
    // task's scope): `classifyFunnelOutcome` maps "pending" and "confirmed"
    // to the SAME "entrant" bucket, so the funnel oracle above is GREEN
    // whether or not this approve action ever actually ran — a reachability
    // test satisfied by ANY value (AGENTS.md recurring-failure class 19).
    // The only thing that DOES witness the pack's "1 approve" is this direct
    // assertion on the recorded driver call, never the funnel gate.
    const approveActs = driverCalls.filter((c) => c.kind === "act");
    expect(approveActs).toEqual([{ kind: "act", detail: { action: "approve", registrationId: "reg-reg-cap1" } }]);

    // No joins declared — makePlayer's join() is never called.
    expect(driverCalls.some((c) => c.kind === "join")).toBe(false);
  });

  // The regression for the first live run's failure. `tiny.ts` addressed every
  // public URL with `plan.org.slug` — the PACK's declared slug — while the org
  // is auto-provisioned and named by the backend. `/shared/bench-tiny-club/...`
  // 404s, and a 404 here still serves HTTP 200 chrome with no wizard on it, so
  // the run died 30s later inside Playwright as
  //   locator.fill: Timeout 30000ms exceeded — waiting for '#reg-who-name'
  // blaming a selector that was correct all along. No unit test could see it:
  // every fake agreed with whatever slug it was handed. This one does not — it
  // asserts the driver is handed the SERVER's slug and, separately, that the
  // pack's own value never reaches a driver at all.
  it("hands the driver the SERVER-assigned org slug, never the pack's declared one", async () => {
    const server = makeFakeServer();
    server.registrationRowsByDivisionId.set(REGISTRATION_DIVISION_ID, [
      { id: "reg-reg-cap1", status: "confirmed", amount_cents: 0, entry_payment_intent_id: null },
      { id: "reg-reg-cap2", status: "pending", amount_cents: 0, entry_payment_intent_id: null },
    ]);

    const seenOrgSlugs: string[] = [];
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      transport: server.transport,
      resolveOrgSlug: async () => SERVER_ORG_SLUG,
      registrationDrivers: async (resolvedEntry, ctx) => {
        seenOrgSlugs.push(ctx.orgSlug);
        return fakeRegistrationDrivers([])(resolvedEntry, ctx);
      },
    });

    expect(report.gate).toBe("green");
    expect(seenOrgSlugs, "the driver factory was never called").not.toHaveLength(0);
    // Positive AND negative. The positive alone would pass if the resolver
    // were ignored and both slugs happened to coincide; the negative alone
    // would pass on any wrong-but-different value.
    for (const slug of seenOrgSlugs) {
      expect(slug).toBe(SERVER_ORG_SLUG);
      expect(slug).not.toBe(TINY_PACK_DECLARED_ORG_SLUG);
    }
  });

  it("--entry admin: the registration division is skipped ENTIRELY — the driver factory is never even called, and no division is created for it", async () => {
    const server = makeFakeServer();
    const driverFactory = vi.fn(fakeRegistrationDrivers([]));

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      transport: server.transport,
      cliEntry: "admin",
      registrationDrivers: driverFactory,
      resolveOrgSlug: async () => SERVER_ORG_SLUG,
    });

    expect(report.gate).toBe("green");
    expect(report.registration).toBeUndefined();
    expect(driverFactory).not.toHaveBeenCalled();
    const divisionPosts = server.calls.filter(
      (c) => c.method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(c.path),
    );
    expect(divisionPosts.some((c) => (c.body as { name: string }).name === "Registration UI Proof")).toBe(false);

    // ...and the skip is VISIBLE. The three assertions above are all
    // negative — they pass just as well when the division is stepped over in
    // silence, which is what this suite actually did until a live
    // `--entry admin` run produced a report with no Registration section at
    // all. `report.registration` being undefined is indistinguishable from a
    // pack that declares no registration divisions; only a warning naming the
    // division tells the two apart.
    const skipWarnings = (report.warnings ?? []).filter((w) => w.includes("d-registration") && /skipped/i.test(w));
    expect(skipWarnings, "the skipped division is not named in any warning").toHaveLength(1);
    expect(skipWarnings[0]).toMatch(/proves nothing about registration/);
  });

  it("no --entry flag: the same run carries NO skip warning — the warning tracks the skip, it is not boilerplate", async () => {
    // The positive pair. Without it, a warning pushed unconditionally (or on
    // every registration division regardless of resolution) would satisfy the
    // assertion above while telling a reader the funnel was skipped on the
    // very run that drove it.
    const server = makeFakeServer();
    server.registrationRowsByDivisionId.set(REGISTRATION_DIVISION_ID, [
      { id: "reg-reg-cap1", status: "confirmed", amount_cents: 0, entry_payment_intent_id: null },
      { id: "reg-reg-cap2", status: "pending", amount_cents: 0, entry_payment_intent_id: null },
    ]);
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      transport: server.transport,
      registrationDrivers: fakeRegistrationDrivers([]),
      resolveOrgSlug: async () => SERVER_ORG_SLUG,
    });

    expect(report.gate).toBe("green");
    expect(report.registration, "the funnel did not run — this test can no longer witness anything").toHaveLength(1);
    expect((report.warnings ?? []).filter((w) => /skipped/i.test(w))).toHaveLength(0);
  });

  it("MUTATION: a funnel mismatch (an entry the fake never actually submitted as expected) reds the gate — the wiring genuinely propagates register.ts's own findings, not just 'ran without throwing'", async () => {
    const server = makeFakeServer();
    // Only ONE final row instead of two — reg-cap2's own row is simply
    // missing from the read-back, simulating a submit that silently failed
    // to reach the server. `evaluateFunnel` (register.ts, untouched) reports
    // `funnel.missing_outcome`... no — actually BOTH entries DID call
    // enter() successfully (the fake always returns "pending" + a ref), so
    // what is actually missing is the ROW `fetchFinalRows` returns for
    // reg-cap2 — `classifyFunnelOutcome` throws for a non-rejected outcome
    // with no row, which `runRegistrationDivision` lets propagate; this
    // suite's own outer try/catch turns that into an `errors` entry and a
    // red gate, exactly like any other unexpected throw during the run.
    server.registrationRowsByDivisionId.set(REGISTRATION_DIVISION_ID, [
      { id: "reg-reg-cap1", status: "confirmed", amount_cents: 0, entry_payment_intent_id: null },
    ]);

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      transport: server.transport,
      registrationDrivers: fakeRegistrationDrivers([]),
      resolveOrgSlug: async () => SERVER_ORG_SLUG,
    });

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("reg-cap2");
  });
});
