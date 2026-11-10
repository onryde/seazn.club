// Sponsor deals, Task 2: the pure deal domain (plan 2026-11-07-sponsor-deals, D2, D8, D9, D22; preflight F3, F12, F13,
// F15, F31). Every expected value below is typed from spec §5.2 (the deal status table and its exits), the brief's
// acceptance lines and the controller's rulings — never read back from lib/sponsor-deals.ts. In particular the
// reachable set of the action table is a typed literal list, not a walk through this module's own transitions (that
// would make the implementation its own oracle, F15).
//
// The rules the tables are typed from (F15, total over deal_status × payment_status × payment_method):
//   - "unpaid" is payment `pending` or `failed` (Task 8 keeps a failed deal payable, so it offers what pending offers);
//   - draft → send_invoice (online, unpaid), end_now;
//   - awaiting_payment → resend_invoice (online), mark_paid, end_now — while unpaid;
//   - awaiting_approval → approve, end_now (plus refund when paid);
//   - live / scheduled → end_now; while unpaid also resend_invoice (online) and mark_paid;
//   - paid, not disputed → refund in every status, ended included, unless ended_reason is refunded or dispute_lost;
//   - ended → nothing else; complimentary → never mark_paid, refund or *_invoice;
//   - `*_invoice` is online-only in PR 1: Task 23 adds resend_invoice for offline deals with an email (F13).
// Every table and sweep counts the rows it checked, and zero checked is a failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEAL_ACTIONS,
  DEAL_STATUSES,
  DealRuleError,
  END_REASONS,
  GO_LIVE_RULES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  allowedActions,
  dealChip,
  goLiveRulesFor,
  initialPaymentStatus,
  initialStatus,
  pickRowDeal,
  primaryLabel,
  rowNextAction,
  statusAfterApproved,
  statusAfterInvoiceSent,
  statusAfterPaid,
  type DealAction,
  type DealChip,
  type DealStatus,
  type EndReason,
  type GoLiveRule,
  type PaymentMethod,
  type PaymentStatus,
  type RowAction,
  type SponsorDeal,
} from "@/lib/sponsor-deals";

// ---- the spec's literals (spec §5.2, D2, the V495 CHECKs, the F3 ruling) ----------------------------------------------
const SPEC_DEAL_STATUSES = ["draft", "awaiting_payment", "awaiting_approval", "scheduled", "live", "ended"];
const SPEC_PAYMENT_METHODS = ["online", "offline", "complimentary"];
const SPEC_GO_LIVE_RULES = ["on_payment", "immediate", "on_approval"];
const SPEC_PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded", "none"];
/** The brief's six plus `duplicate_payment` (F3: a second, different payment on a paid deal is its own ENDED, paid row). */
const SPEC_END_REASONS = ["refunded", "dispute_lost", "ended_now", "expired", "competition_finished", "legacy", "duplicate_payment"];
/** The order allowedActions answers in. */
const SPEC_DEAL_ACTIONS = ["send_invoice", "resend_invoice", "mark_paid", "approve", "refund", "end_now"];

const SI = "send_invoice";
const RI = "resend_invoice";
const MP = "mark_paid";
const AP = "approve";
const RF = "refund";
const EN = "end_now";
/** Reachable / unreachable, for the action table's flag column. */
const R = true;
const U = false;

const T0 = "2026-11-01T10:00:00.000Z";

let seq = 0;
/** A whole deal: an online, on_payment, pending draft unless overridden. Ended rows owe ended_at and ended_reason. */
function deal(over: Partial<SponsorDeal> = {}): SponsorDeal {
  seq++;
  return {
    id: `deal-${seq}`,
    sponsor_id: "sponsor-1",
    package_id: "package-1",
    deal_status: "draft",
    payment_status: "pending",
    payment_method: "online",
    go_live: "on_payment",
    package_name: "Gold",
    tier: "gold",
    includes_on_stream: false,
    competition_id: null,
    amount_cents: 50000,
    currency: "gbp",
    sponsor_name: "Harbourside Building Supplies and Timber Co",
    sponsor_email: "accounts@harbourside.example",
    ends_at: null,
    created_at: T0,
    created_by: null,
    invoice_sent_at: null,
    paid_at: null,
    marked_paid_by: null,
    approved_at: null,
    approved_by: null,
    live_at: null,
    ended_at: null,
    ended_reason: null,
    parked_at: null,
    disputed_at: null,
    dispute_id: null,
    has_payment_intent: false,
    invoice_number: null,
    ...over,
  };
}

/** One of the 90 table rows, as a deal. An ended row ends by End now (the plainest exit), so ended_reason is neither
 *  refunded nor dispute_lost; those two get their own rows below. */
function rowDeal(s: DealStatus, p: PaymentStatus, m: PaymentMethod): SponsorDeal {
  const ended = s === "ended";
  return deal({
    deal_status: s,
    payment_status: p,
    payment_method: m,
    ended_at: ended ? T0 : null,
    ended_reason: ended ? "ended_now" : null,
  });
}

function ruleError(fn: () => unknown): DealRuleError | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DealRuleError ? e : null;
  }
}

