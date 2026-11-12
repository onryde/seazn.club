// Sponsor x live-stream matrix, L1: the ORACLE. TEST-ONLY and PURE. It answers, for one cell (stream-matrix-cells.ts), what the
// product must do - and it never calls the product. Every answer below is derived from a DECLARATION:
//
//   - what each plan grants:  the `plan_entitlements` rows (the migrations' own data: `community`, `pro`, `event_pass` x
//     `sponsors.tiers` / `sponsors.monetize`), read by the test and passed in as `PlanGrants`. The ONE structural rule on top of
//     them is the spec's (§10 Q1, §8; deal-gates.test.ts header): an Event Pass lifts ITS competition and only that one, so a
//     pass org's answer for the whole org, or for another competition, is the community row's;
//   - what needs `sponsors.tiers`: spec §10 Q1 - "on the community plan every placement is Partner on the whole org; a tier or a
//     competition scope needs `sponsors.tiers`". Typed here from the spec, NOT read from `placementNeedsTiers`;
//   - what needs `sponsors.monetize`: spec §8 - online invoices and payment. Offline and complimentary sell on every plan;
//   - what a deal does to its sponsor: spec §5.3 and §8a - a LIVE deal puts its tier, scope and stream flag on the sponsor and
//     makes it active; a deal waiting to go live hides the sponsor; every deal ended hides it (and resets it); a deal queued behind
//     a live one changes nothing until it is promoted; an archived sponsor is hidden everywhere;
//   - the weights:  `SPONSOR_TIER_WEIGHTS` (owner ruling D9), the tier authority;
//   - flattening:  ruling R13 / D8 - an org (or pass) without `sponsors.tiers` on the competition the stream is in gets every card
//     as `partner`, on the stream and on the public strip alike. (No GENERATED cell ever decides this: a cell makes its sponsor
//     after the plan is set, and a plan without `sponsors.tiers` refuses every placement that is not partner on the whole org, so
//     `shownTier` below is the identity for every cell that gets here. The test file's downgrade sequences decide the flattening.);
//   - the Overview listing:  archive spec D15 and the Overview's own contract (`sponsorOverview`'s doc, server/sponsors/report.ts):
//     a sponsor is listed in a competition's Overview when its scope reaches the competition (the whole org, or that competition)
//     and it is not archived - whatever its deal's state, so a sponsor hidden from the stream and the strip (a deal waiting, or
//     ended) is still listed - and an ARCHIVED one only while it has airings or clicks in the period. The matrix writes neither,
//     so that second arm is never met here (a KNOWN GAP, said in the test file's header). The scope the sponsor holds at the end
//     of the script is the spec's: a LIVE deal's scope (§5.3), the whole org after every deal ended (D8's reset), the whole org
//     while a deal waits or is queued (nothing of it reaches the sponsor yet, §8a);
//   - write off:  spec §5.2 / archive spec D9 - only an OFFLINE invoice still due after its deal ran out (`expired`) is waived;
//     a paid deal owes nothing (`deal_already_paid`), and a complimentary or cancelled one never owed (`deal_nothing_due`).
import { SPONSOR_TIER_WEIGHTS, type SponsorTier } from "@/lib/sponsor-tiers";
import type { Cell, DealState } from "./stream-matrix-cells";

/** `plan_entitlements.bool_value` for the three plan keys a cell's plan resolves to, per feature. */
export interface PlanGrants {
  tiers: Record<"community" | "pro" | "event_pass", boolean>;
  monetize: Record<"community" | "pro" | "event_pass", boolean>;
}

export type Feature = "sponsors.tiers" | "sponsors.monetize";

/** What a plan grants for a placement scoped to `scope`. The pass is on THE competition (scope "this") and nowhere else. */
export function granted(g: PlanGrants, plan: Cell["plan"], feature: Feature, scope: Cell["scope"]): boolean {
  const table = feature === "sponsors.tiers" ? g.tiers : g.monetize;
  if (plan === "pro") return table.pro;
  if (plan === "pass") return scope === "this" ? table.event_pass : table.community;
  return table.community;
}

