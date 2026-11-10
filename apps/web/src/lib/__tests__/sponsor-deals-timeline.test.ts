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
//   - an ENDED deal's applicable steps that never happened are `missed` (the screen shows them: "Not paid", "Never went live" - the
//     club must see why nothing came of the deal); a step the deal does not have (a complimentary deal's payment) stays `skipped`
//     and is not drawn (Task 17; owner ruling, pr2-carries);
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
  endsOnOf,
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

/** The context the page hands over: the competition's end date (a display hint), whether the DESK says it has finished (the derived
 *  phase, never the date), and the creator's name (null: not resolvable). */
const NO_END: { competitionEndsOn: string | null; competitionFinished: boolean; createdBy: string | null } = {
  competitionEndsOn: null, competitionFinished: false, createdBy: null,
};
const ctx = (over: Partial<typeof NO_END>) => ({ ...NO_END, ...over });
const LETTER: Record<TimelineStep["state"], string> = { done: "d", next: "n", not_yet: "t", skipped: "s", missed: "m" };
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
  /** One letter per step of the deal's order: d done, n next, t not yet, s skipped (does not apply), m missed (never happened, ended). */
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
  // ended while still unpaid: the payment never happened and the deal HAD one, so the step is `missed` (shown as "Not paid"), not "not yet"
  { method: "offline", rule: "immediate", phase: "ended", want: "dsmsdd", deal: { ...LIVE, ...ENDED("ended_now", "pending") } },
  // offline, after approval
  { method: "offline", rule: "on_approval", phase: "mid-flow", want: "dsdntt", deal: { deal_status: "awaiting_approval", ...PAID } },
  { method: "offline", rule: "on_approval", phase: "live", want: "dsdddt", deal: { deal_status: "live", ...PAID, ...APPROVED, ...LIVE } },
  // End now while it still waited on payment: nothing after "created" ever happened - the payment, the approval and going live are
  // missed; the invoice step never applied to an offline deal that sent none, so it stays skipped
  { method: "offline", rule: "on_approval", phase: "ended", want: "dsmmmd", deal: { ...ENDED("ended_now", "pending") } },
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
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE, ...PAID }), ctx({ competitionEndsOn: "2027-08-31" }));
    const ends = stepOf(steps, "ends");
    expect(ends.detail).toEqual({ competitionEndsOn: "2027-08-31" });
    expect(ends.at).toBeNull();
    expect(ends.state).toBe("not_yet");
  });

  it("an open deal that has not gone live yet ends the same way (mockup: the awaiting-approval deal already shows its end)", () => {
    const steps = dealTimeline(deal({ deal_status: "awaiting_approval", go_live: "on_approval", competition_id: COMP, ...PAID }), ctx({ competitionEndsOn: "2027-08-31" }));
    expect(stepOf(steps, "ends").detail).toEqual({ competitionEndsOn: "2027-08-31" });
  });

  it("the deal's own end date wins: no competition hint beside an ends_at", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ends_at: T_ENDS_AT, ...LIVE }), ctx({ competitionEndsOn: "2027-08-31" }));
    expect(stepOf(steps, "ends").at).toBe(T_ENDS_AT);
    expect(stepOf(steps, "ends").detail).toBeUndefined();
  });

  it("an org-wide deal has no competition to end with, whatever date the caller hands over", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: null, ...LIVE }), ctx({ competitionEndsOn: "2027-08-31" }));
    expect(stepOf(steps, "ends").detail).toBeUndefined();
    expect(stepOf(steps, "ends").at).toBeNull();
  });

  it("a competition with no end date set offers no hint", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE }), ctx({ competitionEndsOn: null }));
    expect(stepOf(steps, "ends").detail).toBeUndefined();
  });

  it("an end date in the past does not finish the deal: the derived phase ends a deal (spec §8a), never this date", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE }), ctx({ competitionEndsOn: "2020-01-01" }));
    expect(stepOf(steps, "ends").state).toBe("not_yet");
    expect(steps.some((s) => s.key === "ended")).toBe(false);
  });

  it("an ended deal closes on `ended` with the reason it ended for, for every declared reason (counted), and never carries an end hint", () => {
    let checked = 0;
    for (const reason of END_REASONS) {
      const steps = dealTimeline(deal({ ...ENDED(reason, "paid"), competition_id: COMP, ...PAID, ...LIVE }), ctx({ competitionEndsOn: "2027-08-31" }));
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

describe("dealTimeline: an ended deal shows what never happened (`missed`), and hides what never applied (`skipped`)", () => {
  it("every ended row: a step that applies and did not happen is missed, one that does not apply is skipped, and no open row has a missed step (24 checked)", () => {
    let ended = 0;
    let open = 0;
    let missedSeen = 0;
    for (const row of ROWS) {
      const steps = dealTimeline(full(row), NO_END);
      const missed = steps.filter((s) => s.state === "missed").length;
      if (row.phase === "ended") {
        // The typed table's `m` letters are the expectation (typed from the spec's states, not read back).
        expect(missed, `${row.method}/${row.rule}/ended`).toBe([...row.want].filter((c) => c === "m").length);
        ended++;
        missedSeen += missed;
      } else {
        expect(missed, `${row.method}/${row.rule}/${row.phase}: an open deal waits, it misses nothing`).toBe(0);
        open++;
      }
    }
    expect(ended).toBe(8);
    expect(open).toBe(16);
    // Anti-vacuity: the two typed rows with missed steps (1 + 3) were reached.
    expect(missedSeen).toBe(4);
  });

  it("the unpaid offline deal ended now: Not paid and Never went live are missed; a complimentary deal's payment is not (it never had one)", () => {
    const unpaid = dealTimeline(deal({ payment_method: "offline", go_live: "on_payment", ...ENDED("ended_now", "pending") }), NO_END);
    expect(stepOf(unpaid, "paid").state).toBe("missed");
    expect(stepOf(unpaid, "live").state).toBe("missed");
    expect(stepOf(unpaid, "approved").state, "an on_payment deal has no approval step").toBe("skipped");
    const free = dealTimeline(deal({ payment_method: "complimentary", go_live: "immediate", ...LIVE, ...ENDED("ended_now", "none") }), NO_END);
    expect(stepOf(free, "paid").state).toBe("skipped");
    expect(stepOf(free, "live").state).toBe("done");
  });

  it("an online deal ended before its invoice went out misses the invoice too", () => {
    const steps = dealTimeline(deal({ deal_status: "ended", ended_at: T_ENDED, ended_reason: "ended_now" }), NO_END);
    expect(states(steps)).toBe("dmmsmd");
  });
});

describe("dealTimeline: who created it, and a competition the desk says has finished", () => {
  const COMP = "c1";

  it("the created step names the creator when the page resolved a name, and carries no author (not a guess) when it did not", () => {
    const named = dealTimeline(deal({}), ctx({ createdBy: "Sam Patel" }));
    expect(stepOf(named, "created").detail).toEqual({ by: "Sam Patel" });
    const unnamed = dealTimeline(deal({}), NO_END);
    expect(stepOf(unnamed, "created").detail).toBeUndefined();
    expect(stepOf(unnamed, "created").at).toBe(T_CREATED);
    // An empty name is no name.
    expect(stepOf(dealTimeline(deal({}), ctx({ createdBy: "" })), "created").detail).toBeUndefined();
  });

  it("an open competition deal whose competition the desk says has finished says so on its end step (it ends at the next hourly check), beside the date hint", () => {
    const steps = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE, ...PAID }), ctx({ competitionEndsOn: "2027-08-31", competitionFinished: true }));
    expect(stepOf(steps, "ends").detail).toEqual({ competitionEndsOn: "2027-08-31", competitionFinished: "yes" });
    expect(stepOf(steps, "ends").state, "still open: the sweep has not ended it yet").toBe("not_yet");
  });

  it("finished is the DESK's word, never the date: a past end date alone says nothing, and a finished competition with no date still says it", () => {
    const pastDate = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE }), ctx({ competitionEndsOn: "2020-01-01", competitionFinished: false }));
    expect(stepOf(pastDate, "ends").detail).toEqual({ competitionEndsOn: "2020-01-01" });
    const noDate = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ...LIVE }), ctx({ competitionEndsOn: null, competitionFinished: true }));
    expect(stepOf(noDate, "ends").detail).toEqual({ competitionFinished: "yes" });
  });

  it("the pairs: the deal's own end date, an org-wide deal and an ended deal never carry the finished note", () => {
    const own = dealTimeline(deal({ deal_status: "live", competition_id: COMP, ends_at: T_ENDS_AT, ...LIVE }), ctx({ competitionFinished: true }));
    expect(stepOf(own, "ends").detail, "the sweep ends it on ends_at, not on the competition").toBeUndefined();
    const whole = dealTimeline(deal({ deal_status: "live", competition_id: null, ...LIVE }), ctx({ competitionFinished: true }));
    expect(stepOf(whole, "ends").detail).toBeUndefined();
    const ended = dealTimeline(deal({ ...ENDED("competition_finished", "paid"), competition_id: COMP, ...PAID, ...LIVE }), ctx({ competitionFinished: true }));
    expect(ended.some((s) => s.key === "ends")).toBe(false);
    expect(stepOf(ended, "ended").detail).toEqual({ reason: "competition_finished" });
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

// ---- the day the club typed ------------------------------------------------------------------------------------------------------
// The producer (server/usecases/sponsor-deals.ts `createDeal`) stores `ends_on` as the START OF THE NEXT DAY in the ORG's timezone
// (`(ends_on::date + 1)::timestamp at time zone tz`; NULL tz is UTC): "Ends 31 Aug" is written as 1 Sep 00:00 local. The deal page shows
// the last day the deal runs, so it reads that instant back one millisecond earlier, in the org's zone - never the viewer's.
describe("endsOnOf: the day the club typed, read back from the instant the producer stored", () => {
  // [ends_on, org zone, that zone's UTC offset at the START OF THE NEXT DAY] - typed from the producer's rule and the zones' own rules
  // (no DST on Kiritimati; London's clocks went back at 01:00 on 25 Oct 2026, so the next day starts on GMT; Auckland is NZST in
  // August; Los Angeles is PDT until November), never read from the function.
  const CASES: [string, string, string][] = [
    ["2026-08-31", "UTC", "+00:00"],
    ["2026-08-31", "America/Los_Angeles", "-07:00"],
    ["2026-08-31", "Pacific/Auckland", "+12:00"],
    ["2026-12-31", "Pacific/Kiritimati", "+14:00"],
    ["2026-03-31", "Europe/London", "+01:00"],
    ["2026-10-24", "Europe/London", "+01:00"],
    ["2026-10-25", "Europe/London", "+00:00"],
  ];
  const nextDay = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  it("every zone and day, including a year end and the day the clocks went back (7 counted): the stored instant reads back as the typed day", () => {
    let checked = 0;
    for (const [endsOn, tz, offset] of CASES) {
      const stored = new Date(`${nextDay(endsOn)}T00:00:00${offset}`).toISOString();
      expect(endsOnOf(stored, tz), `${endsOn} in ${tz} (stored ${stored})`).toBe(endsOn);
      checked++;
    }
    expect(checked).toBe(CASES.length);
    expect(checked).toBe(7);
  });

  it("the other reading is wrong: the stored instant read in a DIFFERENT zone, or with no millisecond taken, is not the typed day", () => {
    const stored = new Date("2026-09-01T00:00:00-07:00").toISOString(); // typed 31 Aug at a Los Angeles org
    expect(endsOnOf(stored, "America/Los_Angeles")).toBe("2026-08-31");
    // A viewer in London or UTC sees the same instant on 1 Sep (07:00Z): that is the off-by-one the deal page must not show.
    expect(endsOnOf(stored, "UTC")).toBe("2026-09-01");
    expect(endsOnOf(stored, "Europe/London")).toBe("2026-09-01");
  });

  it("an unknown zone falls back to UTC rather than throwing (a bad stored zone must not take the deal page down)", () => {
    expect(endsOnOf("2026-09-01T00:00:00.000Z", "Not/AZone")).toBe("2026-08-31");
    expect(endsOnOf("2026-09-01T00:00:00.000Z", "")).toBe("2026-08-31");
  });
});