describe("lib/sponsor-deals — the value sets (D2, the V495 CHECKs; the DB half is server/sponsors/__tests__/deal-values-db.test.ts)", () => {
  it("each constant is the spec's list, in the spec's order", () => {
    expect([...DEAL_STATUSES]).toEqual(SPEC_DEAL_STATUSES);
    expect([...PAYMENT_METHODS]).toEqual(SPEC_PAYMENT_METHODS);
    expect([...GO_LIVE_RULES]).toEqual(SPEC_GO_LIVE_RULES);
    expect([...PAYMENT_STATUSES]).toEqual(SPEC_PAYMENT_STATUSES);
    expect([...END_REASONS]).toEqual(SPEC_END_REASONS);
    expect([...DEAL_ACTIONS]).toEqual(SPEC_DEAL_ACTIONS);
  });

  it("is client-safe: it imports only lib/sponsor-tiers (imports checked reported, 0 ⇒ fail)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "sponsor-deals.ts"), "utf8");
    expect(src.length, "read the module").toBeGreaterThan(0);
    const specifiers = [...src.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length, "imports checked").toBeGreaterThan(0);
    // The relative one carries `.ts`: schemas.ts imports this module's value sets and tsconfig.scripts.json (nodenext, which
    // refuses an extensionless relative specifier: TS2835) reaches it through there, so `./sponsor-tiers` alone reddens the
    // in-image `turbo run typecheck`.
    for (const s of specifiers) expect(["./sponsor-tiers.ts", "@/lib/sponsor-tiers"], s).toContain(s);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bimport\(/);
    expect(src).not.toMatch(/["']server-only["']/);
  });
});

describe("the Add deal sheet's rules (spec §5.2, D22)", () => {
  it("goLiveRulesFor: 'When paid' is not offered for a complimentary deal (3 methods checked)", () => {
    const EXPECTED: Record<string, string[]> = {
      online: ["on_payment", "immediate", "on_approval"],
      offline: ["on_payment", "immediate", "on_approval"],
      complimentary: ["immediate", "on_approval"],
    };
    let checked = 0;
    for (const m of PAYMENT_METHODS) {
      expect([...goLiveRulesFor(m)], m).toEqual(EXPECTED[m]);
      checked++;
    }
    expect(checked, "methods checked").toBe(3);
  });

  it("initialPaymentStatus: complimentary has no payment states (`none`), the others start pending (3 methods checked)", () => {
    const EXPECTED: Record<string, string> = { online: "pending", offline: "pending", complimentary: "none" };
    let checked = 0;
    for (const m of PAYMENT_METHODS) {
      expect(initialPaymentStatus(m), m).toBe(EXPECTED[m]);
      checked++;
    }
    expect(checked, "methods checked").toBe(3);
  });

  it("primaryLabel follows the choice: Send invoice / Save and go live / Save deal (18 cases checked)", () => {
    // [method, rule, otherLive, label]. complimentary + on_payment is never on the sheet (D22 moves it to immediate);
    // its label is still pinned.
    const CASES: [PaymentMethod, GoLiveRule, boolean, string][] = [
      ["online", "on_payment", false, "send_invoice"],
      ["online", "on_payment", true, "send_invoice"],
      ["online", "immediate", false, "send_invoice"],
      ["online", "immediate", true, "send_invoice"],
      ["online", "on_approval", false, "send_invoice"],
      ["online", "on_approval", true, "send_invoice"],
      ["offline", "on_payment", false, "save_deal"],
      ["offline", "on_payment", true, "save_deal"],
      ["offline", "immediate", false, "save_and_go_live"],
      ["offline", "immediate", true, "save_deal"],
      ["offline", "on_approval", false, "save_deal"],
      ["offline", "on_approval", true, "save_deal"],
      ["complimentary", "on_payment", false, "save_deal"],
      ["complimentary", "on_payment", true, "save_deal"],
      ["complimentary", "immediate", false, "save_and_go_live"],
      ["complimentary", "immediate", true, "save_deal"],
      ["complimentary", "on_approval", false, "save_deal"],
      ["complimentary", "on_approval", true, "save_deal"],
    ];
    let checked = 0;
    for (const [m, r, other, label] of CASES) {
      expect(primaryLabel(m, r, other), `${m}/${r}/otherLive=${other}`).toBe(label);
      checked++;
    }
    expect(checked, "cases checked").toBe(18);
  });
});

describe("initialStatus — every PAYMENT_METHODS × GO_LIVE_RULES × otherLive combo (spec §5.2)", () => {
  it("lands where the spec's path starts, and refuses complimentary + on_payment (18 cases checked)", () => {
    // [method, rule, otherLive, status | the refusal code]
    const CASES: [PaymentMethod, GoLiveRule, boolean, DealStatus | "on_payment_needs_payment"][] = [
      ["online", "on_payment", false, "draft"],
      ["online", "on_payment", true, "draft"],
      ["online", "immediate", false, "live"],
      ["online", "immediate", true, "scheduled"],
      ["online", "on_approval", false, "draft"],
      ["online", "on_approval", true, "draft"],
      ["offline", "on_payment", false, "awaiting_payment"],
      ["offline", "on_payment", true, "awaiting_payment"],
      ["offline", "immediate", false, "live"],
      ["offline", "immediate", true, "scheduled"],
      ["offline", "on_approval", false, "awaiting_payment"],
      ["offline", "on_approval", true, "awaiting_payment"],
      ["complimentary", "on_payment", false, "on_payment_needs_payment"],
      ["complimentary", "on_payment", true, "on_payment_needs_payment"],
      ["complimentary", "immediate", false, "live"],
      ["complimentary", "immediate", true, "scheduled"],
      ["complimentary", "on_approval", false, "awaiting_approval"],
      ["complimentary", "on_approval", true, "awaiting_approval"],
    ];
    let checked = 0;
    const seen = new Set<string>();
    for (const [m, r, other, expected] of CASES) {
      const label = `${m}/${r}/otherLive=${other}`;
      seen.add(label);
      if (expected === "on_payment_needs_payment") {
        const err = ruleError(() => initialStatus(m, r, other));
        expect(err, label).toBeInstanceOf(DealRuleError);
        expect(err!.code, label).toBe("on_payment_needs_payment");
      } else {
        expect(initialStatus(m, r, other), label).toBe(expected);
      }
      checked++;
    }
    expect(seen.size, "distinct combos").toBe(18);
    expect(checked, "cases checked").toBe(18);
  });

  it("DealRuleError is a domain error carrying its code (Task 6 maps it to an HttpError, F12)", () => {
    const err = ruleError(() => initialStatus("complimentary", "on_payment", false));
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DealRuleError);
    expect(err!.name).toBe("DealRuleError");
    expect(err!.code).toBe("on_payment_needs_payment");
    expect(err!.message.length).toBeGreaterThan(0);
  });
});

