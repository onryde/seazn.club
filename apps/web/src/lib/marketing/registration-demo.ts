// The Registration page's demo, as a model (components/marketing/product/registration-demo.tsx walks it). ZERO
// imports. Its rules are the ones the help pages state (content/help/registration/open-registration.md,
// card-payments.md, waitlist.md): capacity never overfills, an unpaid card entry holds its spot, a waitlisted entry
// pays nothing until a place is theirs, and a withdrawal refunds in full and promotes the first in line.

export type RegStatus = "paid" | "held" | "waitlisted" | "refunded";
export type RegEntry = { readonly name: string; readonly status: RegStatus };
export type RegEvent = { readonly type: "paid" | "held" | "waitlisted" | "refunded" | "promoted"; readonly name: string };
export type RegList = { readonly entries: readonly RegEntry[]; readonly next: number; readonly last: RegEvent | null };

export const REG_DEMO = {
  capacity: 8,
  /** The entry fee, in minor units of whatever currency the visitor sees. */
  feeMinor: 2400,
  /** How long an unpaid card entry holds its spot (registration-submit.ts writes the same window). */
  holdHours: 48,
  /** Who enters next, in order. The demo ends when they have all entered. */
  queue: [
    { name: "Okafor / Lindqvist" },
    { name: "Haddad / Novak" },
    { name: "Silva / Whitlock" },
    { name: "Tanaka / Byrne" },
    { name: "Osei / Marchetti" },
  ],
} as const;

const OPENING: readonly RegEntry[] = [
  { name: "Rahman / Castillo", status: "paid" },
  { name: "Iyer / Brandt", status: "paid" },
  { name: "Mensah / Koval", status: "held" },
  { name: "Nair / Dubois", status: "paid" },
  { name: "Petrov / Adeyemi", status: "paid" },
  { name: "Lam / Fitzgerald", status: "paid" },
];

export function openingList(): RegList {
  return { entries: OPENING, next: 0, last: null };
}

const takesSpot = (e: RegEntry) => e.status === "paid" || e.status === "held";

export function totals(list: RegList) {
  const paid = list.entries.filter((e) => e.status === "paid").length;
  const held = list.entries.filter((e) => e.status === "held").length;
  const waiting = list.entries.filter((e) => e.status === "waitlisted").length;
  const taken = list.entries.filter(takesSpot).length;
  return { paid, held, waiting, taken, spotsLeft: Math.max(0, REG_DEMO.capacity - taken), collectedMinor: paid * REG_DEMO.feeMinor };
}

/** Who the phone is showing: the next player in the queue, or null when everyone has entered. */
export function nextPlayer(list: RegList): (typeof REG_DEMO.queue)[number] | null {
  return REG_DEMO.queue[list.next] ?? null;
}

/** The next player enters: by card, or by closing checkout without paying. A full division offers the waitlist. */
export function enter(list: RegList, how: "card" | "leave"): RegList {
  const who = nextPlayer(list);
  if (who === null) return list;
  const status: RegStatus = totals(list).spotsLeft === 0 ? "waitlisted" : how === "card" ? "paid" : "held";
  return { entries: [...list.entries, { ...who, status }], next: list.next + 1, last: { type: status, name: who.name } };
}

/** A held entry pays inside its window. */
export function payHeld(list: RegList, index: number): RegList {
  const entry = list.entries[index];
  if (entry?.status !== "held") return list;
  return { ...list, entries: list.entries.map((e, i) => (i === index ? { ...e, status: "paid" as const } : e)), last: { type: "paid", name: entry.name } };
}

/** A paid entry withdraws: refunded in full, and the first waitlisted entry is offered the place (held until it pays). */
export function withdraw(list: RegList, index: number): RegList {
  const entry = list.entries[index];
  if (entry?.status !== "paid") return list;
  const promote = list.entries.findIndex((e) => e.status === "waitlisted");
  const entries = list.entries.map((e, i) =>
    i === index ? { ...e, status: "refunded" as const } : i === promote ? { ...e, status: "held" as const } : e,
  );
  const last: RegEvent = promote >= 0 ? { type: "promoted", name: list.entries[promote]!.name } : { type: "refunded", name: entry.name };
  return { ...list, entries, last };
}
