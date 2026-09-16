import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { applyProviderGameUpdate } from "@/server/usecases/external-play";
import { verifyLichessWebhookSignature } from "@/server/external-play/webhook-signature";

/**
 * POST /api/webhooks/lichess — provider game updates from our workflow.
 *
 * Auth: HMAC-SHA256 sign key `LICHESS_WEBHOOK_SECRET` over `${t}.${rawBody}`,
 * header `x-lichess-signature: t=<unix>,v1=<hex>`. See webhook-signature.ts.
 *
 * Body: `{ "gameId": "..." }` only. A caller-supplied `game` snapshot is
 * ignored — the result is always fetched from Lichess, so a signed-but-forged
 * result object cannot be scored.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  return handler(async () => {
    const secret = process.env.LICHESS_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, "LICHESS_WEBHOOK_SECRET is not configured");
    const verified = verifyLichessWebhookSignature({
      secret,
      header: req.headers.get("x-lichess-signature"),
      rawBody,
    });
    if (!verified.ok) throw new HttpError(401, "Bad webhook signature");

    let parsed: { gameId?: unknown; id?: unknown } | null = null;
    try {
      parsed = JSON.parse(rawBody) as { gameId?: unknown; id?: unknown };
    } catch {
      parsed = null;
    }
    const gameId = parsed?.gameId ?? parsed?.id;
    if (!gameId || typeof gameId !== "string") {
      throw new HttpError(422, "gameId required");
    }

    const result = await applyProviderGameUpdate({
      provider: "lichess",
      gameId,
    });
    return { result };
  });
}