describe("the transitions (spec §5.2 table)", () => {
  it("statusAfterPaid over every deal_status × go_live × otherLive (36 cases checked)", () => {
    // Per status: the answer for [on_payment, immediate, on_approval] at otherLive false, then at true. "!" = refused.
    const X = "!";
    const TABLE: [DealStatus, [string, string, string], [string, string, string]][] = [
      ["draft", [X, X, X], [X, X, X]],
      ["awaiting_payment", ["live", X, "awaiting_approval"], ["scheduled", X, "awaiting_approval"]],
      ["awaiting_approval", [X, X, X], [X, X, X]],
      ["scheduled", ["scheduled", "scheduled", "scheduled"], ["scheduled", "scheduled", "scheduled"]],
      ["live", ["live", "live", "live"], ["live", "live", "live"]],
      ["ended", ["ended", "ended", "ended"], ["ended", "ended", "ended"]],
    ];
    let checked = 0;
    for (const [s, alone, behind] of TABLE) {
      for (const [other, answers] of [[false, alone], [true, behind]] as const) {
        SPEC_GO_LIVE_RULES.forEach((r, i) => {
          const label = `${s}/${r}/otherLive=${other}`;
          const d = { deal_status: s, go_live: r as GoLiveRule };
          if (answers[i] === X) {
            expect(ruleError(() => statusAfterPaid(d, other))?.code, label).toBe("illegal_transition");
          } else {
            expect(statusAfterPaid(d, other), label).toBe(answers[i]);
          }
          checked++;
        });
      }
    }
    expect(checked, "cases checked").toBe(36);
  });

  it("statusAfterInvoiceSent: a draft awaits payment; a resend leaves an unpaid deal where it is (6 statuses checked)", () => {
    const TABLE: [DealStatus, DealStatus | "!"][] = [
      ["draft", "awaiting_payment"],
      ["awaiting_payment", "awaiting_payment"],
      ["awaiting_approval", "!"],
      ["scheduled", "scheduled"],
      ["live", "live"],
      ["ended", "!"],
    ];
    let checked = 0;
    for (const [s, expected] of TABLE) {
      if (expected === "!") expect(ruleError(() => statusAfterInvoiceSent({ deal_status: s }))?.code, s).toBe("illegal_transition");
      else expect(statusAfterInvoiceSent({ deal_status: s }), s).toBe(expected);
      checked++;
    }
    expect(checked, "statuses checked").toBe(6);
  });

  it("statusAfterApproved: only an awaiting_approval deal is approved — live, or scheduled behind a live one (12 cases checked)", () => {
    let checked = 0;
    for (const s of SPEC_DEAL_STATUSES as DealStatus[]) {
      for (const other of [false, true]) {
        const label = `${s}/otherLive=${other}`;
        if (s === "awaiting_approval") expect(statusAfterApproved({ deal_status: s }, other), label).toBe(other ? "scheduled" : "live");
        else expect(ruleError(() => statusAfterApproved({ deal_status: s }, other))?.code, label).toBe("illegal_transition");
        checked++;
      }
    }
    expect(checked, "cases checked").toBe(12);
  });

  it("the second call: a redelivered payment leaves a live deal live, a second resend stays put, a second approve is refused", () => {
    const paidOnce = statusAfterPaid({ deal_status: "awaiting_payment", go_live: "on_payment" }, false);
    expect(paidOnce).toBe("live");
    expect(statusAfterPaid({ deal_status: paidOnce, go_live: "on_payment" }, false)).toBe("live");
    const sentOnce = statusAfterInvoiceSent({ deal_status: "draft" });
    expect(statusAfterInvoiceSent({ deal_status: sentOnce })).toBe("awaiting_payment");
    const approvedOnce = statusAfterApproved({ deal_status: "awaiting_approval" }, false);
    expect(ruleError(() => statusAfterApproved({ deal_status: approvedOnce }, false))?.code).toBe("illegal_transition");
  });
});