export interface WriteOffAnswer {
  accepted: boolean;
  /** The refusal's HTTP status and code when it is refused. */
  refusal: { status: 409; code: "deal_already_paid" | "deal_nothing_due" } | null;
}

export interface Expected {
  /** The step that creates the cell's deal (or manual sponsor) is refused by the plan: status 402 naming the feature. */
  refusal: { status: 402; featureKey: Feature } | null;
  /** Does the cell's own sponsor (the manual one, the deal's, or - for `scheduled` - the live deal's) air on this competition's stream? */
  airs: boolean;
  /** The tier the stream shows it as, after flattening. Null when it does not air. */
  airedTier: SponsorTier | null;
  /** Its turns in the rotation per cycle (`SPONSOR_TIER_WEIGHTS[airedTier]`). Null when it does not air. */
  weight: number | null;
  /** Is it on the competition's public sponsor strip (the page's reader: `resolveSponsors` with the page's own `tiered` flag)? */
  onPublicPage: boolean;
  /** The tier the public strip shows it as. Null when it is not on the strip. */
  publicTier: SponsorTier | null;
  /** The cell's deal after the script, or null when no deal exists (none, or refused). */
  deal: { status: "awaiting_payment" | "awaiting_approval" | "live" | "scheduled" | "ended"; paymentStatus: "pending" | "paid" | "none" } | null;
  /** The write-off attempt the `written_off` state makes, or null when the state makes none (or there is no deal to write off). */
  writeOff: WriteOffAnswer | null;
  /** Is the sponsor archived at the end of the script? */
  archived: boolean;
  /** Is the cell's own sponsor listed in THIS competition's Overview (`sponsorOverview`, the period "this competition")? See the
   *  header's listing rule. False when there is no sponsor at all (a refused hand-made one), or it is archived with no numbers. */
  inReport: boolean;
}

/** States whose script creates the cell's own deal (the others create a manual sponsor, or nothing of the cell's own). */
const MAKES_A_DEAL: ReadonlySet<DealState> = new Set<DealState>(["waiting", "live", "scheduled", "ended", "written_off", "archived"]);

