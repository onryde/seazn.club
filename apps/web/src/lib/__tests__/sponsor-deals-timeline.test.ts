// Sponsor deals PR 2, Task 13: the deal timeline model (`dealTimeline`, lib/sponsor-deals.ts) behind the deal page's
// timeline (Task 17; spec §6.5; mockup screen 5).
//
// Every expectation below is typed from the spec and the mockup, never read back from lib/sponsor-deals.ts:
//   - the step ORDER is the mockup's screen 5 order - created, invoice_sent, paid, approved, live, ends - and an ended deal
//     closes on `ended` where an open one closes on `ends`;
//   - which steps a deal HAS comes from spec §5.2: a complimentary deal has no payment states (no invoice_sent, no paid); an
//     approval step exists only for the `on_approval` rule; the mockup's offline deal (Marlow & Daughters Bakery) shows no
//     "Invoice sent" step - an offline deal sends no invoice in this PR (Task 23 may), so that step is skipped until a send is
//     recorded;
//   - `next` is the ONE step an open deal is waiting on (mockup: "Awaiting payment", "Awaiting your approval"); "Ends" is a
//     future date, never the thing the deal waits on (mockup: it stays "todo" beside a waiting step).
// The eight (payment method x go-live) combinations spec §5.2 allows ("When paid" is not offered for a complimentary deal)
// are each driven through three phases - mid-flow, live, ended - 24 typed rows, and the count is asserted (anti-vacuity).
import { describe, expect, it } from "vitest";
import {
  END_REASONS,
  GO_LIVE_RULES,
  PAYMENT_METHODS,
  dealTimeline,
  goLiveRulesFor,
  type EndReason,
  type GoLiveRule,
  type PaymentMethod,
  type PaymentStatus,
  type SponsorDeal,
  type TimelineStep,
} from "@/lib/sponsor-deals";

/** Mockup screen 5, top to bottom (an open deal). */
const MOCKUP_ORDER = ["created", "invoice_sent", "paid", "approved", "live", "ends"] as const;
/** An ended deal replaces the last step. */
const ENDED_ORDER = ["created", "invoice_sent", "paid", "approved", "live", "ended"] as const;

const T_CREATED = "2026-10-14T09:00:00.000Z";
const T_INVOICE = "2026-10-14T09:05:00.000Z";
const T_PAID = "2026-10-16T12:00:00.000Z";
const T_APPROVED = "2026-10-17T08:00:00.000Z";
const T_LIVE = "2026-10-17T08:00:01.000Z";
const T_ENDED = "2027-01-05T10:00:00.000Z";
const T_ENDS_AT = "2027-08-31T23:00:00.000Z";