describe("the path walks — create → send → paid → approve in the order each rule allows (8 combos × otherLive)", () => {
  type Step = "send" | "paid" | "approve";
  /** [method, rule, the steps the rule takes after create, the path at otherLive false, the path at otherLive true].
   *  A path lists the status after create and after each step (spec §5.2). */
  const WALKS: [PaymentMethod, GoLiveRule, Step[], DealStatus[], DealStatus[]][] = [
    ["online", "on_payment", ["send", "paid"], ["draft", "awaiting_payment", "live"], ["draft", "awaiting_payment", "scheduled"]],
    // "Online, straight away": live at once, while payment is still awaited; the invoice and the payment move nothing.
    ["online", "immediate", ["send", "paid"], ["live", "live", "live"], ["scheduled", "scheduled", "scheduled"]],
    [
      "online", "on_approval", ["send", "paid", "approve"],
      ["draft", "awaiting_payment", "awaiting_approval", "live"], ["draft", "awaiting_payment", "awaiting_approval", "scheduled"],
    ],
    // Offline: the same three rules, with Mark as paid in place of the webhook (no send step in PR 1).
    ["offline", "on_payment", ["paid"], ["awaiting_payment", "live"], ["awaiting_payment", "scheduled"]],
    ["offline", "immediate", ["paid"], ["live", "live"], ["scheduled", "scheduled"]],
    ["offline", "on_approval", ["paid", "approve"], ["awaiting_payment", "awaiting_approval", "live"], ["awaiting_payment", "awaiting_approval", "scheduled"]],
    // Complimentary: no payment states.
    ["complimentary", "immediate", [], ["live"], ["scheduled"]],
    ["complimentary", "on_approval", ["approve"], ["awaiting_approval", "live"], ["awaiting_approval", "scheduled"]],
  ];

  it("each walk follows the spec path, and every console step on it is an action the deal offers (16 walks checked)", () => {
    let walks = 0;
    let steps = 0;
    for (const [m, r, plan, alone, behind] of WALKS) {
      for (const [other, expected] of [[false, alone], [true, behind]] as const) {
        const label = `${m}/${r}/otherLive=${other}`;
        let d = deal({ payment_method: m, go_live: r, payment_status: initialPaymentStatus(m), deal_status: initialStatus(m, r, other) });
        const path: DealStatus[] = [d.deal_status];
        for (const step of plan) {
          if (step === "send") {
            // A draft's send is the Send invoice action; an immediate online deal's invoice goes with its create.
            if (d.deal_status === "draft") expect(allowedActions(d), `${label} send`).toContain("send_invoice");
            d = { ...d, deal_status: statusAfterInvoiceSent(d), invoice_sent_at: T0 };
          } else if (step === "paid") {
            // The webhook (online) or Mark as paid (offline): both are offered to an unpaid deal on the walk.
            expect(allowedActions(d), `${label} paid`).toContain("mark_paid");
            d = { ...d, deal_status: statusAfterPaid(d, other), payment_status: "paid", paid_at: T0 };
          } else {
            expect(allowedActions(d), `${label} approve`).toContain("approve");
            d = { ...d, deal_status: statusAfterApproved(d, other), approved_at: T0 };
          }
          path.push(d.deal_status);
          steps++;
        }
        expect(path, label).toEqual(expected);
        walks++;
      }
    }
    expect(walks, "walks checked").toBe(16);
    expect(steps, "steps taken").toBeGreaterThan(0);
  });

  it("the walks cover every allowed method × rule combo exactly once (8), and complimentary + on_payment is not one", () => {
    const combos = new Set(WALKS.map(([m, r]) => `${m}/${r}`));
    expect(combos.size).toBe(8);
    expect(combos.has("complimentary/on_payment")).toBe(false);
  });
});

