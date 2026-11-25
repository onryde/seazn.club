import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { OnlinePackagePayInput, OnlinePackageQuoteQuery } from "@/server/api-v1/schemas";
import { onlinePackageQuote, payOnlinePackage } from "@/server/usecases/online-package";

type Ctx = { params: Promise<{ id: string }> };

/** The receipt's quote (spec 2026-11-23-online-chess-credits-design.md §7.3): what `size` costs the division's Online Chess
 *  package, what is owed or returned, and whether it is refused. Organisers only (owner or admin); writes nothing. Never an
 *  API-key route (key-scopes NEVER_KEY_ROUTES): it is the money surface's read. Not flag-gated: a move down reads it too, and a
 *  refund is never gated. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const q = OnlinePackageQuoteQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return onlinePackageQuote(auth, id, q.size, q.cameras);
  });
}

/** Pay for, upgrade, turn the Fair-play camera on or off on, or move down the division's Online Chess package (spec §7.3, §7.4,
 *  §8.4-§8.6): the confirmed quote turned into ledger rows and package-row state under the locks, exactly once, and the camera answer
 *  written to the division's camera policy in the same transaction. Organisers only, signed in (the payment names
 *  who paid); never an API key. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const input = await parseBody(req, OnlinePackagePayInput);
    return payOnlinePackage(auth, id, input);
  });
}
