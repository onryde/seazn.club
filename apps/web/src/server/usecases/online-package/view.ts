import "server-only";
// server/usecases/online-package/view.ts — what the Division rules strip draws its Online Chess controls from (spec
// 2026-11-23-online-chess-credits-design.md §8.1, §8.6): the size select's options, its price line and the format refusal. ONE read
// with the quote's own facts (`readPackageFacts`) and balance (`quoteLocked`), so the page and the quote door cannot judge a
// division differently; the live package row says what is stored and what is paid. Read-only: it writes and locks nothing.
//
// The division and org are the caller's: the page has already proved them (`requireDivisionPage`), and `quoteLocked` re-proves the
// division is the org's (a foreign or unknown division is a 404) before anything is read for it.
import { sql } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { ONLINE_SIZES, type OnlineSize } from "@/lib/online-chess-package";
import { streamMonthlyRate } from "@/server/usecases/stream-credits";
import { quoteLocked, readPackageFacts } from "./quote";
import { livePackage } from "./read";

export interface OnlinePackageView {
  /** The plan's `entrants.per_division.max` (null: no cap). */
  planCap: number | null;
  /** Places held, and the Swiss rounds the division's stages declare, as the quote judges them. */
  held: number;
  rounds: number;
  /** Whether the division is priced with the Fair-play camera (P9): its effective camera policy is not `off`. A camera price
   *  already paid is the package's (`stored.paid.camerasPaid`), not this. */
  cameras: boolean;
  /** What the org holds once the month's rollover has run: the quote's `balance`. */
  balance: number;
  /** The live package row, or null when the division has none (online play off). `paid` is the paid state at the row's own size;
   *  `frozen` a round has opened. */
  stored: { size: OnlineSize; paid: { size: OnlineSize; camerasPaid: boolean } | null; frozen: boolean } | null;
  /** The division's stage kinds in stage order: the format refusal's input (Online Chess runs Swiss and knockout only). */
  stageKinds: string[];
}

export async function onlinePackageView(a: { orgId: string; competitionId: string; divisionId: string }): Promise<OnlinePackageView> {
  const planCap = await getLimit(a.orgId, "entrants.per_division.max", a.competitionId);
  const rate = await streamMonthlyRate(a.orgId, { quiet: true });
  return sql.begin("read only", async (tx) => {
    const facts = await readPackageFacts(tx, a.divisionId, planCap);
    const row = await livePackage(tx, a.divisionId);
    // The quote is asked at the row's own size (any ladder size answers the balance and facts; the stored one is the honest one).
    const quote = await quoteLocked(tx, { orgId: a.orgId, divisionId: a.divisionId, size: row?.size ?? ONLINE_SIZES[0], rate }, facts);
    const stages = await tx<{ kind: string }[]>`select kind from stages where division_id = ${a.divisionId} order by seq`;
    return {
      planCap,
      held: facts.held,
      rounds: facts.rounds,
      cameras: facts.cameras,
      balance: quote.balance,
      stored:
        row === null
          ? null
          : {
              size: row.size,
              paid: row.paidAt === null ? null : { size: row.size, camerasPaid: row.camerasPaid === true },
              frozen: row.frozenAt !== null,
            },
      stageKinds: stages.map((s) => s.kind),
    } satisfies OnlinePackageView;
  }) as Promise<OnlinePackageView>;
}