describe("allowedActions — the full action table (F15): deal_status × payment_status × payment_method", () => {
  /** [deal_status, payment_status, method, allowedActions in DEAL_ACTIONS order, rowNextAction, reachable].
   *  Reachable = some product path writes it (spec §5.2, D2, the V495 CHECKs: complimentary ⇔ `none`; an offline deal
   *  never fails a payment; a refund or a lost dispute ends the deal). Unreachable rows still pin their answer. */
  type Row = [DealStatus, PaymentStatus, PaymentMethod, DealAction[], RowAction | null, boolean];
  const TABLE: Row[] = [
    // draft — only an online deal is ever a draft (offline starts awaiting payment; complimentary never waits on one).
    ["draft", "pending", "online", [SI, EN], "open_deal", R],
    ["draft", "pending", "offline", [EN], "open_deal", U],
    ["draft", "pending", "complimentary", [EN], "open_deal", U],
    ["draft", "paid", "online", [RF, EN], "open_deal", U],
    ["draft", "paid", "offline", [RF, EN], "open_deal", U],
    ["draft", "paid", "complimentary", [EN], "open_deal", U],
    ["draft", "failed", "online", [SI, EN], "open_deal", U],
    ["draft", "failed", "offline", [EN], "open_deal", U],
    ["draft", "failed", "complimentary", [EN], "open_deal", U],
    ["draft", "refunded", "online", [EN], "open_deal", U],
    ["draft", "refunded", "offline", [EN], "open_deal", U],
    ["draft", "refunded", "complimentary", [EN], "open_deal", U],
    ["draft", "none", "online", [EN], "open_deal", U],
    ["draft", "none", "offline", [EN], "open_deal", U],
    ["draft", "none", "complimentary", [EN], "open_deal", U],
    // awaiting_payment — "Awaiting payment: Mark as paid, Resend invoice (online), End now" (mockup screen 5).
    ["awaiting_payment", "pending", "online", [RI, MP, EN], "resend_invoice", R],
    ["awaiting_payment", "pending", "offline", [MP, EN], "mark_paid", R],
    ["awaiting_payment", "pending", "complimentary", [EN], null, U],
    ["awaiting_payment", "paid", "online", [RF, EN], null, U],
    ["awaiting_payment", "paid", "offline", [RF, EN], null, U],
    ["awaiting_payment", "paid", "complimentary", [EN], null, U],
    ["awaiting_payment", "failed", "online", [RI, MP, EN], "resend_invoice", R],
    ["awaiting_payment", "failed", "offline", [MP, EN], "mark_paid", U],
    ["awaiting_payment", "failed", "complimentary", [EN], null, U],
    ["awaiting_payment", "refunded", "online", [EN], null, U],
    ["awaiting_payment", "refunded", "offline", [EN], null, U],
    ["awaiting_payment", "refunded", "complimentary", [EN], null, U],
    ["awaiting_payment", "none", "online", [EN], null, U],
    ["awaiting_payment", "none", "offline", [EN], null, U],
    ["awaiting_payment", "none", "complimentary", [EN], null, U],
    // awaiting_approval — paid online/offline after approval, or complimentary on approval.
    ["awaiting_approval", "pending", "online", [AP, EN], "approve", U],
    ["awaiting_approval", "pending", "offline", [AP, EN], "approve", U],
    ["awaiting_approval", "pending", "complimentary", [AP, EN], "approve", U],
    ["awaiting_approval", "paid", "online", [AP, RF, EN], "approve", R],
    ["awaiting_approval", "paid", "offline", [AP, RF, EN], "approve", R],
    ["awaiting_approval", "paid", "complimentary", [AP, EN], "approve", U],
    ["awaiting_approval", "failed", "online", [AP, EN], "approve", U],
    ["awaiting_approval", "failed", "offline", [AP, EN], "approve", U],
    ["awaiting_approval", "failed", "complimentary", [AP, EN], "approve", U],
    ["awaiting_approval", "refunded", "online", [AP, EN], "approve", U],
    ["awaiting_approval", "refunded", "offline", [AP, EN], "approve", U],
    ["awaiting_approval", "refunded", "complimentary", [AP, EN], "approve", U],
    ["awaiting_approval", "none", "online", [AP, EN], "approve", U],
    ["awaiting_approval", "none", "offline", [AP, EN], "approve", U],
    ["awaiting_approval", "none", "complimentary", [AP, EN], "approve", R],
    // scheduled — every condition met, queued behind the sponsor's live deal (§8a); an immediate deal may still be unpaid.
    ["scheduled", "pending", "online", [RI, MP, EN], "open_deal", R],
    ["scheduled", "pending", "offline", [MP, EN], "open_deal", R],
    ["scheduled", "pending", "complimentary", [EN], "open_deal", U],
    ["scheduled", "paid", "online", [RF, EN], "open_deal", R],
    ["scheduled", "paid", "offline", [RF, EN], "open_deal", R],
    ["scheduled", "paid", "complimentary", [EN], "open_deal", U],
    ["scheduled", "failed", "online", [RI, MP, EN], "open_deal", R],
    ["scheduled", "failed", "offline", [MP, EN], "open_deal", U],
    ["scheduled", "failed", "complimentary", [EN], "open_deal", U],
    ["scheduled", "refunded", "online", [EN], "open_deal", U],
    ["scheduled", "refunded", "offline", [EN], "open_deal", U],
    ["scheduled", "refunded", "complimentary", [EN], "open_deal", U],
    ["scheduled", "none", "online", [EN], "open_deal", U],
    ["scheduled", "none", "offline", [EN], "open_deal", U],
    ["scheduled", "none", "complimentary", [EN], "open_deal", R],
    // live — "Live: Refund, End now"; "Live · awaiting payment" (immediate) also offers the payment actions.
    ["live", "pending", "online", [RI, MP, EN], "resend_invoice", R],
    ["live", "pending", "offline", [MP, EN], "mark_paid", R],
    ["live", "pending", "complimentary", [EN], null, U],
    ["live", "paid", "online", [RF, EN], null, R],
    ["live", "paid", "offline", [RF, EN], null, R],
    ["live", "paid", "complimentary", [EN], null, U],
    ["live", "failed", "online", [RI, MP, EN], "resend_invoice", R],
    ["live", "failed", "offline", [MP, EN], "mark_paid", U],
    ["live", "failed", "complimentary", [EN], null, U],
    ["live", "refunded", "online", [EN], null, U],
    ["live", "refunded", "offline", [EN], null, U],
    ["live", "refunded", "complimentary", [EN], null, U],
    ["live", "none", "online", [EN], null, U],
    ["live", "none", "offline", [EN], null, U],
    ["live", "none", "complimentary", [EN], null, R],
    // ended (by End now) — nothing but a refund of a paid deal (F3).
    ["ended", "pending", "online", [], "add_deal", R],
    ["ended", "pending", "offline", [], "add_deal", R],
    ["ended", "pending", "complimentary", [], "add_deal", U],
    ["ended", "paid", "online", [RF], "add_deal", R],
    ["ended", "paid", "offline", [RF], "add_deal", R],
    ["ended", "paid", "complimentary", [], "add_deal", U],
    ["ended", "failed", "online", [], "add_deal", R],
    ["ended", "failed", "offline", [], "add_deal", U],
    ["ended", "failed", "complimentary", [], "add_deal", U],
    ["ended", "refunded", "online", [], "add_deal", R],
    ["ended", "refunded", "offline", [], "add_deal", R],
    ["ended", "refunded", "complimentary", [], "add_deal", U],
    ["ended", "none", "online", [], "add_deal", U],
    ["ended", "none", "offline", [], "add_deal", U],
    ["ended", "none", "complimentary", [], "add_deal", R],
  ];

  it("the table is the full product, once each: 90 rows, 27 reachable", () => {
    expect(TABLE.length).toBe(90);
    const keys = new Set(TABLE.map(([s, p, m]) => `${s}/${p}/${m}`));
    let covered = 0;
    for (const s of SPEC_DEAL_STATUSES) {
      for (const p of SPEC_PAYMENT_STATUSES) {
        for (const m of SPEC_PAYMENT_METHODS) {
          expect(keys.has(`${s}/${p}/${m}`), `${s}/${p}/${m}`).toBe(true);
          covered++;
        }
      }
    }
    expect(covered, "combos covered").toBe(90);
    expect(keys.size).toBe(90);
    expect(TABLE.filter((row) => row[5]).length, "reachable rows").toBe(27);
  });

  it("the typed reachable set agrees with the V495 CHECK none_iff_complimentary (27 reachable rows checked)", () => {
    let checked = 0;
    for (const [s, p, m, , , reachable] of TABLE) {
      if (!reachable) continue;
      expect(m === "complimentary", `${s}/${p}/${m}`).toBe(p === "none");
      checked++;
    }
    expect(checked, "reachable rows checked").toBe(27);
  });

  it("allowedActions answers every row with its typed list, in DEAL_ACTIONS order (90 rows checked)", () => {
    let checked = 0;
    for (const [s, p, m, expected] of TABLE) {
      expect(allowedActions(rowDeal(s, p, m)), `${s}/${p}/${m}`).toEqual(expected);
      checked++;
    }
    expect(checked, "rows checked").toBe(90);
  });

  it("rowNextAction answers every row with its typed action (90 rows checked)", () => {
    let checked = 0;
    for (const [s, p, m, , expected] of TABLE) {
      expect(rowNextAction(rowDeal(s, p, m)), `${s}/${p}/${m}`).toBe(expected);
      checked++;
    }
    expect(checked, "rows checked").toBe(90);
  });

  it("a row's next action is never send_invoice, and when it is a deal action the deal offers it (90 rows checked)", () => {
    const DEAL_ACTION_SET = new Set<string>(SPEC_DEAL_ACTIONS);
    let checked = 0;
    let dealActionRows = 0;
    for (const [s, p, m] of TABLE) {
      const d = rowDeal(s, p, m);
      const next = rowNextAction(d);
      expect(next, `${s}/${p}/${m}`).not.toBe("send_invoice");
      if (next !== null && DEAL_ACTION_SET.has(next)) {
        expect(allowedActions(d) as string[], `${s}/${p}/${m}`).toContain(next);
        dealActionRows++;
      }
      checked++;
    }
    expect(checked, "rows checked").toBe(90);
    expect(dealActionRows, "rows whose next action is a deal action").toBeGreaterThan(0);
  });

  it("complimentary never offers mark_paid, refund or *_invoice, whatever its other fields say (30 rows checked)", () => {
    const FORBIDDEN = new Set<string>([SI, RI, MP, RF]);
    let checked = 0;
    for (const s of SPEC_DEAL_STATUSES as DealStatus[]) {
      for (const p of SPEC_PAYMENT_STATUSES as PaymentStatus[]) {
        const offered = allowedActions(rowDeal(s, p, "complimentary"));
        expect(offered.filter((a) => FORBIDDEN.has(a)), `${s}/${p}`).toEqual([]);
        checked++;
      }
    }
    expect(checked, "rows checked").toBe(30);
  });

  it("the exits and the dispute: refund stops at a refund in flight, a lost dispute and an open dispute; a duplicate payment is refundable (F3) (rows checked reported)", () => {
    // [label, the deal, allowedActions]
    const EXTRA: [string, SponsorDeal, DealAction[]][] = [
      ["the empty case: ended, refunded and refunded", deal({ deal_status: "ended", payment_status: "refunded", ended_at: T0, ended_reason: "refunded" }), []],
      ["ended by a refund still in flight (paid), online", deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "refunded" }), []],
      ["ended by a refund still in flight (paid), offline", deal({ payment_method: "offline", deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "refunded" }), []],
      ["ended by a lost dispute, still paid, online", deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "dispute_lost", disputed_at: T0, dispute_id: "dp_1" }), []],
      ["ended by a lost dispute, flag cleared, online", deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "dispute_lost" }), []],
      ["ended by a lost dispute, offline (unreachable)", deal({ payment_method: "offline", deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "dispute_lost" }), []],
      ["ended as a duplicate payment (F3), online", deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "duplicate_payment" }), [RF]],
      ["ended by expiry, paid", deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "expired" }), [RF]],
      ["ended as its competition finished, paid offline", deal({ payment_method: "offline", deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "competition_finished" }), [RF]],
      ["ended by End now with an open dispute", deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "ended_now", disputed_at: T0, dispute_id: "dp_2" }), []],
      ["live, parked by an open dispute", deal({ deal_status: "live", payment_status: "paid", disputed_at: T0, dispute_id: "dp_3", parked_at: T0 }), [EN]],
      ["awaiting approval with an open dispute", deal({ deal_status: "awaiting_approval", payment_status: "paid", disputed_at: T0, dispute_id: "dp_4" }), [AP, EN]],
      ["scheduled with an open dispute", deal({ deal_status: "scheduled", payment_status: "paid", disputed_at: T0, dispute_id: "dp_5" }), [EN]],
      ["live after a won dispute (flag cleared)", deal({ deal_status: "live", payment_status: "paid", dispute_id: "dp_6" }), [RF, EN]],
      ["a legacy deal, paid", deal({ sponsor_id: null, deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "legacy" }), [RF]],
      ["complimentary, ended", deal({ payment_method: "complimentary", go_live: "immediate", deal_status: "ended", payment_status: "none", ended_at: T0, ended_reason: "ended_now" }), []],
    ];
    let checked = 0;
    for (const [label, d, expected] of EXTRA) {
      expect(allowedActions(d), label).toEqual(expected);
      checked++;
    }
    expect(checked, "rows checked").toBe(16);
  });

  it("every end reason × paid online: refund unless refunded or dispute_lost (7 reasons checked)", () => {
    const REFUNDABLE: Record<string, boolean> = {
      refunded: false, dispute_lost: false, ended_now: true, expired: true, competition_finished: true, legacy: true, duplicate_payment: true,
    };
    let checked = 0;
    for (const reason of SPEC_END_REASONS as EndReason[]) {
      const d = deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: reason });
      expect(allowedActions(d), reason).toEqual(REFUNDABLE[reason] ? [RF] : []);
      checked++;
    }
    expect(checked, "reasons checked").toBe(7);
  });
});

