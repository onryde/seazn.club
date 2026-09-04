// Unit coverage for register.ts (B03r tasks 5+6): the --entry mode
// resolver, the funnel oracle, and organiser-action ordering. DB-free and
// HTTP-free throughout — every driver here is a hand-built fake recording
// into a shared `calls[]` array, exactly what "DB-free" means for a file
// whose whole job is orchestrating those interfaces.
import { describe, expect, it } from "vitest";
import type { Captain, Organiser, PayableEntry } from "../drivers/types.ts";
import type { PackRegistrationBlock, PackRegistrationEntry } from "../pack-schema.ts";
import {
  applyOrganiserActions,
  classifyFunnelOutcome,
  evaluateFunnel,
  resolveEntryMode,
  SUITE_13_KEY,
  type CliEntryFlag,
  type EntryMode,
  type FunnelEntryOutcome,
  type FunnelRow,
  type OrganiserActionContext,
  type PackOrganiserAction,
} from "../register.ts";

// ---------------------------------------------------------------------------
// Mode resolution (design §3, ladder item 5)
// ---------------------------------------------------------------------------

describe("resolveEntryMode", () => {
  const MODES: readonly EntryMode[] = ["admin", "registration-api", "registration-ui"];
  const NORMAL_SUITE = "_tiny";

  it("no flag: the division's own declared entry wins, untouched — every value, every suite", () => {
    for (const declared of MODES) {
      expect(resolveEntryMode(declared, NORMAL_SUITE, undefined)).toBe(declared);
      expect(resolveEntryMode(declared, SUITE_13_KEY, undefined)).toBe(declared);
    }
  });

  it("--entry admin: every division becomes admin, suite 13 INCLUDED — design names no exception here", () => {
    for (const declared of MODES) {
      expect(resolveEntryMode(declared, NORMAL_SUITE, "admin")).toBe("admin");
      expect(resolveEntryMode(declared, SUITE_13_KEY, "admin")).toBe("admin");
    }
  });

  it("--entry registration on a normal suite (1-12): resolves to registration-api regardless of the declared value", () => {
    for (const declared of MODES) {
      expect(resolveEntryMode(declared, NORMAL_SUITE, "registration")).toBe("registration-api");
    }
  });

  it("--entry registration on suite 13 (club-open): stays registration-ui — design's one named exception", () => {
    expect(resolveEntryMode("registration-ui", SUITE_13_KEY, "registration")).toBe("registration-ui");
  });

  // The differentiator: a suite-13 division that (hypothetically) declared
  // "admin" must STILL resolve to "registration-ui" under --entry
  // registration, never "registration-api" — the ONLY way to tell "suite
  // 13 gets registration-ui" apart from "every suite gets registration-api"
  // is a case where the two answers disagree. A resolver that forgot the
  // suite-13 branch (or checked the wrong suite key) passes every OTHER
  // case in this file and only fails this one.
  it("--entry registration on suite 13 forces registration-ui even for a division that declared something else", () => {
    expect(resolveEntryMode("admin", SUITE_13_KEY, "registration")).toBe("registration-ui");
    expect(resolveEntryMode("registration-api", SUITE_13_KEY, "registration")).toBe("registration-ui");
  });

  it("a suite key that merely CONTAINS the suite-13 key is not suite 13 (exact match, not substring)", () => {
    expect(resolveEntryMode("admin", `${SUITE_13_KEY}-2`, "registration")).toBe("registration-api");
    expect(resolveEntryMode("admin", `pre-${SUITE_13_KEY}`, "registration")).toBe("registration-api");
  });

  it("full table, one assertion per cell (no flag / admin / registration × 3 declared entries × 2 suites)", () => {
    const cliValues: readonly (CliEntryFlag | undefined)[] = [undefined, "admin", "registration"];
    const suites = [NORMAL_SUITE, SUITE_13_KEY];
    const expected: Record<string, EntryMode> = {
      // suiteKey|cli|declared -> expected
      [`${NORMAL_SUITE}|undefined|admin`]: "admin",
      [`${NORMAL_SUITE}|undefined|registration-api`]: "registration-api",
      [`${NORMAL_SUITE}|undefined|registration-ui`]: "registration-ui",
      [`${NORMAL_SUITE}|admin|admin`]: "admin",
      [`${NORMAL_SUITE}|admin|registration-api`]: "admin",
      [`${NORMAL_SUITE}|admin|registration-ui`]: "admin",
      [`${NORMAL_SUITE}|registration|admin`]: "registration-api",
      [`${NORMAL_SUITE}|registration|registration-api`]: "registration-api",
      [`${NORMAL_SUITE}|registration|registration-ui`]: "registration-api",
      [`${SUITE_13_KEY}|undefined|admin`]: "admin",
      [`${SUITE_13_KEY}|undefined|registration-api`]: "registration-api",
      [`${SUITE_13_KEY}|undefined|registration-ui`]: "registration-ui",
      [`${SUITE_13_KEY}|admin|admin`]: "admin",
      [`${SUITE_13_KEY}|admin|registration-api`]: "admin",
      [`${SUITE_13_KEY}|admin|registration-ui`]: "admin",
      [`${SUITE_13_KEY}|registration|admin`]: "registration-ui",
      [`${SUITE_13_KEY}|registration|registration-api`]: "registration-ui",
      [`${SUITE_13_KEY}|registration|registration-ui`]: "registration-ui",
    };
    for (const suite of suites) {
      for (const cli of cliValues) {
        for (const declared of MODES) {
          const key = `${suite}|${cli}|${declared}`;
          expect(resolveEntryMode(declared, suite, cli)).toBe(expected[key]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Funnel oracle fixtures
// ---------------------------------------------------------------------------

function entry(extKey: string, expectVal: PackRegistrationEntry["expect"]): PackRegistrationEntry {
  return { extKey, captain: `@person:${extKey}`, roster: [], pay: false, expect: expectVal };
}

function block(entries: PackRegistrationEntry[], expect: PackRegistrationBlock["expect"]): PackRegistrationBlock {
  return {
    category: "open",
    entrantKind: "individual",
    feeCents: 0,
    approval: "auto",
    entries,
    joins: [],
    organiser: [],
    expect,
  };
}

function outcome(extKey: string, registrationId: string, submitStatus: FunnelEntryOutcome["submitStatus"]): FunnelEntryOutcome {
  return { extKey, registrationId, submitStatus };
}

function row(registrationId: string, status: FunnelRow["status"], amountCents = 0, paymentIntentId: string | null = null): FunnelRow {
  return { registrationId, status, amountCents, paymentIntentId };
}

function mapOf<T extends { extKey?: string; registrationId?: string }>(items: T[], keyOf: (t: T) => string): Map<string, T> {
  return new Map(items.map((i) => [keyOf(i), i]));
}

// ---------------------------------------------------------------------------
// classifyFunnelOutcome
// ---------------------------------------------------------------------------

describe("classifyFunnelOutcome", () => {
  it("rejected_eligibility is decided from submit-time alone — no row needed", () => {
    expect(classifyFunnelOutcome(outcome("e1", "", "rejected_eligibility"), undefined)).toBe("rejected_eligibility");
  });

  it("final row 'rejected' -> rejected_manual", () => {
    expect(classifyFunnelOutcome(outcome("e1", "r1", "pending"), row("r1", "rejected"))).toBe("rejected_manual");
  });

  it("final row 'waitlisted' -> waitlisted", () => {
    expect(classifyFunnelOutcome(outcome("e1", "r1", "waitlisted"), row("r1", "waitlisted"))).toBe("waitlisted");
  });

  it.each(["pending", "paid", "confirmed"] as const)("final row '%s' -> entrant", (status) => {
    expect(classifyFunnelOutcome(outcome("e1", "r1", "pending"), row("r1", status))).toBe("entrant");
  });

  it("throws when a non-rejected-eligibility outcome has no final row", () => {
    expect(() => classifyFunnelOutcome(outcome("e1", "r1", "pending"), undefined)).toThrow(/no final row/);
  });

  it("throws on a final status outside the four-value vocabulary", () => {
    expect(() => classifyFunnelOutcome(outcome("e1", "r1", "pending"), row("r1", "withdrawn"))).toThrow(/no funnel classification/);
  });
});

// ---------------------------------------------------------------------------
// evaluateFunnel — the four expect outcomes, green
// ---------------------------------------------------------------------------

describe("evaluateFunnel — each of the four expect outcomes, correctly resolved", () => {
  it("entrant / rejected_eligibility / waitlisted / rejected_manual all in one division, ok:true", () => {
    const b = block(
      [entry("e-ok", "entrant"), entry("e-elig", "rejected_eligibility"), entry("e-wait", "waitlisted"), entry("e-man", "rejected_manual")],
      { entrants: 1, waitlisted: 1, rejected: 2, paidCents: 0 },
    );
    const outcomes = mapOf(
      [outcome("e-ok", "r-ok", "pending"), outcome("e-elig", "", "rejected_eligibility"), outcome("e-wait", "r-wait", "waitlisted"), outcome("e-man", "r-man", "pending")],
      (o) => o.extKey,
    );
    const rows = mapOf([row("r-ok", "pending"), row("r-wait", "waitlisted"), row("r-man", "rejected")], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.entrants).toBe(1);
    expect(result.waitlisted).toBe(1);
    expect(result.paidCents).toBe(0);
    expect(result.organiserForceEligibilityProven).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateFunnel — "offender admitted" reds, one per offender kind
// ---------------------------------------------------------------------------

describe("evaluateFunnel — offender admitted reds", () => {
  it("a rejected_eligibility offender that the product actually let through reds as offender admitted", () => {
    const b = block([entry("e1", "rejected_eligibility")], { entrants: 0, waitlisted: 0, rejected: 1, paidCents: 0 });
    // Admitted: submit succeeded (not rejected_eligibility) and the final row is a live entrant status.
    const outcomes = mapOf([outcome("e1", "r1", "pending")], (o) => o.extKey);
    const rows = mapOf([row("r1", "pending")], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "funnel.offender_admitted" && f.extKey === "e1")).toBe(true);
    expect(result.findings.map((f) => f.message).join(" | ")).toContain("offender admitted");
    // The public-submit half of the eligibility gate is also violated here.
    expect(result.findings.some((f) => f.code === "funnel.eligibility_not_blocked_at_submit")).toBe(true);
  });

  it("a waitlisted offender that ends up admitted (without a promote in the pack) reds as offender admitted", () => {
    const b = block([entry("e1", "waitlisted")], { entrants: 1, waitlisted: 0, rejected: 0, paidCents: 0 });
    const outcomes = mapOf([outcome("e1", "r1", "waitlisted")], (o) => o.extKey);
    const rows = mapOf([row("r1", "confirmed")], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "funnel.offender_admitted" && f.extKey === "e1")).toBe(true);
  });

  it("a rejected_manual offender the organiser never actually rejected reds as offender admitted", () => {
    const b = block([entry("e1", "rejected_manual")], { entrants: 1, waitlisted: 0, rejected: 0, paidCents: 0 });
    const outcomes = mapOf([outcome("e1", "r1", "pending")], (o) => o.extKey);
    const rows = mapOf([row("r1", "paid")], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "funnel.offender_admitted" && f.extKey === "e1")).toBe(true);
  });

  it("a genuinely rejected entry never reds as offender admitted (negative control)", () => {
    const b = block([entry("e1", "rejected_manual")], { entrants: 0, waitlisted: 0, rejected: 1, paidCents: 0 });
    const outcomes = mapOf([outcome("e1", "r1", "pending")], (o) => o.extKey);
    const rows = mapOf([row("r1", "rejected")], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateFunnel — paid_cents (FP6 correction and its regression)
// ---------------------------------------------------------------------------

describe("evaluateFunnel — paid_cents sources only paid|confirmed rows carrying a payment_intent_id", () => {
  it("an entry with a non-zero amount_cents that was NEVER paid contributes nothing", () => {
    const b = block([entry("e1", "entrant")], { entrants: 1, waitlisted: 0, rejected: 0, paidCents: 0 });
    const outcomes = mapOf([outcome("e1", "r1", "pending")], (o) => o.extKey);
    // amountCents is non-zero, but status is "pending" and no payment_intent_id
    // was ever set — exactly registration_groups.amount_cents's submit-time
    // snapshot that confirmPaidRegistration never touches (FP6).
    const rows = mapOf([row("r1", "pending", 5000, null)], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.paidCents).toBe(0);
    expect(result.ok).toBe(true);
  });

  it("both terminal paid states count: auto-approval 'confirmed' AND manual-approval 'paid'", () => {
    const b = block(
      [entry("auto", "entrant"), entry("manual", "entrant"), entry("unpaid", "entrant")],
      { entrants: 3, waitlisted: 0, rejected: 0, paidCents: 10000 },
    );
    const outcomes = mapOf(
      [outcome("auto", "r-auto", "pending"), outcome("manual", "r-manual", "pending"), outcome("unpaid", "r-unpaid", "pending")],
      (o) => o.extKey,
    );
    const rows = mapOf(
      [
        row("r-auto", "confirmed", 6000, "pi_auto"), // auto-approval terminal state
        row("r-manual", "paid", 4000, "pi_manual"), // manual-approval terminal state
        row("r-unpaid", "pending", 5000, null), // never charged — must NOT count
      ],
      (r) => r.registrationId,
    );

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.paidCents).toBe(10000);
    expect(result.ok).toBe(true);
  });

  it("a paid|confirmed row with NO payment_intent_id does not count either (a real charge must have landed)", () => {
    const b = block([entry("e1", "entrant")], { entrants: 1, waitlisted: 0, rejected: 0, paidCents: 0 });
    const outcomes = mapOf([outcome("e1", "r1", "pending")], (o) => o.extKey);
    const rows = mapOf([row("r1", "confirmed", 6000, null)], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.paidCents).toBe(0);
  });

  it("reds funnel.paid_cents_mismatch when the pack's declared paidCents disagrees with the derived sum", () => {
    const b = block([entry("e1", "entrant")], { entrants: 1, waitlisted: 0, rejected: 0, paidCents: 999 });
    const outcomes = mapOf([outcome("e1", "r1", "pending")], (o) => o.extKey);
    const rows = mapOf([row("r1", "confirmed", 6000, "pi_1")], (r) => r.registrationId);

    const result = evaluateFunnel("div-1", b, outcomes, rows);

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "funnel.paid_cents_mismatch")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyOrganiserActions — pack order + promote's second pay()
// ---------------------------------------------------------------------------

/** A fake `Organiser` whose `act()` takes LONGER for "approve" than for
 *  anything else — deliberately, so that a `Promise.all`-based (wrongly
 *  parallel) implementation would let "reject"/"promote" finish first and
 *  scramble the observed order. A correct, strictly-sequential
 *  implementation is unaffected by this delay: it never starts the next
 *  action until the current one's promise has resolved. */
function makeOrderingFakes(): { organiser: Organiser; captainOf: (id: string) => Captain; calls: string[] } {
  const calls: string[] = [];
  const organiser: Organiser = {
    async configureRegistration() {},
    async act(action) {
      const delayMs = action.action === "approve" ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const suffix = action.targetRegistrationId ? `:${action.targetRegistrationId}` : "";
      calls.push(`act:${action.action}:${action.registrationId}${suffix}`);
    },
  };
  const captainOf = (): Captain => ({
    async enter() {
      throw new Error("not used in this fixture");
    },
    async pay(entryArg: PayableEntry) {
      calls.push(`pay:${entryArg.registrationId}`);
    },
  });
  return { organiser, captainOf, calls };
}

describe("applyOrganiserActions", () => {
  it("applies actions strictly in pack order, and promote's pay() lands immediately after its own act()", async () => {
    const { organiser, captainOf, calls } = makeOrderingFakes();
    const contextByExtKey = new Map<string, OrganiserActionContext>([
      ["a", { registrationId: "reg-a" }],
      ["b", { registrationId: "reg-b" }],
      ["c", { registrationId: "reg-c", captain: captainOf() }],
    ]);
    const actions: PackOrganiserAction[] = [
      { action: "approve", target: "a" },
      { action: "reject", target: "b" },
      { action: "promote", target: "c" },
    ];

    await applyOrganiserActions({ organiser, actions, contextByExtKey, feeCents: 1000 });

    expect(calls).toEqual(["act:approve:reg-a", "act:reject:reg-b", "act:promote:reg-c", "pay:reg-c"]);
  });

  it("pack order is authoritative, not action-kind order: promote FIRST still pays immediately after its own act()", async () => {
    const { organiser, captainOf, calls } = makeOrderingFakes();
    const contextByExtKey = new Map<string, OrganiserActionContext>([
      ["c", { registrationId: "reg-c", captain: captainOf() }],
      ["a", { registrationId: "reg-a" }],
    ]);
    const actions: PackOrganiserAction[] = [
      { action: "promote", target: "c" },
      { action: "approve", target: "a" },
    ];

    await applyOrganiserActions({ organiser, actions, contextByExtKey, feeCents: 1000 });

    expect(calls).toEqual(["act:promote:reg-c", "pay:reg-c", "act:approve:reg-a"]);
  });

  it("promote does NOT re-run pay() when the division is free (feeCents 0)", async () => {
    const { organiser, captainOf, calls } = makeOrderingFakes();
    const contextByExtKey = new Map<string, OrganiserActionContext>([["c", { registrationId: "reg-c", captain: captainOf() }]]);

    await applyOrganiserActions({ organiser, actions: [{ action: "promote", target: "c" }], contextByExtKey, feeCents: 0 });

    expect(calls).toEqual(["act:promote:reg-c"]);
  });

  it("throws when promote's context carries no captain to pay", async () => {
    const { organiser } = makeOrderingFakes();
    const contextByExtKey = new Map<string, OrganiserActionContext>([["c", { registrationId: "reg-c" }]]);

    await expect(
      applyOrganiserActions({ organiser, actions: [{ action: "promote", target: "c" }], contextByExtKey, feeCents: 500 }),
    ).rejects.toThrow(/no captain in context/);
  });

  it("throws when an action targets an entry with no resolved context", async () => {
    const { organiser } = makeOrderingFakes();
    await expect(
      applyOrganiserActions({ organiser, actions: [{ action: "approve", target: "ghost" }], contextByExtKey: new Map(), feeCents: 0 }),
    ).rejects.toThrow(/unresolved entry "ghost"/);
  });

  it("assign_free_agent is skipped (never gated, never throws) when no target resolver is wired", async () => {
    const { organiser, calls } = makeOrderingFakes();
    const warnings: string[] = [];
    const contextByExtKey = new Map<string, OrganiserActionContext>([["fa", { registrationId: "reg-fa" }]]);

    await applyOrganiserActions({
      organiser,
      actions: [{ action: "assign_free_agent", target: "fa" }],
      contextByExtKey,
      feeCents: 0,
      onFreeAgentWarning: (m) => warnings.push(m),
    });

    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no target resolver/);
  });

  it("assign_free_agent calls act() with the first resolved target when a resolver is wired", async () => {
    const { organiser, calls } = makeOrderingFakes();
    const contextByExtKey = new Map<string, OrganiserActionContext>([["fa", { registrationId: "reg-fa" }]]);

    await applyOrganiserActions({
      organiser,
      actions: [{ action: "assign_free_agent", target: "fa" }],
      contextByExtKey,
      feeCents: 0,
      listAssignTargets: async () => ["reg-team-1", "reg-team-2"],
    });

    expect(calls).toEqual(["act:assign_free_agent:reg-fa:reg-team-1"]);
  });
});
