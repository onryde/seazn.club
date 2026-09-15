import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { applyProviderGameUpdate } from "@/server/usecases/external-play";

/**
 * POST /api/webhooks/lichess — provider game updates.
 * Auth: shared secret header `x-lichess-webhook-secret` === LICHESS_WEBHOOK_SECRET.
 * Body: `{ "gameId": "..." }` (optional full snapshot under `game`).
 */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.LICHESS_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, "LICHESS_WEBHOOK_SECRET is not configured");
    const given = (await headers()).get("x-lichess-webhook-secret");
    if (given !== secret) throw new HttpError(401, "Bad webhook secret");

    const body = (await req.json().catch(() => null)) as {
      gameId?: string;
      id?: string;
      game?: unknown;
    } | null;
    const gameId = body?.gameId ?? body?.id;
    if (!gameId || typeof gameId !== "string") {
      throw new HttpError(422, "gameId required");
    }

    const snapshot =
      body?.game && typeof body.game === "object"
        ? (body.game as {
            id: string;
            status: string;
            winner?: "white" | "black";
            players: {
              white: { userId: string | null };
              black: { userId: string | null };
            };
          })
        : undefined;

    const result = await applyProviderGameUpdate({
      provider: "lichess",
      gameId,
      snapshot,
    });
    return { result };
  });
}