describe("pickRowDeal — the deal a sponsor's row shows", () => {
  const ended = (over: Partial<SponsorDeal>) => deal({ deal_status: "ended", ended_reason: "ended_now", ended_at: T0, ...over });

  it("the empty case: no deals, or only legacy deals ⇒ null", () => {
    expect(pickRowDeal([])).toBeNull();
    expect(pickRowDeal([ended({ sponsor_id: null, ended_reason: "legacy" })])).toBeNull();
    expect(pickRowDeal([ended({ ended_reason: "legacy" }), ended({ ended_reason: "legacy", ended_at: "2026-11-05T00:00:00.000Z" })])).toBeNull();
  });

  it("precedence live > awaiting_approval > awaiting_payment > draft > scheduled > ended, removing each winner in turn (6 steps checked)", () => {
    const ORDER: DealStatus[] = ["live", "awaiting_approval", "awaiting_payment", "draft", "scheduled", "ended"];
    // Created in REVERSE precedence, so the winner is never simply the newest or the oldest row.
    const pool = [...ORDER].reverse().map((s, i) =>
      s === "ended" ? ended({ created_at: `2026-11-0${i + 1}T00:00:00.000Z` }) : deal({ deal_status: s, created_at: `2026-11-0${i + 1}T00:00:00.000Z` }),
    );
    pool.push(ended({ ended_reason: "legacy", created_at: "2026-11-09T00:00:00.000Z", ended_at: "2026-11-09T00:00:00.000Z" }));
    let checked = 0;
    let rest = pool;
    for (const s of ORDER) {
      const pick = pickRowDeal(rest);
      expect(pick?.deal_status, `step ${checked}`).toBe(s);
      expect(pick?.ended_reason, `step ${checked}`).not.toBe("legacy");
      rest = rest.filter((d) => d !== pick);
      checked++;
    }
    expect(checked, "steps checked").toBe(6);
    // Only the legacy row is left.
    expect(rest).toHaveLength(1);
    expect(pickRowDeal(rest)).toBeNull();
  });

  it("the ordering differential: [ended newer, live older] ⇒ live", () => {
    const live = deal({ deal_status: "live", payment_status: "paid", created_at: "2026-10-01T00:00:00.000Z" });
    const newer = ended({ created_at: "2026-11-01T00:00:00.000Z", ended_at: "2026-11-02T00:00:00.000Z" });
    expect(pickRowDeal([newer, live])).toBe(live);
    expect(pickRowDeal([live, newer])).toBe(live);
  });

  it("among ended deals, the latest by ended_at — not by created_at, not by input order", () => {
    const createdLateEndedEarly = ended({ created_at: "2026-11-05T00:00:00.000Z", ended_at: "2026-11-06T00:00:00.000Z" });
    const createdEarlyEndedLate = ended({ created_at: "2026-11-01T00:00:00.000Z", ended_at: "2026-11-08T00:00:00.000Z" });
    expect(pickRowDeal([createdLateEndedEarly, createdEarlyEndedLate])).toBe(createdEarlyEndedLate);
    expect(pickRowDeal([createdEarlyEndedLate, createdLateEndedEarly])).toBe(createdEarlyEndedLate);
  });

  it("a legacy deal is excluded even when it ended last", () => {
    const real = ended({ ended_at: "2026-11-01T00:00:00.000Z" });
    const legacy = ended({ sponsor_id: null, ended_reason: "legacy", ended_at: "2026-11-09T00:00:00.000Z" });
    expect(pickRowDeal([legacy, real])).toBe(real);
  });

  it("two open deals of one status: the oldest (the queue order, created_at then id), whatever the input order", () => {
    const older = deal({ deal_status: "awaiting_payment", created_at: "2026-11-01T00:00:00.000Z" });
    const newer = deal({ deal_status: "awaiting_payment", created_at: "2026-11-03T00:00:00.000Z" });
    expect(pickRowDeal([newer, older])).toBe(older);
    expect(pickRowDeal([older, newer])).toBe(older);
    const a = deal({ id: "a", deal_status: "scheduled", created_at: T0 });
    const b = deal({ id: "b", deal_status: "scheduled", created_at: T0 });
    expect(pickRowDeal([b, a])).toBe(a);
  });

  it("reads timestamps given as Date objects too (postgres.js rows), and never reorders its input", () => {
    const early = ended({ ended_at: new Date("2026-11-01T00:00:00.000Z") as unknown as string });
    const late = ended({ ended_at: new Date("2026-11-04T00:00:00.000Z") as unknown as string });
    const input = Object.freeze([early, late]);
    expect(pickRowDeal(input)).toBe(late);
    expect(input[0]).toBe(early);
  });
});

