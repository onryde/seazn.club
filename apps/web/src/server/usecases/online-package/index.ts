// server/usecases/online-package/ — an Online Chess division's package: the size bought with Seazn credits (spec
// docs/superpowers/specs/2026-11-23-online-chess-credits-design.md §7). The barrel is the map; read the ONE module you need.
//   types.ts   PackageRow, BucketSplit, Returnable, ReturnPlan — the shapes the modules share
//   read.ts    livePackage — the division's live package row (optionally `for update`), its size asserted on the ladder
//   read.ts    + derivedCameras (P9) and countedRounds (P15): what a division's stages say about its price
//   ledger.ts  planDebit / debitForPackage, returnableFor / planReturn / refundForPackage, OnlineChessNoCreditsError —
//              the package's consume and refund rows on org_stream_credits, monthly first and P21's return order
//   quote.ts   quoteLocked / onlinePackageQuote / readPackageFacts — what a size costs, what is owed or returned, and whether it
//              is refused; one answer for the price line, the pay line and the receipt. Writes and locks nothing.
//   pay.ts     payOnlinePackage / payOnlinePackageInTx — pay, upgrade, add cameras and move down: the quote turned into ledger
//              rows and package-row state under the division, money and row locks, exactly once by state
export * from "./types";
export * from "./ledger";
export * from "./read";
export * from "./quote";
export * from "./pay";
