// The Online Chess package doors, from the browser (spec 2026-11-23-online-chess-credits-design.md §7.3, §7.4; plan Task 12): the quote the receipt
// reads and the payment it confirms. One module, so the receipt on the division page and the receipt of Open round 1 on Match Day send exactly the
// same bytes to exactly the same two routes.
//
// Nothing is priced here. A body that does not parse as the server's own `OnlinePackageQuote` is refused (never drawn); a payment is the body
// `payBodyOf` built from the quote on screen.
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";
import { apiV1 } from "@/lib/client-v1";
import { quoteFromWire, type PayBody, type ReceiptQuote } from "@/lib/online-receipt";
import type { ReceiptChoice } from "@/lib/online-receipt-state";

/** What the pay door answers (`OnlinePackagePayResult`): whether it moved anything, the registration capacity a size change lowered, and the
 *  division camera setting the camera answer wrote (`cameraPolicy.to`; null when the setting already said it). Only the fields the page acts on are
 *  read; `applied: false` is "already at that size and camera" (another tab paid, or the paid answer written back to the setting: no credits
 *  moved, `cameraPolicySetTo` says whether the setting was written), which is not a failure. */
export interface PackagePayResult {
  applied: boolean;
  capacityLoweredTo: number | null;
  cameraPolicySetTo: CameraPolicy | null;
}

export class UnreadableQuoteError extends Error {
  constructor() {
    super("The quote did not parse");
    this.name = "UnreadableQuoteError";
  }
}

/** `GET /divisions/{id}/online-package?size=&cameras=`: the quote for a choice - a size and the Fair-play camera answer. Throws what the route
 *  throws, or `UnreadableQuoteError`. */
export async function readPackageQuote(divisionId: string, choice: ReceiptChoice): Promise<ReceiptQuote> {
  const query = `size=${choice.size}&cameras=${choice.cameras ? "true" : "false"}`;
  const raw = await apiV1<unknown>(`/api/v1/divisions/${encodeURIComponent(divisionId)}/online-package?${query}`);
  const quote = quoteFromWire(raw);
  if (quote === null) throw new UnreadableQuoteError();
  return quote;
}

/** `POST /divisions/{id}/online-package`: pay, move up, turn the camera on or off, or move down, exactly the body the receipt showed. Throws what the route
 *  throws (`ApiV1Error`: 409 ONLINE_QUOTE_CHANGED, 402 ONLINE_CHESS_NO_CREDITS, ...), which `payFailureOf` reads. */
export async function payPackage(divisionId: string, body: PayBody): Promise<PackagePayResult> {
  const answer = await apiV1<{ applied?: unknown; capacityLoweredTo?: unknown; cameraPolicy?: unknown } | null>(`/api/v1/divisions/${encodeURIComponent(divisionId)}/online-package`, {
    method: "POST",
    json: body,
  });
  const to = (answer?.cameraPolicy as { to?: unknown } | null | undefined)?.to;
  return {
    applied: answer?.applied === true,
    capacityLoweredTo: typeof answer?.capacityLoweredTo === "number" ? answer.capacityLoweredTo : null,
    // A policy off the vocabulary (or none) says nothing: the notice is drawn only for one of the three settings.
    cameraPolicySetTo: CAMERA_POLICIES.find((p) => p === to) ?? null,
  };
}
