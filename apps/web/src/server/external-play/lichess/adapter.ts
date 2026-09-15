import type {
  CreateChallengeInput,
  CreateChallengeResult,
  ExternalPlayAdapter,
  LichessGameSnapshot,
} from "../types";
import { LichessHttpError } from "../types";

const DEFAULT_BASE = "https://lichess.org";

type FetchFn = typeof fetch;

export type LichessAdapterDeps = {
  fetch: FetchFn;
  baseUrl?: string;
};

/**
 * Lichess Challenge + game export client.
 * Spec: create as White (home token), unrated/casual, injectable fetch for tests.
 */
export function createLichessAdapter(deps: LichessAdapterDeps): ExternalPlayAdapter {
  const base = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const fetchFn = deps.fetch;

  return {
    async createChallenge(input: CreateChallengeInput): Promise<CreateChallengeResult> {
      const url = `${base}/api/challenge/${encodeURIComponent(input.blackLichessUsername)}`;
      const body = new URLSearchParams({
        rated: String(input.rated),
        "clock.limit": String(input.clock.limit),
        "clock.increment": String(input.clock.increment),
        color: "white",
        variant: "standard",
      });

      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.whiteAccessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      if (res.status === 401) {
        throw new LichessHttpError(401, "Lichess challenge create unauthorized");
      }
      if (res.status === 429) {
        throw new LichessHttpError(429, "Lichess challenge create rate limited");
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new LichessHttpError(res.status, `Lichess challenge create failed: ${detail}`);
      }

      const json = (await res.json()) as {
        challenge?: {
          id?: string;
          url?: string;
          open?: { url?: string };
        };
        url?: string;
      };

      const challengeId = json.challenge?.id;
      if (!challengeId) {
        throw new LichessHttpError(502, "Lichess challenge create missing challenge id");
      }

      const playUrl =
        json.challenge?.url ?? json.challenge?.open?.url ?? json.url ?? `${base}/${challengeId}`;

      return {
        challengeId,
        whitePlayUrl: playUrl,
        blackPlayUrl: playUrl,
      };
    },

    async fetchGame(gameId: string): Promise<LichessGameSnapshot> {
      const url = `${base}/game/export/${encodeURIComponent(gameId)}?pgnInJson=true&clocks=false`;
      const res = await fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (res.status === 401) {
        throw new LichessHttpError(401, "Lichess game export unauthorized");
      }
      if (res.status === 429) {
        throw new LichessHttpError(429, "Lichess game export rate limited");
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new LichessHttpError(res.status, `Lichess game export failed: ${detail}`);
      }

      const json = (await res.json()) as {
        id?: string;
        status?: string;
        winner?: "white" | "black";
        players?: {
          white?: { user?: { id?: string }; userId?: string };
          black?: { user?: { id?: string }; userId?: string };
        };
      };

      if (!json.id || !json.status) {
        throw new LichessHttpError(502, "Lichess game export missing id/status");
      }

      return {
        id: json.id,
        status: json.status,
        winner: json.winner,
        players: {
          white: {
            userId: json.players?.white?.user?.id ?? json.players?.white?.userId ?? null,
          },
          black: {
            userId: json.players?.black?.user?.id ?? json.players?.black?.userId ?? null,
          },
        },
      };
    },
  };
}