describe("rowNextAction — the precedence (F15), first match wins", () => {
  it("rule 1, the empty case first: no deal ⇒ add_deal; an ended deal ⇒ add_deal, even a refundable one", () => {
    expect(rowNextAction(null)).toBe("add_deal");
    expect(rowNextAction(deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: "ended_now" }))).toBe("add_deal");
  });

  it("rule 2: awaiting_approval ⇒ approve, even with payment pending (the overlap with rule 3)", () => {
    expect(rowNextAction(deal({ deal_status: "awaiting_approval", payment_status: "paid" }))).toBe("approve");
    expect(rowNextAction(deal({ deal_status: "awaiting_approval", payment_status: "pending" }))).toBe("approve");
  });

  it("rule 3: unpaid and not draft or scheduled ⇒ resend_invoice (online) or mark_paid (offline); failed is unpaid", () => {
    expect(rowNextAction(deal({ deal_status: "awaiting_payment", payment_status: "pending" }))).toBe("resend_invoice");
    expect(rowNextAction(deal({ deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline" }))).toBe("mark_paid");
    expect(rowNextAction(deal({ deal_status: "live", payment_status: "pending", go_live: "immediate" }))).toBe("resend_invoice");
    expect(rowNextAction(deal({ deal_status: "live", payment_status: "pending", go_live: "immediate", payment_method: "offline" }))).toBe("mark_paid");
    expect(rowNextAction(deal({ deal_status: "awaiting_payment", payment_status: "failed" }))).toBe("resend_invoice");
    expect(rowNextAction(deal({ deal_status: "live", payment_status: "failed", go_live: "immediate" }))).toBe("resend_invoice");
  });

  it("rule 4: draft or scheduled ⇒ open_deal — a draft with payment pending and a scheduled deal with payment pending included", () => {
    expect(rowNextAction(deal({ deal_status: "draft", payment_status: "pending" }))).toBe("open_deal");
    expect(rowNextAction(deal({ deal_status: "scheduled", payment_status: "pending", go_live: "immediate" }))).toBe("open_deal");
    expect(rowNextAction(deal({ deal_status: "scheduled", payment_status: "pending", go_live: "immediate", payment_method: "offline" }))).toBe("open_deal");
    expect(rowNextAction(deal({ deal_status: "scheduled", payment_status: "paid" }))).toBe("open_deal");
  });

  it("rule 5: live with payment paid or none ⇒ null", () => {
    expect(rowNextAction(deal({ deal_status: "live", payment_status: "paid" }))).toBeNull();
    expect(rowNextAction(deal({ deal_status: "live", payment_status: "none", payment_method: "complimentary", go_live: "immediate" }))).toBeNull();
  });
});

describe("dealChip (spec §5.2 chips, D2: Paid is derived)", () => {
  it("kind and awaitingPayment over every deal_status × payment_status (30 rows checked)", () => {
    // [status, payment, kind, awaitingPayment]. "Live · awaiting payment" is live + unpaid; a scheduled deal shows Paid
    // once paid; failed reads as pending (F15).
    const TABLE: [DealStatus, PaymentStatus, DealChip["kind"], boolean][] = [
      ["draft", "pending", "draft", false], ["draft", "paid", "draft", false], ["draft", "failed", "draft", false],
      ["draft", "refunded", "draft", false], ["draft", "none", "draft", false],
      ["awaiting_payment", "pending", "awaiting_payment", false], ["awaiting_payment", "paid", "awaiting_payment", false],
      ["awaiting_payment", "failed", "awaiting_payment", false], ["awaiting_payment", "refunded", "awaiting_payment", false],
      ["awaiting_payment", "none", "awaiting_payment", false],
      ["awaiting_approval", "pending", "awaiting_approval", false], ["awaiting_approval", "paid", "awaiting_approval", false],
      ["awaiting_approval", "failed", "awaiting_approval", false], ["awaiting_approval", "refunded", "awaiting_approval", false],
      ["awaiting_approval", "none", "awaiting_approval", false],
      ["scheduled", "pending", "scheduled", false], ["scheduled", "paid", "paid", false], ["scheduled", "failed", "scheduled", false],
      ["scheduled", "refunded", "scheduled", false], ["scheduled", "none", "scheduled", false],
      ["live", "pending", "live", true], ["live", "paid", "live", false], ["live", "failed", "live", true],
      ["live", "refunded", "live", false], ["live", "none", "live", false],
      ["ended", "pending", "ended", false], ["ended", "paid", "ended", false], ["ended", "failed", "ended", false],
      ["ended", "refunded", "ended", false], ["ended", "none", "ended", false],
    ];
    expect(TABLE.length).toBe(30);
    let checked = 0;
    for (const [s, p, kind, awaiting] of TABLE) {
      expect(dealChip(rowDeal(s, p, p === "none" ? "complimentary" : "online")), `${s}/${p}`).toEqual({ kind, awaitingPayment: awaiting, onHold: false });
      checked++;
    }
    expect(checked, "rows checked").toBe(30);
  });

  it("onHold: a live deal parked by a dispute is on hold; parked_at on any other status is not (6 statuses checked)", () => {
    let checked = 0;
    for (const s of SPEC_DEAL_STATUSES as DealStatus[]) {
      const d = { ...rowDeal(s, "paid", "online"), parked_at: T0, disputed_at: T0, dispute_id: "dp_9" };
      expect(dealChip(d).onHold, s).toBe(s === "live");
      checked++;
    }
    expect(checked, "statuses checked").toBe(6);
    // Both flags at once: live, unpaid, parked.
    expect(dealChip(deal({ deal_status: "live", payment_status: "pending", parked_at: T0 }))).toEqual({ kind: "live", awaitingPayment: true, onHold: true });
    // The negative's positive pair: the same live deal unparked is not on hold.
    expect(dealChip(deal({ deal_status: "live", payment_status: "paid" })).onHold).toBe(false);
  });
});