function deal(over: Partial<SponsorDeal>): SponsorDeal {
  return {
    id: "d1",
    sponsor_id: "s1",
    package_id: "p1",
    deal_status: "awaiting_payment",
    payment_status: "pending",
    payment_method: "online",
    go_live: "on_payment",
    package_name: "Silver Season",
    tier: "silver",
    includes_on_stream: false,
    competition_id: null,
    amount_cents: 30_000,
    currency: "gbp",
    sponsor_name: "Quay Fisheries",
    sponsor_email: "accounts@quayfisheries.co.uk",
    ends_at: null,
    created_at: T_CREATED,
    created_by: "u1",
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

const NO_END = { competitionEndsOn: null };
const LETTER: Record<TimelineStep["state"], string> = { done: "d", next: "n", not_yet: "t", skipped: "s" };
const states = (steps: TimelineStep[]): string => steps.map((s) => LETTER[s.state]).join("");
const stepOf = (steps: TimelineStep[], key: TimelineStep["key"]): TimelineStep => {
  const found = steps.find((s) => s.key === key);
  if (!found) throw new Error(`no ${key} step in [${steps.map((s) => s.key).join(", ")}]`);
  return found;
};

type Phase = "mid-flow" | "live" | "ended";
interface Row {
  method: PaymentMethod;
  rule: GoLiveRule;
  phase: Phase;
  /** The deal, typed field by field. */
  deal: Partial<SponsorDeal>;
  /** One letter per step of the deal's order: d done, n next, t not yet, s skipped. */
  want: string;
}

// ---- the 24 rows: 8 combinations x 3 phases --------------------------------------------------------------------------------
const SENT = { invoice_sent_at: T_INVOICE };
const PAID = { payment_status: "paid" as PaymentStatus, paid_at: T_PAID };
const APPROVED = { approved_at: T_APPROVED, approved_by: "u1" };
const LIVE = { live_at: T_LIVE };
const ENDED = (reason: EndReason, status: PaymentStatus) => ({
  deal_status: "ended" as const, ended_at: T_ENDED, ended_reason: reason, payment_status: status,
});

const ROWS: Row[] = [
  // online, when paid
  { method: "online", rule: "on_payment", phase: "mid-flow", want: "ddnstt", deal: { ...SENT } },
  { method: "online", rule: "on_payment", phase: "live", want: "dddsdt", deal: { deal_status: "live", ...SENT, ...PAID, ...LIVE } },
  { method: "online", rule: "on_payment", phase: "ended", want: "dddsdd", deal: { ...SENT, ...PAID, ...LIVE, ...ENDED("refunded", "refunded") } },
  // online, straight away: queued behind another live deal; live while the payment is still awaited; ended after expiry
  { method: "online", rule: "immediate", phase: "mid-flow", want: "ddnstt", deal: { deal_status: "scheduled", ...SENT } },
  { method: "online", rule: "immediate", phase: "live", want: "ddnsdt", deal: { deal_status: "live", ...SENT, ...LIVE } },
  { method: "online", rule: "immediate", phase: "ended", want: "dddsdd", deal: { ...SENT, ...PAID, ...LIVE, ...ENDED("expired", "paid") } },
  // online, after approval
  { method: "online", rule: "on_approval", phase: "mid-flow", want: "dddntt", deal: { deal_status: "awaiting_approval", ...SENT, ...PAID } },
  { method: "online", rule: "on_approval", phase: "live", want: "dddddt", deal: { deal_status: "live", ...SENT, ...PAID, ...APPROVED, ...LIVE } },
  { method: "online", rule: "on_approval", phase: "ended", want: "dddddd", deal: { ...SENT, ...PAID, ...APPROVED, ...LIVE, ...ENDED("dispute_lost", "refunded") } },
  // offline, when paid: no invoice step (mockup: Created, Awaiting payment, Live, Ends)
  { method: "offline", rule: "on_payment", phase: "mid-flow", want: "dsnstt", deal: {} },
  { method: "offline", rule: "on_payment", phase: "live", want: "dsdsdt", deal: { deal_status: "live", ...PAID, ...LIVE } },
  { method: "offline", rule: "on_payment", phase: "ended", want: "dsdsdd", deal: { ...PAID, ...LIVE, ...ENDED("refunded", "refunded") } },
  // offline, straight away
  { method: "offline", rule: "immediate", phase: "mid-flow", want: "dsnstt", deal: { deal_status: "scheduled" } },
  { method: "offline", rule: "immediate", phase: "live", want: "dsnsdt", deal: { deal_status: "live", ...LIVE } },
  // ended while still unpaid: the payment never happened, so its step is skipped, not "not yet"
  { method: "offline", rule: "immediate", phase: "ended", want: "dsssdd", deal: { ...LIVE, ...ENDED("ended_now", "pending") } },
  // offline, after approval
  { method: "offline", rule: "on_approval", phase: "mid-flow", want: "dsdntt", deal: { deal_status: "awaiting_approval", ...PAID } },
  { method: "offline", rule: "on_approval", phase: "live", want: "dsdddt", deal: { deal_status: "live", ...PAID, ...APPROVED, ...LIVE } },
  // End now while it still waited on payment: nothing after "created" ever happened
  { method: "offline", rule: "on_approval", phase: "ended", want: "dssssd", deal: { ...ENDED("ended_now", "pending") } },
  // complimentary: no payment states, "when paid" not offered
  { method: "complimentary", rule: "immediate", phase: "mid-flow", want: "dsssnt", deal: { deal_status: "scheduled", payment_status: "none", sponsor_email: null } },
  { method: "complimentary", rule: "immediate", phase: "live", want: "dsssdt", deal: { deal_status: "live", payment_status: "none", sponsor_email: null, ...LIVE } },
  { method: "complimentary", rule: "immediate", phase: "ended", want: "dsssdd", deal: { sponsor_email: null, ...LIVE, ...ENDED("ended_now", "none") } },
  { method: "complimentary", rule: "on_approval", phase: "mid-flow", want: "dssntt", deal: { deal_status: "awaiting_approval", payment_status: "none", sponsor_email: null } },
  { method: "complimentary", rule: "on_approval", phase: "live", want: "dssddt", deal: { deal_status: "live", payment_status: "none", sponsor_email: null, ...APPROVED, ...LIVE } },
  { method: "complimentary", rule: "on_approval", phase: "ended", want: "dssddd", deal: { sponsor_email: null, ...APPROVED, ...LIVE, ...ENDED("ended_now", "none") } },
];

const full = (row: Row): SponsorDeal => deal({ payment_method: row.method, go_live: row.rule, ...row.deal });

describe("dealTimeline over the 8 method x go-live combinations x {mid-flow, live, ended}", () => {
  it("the 24 typed rows cover exactly the combinations spec §5.2 allows (8) times three phases - nothing missing, nothing doubled", () => {
    const declared = PAYMENT_METHODS.flatMap((m) => goLiveRulesFor(m).map((r) => `${m}/${r}`));
    expect(declared.length, "spec §5.2: 3 methods x 3 rules minus complimentary-on_payment").toBe(8);
    const typed = new Set(ROWS.map((r) => `${r.method}/${r.rule}`));
    expect([...typed].sort()).toEqual([...declared].sort());
    for (const combo of declared) {
      const phases = ROWS.filter((r) => `${r.method}/${r.rule}` === combo).map((r) => r.phase);
      expect(phases.sort(), combo).toEqual(["ended", "live", "mid-flow"]);
    }
    expect(ROWS.length).toBe(24);
    // The rule list is the engine's own: the typed rows can only name rules the declaration has.
    for (const r of ROWS) expect(GO_LIVE_RULES).toContain(r.rule);
  });

  it("each row answers the mockup's step order, and the states the typed table says (24 checked)", () => {
    let checked = 0;
    for (const row of ROWS) {
      const label = `${row.method}/${row.rule}/${row.phase}`;
      const steps = dealTimeline(full(row), NO_END);
      const order = row.phase === "ended" ? ENDED_ORDER : MOCKUP_ORDER;
      expect(steps.map((s) => s.key), `${label}: order`).toEqual([...order]);
      expect(states(steps), `${label}: states`).toBe(row.want);
      checked++;
    }
    expect(checked).toBe(24);
  });

  it("an open deal has exactly one `next` step at most, and an ended deal has none (24 checked)", () => {
    let checked = 0;
    for (const row of ROWS) {
      const steps = dealTimeline(full(row), NO_END);
      const nexts = steps.filter((s) => s.state === "next").length;
      if (row.phase === "ended") expect(nexts, `${row.method}/${row.rule}/ended`).toBe(0);
      else expect(nexts, `${row.method}/${row.rule}/${row.phase}`).toBeLessThanOrEqual(1);
      checked++;
    }
    expect(checked).toBe(24);
  });

  it("the spec's two named omissions hold in every row: a complimentary deal has no invoice or payment step, and a non-approval rule has no approval step (24 checked)", () => {
    let checked = 0;
    let complimentary = 0;
    let withoutApproval = 0;
    for (const row of ROWS) {
      const steps = dealTimeline(full(row), NO_END);
      if (row.method === "complimentary") {
        expect(stepOf(steps, "invoice_sent").state, `${row.rule}/${row.phase}`).toBe("skipped");
        expect(stepOf(steps, "paid").state, `${row.rule}/${row.phase}`).toBe("skipped");
        complimentary++;
      }
      if (row.rule !== "on_approval") {
        expect(stepOf(steps, "approved").state, `${row.method}/${row.rule}/${row.phase}`).toBe("skipped");
        withoutApproval++;
      }
      checked++;
    }
    expect(checked).toBe(24);
    // Anti-vacuity: both arms ran (2 complimentary combos x 3 phases; 5 non-approval combos x 3 phases).
    expect(complimentary).toBe(6);
    expect(withoutApproval).toBe(15);
  });
});

describe("dealTimeline: each step's time and detail", () => {
  const quay = deal({ deal_status: "awaiting_approval", go_live: "on_approval", ...SENT, ...PAID });

  it("every step carries its own timestamp; a step that has not happened carries none", () => {
    const steps = dealTimeline(
      deal({ go_live: "on_approval", ...SENT, paid_at: T_PAID, ...APPROVED, ...LIVE, ...ENDED("refunded", "refunded") }),
      NO_END,
    );
    expect(steps.map((s) => [s.key, s.at])).toEqual([
      ["created", T_CREATED],
      ["invoice_sent", T_INVOICE],
      ["paid", T_PAID],
      ["approved", T_APPROVED],
      ["live", T_LIVE],
      ["ended", T_ENDED],
    ]);
    const open = dealTimeline(quay, NO_END);
    expect(stepOf(open, "approved").at).toBeNull();
    expect(stepOf(open, "live").at).toBeNull();
    expect(stepOf(open, "ends").at).toBeNull();
  });

  it("the mockup's Quay Fisheries deal (online, paid by card, waiting for approval): the model carries the invoice email, the raw payment (method online, 30000 gbp cents) and its own ISO end instant - the £300 and the date are the screen's formatting", () => {
    const steps = dealTimeline({ ...quay, ends_at: T_ENDS_AT }, NO_END);
    expect(stepOf(steps, "invoice_sent").detail).toEqual({ to: "accounts@quayfisheries.co.uk" });
    expect(stepOf(steps, "paid").detail).toEqual({ method: "online", amountCents: "30000", currency: "gbp" });
    expect(stepOf(steps, "ends").at).toBe(T_ENDS_AT);
    expect(stepOf(steps, "ends").detail, "its own end date: no competition hint").toBeUndefined();
    expect(states(steps)).toBe("dddntt");
  });

  it("an invoice recorded on an OFFLINE deal shows (done); one never sent stays skipped (the mockup's Marlow deal)", () => {
    const sent = dealTimeline(deal({ payment_method: "offline", ...SENT }), NO_END);
    expect(stepOf(sent, "invoice_sent").state).toBe("done");
    expect(stepOf(sent, "invoice_sent").at).toBe(T_INVOICE);
    const never = dealTimeline(deal({ payment_method: "offline" }), NO_END);
    expect(stepOf(never, "invoice_sent").state).toBe("skipped");
    expect(stepOf(never, "paid").state).toBe("next");
  });

  it("a complimentary deal has no invoice or payment step even if a stray invoice time were recorded", () => {
    const steps = dealTimeline(deal({ payment_method: "complimentary", payment_status: "none", go_live: "immediate", ...SENT }), NO_END);
    expect(stepOf(steps, "invoice_sent").state).toBe("skipped");
    expect(stepOf(steps, "paid").state).toBe("skipped");
  });

  it("a payment that failed is still unpaid: the paid step stays `next`; a refunded deal was paid", () => {
    const failed = dealTimeline(deal({ payment_status: "failed", ...SENT }), NO_END);
    expect(stepOf(failed, "paid").state).toBe("next");
    const refunded = dealTimeline(deal({ ...SENT, paid_at: T_PAID, ...ENDED("refunded", "refunded") }), NO_END);
    expect(stepOf(refunded, "paid").state).toBe("done");
  });

  it("an unsent online invoice is the first thing a draft waits on", () => {
    const draft = dealTimeline(deal({ deal_status: "draft" }), NO_END);
    expect(states(draft)).toBe("dntstt");
    expect(stepOf(draft, "invoice_sent").state).toBe("next");
    expect(stepOf(draft, "paid").state).toBe("not_yet");
  });

  it("a deal whose status says live is live even if its live_at was never stamped (a guard, not a comment): done, at null", () => {
    const steps = dealTimeline(deal({ deal_status: "live", payment_method: "offline", go_live: "immediate" }), NO_END);
    expect(stepOf(steps, "live").state).toBe("done");
    expect(stepOf(steps, "live").at).toBeNull();
  });
});

describe("dealTimeline: the end step", () => {
  const COMP = "c1";

  it("live, no end date, scoped to a competition -> ends carries the competition's end date as a hint (and no time)", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE, ...PAID }), { competitionEndsOn: "2027-08-31" });
    const ends = stepOf(steps, "ends");
    expect(ends.detail).toEqual({ competitionEndsOn: "2027-08-31" });
    expect(ends.at).toBeNull();
    expect(ends.state).toBe("not_yet");
  });

  it("an open deal that has not gone live yet ends the same way (mockup: the awaiting-approval deal already shows its end)", () => {
    const steps = dealTimeline(deal({ deal_status: "awaiting_approval", go_live: "on_approval", competition_id: COMP, ...PAID }), { competitionEndsOn: "2027-08-31" });
    expect(stepOf(steps, "ends").detail).toEqual({ competitionEndsOn: "2027-08-31" });
  });

  it("the deal's own end date wins: no competition hint beside an ends_at", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ends_at: T_ENDS_AT, ...LIVE }), { competitionEndsOn: "2027-08-31" });
    expect(stepOf(steps, "ends").at).toBe(T_ENDS_AT);
    expect(stepOf(steps, "ends").detail).toBeUndefined();
  });

  it("an org-wide deal has no competition to end with, whatever date the caller hands over", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: null, ...LIVE }), { competitionEndsOn: "2027-08-31" });
    expect(stepOf(steps, "ends").detail).toBeUndefined();
    expect(stepOf(steps, "ends").at).toBeNull();
  });

  it("a competition with no end date set offers no hint", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE }), { competitionEndsOn: null });
    expect(stepOf(steps, "ends").detail).toBeUndefined();
  });

  it("an end date in the past does not finish the deal: the derived phase ends a deal (spec §8a), never this date", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE }), { competitionEndsOn: "2020-01-01" });
    expect(stepOf(steps, "ends").state).toBe("not_yet");
    expect(steps.some((s) => s.key === "ended")).toBe(false);
  });

  it("an ended deal closes on `ended` with the reason it ended for, for every declared reason (counted), and never carries an end hint", () => {
    let checked = 0;
    for (const reason of END_REASONS) {
      const steps = dealTimeline(deal({ ...ENDED(reason, "paid"), competition_id: COMP, ...PAID, ...LIVE }), { competitionEndsOn: "2027-08-31" });
      const last = steps[steps.length - 1]!;
      expect(last.key, reason).toBe("ended");
      expect(last.state, reason).toBe("done");
      expect(last.at, reason).toBe(T_ENDED);
      expect(last.detail, reason).toEqual({ reason });
      expect(steps.some((s) => s.key === "ends"), `${reason}: no ends step`).toBe(false);
      checked++;
    }
    expect(checked).toBe(END_REASONS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an ended deal with no recorded reason still closes on `ended`, with no detail", () => {
    const last = dealTimeline(deal({ deal_status: "ended", ended_at: T_ENDED }), NO_END).at(-1)!;
    expect(last.key).toBe("ended");
    expect(last.detail).toBeUndefined();
  });
});

