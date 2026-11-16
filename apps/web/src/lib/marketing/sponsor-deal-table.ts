import {
  PAYMENT_METHODS,
  allowedActions,
  goLiveRulesFor,
  initialPaymentStatus,
  initialStatus,
  statusAfterApproved,
  statusAfterInvoiceSent,
  statusAfterPaid,
  type DealStatus,
  type GoLiveRule,
  type PaymentMethod,
  type PaymentStatus,
} from "@/lib/sponsor-deals";

/**
 * The Sponsoring page's demo, as a table. Every state a deal can be in and every step offered there is worked out
 * HERE, on the server, by asking the product's own deal rules (lib/sponsor-deals.ts): which rules a payment method
 * offers, where a deal starts, what a payment or an approval does, which actions are offered. The island only walks
 * the table, so the demo cannot disagree with the product and none of the rules ship to the browser.
 *
 * A state is `status|money`: money is `due` (an invoice not yet paid), `paid`, or `free` (a complimentary deal).
 */
export type DemoStep = "send_invoice" | "pay" | "approve" | "end";
export type DemoMoney = "due" | "paid" | "free";
export type DemoNode = `${DealStatus}|${DemoMoney}`;
export type DealFlow = { start: DemoNode; edges: Record<string, Partial<Record<DemoStep, DemoNode>>> };
export type DealTable = { methods: PaymentMethod[]; rules: Record<PaymentMethod, GoLiveRule[]>; flows: Record<string, DealFlow> };

const MONEY: Record<PaymentStatus, DemoMoney | null> = { pending: "due", paid: "paid", none: "free", failed: null, refunded: null };

function flowOf(method: PaymentMethod, rule: GoLiveRule): DealFlow {
  const node = (status: DealStatus, pay: PaymentStatus): DemoNode => `${status}|${MONEY[pay]!}`;
  const start: [DealStatus, PaymentStatus] = [initialStatus(method, rule, false), initialPaymentStatus(method)];
  const edges: DealFlow["edges"] = {};
  const queue = [start];
  while (queue.length) {
    const [status, pay] = queue.shift()!;
    const key = node(status, pay);
    if (edges[key]) continue;
    const steps: Partial<Record<DemoStep, DemoNode>> = {};
    edges[key] = steps;
    // An ended deal offers none of the demo's four steps: it was ended by hand here (no end reason that leaves money
    // owed), so the product's own answer is already "nothing", and the test pins that.
    const offered = allowedActions({
      deal_status: status,
      payment_method: method,
      payment_status: pay,
      disputed_at: null,
      ended_reason: null,
      sponsor_email: "sponsor@example.com",
      live_at: null,
      invoice_number: 1,
    });
    const go = (step: DemoStep, to: [DealStatus, PaymentStatus]) => {
      steps[step] = node(...to);
      queue.push(to);
    };
    if (offered.includes("send_invoice")) go("send_invoice", [statusAfterInvoiceSent({ deal_status: status }), pay]);
    if (offered.includes("mark_paid")) go("pay", [statusAfterPaid({ deal_status: status, go_live: rule }, false), "paid"]);
    if (offered.includes("approve")) go("approve", [statusAfterApproved({ deal_status: status }, false), pay]);
    if (offered.includes("end_now")) go("end", ["ended", pay]);
  }
  return { start: node(...start), edges };
}

export function buildDealTable(): DealTable {
  const methods = [...PAYMENT_METHODS];
  const rules = Object.fromEntries(methods.map((m) => [m, [...goLiveRulesFor(m)]])) as DealTable["rules"];
  const flows = Object.fromEntries(methods.flatMap((m) => rules[m].map((r) => [`${m}|${r}`, flowOf(m, r)])));
  return { methods, rules, flows };
}
