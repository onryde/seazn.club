// Sponsor deals, Task 2: the pure deal domain (plan 2026-11-07-sponsor-deals, D2, D8, D9, D22; preflight F3, F12, F13,
// F15, F31). Every expected value below is typed from spec §5.2 (the deal status table and its exits), the brief's
// acceptance lines and the controller's rulings — never read back from lib/sponsor-deals.ts. In particular the
// reachable set of the action table is a typed literal list, not a walk through this module's own transitions (that
// would make the implementation its own oracle, F15).
//
// The rules the tables are typed from (F15, total over deal_status × payment_status × payment_method):
//   - "unpaid" is payment `pending` or `failed` (Task 8 keeps a failed deal payable, so it offers what pending offers);
//   - draft → send_invoice (online, unpaid), end_now;
//   - awaiting_payment → resend_invoice (online, or offline with an email), mark_paid, end_now — while unpaid;
//   - awaiting_approval → approve, end_now (plus refund when paid);
//   - live / scheduled → end_now; while unpaid also resend_invoice (online, or offline with an email) and mark_paid;
//   - paid, not disputed → refund in every status, ended included, unless ended_reason is refunded or dispute_lost;
//   - ended → nothing else, EXCEPT an offline deal that went live and ended unpaid by the sweep (`expired`,
//     `competition_finished`): still due, so mark_paid and write_off, and resend_invoice when it has an email (Task 23
//     carries 1 and 4, from the T22 re-review); complimentary → never mark_paid, write_off, refund or *_invoice;
//   - send_invoice is online-only; resend_invoice reaches an offline deal only through its email (Task 23, F13).
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
  blocksArchive,
  dealChip,
  endedStillDue,
  goLiveRulesFor,
  initialPaymentStatus,
  initialStatus,
  invoiceActionOnCreate,
  isPastEnd,
  nextScheduledDeal,
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
/** The brief's six plus `duplicate_payment` (F3: a second, different payment on a paid deal is its own ENDED, paid row) and
 *  `written_off` (Task 23 carry 4: the club waived an offline invoice still due after its deal ended). */
const SPEC_END_REASONS = [
  "refunded", "dispute_lost", "ended_now", "expired", "competition_finished", "legacy", "duplicate_payment", "written_off",
];
/** The end reasons after which an offline deal that went live and ended unpaid is still DUE: the sweep's two (its term ran out,
 *  its competition finished). Task 23 carries 1 and 4, and archive spec §8 row 7. Every other reason, `written_off` included
 *  (archive preflight P2), is settled or was never a deal. */
const SPEC_STILL_DUE_REASONS: ReadonlySet<string> = new Set(["expired", "competition_finished"]);
/** The order allowedActions answers in: Write off sits beside Mark as paid, the other answer to an invoice still due. */
const SPEC_DEAL_ACTIONS = ["send_invoice", "resend_invoice", "mark_paid", "write_off", "approve", "refund", "end_now"];

