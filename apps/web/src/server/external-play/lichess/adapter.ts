import type {
  CreateOpenChallengeInput,
  ExternalPlayAdapter,
  LichessGameSnapshot,
  OpenChallenge,
} from "../types";
import { LichessHttpError } from "../types";
import { LICHESS_TIMEOUT_MS } from "../window";

const DEFAULT_BASE = "https://lichess.org";

type FetchFn = typeof fetch;

export type LichessAdapterDeps = {
  fetch: FetchFn;
  baseUrl?: string;
  timeoutMs?: number;
};

/**
 * Lichess open-challenge + game export client.
 * Spec: open challenge (no auth, either side can join as White/Black via
 * their own URL) rather than a direct challenge tied to one access token;
 * unrated/casual, no rematch; injectable fetch + timeout for tests.
 */
export function createLichessAdapter(deps: LichessAdapterDeps): ExternalPlayAdapter {
  const base = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const fetchFn = deps.fetch;
  const timeoutMs = deps.timeoutMs ?? LICHESS_TIMEOUT_MS;

  return {
    async createOpenChallenge(input: CreateOpenChallengeInput): Promise<OpenChallenge> {
      const body = new URLSearchParams({
        users: `${input.whiteUsername},${input.blackUsername}`,
        "clock.limit": String(input.clock.limit),
        "clock.increment": String(input.clock.increment),
        rated: "false",
        expiresAt: String(input.expiresAt.getTime()),
        rules: "noRematch",
      });

      const res = await fetchFn(`${base}/api/challenge/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 401) {
        throw new LichessHttpError(401, "Lichess open challenge unauthorized");
      }
      if (res.status === 429) {
        throw new LichessHttpError(429, "Lichess open challenge rate limited");
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new LichessHttpError(res.status, `Lichess open challenge failed: ${detail}`);
      }

      const json = (await res.json()) as {
        id?: unknown;
        urlWhite?: unknown;
        urlBlack?: unknown;
      };

      if (
        typeof json.id !== "string" ||
        typeof json.urlWhite !== "string" ||
        typeof json.urlBlack !== "string"
      ) {
        throw new LichessHttpError(502, "open challenge response missing id/urlWhite/urlBlack");
      }

      return {
        challengeId: json.id,
        urlWhite: json.urlWhite,
        urlBlack: json.urlBlack,
      };
    },

    async fetchGame(gameId: string): Promise<LichessGameSnapshot | null> {
      const url = `${base}/game/export/${encodeURIComponent(gameId)}?pgnInJson=true&clocks=false`;
      const res = await fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });

      // No game yet: the open challenge exists but nobody has joined, or the
      // id is simply unknown to Lichess. Callers treat this as "keep polling".
      if (res.status === 404) return null;

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