export function expectedFor(cell: Cell, g: PlanGrants): Expected {
  const { plan, tier, state, payment, scope, stream } = cell;
  // The stream is always in "this" competition: its tier question is asked there.
  const tiersOnStream = granted(g, plan, "sponsors.tiers", "this");
  const shownTier = (t: SponsorTier): SponsorTier => (tiersOnStream ? t : "partner");
  const scopeReachesThisStream = scope !== "other";

  // Spec §10 Q1 / §8, in the order the funnel asks them: the placement first, then online selling.
  const needsTiers = tier !== "partner" || scope !== "org";
  let refusal: Expected["refusal"] = null;
  if (needsTiers && !granted(g, plan, "sponsors.tiers", scope)) refusal = { status: 402, featureKey: "sponsors.tiers" };
  else if (MAKES_A_DEAL.has(state) && payment === "online_paid" && !granted(g, plan, "sponsors.monetize", scope)) {
    refusal = { status: 402, featureKey: "sponsors.monetize" };
  }

  const aired = (t: SponsorTier): Pick<Expected, "airs" | "airedTier" | "weight"> => ({
    airs: true,
    airedTier: shownTier(t),
    weight: SPONSOR_TIER_WEIGHTS[shownTier(t)],
  });
  const hidden = { airs: false, airedTier: null, weight: null, onPublicPage: false, publicTier: null } as const;
  const noDeal = { deal: null, writeOff: null, archived: false } as const;
  /** The sponsor the club made by hand and left as it was: active, partner, the whole org, OFF the stream. A refused deal leaves
   *  exactly this behind: a refusal writes nothing. */
  const leftAlone: Pick<Expected, "airs" | "airedTier" | "weight" | "onPublicPage" | "publicTier" | "inReport"> = {
    airs: false, airedTier: null, weight: null, onPublicPage: true, publicTier: "partner", inReport: true,
  };

  if (state === "none") {
    // No deal: the sponsor the club typed in. Refused on a plan that cannot place it - and then there is no sponsor at all.
    if (refusal !== null) return { refusal, ...hidden, ...noDeal, inReport: false };
    const onStream = stream === "on" && scopeReachesThisStream;
    return {
      refusal: null,
      ...(onStream ? aired(tier) : { airs: false, airedTier: null, weight: null }),
      onPublicPage: scopeReachesThisStream,
      publicTier: scopeReachesThisStream ? shownTier(tier) : null,
      inReport: scopeReachesThisStream,
      ...noDeal,
    };
  }

  if (state === "scheduled") {
    // The sponsor already has a LIVE deal (the baseline: partner, whole org, on the stream), and the cell's deal queues behind
    // it. Spec §8a: nothing of the queued deal reaches the sponsor until it is promoted - not its tier, not its scope, not its
    // stream flag - whether or not the plan would even let it be made.
    return {
      refusal,
      ...aired("partner"),
      onPublicPage: true,
      publicTier: "partner",
      deal: refusal === null ? { status: "scheduled", paymentStatus: paymentStatusOf(payment) } : null,
      writeOff: null,
      archived: false,
      inReport: true,
    };
  }

  if (refusal !== null) {
    // The deal was refused, so nothing was written; the sponsor is as the club left it. `archived` then archives THAT sponsor.
    if (state === "archived") return { refusal, ...hidden, deal: null, writeOff: null, archived: true, inReport: false };
    return { refusal, ...leftAlone, ...noDeal };
  }

  switch (state) {
    case "live":
      return {
        refusal: null,
        ...(stream === "on" && scopeReachesThisStream ? aired(tier) : { airs: false, airedTier: null, weight: null }),
        onPublicPage: scopeReachesThisStream,
        publicTier: scopeReachesThisStream ? shownTier(tier) : null,
        deal: { status: "live", paymentStatus: paymentStatusOf(payment) },
        writeOff: null,
        archived: false,
        inReport: scopeReachesThisStream,
      };
    case "waiting":
      // Spec §8a / D8: a deal waiting to go live hides its sponsor until it is live.
      return {
        refusal: null,
        ...hidden,
        deal: { status: payment === "awaiting" ? "awaiting_payment" : "awaiting_approval", paymentStatus: paymentStatusOf(payment) },
        writeOff: null,
        archived: false,
        inReport: true,
      };
    case "ended":
    case "archived":
      // Every deal ended: the sponsor is hidden (D8). An archived sponsor is hidden everywhere (archive spec §8).
      return {
        refusal: null,
        ...hidden,
        deal: { status: "ended", paymentStatus: paymentStatusOf(payment) },
        writeOff: null,
        archived: state === "archived",
        inReport: state !== "archived",
      };
    case "written_off": {
      const owed = payment === "awaiting"; // an unpaid OFFLINE invoice (the awaiting payment's method) that ran out
      const writeOff: WriteOffAnswer = owed
        ? { accepted: true, refusal: null }
        : {
            accepted: false,
            refusal: { status: 409, code: payment === "complimentary" ? "deal_nothing_due" : "deal_already_paid" },
          };
      return {
        refusal: null,
        ...hidden,
        deal: { status: "ended", paymentStatus: paymentStatusOf(payment) },
        writeOff,
        archived: false,
        inReport: true,
      };
    }
    default: {
      const never: never = state;
      throw new Error(`oracle: no answer for state ${String(never)}`);
    }
  }
}

/** Spec D2: a complimentary deal has no payment (`none`); a paid one is `paid`; an unpaid one is `pending`. */
function paymentStatusOf(p: Cell["payment"]): "pending" | "paid" | "none" {
  if (p === "complimentary") return "none";
  if (p === "online_paid" || p === "offline_paid") return "paid";
  return "pending";
}

/** The airings a poll over `breaks` majors hands each card: one full smooth-weighted-round-robin cycle gives every card exactly
 *  its weight (spec P7), so `cycles` cycles give `cycles x weight`. `tiers`: the aired tier of each card, in any order. */
export function cycleLength(tiers: readonly SponsorTier[]): number {
  return tiers.reduce((sum, t) => sum + SPONSOR_TIER_WEIGHTS[t], 0);
}