const SI = "send_invoice";
const RI = "resend_invoice";
const MP = "mark_paid";
const WO = "write_off";
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
  // D11: an online or offline deal is numbered when it is created; a complimentary one never is. The unnumbered (pre-numbering)
  // deal is its own sweep below.
  const numbered = (over.payment_method ?? "online") !== "complimentary";
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
    invoice_number: numbered ? 7 : null,
    written_off_at: null,
    written_off_by: null,
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

  it("is client-safe: it imports only lib/sponsor-tiers at run time; the one TYPE-only import (the summary's MessageKey) is erased (imports checked reported, 0 ⇒ fail)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "sponsor-deals.ts"), "utf8");
    expect(src.length, "read the module").toBeGreaterThan(0);
    const imports = [...src.matchAll(/^\s*import\b(\s+type\b)?[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => ({ typeOnly: m[1] !== undefined, from: m[2]! }));
    expect(imports.length, "imports checked").toBeGreaterThan(0);
    const runtime = imports.filter((i) => !i.typeOnly);
    const typeOnly = imports.filter((i) => i.typeOnly);
    // The relative one carries `.ts`: api-v1/schemas/ imports this module's value sets and tsconfig.scripts.json (nodenext, which
    // refuses an extensionless relative specifier: TS2835) reaches it through there, so `./sponsor-tiers` alone reddens the
    // in-image `turbo run typecheck`.
    for (const i of runtime) expect(["./sponsor-tiers.ts", "@/lib/sponsor-tiers"], i.from).toContain(i.from);
    // `import type` never reaches the bundle, so it cannot make this module server-only: the summary's keys are typed by the
    // message catalogue (the i18n house rule bans dynamic `msg()` keys) and nothing else may be type-imported without a ruling here.
    for (const i of typeOnly) expect(["./sponsor-tiers.ts", "@/lib/sponsor-tiers", "@/lib/messages"], i.from).toContain(i.from);
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

// Fix round 1 (batch H review): the queue's head and the end test the Add deal sheet asks the same way the server does, and the
// invoice action a saved online deal offers.
describe("isPastEnd and nextScheduledDeal — the queue's head (spec §8a, deal-apply step 2, F19)", () => {
  const NOW = new Date("2026-11-10T12:00:00.000Z");
  const sched = (id: string, ends_at: string | null, deal_status: DealStatus = "scheduled") => ({ id, deal_status, ends_at });

  it("isPastEnd: no end is never past; the end itself IS over (<=); a millisecond either side (6 checked)", () => {
    const cases: [string | Date | null, boolean][] = [
      [null, false],
      [NOW.toISOString(), true],
      [new Date(NOW.getTime() - 1).toISOString(), true],
      [new Date(NOW.getTime() + 1).toISOString(), false],
      [new Date(NOW.getTime()), true],
      ["2099-01-01T00:00:00.000Z", false],
    ];
    let checked = 0;
    for (const [endsAt, past] of cases) {
      expect(isPastEnd(endsAt, NOW), String(endsAt)).toBe(past);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("the empty case first: no deals, nothing scheduled, and nothing but scheduled counts (every other status, 5 checked)", () => {
    expect(nextScheduledDeal([], NOW)).toBeNull();
    let checked = 0;
    for (const status of DEAL_STATUSES.filter((st) => st !== "scheduled")) {
      expect(nextScheduledDeal([sched("x", null, status)], NOW), status).toBeNull();
      checked++;
    }
    expect(checked, "six statuses less scheduled").toBe(5);
  });

  it("it is the FIRST scheduled deal in the order given whose own end has not passed: a past-end one is skipped, never promoted", () => {
    const a = sched("a", "2020-01-01T00:00:00.000Z");
    const b = sched("b", null);
    const c = sched("c", "2099-01-01T00:00:00.000Z");
    expect(nextScheduledDeal([a, b, c], NOW)?.id, "a is past its end: b is the head").toBe("b");
    expect(nextScheduledDeal([c, b], NOW)?.id, "the order given decides").toBe("c");
    expect(nextScheduledDeal([a], NOW), "every scheduled deal past its end: nothing to promote").toBeNull();
    expect(nextScheduledDeal([sched("l", null, "live"), c], NOW)?.id, "a live deal in the list is not the queue").toBe("c");
  });
});

describe("invoiceActionOnCreate — which invoice action an ONLINE deal offers right after it is made (spec §5.2, F15)", () => {
  // Typed from the spec: a deal that waits for its rule is a DRAFT (Send invoice sends it); an immediate deal is live - or scheduled
  // behind a live deal - with its payment pending, and an invoice that is out is RESENT.
  const EXPECTED: [GoLiveRule, boolean, "send_invoice" | "resend_invoice"][] = [
    ["on_payment", false, "send_invoice"],
    ["on_payment", true, "send_invoice"],
    ["on_approval", false, "send_invoice"],
    ["on_approval", true, "send_invoice"],
    ["immediate", false, "resend_invoice"],
    ["immediate", true, "resend_invoice"],
  ];

  it("every rule x queued (6 checked), and the answer is one of the deal's own allowed actions", () => {
    let checked = 0;
    for (const [rule, queued, action] of EXPECTED) {
      expect(invoiceActionOnCreate(rule, queued), `${rule}/queued=${queued}`).toBe(action);
      // The same deal, built by the lifecycle table, offers it - and never the other one.
      const offered = allowedActions({
        deal_status: initialStatus("online", rule, queued), payment_method: "online", payment_status: initialPaymentStatus("online"),
        disputed_at: null, ended_reason: null, sponsor_email: "accounts@harbourside.example", live_at: null, invoice_number: 1,
      });
      expect(offered, `${rule}/queued=${queued}`).toContain(action);
      expect(offered).not.toContain(action === "send_invoice" ? "resend_invoice" : "send_invoice");
      checked++;
    }
    expect(checked).toBe(6);
    expect(EXPECTED.length, "the typed table covers every rule x queued").toBe(GO_LIVE_RULES.length * 2);
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
    // awaiting_payment — "Awaiting payment: Mark as paid, Resend invoice, End now" (mockup screen 5). Every row here has a
    // billing email (`deal()`), so an offline deal offers Resend invoice too (F13); the no-email table below drops it.
    ["awaiting_payment", "pending", "online", [RI, MP, EN], "resend_invoice", R],
    ["awaiting_payment", "pending", "offline", [RI, MP, EN], "mark_paid", R],
    ["awaiting_payment", "pending", "complimentary", [EN], null, U],
    ["awaiting_payment", "paid", "online", [RF, EN], null, U],
    ["awaiting_payment", "paid", "offline", [RF, EN], null, U],
    ["awaiting_payment", "paid", "complimentary", [EN], null, U],
    ["awaiting_payment", "failed", "online", [RI, MP, EN], "resend_invoice", R],
    ["awaiting_payment", "failed", "offline", [RI, MP, EN], "mark_paid", U],
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
    ["scheduled", "pending", "offline", [RI, MP, EN], "open_deal", R],
    ["scheduled", "pending", "complimentary", [EN], "open_deal", U],
    ["scheduled", "paid", "online", [RF, EN], "open_deal", R],
    ["scheduled", "paid", "offline", [RF, EN], "open_deal", R],
    ["scheduled", "paid", "complimentary", [EN], "open_deal", U],
    ["scheduled", "failed", "online", [RI, MP, EN], "open_deal", R],
    ["scheduled", "failed", "offline", [RI, MP, EN], "open_deal", U],
    ["scheduled", "failed", "complimentary", [EN], "open_deal", U],
    ["scheduled", "refunded", "online", [EN], "open_deal", U],
    ["scheduled", "refunded", "offline", [EN], "open_deal", U],
    ["scheduled", "refunded", "complimentary", [EN], "open_deal", U],
    ["scheduled", "none", "online", [EN], "open_deal", U],
    ["scheduled", "none", "offline", [EN], "open_deal", U],
    ["scheduled", "none", "complimentary", [EN], "open_deal", R],
    // live — "Live: Refund, End now"; "Live · awaiting payment" (immediate) also offers the payment actions.
    ["live", "pending", "online", [RI, MP, EN], "resend_invoice", R],
    ["live", "pending", "offline", [RI, MP, EN], "mark_paid", R],
    ["live", "pending", "complimentary", [EN], null, U],
    ["live", "paid", "online", [RF, EN], null, R],
    ["live", "paid", "offline", [RF, EN], null, R],
    ["live", "paid", "complimentary", [EN], null, U],
    ["live", "failed", "online", [RI, MP, EN], "resend_invoice", R],
    ["live", "failed", "offline", [RI, MP, EN], "mark_paid", U],
    ["live", "failed", "complimentary", [EN], null, U],
    ["live", "refunded", "online", [EN], null, U],
    ["live", "refunded", "offline", [EN], null, U],
    ["live", "refunded", "complimentary", [EN], null, U],
    ["live", "none", "online", [EN], null, U],
    ["live", "none", "offline", [EN], null, U],
    ["live", "none", "complimentary", [EN], null, R],
    // ended (by End now: the club cancelled, so nothing is due) — nothing but a refund of a paid deal (F3). The deals that
    // ended still due have their own table below.
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

  it("complimentary never offers mark_paid, write_off, refund or *_invoice, whatever its other fields say (30 rows checked)", () => {
    const FORBIDDEN = new Set<string>([SI, RI, MP, WO, RF]);
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

  it("every end reason × paid online: refund unless refunded or dispute_lost (8 reasons checked)", () => {
    // written_off on a paid deal is unreachable (V<n>__sponsor_deal_written_off.sql: only an unpaid offline deal is written off);
    // its row still pins the answer: a paid deal is refundable unless the money already went back.
    const REFUNDABLE: Record<string, boolean> = {
      refunded: false, dispute_lost: false, ended_now: true, expired: true, competition_finished: true, legacy: true, duplicate_payment: true,
      written_off: true,
    };
    let checked = 0;
    for (const reason of SPEC_END_REASONS as EndReason[]) {
      const d = deal({ deal_status: "ended", payment_status: "paid", ended_at: T0, ended_reason: reason });
      expect(allowedActions(d), reason).toEqual(REFUNDABLE[reason] ? [RF] : []);
      checked++;
    }
    expect(checked, "reasons checked").toBe(8);
  });
});

describe("allowedActions — a deal with NO invoice number (made before invoices were numbered; T23 review m5)", () => {
  // The server refuses a send of an unnumbered deal (it has no invoice page for the email to link), so offering one is a button
  // that always answers 409. Expected: the numbered twin's actions minus the two sends - every other action is untouched.
  const SENDS = new Set<string>(["send_invoice", "resend_invoice"]);

  it("the empty case first: a numbered deal that offers a send (the twin this sweep strips) exists, and an unnumbered one offers no send", () => {
    const numbered = deal({ deal_status: "draft", payment_method: "online" });
    expect(allowedActions(numbered)).toContain("send_invoice");
    expect(allowedActions({ ...numbered, invoice_number: null })).not.toContain("send_invoice");
  });

  it("every deal_status × payment_status × method × end reason × live_at, with and without an email: no send offered, nothing else moves (rows and send rows reported)", () => {
    let checked = 0;
    let twinsWithSend = 0;
    for (const s of SPEC_DEAL_STATUSES as DealStatus[]) {
      for (const p of SPEC_PAYMENT_STATUSES as PaymentStatus[]) {
        for (const m of SPEC_PAYMENT_METHODS as PaymentMethod[]) {
          for (const reason of [null, ...SPEC_END_REASONS] as (EndReason | null)[]) {
            for (const liveAt of [T0, null]) {
              for (const email of ["accounts@harbourside.example", null]) {
                const base = { deal_status: s, payment_status: p, payment_method: m, ended_reason: reason, live_at: liveAt, sponsor_email: email };
                const twin = allowedActions(deal({ ...base, invoice_number: 12 }));
                if (twin.some((a) => SENDS.has(a))) twinsWithSend++;
                const label = `${s}/${p}/${m}/${reason ?? "-"}/${liveAt ? "live" : "never"}/${email ? "email" : "none"}`;
                expect(allowedActions(deal({ ...base, invoice_number: null })), label).toEqual(twin.filter((a) => !SENDS.has(a)));
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked, "rows checked").toBe(6 * 5 * 3 * 9 * 2 * 2);
    expect(twinsWithSend, "anti-vacuity: numbered twins that offer a send").toBeGreaterThan(0);
  });
});

describe("allowedActions — an OFFLINE deal with no billing email (F13: nothing to resend an invoice to)", () => {
  /** Every offline deal_status × payment_status, with `sponsor_email` null: the main table's offline rows minus Resend invoice.
   *  [deal_status, payment_status, allowedActions, rowNextAction, reachable] — reachable as in the main table (an offline deal
   *  never fails a payment, never sits in draft, and its email is optional). */
  type NoEmailRow = [DealStatus, PaymentStatus, DealAction[], RowAction | null, boolean];
  const NO_EMAIL: NoEmailRow[] = [
    ["draft", "pending", [EN], "open_deal", U],
    ["draft", "paid", [RF, EN], "open_deal", U],
    ["draft", "failed", [EN], "open_deal", U],
    ["draft", "refunded", [EN], "open_deal", U],
    ["draft", "none", [EN], "open_deal", U],
    ["awaiting_payment", "pending", [MP, EN], "mark_paid", R],
    ["awaiting_payment", "paid", [RF, EN], null, U],
    ["awaiting_payment", "failed", [MP, EN], "mark_paid", U],
    ["awaiting_payment", "refunded", [EN], null, U],
    ["awaiting_payment", "none", [EN], null, U],
    ["awaiting_approval", "pending", [AP, EN], "approve", U],
    ["awaiting_approval", "paid", [AP, RF, EN], "approve", R],
    ["awaiting_approval", "failed", [AP, EN], "approve", U],
    ["awaiting_approval", "refunded", [AP, EN], "approve", U],
    ["awaiting_approval", "none", [AP, EN], "approve", U],
    ["scheduled", "pending", [MP, EN], "open_deal", R],
    ["scheduled", "paid", [RF, EN], "open_deal", R],
    ["scheduled", "failed", [MP, EN], "open_deal", U],
    ["scheduled", "refunded", [EN], "open_deal", U],
    ["scheduled", "none", [EN], "open_deal", U],
    ["live", "pending", [MP, EN], "mark_paid", R],
    ["live", "paid", [RF, EN], null, R],
    ["live", "failed", [MP, EN], "mark_paid", U],
    ["live", "refunded", [EN], null, U],
    ["live", "none", [EN], null, U],
    ["ended", "pending", [], "add_deal", R],
    ["ended", "paid", [RF], "add_deal", R],
    ["ended", "failed", [], "add_deal", U],
    ["ended", "refunded", [], "add_deal", R],
    ["ended", "none", [], "add_deal", U],
  ];
  const noEmail = (s: DealStatus, p: PaymentStatus) => ({ ...rowDeal(s, p, "offline"), sponsor_email: null });

  it("the table is every offline combo, once each: 30 rows, 9 reachable", () => {
    expect(NO_EMAIL.length).toBe(30);
    const keys = new Set(NO_EMAIL.map(([s, p]) => `${s}/${p}`));
    let covered = 0;
    for (const s of SPEC_DEAL_STATUSES) {
      for (const p of SPEC_PAYMENT_STATUSES) {
        expect(keys.has(`${s}/${p}`), `${s}/${p}`).toBe(true);
        covered++;
      }
    }
    expect(covered, "combos covered").toBe(30);
    expect(NO_EMAIL.filter((row) => row[4]).length, "reachable rows").toBe(9);
  });

  it("allowedActions and rowNextAction answer every row with their typed values (30 rows checked)", () => {
    let checked = 0;
    for (const [s, p, actions, next] of NO_EMAIL) {
      expect(allowedActions(noEmail(s, p)), `${s}/${p}`).toEqual(actions);
      expect(rowNextAction(noEmail(s, p)), `${s}/${p}`).toBe(next);
      checked++;
    }
    expect(checked, "rows checked").toBe(30);
  });

  it("the email is the ONLY difference: adding one adds Resend invoice exactly where the deal is unpaid and due (30 rows checked, 6 gain it)", () => {
    let checked = 0;
    let gained = 0;
    for (const [s, p, actions] of NO_EMAIL) {
      const withEmail = allowedActions({ ...noEmail(s, p), sponsor_email: "accounts@harbourside.example" });
      const due = (s === "awaiting_payment" || s === "scheduled" || s === "live") && (p === "pending" || p === "failed");
      expect(withEmail, `${s}/${p}`).toEqual(due ? [RI, ...actions] : actions);
      if (due) gained++;
      checked++;
    }
    expect(checked, "rows checked").toBe(30);
    expect(gained, "rows that gain Resend invoice").toBe(6);
  });

  it("an empty-string email is no email (12 offline due rows checked)", () => {
    let checked = 0;
    for (const s of ["awaiting_payment", "scheduled", "live"] as DealStatus[]) {
      for (const p of ["pending", "failed"] as PaymentStatus[]) {
        for (const email of [null, ""]) {
          expect(allowedActions({ ...rowDeal(s, p, "offline"), sponsor_email: email }), `${s}/${p}/${JSON.stringify(email)}`).not.toContain(RI);
          checked++;
        }
      }
    }
    expect(checked, "rows checked").toBe(12);
  });
});

describe("an ENDED deal still due (Task 23 carries 1 and 4): late Mark as paid, Write off, and Resend invoice", () => {
  /** An ended deal that went live (`live_at`) and ended by `reason`. */
  const ended = (over: Partial<SponsorDeal>) =>
    deal({ deal_status: "ended", live_at: T0, ended_at: T0, payment_method: "offline", payment_status: "pending", ...over });

  it("the empty case first: an ended deal is not due by default — End now, no live_at, an online deal, money settled (rows checked reported)", () => {
    const NOT_DUE: [string, SponsorDeal][] = [
      ["ended by End now (the club cancelled)", ended({ ended_reason: "ended_now" })],
      ["expired but never went live", ended({ ended_reason: "expired", live_at: null })],
      ["competition finished but never went live", ended({ ended_reason: "competition_finished", live_at: null })],
      ["online, expired after going live (its card link is gone; claims nothing)", ended({ payment_method: "online", ended_reason: "expired" })],
      ["offline, paid, expired", ended({ payment_status: "paid", ended_reason: "expired" })],
      ["offline, refunded, expired", ended({ payment_status: "refunded", ended_reason: "expired" })],
      ["complimentary, expired", ended({ payment_method: "complimentary", payment_status: "none", ended_reason: "expired" })],
      ["already written off (the second call)", ended({ ended_reason: "written_off" })],
      ["a live deal is not ENDED, whatever its reason field", ended({ deal_status: "live", ended_reason: "expired" })],
    ];
    let checked = 0;
    for (const [label, d] of NOT_DUE) {
      expect(endedStillDue(d), label).toBe(false);
      expect(allowedActions(d), label).not.toContain(WO);
      checked++;
    }
    expect(checked, "rows checked").toBe(9);
  });

  it("every end reason × an offline unpaid deal that went live: only the sweep's two leave it due (8 reasons × pending/failed × email or none = 32 checked)", () => {
    let checked = 0;
    let due = 0;
    for (const reason of SPEC_END_REASONS as EndReason[]) {
      for (const p of ["pending", "failed"] as PaymentStatus[]) {
        for (const email of ["accounts@harbourside.example", null]) {
          const d = ended({ ended_reason: reason, payment_status: p, sponsor_email: email });
          const isDue = SPEC_STILL_DUE_REASONS.has(reason);
          const label = `${reason}/${p}/${email ? "email" : "no email"}`;
          expect(endedStillDue(d), label).toBe(isDue);
          expect(allowedActions(d), label).toEqual(isDue ? (email ? [RI, MP, WO] : [MP, WO]) : []);
          // The row's one action (T24 m8): an ended deal still due offers Mark as paid, the money is what to chase; every other ended
          // deal offers a new deal.
          expect(rowNextAction(d), `${label}: the row's one action`).toBe(isDue ? "mark_paid" : "add_deal");
          if (isDue) due++;
          checked++;
        }
      }
    }
    expect(checked, "rows checked").toBe(32);
    expect(due, "due rows").toBe(8);
  });

  it("Write off is never offered without Mark as paid, nor on a deal that is not ended (every table row checked)", () => {
    let checked = 0;
    let woRows = 0;
    for (const s of SPEC_DEAL_STATUSES as DealStatus[]) {
      for (const p of SPEC_PAYMENT_STATUSES as PaymentStatus[]) {
        for (const m of SPEC_PAYMENT_METHODS as PaymentMethod[]) {
          for (const reason of SPEC_END_REASONS as EndReason[]) {
            for (const liveAt of [T0, null]) {
              const offered = allowedActions(deal({ deal_status: s, payment_status: p, payment_method: m, live_at: liveAt, ended_reason: reason, ended_at: T0 }));
              if (offered.includes(WO)) {
                expect(offered, `${s}/${p}/${m}/${reason}`).toContain(MP);
                expect(s, `${s}/${p}/${m}/${reason}`).toBe("ended");
                woRows++;
              }
              checked++;
            }
          }
        }
      }
    }
    expect(checked, "rows checked").toBe(6 * 5 * 3 * 8 * 2);
    expect(woRows, "rows offering Write off").toBe(4); // offline × pending/failed × expired/competition_finished, live_at set
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

describe("rowNextAction — the row agrees with allowedActions (T24: m5 an unnumbered deal, m8 an ended deal still due)", () => {
  const SEND_ACTIONS = new Set<string>(["send_invoice", "resend_invoice"]);

  it("m5, the empty case first: a numbered online deal awaiting payment offers Resend invoice on its row; its unnumbered twin does not (the pair)", () => {
    const numbered = deal({ deal_status: "awaiting_payment", payment_status: "pending", payment_method: "online", invoice_number: 7 });
    expect(rowNextAction(numbered), "the positive: a numbered online unpaid row offers Resend").toBe("resend_invoice");
    expect(allowedActions(numbered), "premise: the deal itself offers it").toContain("resend_invoice");
    const unnumbered = { ...numbered, invoice_number: null };
    expect(allowedActions(unnumbered), "premise: the unnumbered deal does not offer a send (the server answers 409 deal_not_invoiceable)").not.toContain("resend_invoice");
    expect(rowNextAction(unnumbered), "the row says what the deal says").not.toBe("resend_invoice");
    // It is not left without a next step: it opens the deal, where its real actions (Mark as paid, End now) are.
    expect(rowNextAction(unnumbered)).toBe("open_deal");
  });

  it("m5: an unnumbered deal's row never names a send, and every row action that writes is one the deal offers (rows, unnumbered rows and send rows reported)", () => {
    let checked = 0;
    let unnumberedRows = 0;
    let sendRows = 0;
    let writeRows = 0;
    for (const s of SPEC_DEAL_STATUSES as DealStatus[]) {
      for (const p of SPEC_PAYMENT_STATUSES as PaymentStatus[]) {
        for (const m of SPEC_PAYMENT_METHODS as PaymentMethod[]) {
          for (const reason of [null, ...SPEC_END_REASONS] as (EndReason | null)[]) {
            for (const liveAt of [T0, null]) {
              for (const email of ["accounts@harbourside.example", null]) {
                for (const number of [7, null]) {
                  const d = deal({
                    deal_status: s, payment_status: p, payment_method: m, ended_reason: reason, live_at: liveAt, sponsor_email: email,
                    invoice_number: number, ended_at: s === "ended" ? T0 : null,
                  });
                  const next = rowNextAction(d);
                  const label = `${s}/${p}/${m}/${reason ?? "-"}/${liveAt ? "live" : "never"}/${email ? "email" : "none"}/${number ?? "unnumbered"}`;
                  if (number === null) {
                    unnumberedRows++;
                    expect(SEND_ACTIONS.has(next ?? ""), `${label}: an unnumbered deal's row names no send`).toBe(false);
                  }
                  if (next === "resend_invoice" || next === "mark_paid" || next === "approve") {
                    expect(allowedActions(d) as string[], `${label}: the row's write is one the deal offers`).toContain(next);
                    writeRows++;
                    if (next === "resend_invoice") sendRows++;
                  }
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    expect(checked, "rows checked").toBe(6 * 5 * 3 * 9 * 2 * 2 * 2);
    expect(unnumberedRows, "unnumbered rows checked").toBe(checked / 2);
    expect(writeRows, "anti-vacuity: rows whose action writes").toBeGreaterThan(0);
    expect(sendRows, "anti-vacuity: rows that offer Resend invoice (the numbered ones)").toBeGreaterThan(0);
  });

  it("m8, the empty case first: an ended deal that is not due still offers a new deal; the due ones offer Mark as paid (hand-typed rows, from the rule: an OFFLINE deal that went live, then ended unpaid by its term or its competition)", () => {
    const ended = (over: Partial<SponsorDeal>) =>
      deal({ deal_status: "ended", ended_at: T0, payment_method: "offline", payment_status: "pending", live_at: T0, ended_reason: "expired", ...over });
    const ROWS: [string, SponsorDeal, RowAction][] = [
      ["the empty case: ended by End now (the club cancelled)", ended({ ended_reason: "ended_now" }), "add_deal"],
      ["expired, never went live", ended({ live_at: null }), "add_deal"],
      ["online, expired after going live (its card link is gone; it claims nothing)", ended({ payment_method: "online" }), "add_deal"],
      ["offline, paid, expired", ended({ payment_status: "paid" }), "add_deal"],
      ["offline, refunded, expired", ended({ payment_status: "refunded", ended_reason: "refunded" }), "add_deal"],
      ["already written off (the waiver is the answer)", ended({ ended_reason: "written_off" }), "add_deal"],
      ["complimentary, expired", ended({ payment_method: "complimentary", payment_status: "none" }), "add_deal"],
      ["offline, live, expired, pending", ended({}), "mark_paid"],
      ["offline, live, competition finished, pending", ended({ ended_reason: "competition_finished" }), "mark_paid"],
      ["offline, live, expired, a failed payment (the domain's unpaid)", ended({ payment_status: "failed" }), "mark_paid"],
      ["the same, with no billing email (Mark as paid needs none)", ended({ sponsor_email: null }), "mark_paid"],
    ];
    let checked = 0;
    for (const [label, d, want] of ROWS) {
      expect(rowNextAction(d), label).toBe(want);
      checked++;
    }
    expect(checked, "rows checked").toBe(11);
    expect(ROWS.filter(([, , want]) => want === "mark_paid"), "anti-vacuity: some rows are due").toHaveLength(4);
  });

  it("m8: only the ENDED branch moved — an open deal's row is what it was (every status but ended, unpaid offline and online, 4 rows)", () => {
    expect(rowNextAction(deal({ deal_status: "awaiting_payment", payment_method: "offline", live_at: T0, ended_reason: "expired" }))).toBe("mark_paid");
    expect(rowNextAction(deal({ deal_status: "live", payment_status: "paid", payment_method: "offline", live_at: T0, ended_reason: "expired" }))).toBeNull();
    expect(rowNextAction(deal({ deal_status: "draft", payment_method: "online" }))).toBe("open_deal");
    expect(rowNextAction(deal({ deal_status: "awaiting_approval", payment_method: "offline", live_at: T0, ended_reason: "expired" }))).toBe("approve");
  });
});

describe("dealChip — an ended deal still due (T24 m8)", () => {
  const ended = (over: Partial<SponsorDeal>) =>
    deal({ deal_status: "ended", ended_at: T0, payment_method: "offline", payment_status: "pending", live_at: T0, ended_reason: "expired", ...over });

  it("the empty case first: no ended deal that is not due is flagged; the due ones are (hand-typed rows)", () => {
    const ROWS: [string, SponsorDeal, boolean][] = [
      ["ended by End now", ended({ ended_reason: "ended_now" }), false],
      ["never went live", ended({ live_at: null }), false],
      ["online", ended({ payment_method: "online" }), false],
      ["paid", ended({ payment_status: "paid" }), false],
      ["written off", ended({ ended_reason: "written_off" }), false],
      ["a live deal with the same money fields", deal({ deal_status: "live", payment_method: "offline", live_at: T0, ended_reason: "expired" }), false],
      ["offline, live, expired, pending", ended({}), true],
      ["offline, live, competition finished, failed", ended({ ended_reason: "competition_finished", payment_status: "failed" }), true],
    ];
    let checked = 0;
    for (const [label, d, want] of ROWS) {
      expect(dealChip(d).endedDue, label).toBe(want);
      checked++;
    }
    expect(checked, "rows checked").toBe(8);
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
      expect(dealChip(rowDeal(s, p, p === "none" ? "complimentary" : "online")), `${s}/${p}`).toEqual({ kind, awaitingPayment: awaiting, onHold: false, endedDue: false });
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
    expect(dealChip(deal({ deal_status: "live", payment_status: "pending", parked_at: T0 }))).toEqual({ kind: "live", awaitingPayment: true, onHold: true, endedDue: false });
    // The negative's positive pair: the same live deal unparked is not on hold.
    expect(dealChip(deal({ deal_status: "live", payment_status: "paid" })).onHold).toBe(false);
  });
});

// ---- Archive a sponsor, Task 2: blocksArchive, the one rule for what holds a sponsor ----------------------------------------
// Spec docs/superpowers/specs/2026-11-11-sponsor-archive-design.md D9, D17 and §8 (the blocking table, transcribed below), plus
// preflight P2: `written_off` is an end reason outside the still-due pair, so a written-off deal is settled and does not block.
// Sport-agnostic: no sport sweep. A deal's hold on its sponsor carries no sport.
// Expected values come from §8 and the declared value sets (DEAL_STATUSES, END_REASONS, PAYMENT_STATUSES, PAYMENT_METHODS),
// never from blocksArchive or the predicates it composes.
describe("blocksArchive — what holds a sponsor from Archive (archive spec D9, D17, §8; preflight P2)", () => {
  /** An ended deal: the caller names the reason and the money. */
  const endedDeal = (over: Partial<SponsorDeal>): SponsorDeal => deal({ deal_status: "ended", ended_at: T0, ...over });
  /** §8 row 7's shape: offline, went live, unpaid. Only its end reason decides. */
  const offlineWentLiveUnpaid = (reason: EndReason, p: PaymentStatus = "pending"): SponsorDeal =>
    endedDeal({ payment_method: "offline", payment_status: p, live_at: T0, ended_reason: reason });

  /** Spec §8, row by row (§9's complimentary sequence adds the last "no"). */
  const ROWS: { label: string; deal: SponsorDeal; blocks: boolean }[] = [
    { label: "draft", deal: deal({ deal_status: "draft" }), blocks: true },
    { label: "awaiting_payment, online", deal: deal({ deal_status: "awaiting_payment", invoice_sent_at: T0 }), blocks: true },
    { label: "awaiting_payment, offline", deal: deal({ deal_status: "awaiting_payment", payment_method: "offline" }), blocks: true },
    { label: "awaiting_approval, paid", deal: deal({ deal_status: "awaiting_approval", go_live: "on_approval", payment_status: "paid", paid_at: T0 }), blocks: true },
    { label: "scheduled, paid", deal: deal({ deal_status: "scheduled", payment_status: "paid", paid_at: T0 }), blocks: true },
    { label: "scheduled, unpaid", deal: deal({ deal_status: "scheduled", payment_method: "offline", go_live: "immediate" }), blocks: true },
    { label: "live, paid", deal: deal({ deal_status: "live", payment_status: "paid", paid_at: T0, live_at: T0 }), blocks: true },
    {
      label: "live, parked by a dispute",
      deal: deal({ deal_status: "live", payment_status: "paid", paid_at: T0, live_at: T0, parked_at: T0, disputed_at: T0, dispute_id: "dp_1" }),
      blocks: true,
    },
    { label: "ended still due: offline, went live, unpaid, expired", deal: offlineWentLiveUnpaid("expired"), blocks: true },
    { label: "ended still due: offline, went live, failed, competition_finished", deal: offlineWentLiveUnpaid("competition_finished", "failed"), blocks: true },
    { label: "ended_now (the club cancelled)", deal: offlineWentLiveUnpaid("ended_now"), blocks: false },
    { label: "refunded", deal: endedDeal({ payment_status: "refunded", paid_at: T0, live_at: T0, ended_reason: "refunded" }), blocks: false },
    {
      label: "written_off (P2: settled)",
      deal: { ...offlineWentLiveUnpaid("written_off"), written_off_at: T0, written_off_by: "user-1" },
      blocks: false,
    },
    {
      label: "dispute_lost",
      deal: endedDeal({ payment_status: "refunded", paid_at: T0, live_at: T0, disputed_at: T0, dispute_id: "dp_2", ended_reason: "dispute_lost" }),
      blocks: false,
    },
    { label: "paid, expired", deal: endedDeal({ payment_method: "offline", payment_status: "paid", paid_at: T0, live_at: T0, ended_reason: "expired" }), blocks: false },
    { label: "offline, unpaid, never went live, expired", deal: { ...offlineWentLiveUnpaid("expired"), live_at: null }, blocks: false },
    { label: "online, unpaid, expired (its link is gone)", deal: { ...offlineWentLiveUnpaid("expired"), payment_method: "online" }, blocks: false },
    {
      label: "paid, open dispute (D17)",
      deal: endedDeal({ payment_status: "paid", paid_at: T0, live_at: T0, disputed_at: T0, dispute_id: "dp_3", ended_reason: "expired" }),
      blocks: false,
    },
    { label: "legacy order", deal: endedDeal({ payment_status: "paid", paid_at: T0, ended_reason: "legacy", invoice_number: null }), blocks: false },
    {
      label: "complimentary, ended (§9)",
      deal: endedDeal({ payment_method: "complimentary", payment_status: "none", go_live: "immediate", live_at: T0, ended_reason: "expired", invoice_number: null }),
      blocks: false,
    },
  ];

  it("the empty case first: a sponsor with no deals is not held; the same list with one live deal is", () => {
    const none: SponsorDeal[] = [];
    expect(none.some(blocksArchive)).toBe(false);
    // The positive pair: one live deal is enough.
    expect([deal({ deal_status: "live", payment_status: "paid", live_at: T0 })].some(blocksArchive)).toBe(true);
  });

  it("the §8 table: every row answers as the spec says, and every deal_status of DEAL_STATUSES appears (rows and statuses checked reported)", () => {
    const seenStatuses = new Set<DealStatus>();
    let checked = 0;
    for (const row of ROWS) {
      expect(blocksArchive(row.deal), row.label).toBe(row.blocks);
      seenStatuses.add(row.deal.deal_status);
      checked++;
    }
    expect(checked, "rows checked").toBe(ROWS.length);
    expect(ROWS.length, "rows in the table").toBeGreaterThanOrEqual(14);
    expect(seenStatuses.size, "deal statuses seen").toBe(DEAL_STATUSES.length);
    // Both answers are present, so neither `() => true` nor `() => false` can pass the table.
    expect(ROWS.filter((r) => r.blocks).length, "blocking rows").toBe(10);
    expect(ROWS.filter((r) => !r.blocks).length, "non-blocking rows").toBe(10);
  });

  it("every deal that is not ended holds its sponsor, whatever its money or method (DEAL_STATUSES × PAYMENT_STATUSES × PAYMENT_METHODS, count reported)", () => {
    let checked = 0;
    for (const s of DEAL_STATUSES) {
      if (s === "ended") continue;
      for (const p of PAYMENT_STATUSES) {
        for (const m of PAYMENT_METHODS) {
          expect(blocksArchive(deal({ deal_status: s, payment_status: p, payment_method: m })), `${s}/${p}/${m}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked, "combinations checked").toBe((DEAL_STATUSES.length - 1) * PAYMENT_STATUSES.length * PAYMENT_METHODS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an ended offline deal that went live unpaid: only the two still-due reasons hold it; written_off and legacy do not (END_REASONS × pending/failed, count reported)", () => {
    let checked = 0;
    let held = 0;
    for (const reason of END_REASONS) {
      for (const p of ["pending", "failed"] as PaymentStatus[]) {
        const expected = SPEC_STILL_DUE_REASONS.has(reason);
        expect(blocksArchive(offlineWentLiveUnpaid(reason, p)), `${reason}/${p}`).toBe(expected);
        if (expected) held++;
        checked++;
      }
    }
    expect(checked, "rows checked").toBe(END_REASONS.length * 2);
    expect(held, "rows held").toBe(SPEC_STILL_DUE_REASONS.size * 2);
    expect(held).toBeGreaterThan(0);
    expect(checked - held).toBeGreaterThan(0);
  });

  it("the differential pairs: expired and competition_finished each hold only when the offline deal went live; online claims nothing; a write-off releases it (P2)", () => {
    let checked = 0;
    for (const reason of ["expired", "competition_finished"] as EndReason[]) {
      const due = offlineWentLiveUnpaid(reason);
      expect(blocksArchive(due), `${reason}: offline, went live, unpaid`).toBe(true);
      // The same deal, never live: nothing to pay for.
      expect(blocksArchive({ ...due, live_at: null }), `${reason}: never went live`).toBe(false);
      // The same deal, online: its card link is gone and it claims nothing.
      expect(blocksArchive({ ...due, payment_method: "online" }), `${reason}: online`).toBe(false);
      // The same deal, paid late (Mark as paid keeps it ended): settled.
      const paidLate: SponsorDeal = { ...due, payment_status: "paid", paid_at: T0 };
      expect(blocksArchive(paidLate), `${reason}: paid late`).toBe(false);
      // The same deal, written off (the reason becomes written_off): settled, the club gave up the money (P2).
      const writtenOff: SponsorDeal = { ...due, ended_reason: "written_off", written_off_at: T0, written_off_by: "user-1" };
      expect(blocksArchive(writtenOff), `${reason}: written off`).toBe(false);
      checked++;
    }
    expect(checked, "still-due reasons checked").toBe(SPEC_STILL_DUE_REASONS.size);
  });

  it("legacy: an ended legacy order never holds its sponsor, in any money state; its twin differing only in reason holds whenever unpaid (PAYMENT_STATUSES, count reported)", () => {
    /** The file header's rule: "unpaid" is payment `pending` or `failed`. */
    const SPEC_UNPAID: ReadonlySet<string> = new Set(["pending", "failed"]);
    let checked = 0;
    let discriminating = 0;
    for (const p of PAYMENT_STATUSES) {
      // The still-due shape (offline, went live, ended), so the endedStillDue arm CAN answer true: only the reason differs.
      const legacy = endedDeal({ payment_method: "offline", payment_status: p, live_at: T0, ended_reason: "legacy", invoice_number: null });
      const twin: SponsorDeal = { ...legacy, ended_reason: "expired" };
      expect(blocksArchive(legacy), `legacy/${p}`).toBe(false);
      expect(blocksArchive(twin), `expired twin/${p}`).toBe(SPEC_UNPAID.has(p));
      if (SPEC_UNPAID.has(p)) discriminating++;
      checked++;
    }
    expect(checked, "money states checked").toBe(PAYMENT_STATUSES.length);
    expect(discriminating, "rows whose twin holds").toBe([...PAYMENT_STATUSES].filter((p) => SPEC_UNPAID.has(p)).length);
    expect(discriminating).toBeGreaterThan(0);
  });

  it("legacy, the second barrier: a legacy reason on a deal that is not ended never holds (rows the DB refuses by sponsor_orders_ended_shape; not-ended DEAL_STATUSES, count reported)", () => {
    // Impossible rows on purpose: they pin the deliberate redundant `!== "legacy"` conjunct (sponsor-deals.ts blocksArchive), so
    // dropping it is caught here rather than only by the CHECK (deals-migration.test.ts refuses these rows).
    let checked = 0;
    for (const s of DEAL_STATUSES) {
      if (s === "ended") continue;
      const legacy: SponsorDeal = { ...deal({ deal_status: s }), ended_reason: "legacy" };
      expect(blocksArchive(legacy), `${s} + legacy`).toBe(false);
      // The positive twin: the same deal without the reason holds (it is live or open).
      expect(blocksArchive({ ...legacy, ended_reason: null }), `${s}, no reason`).toBe(true);
      checked++;
    }
    expect(checked, "not-ended statuses checked").toBe(DEAL_STATUSES.length - 1);
    expect(checked).toBeGreaterThan(0);
  });
});
