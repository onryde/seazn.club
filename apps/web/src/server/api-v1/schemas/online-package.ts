// /api/v1 contracts — an Online Chess division's package (spec 2026-11-23-online-chess-credits-design.md §7.3, §7.4): the quote
// (OnlinePackageQuote, read by the receipt) and the payment (OnlinePackagePayInput → OnlinePackagePayResult).
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// The size ladder. The leaf is import-free, so the standalone generator loads it like the other modules' lib imports.
import { ONLINE_SIZES, packagePrice } from "../../../lib/online-chess-package.ts";
import { Uuid } from "./common.ts";

/** A size on the ladder (16, 32, 64, 128, 256): the entrant limit an Online Chess package buys. Anything else is a 400. */
export const OnlineSizeS = z.literal(ONLINE_SIZES);

/** The most a payment can charge or return, from the leaf's price table: the dearest package (the largest size, with cameras).
 *  A charge is at most a whole price, and a return at most the value a package holds, which is always a price (§7.1), so
 *  |owed| never exceeds it. */
export const ONLINE_MAX_OWED = Math.max(...ONLINE_SIZES.flatMap((s) => [packagePrice(s, false), packagePrice(s, true)]));

/** GET /divisions/{id}/online-package: the size asked about, and the one intent the client may send (`addCameras`, which only
 *  ever raises the price). Query values are strings: `size` is coerced to the ladder, `addCameras` is `true` or `false`. */
export const OnlinePackageQuoteQuery = z.object({
  size: z.coerce.number().pipe(OnlineSizeS),
  addCameras: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});
export type OnlinePackageQuoteQuery = z.infer<typeof OnlinePackageQuoteQuery>;

/** POST /divisions/{id}/online-package: what the organiser confirmed. A size, the total the receipt showed (positive to pay,
 *  negative to return), at most the `addCameras` intent, and — on a move down — the credits the receipt said would NOT come
 *  back. Strict: the server derives the camera state, the rounds and the places itself, so a body carrying `cameras` (or any
 *  other field) is refused rather than ignored. */
export const OnlinePackagePayInput = z
  .object({
    size: OnlineSizeS,
    expectedOwed: z.number().int().min(-ONLINE_MAX_OWED).max(ONLINE_MAX_OWED).meta({ examples: [2] }),
    addCameras: z.boolean().optional(),
    /** A forfeit is included credits a package held, so never more than its price: bounded by the dearest one, as `owed` is. */
    expectedForfeited: z.number().int().min(0).max(ONLINE_MAX_OWED).optional().meta({ examples: [1] }),
  })
  .strict();
export type OnlinePackagePayInput = z.infer<typeof OnlinePackagePayInput>;

const BucketSplitS = z.object({ monthly: z.number().int(), pack: z.number().int() });
const ReturnPlanS = z.object({ pack: z.number().int(), monthly: z.number().int(), forfeited: z.number().int() });

/** What a size costs and what is owed or returned, refused or not — one answer for the price line, the pay line and the
 *  receipt (server/usecases/online-package/quote.ts `PackageQuote`). */
export const OnlinePackageQuote = z.object({
  size: OnlineSizeS,
  cameras: z.boolean(),
  price: z.number().int(),
  owed: z.number().int(),
  take: BucketSplitS.nullable(),
  shortBy: z.number().int().nullable(),
  back: ReturnPlanS.nullable(),
  monthlyExpiresOn: z.string(),
  balance: z.number().int(),
  held: z.number().int(),
  rounds: z.number().int(),
  refusal: z.enum(["below_held", "plan", "rounds", "rounds_above_max", "frozen"]).nullable(),
  covers: z.boolean(),
});

/** The division's package row as it stands after the payment. Timestamps are ISO strings on the wire. */
export const OnlinePackageRow = z.object({
  id: Uuid,
  orgId: Uuid,
  divisionId: Uuid.nullable(),
  divisionName: z.string(),
  size: OnlineSizeS,
  camerasPaid: z.boolean().nullable(),
  creditsPaid: z.number().int(),
  creditsRefunded: z.number().int(),
  creditsForfeited: z.number().int(),
  paidAt: z.string().nullable(),
  paidBy: Uuid.nullable(),
  frozenAt: z.string().nullable(),
  refundedAt: z.string().nullable(),
  createdAt: z.string(),
});

/** `applied` false: the package was already at the target and nothing was written. `quote`: the quote the server acted on.
 *  `capacityLoweredTo`: the size, when a stored registration capacity above it was lowered to it. */
export const OnlinePackagePayResult = z.object({
  applied: z.boolean(),
  quote: OnlinePackageQuote,
  package: OnlinePackageRow,
  capacityLoweredTo: z.number().int().nullable(),
});