describe("dealTimeline: the sequence, not just one call", () => {
  it("a deal walked through its life (online, after approval) moves its `next` marker one step at a time, and ends on `ended`", () => {
    // Each frame is the same deal after one more event, typed from spec §5.2's path: created -> invoice -> paid -> approved -> ended.
    const frames: [string, Partial<SponsorDeal>, string][] = [
      ["created", { deal_status: "draft", go_live: "on_approval" }, "dntttt"],
      ["invoice sent", { deal_status: "awaiting_payment", go_live: "on_approval", ...SENT }, "ddnttt"],
      ["paid", { deal_status: "awaiting_approval", go_live: "on_approval", ...SENT, ...PAID }, "dddntt"],
      ["approved", { deal_status: "live", go_live: "on_approval", ...SENT, ...PAID, ...APPROVED, ...LIVE }, "dddddt"],
      ["refunded", { go_live: "on_approval", ...SENT, ...PAID, ...APPROVED, ...LIVE, ...ENDED("refunded", "refunded") }, "dddddd"],
    ];
    let checked = 0;
    for (const [what, over, want] of frames) {
      const steps = dealTimeline(deal(over), NO_END);
      expect(states(steps), what).toBe(want);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("is pure: a second call answers the same and the deal is not touched", () => {
    const d = deal({ deal_status: "awaiting_approval", go_live: "on_approval", ...SENT, ...PAID });
    const before = JSON.stringify(d);
    const first = dealTimeline(d, NO_END);
    expect(dealTimeline(d, NO_END)).toEqual(first);
    expect(JSON.stringify(d)).toBe(before);
    expect(first.length).toBe(6);
  });
});
