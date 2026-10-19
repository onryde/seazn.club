import "server-only";
import { HttpError } from "@/lib/errors";

export type OnlinePlayMode = "off" | "lichess";

const ONLINE_PLAY_VALUES = new Set<OnlinePlayMode>(["off", "lichess"]);

/** Read divisions.config.onlinePlay; absent or unknown → off. */
export function readOnlinePlay(config: unknown): OnlinePlayMode {
  const raw = (config as Record<string, unknown> | null)?.onlinePlay;
  if (raw === "lichess") return "lichess";
  return "off";
}

/** The one statement of which sports can be played online. The camera policy
 *  (camera-policy.ts) follows it: no online play ⇒ no camera to require. */
export function supportsOnlinePlay(sportKey: string): boolean {
  return sportKey === "boardgame";
}

/** Whether a division plays online: a sport that can (supportsOnlinePlay) set to Lichess. ONE predicate (final
 *  review M-11) for the registration path: the entries step's statement (registrations.ts publicRegistrationInfo)
 *  and the link demand at submit and at the join link (registration-submit.ts) read THIS, so a stored onlinePlay on a
 *  sport that cannot play online is stated by neither and demanded by neither. */
export function divisionPlaysOnline(d: { sport_key: string; config: unknown }): boolean {
  return supportsOnlinePlay(d.sport_key) && readOnlinePlay(d.config) === "lichess";
}

/** Validate and normalise an onlinePlay patch value for a sport. */
export function assertOnlinePlayValue(
  sportKey: string,
  value: unknown,
): OnlinePlayMode {
  const mode: OnlinePlayMode =
    value === undefined || value === null || value === "off" ? "off" : (value as OnlinePlayMode);
  if (!ONLINE_PLAY_VALUES.has(mode)) {
    throw new HttpError(422, "onlinePlay must be 'off' or 'lichess'", "ONLINE_PLAY_INVALID");
  }
  if (mode === "lichess" && !supportsOnlinePlay(sportKey)) {
    throw new HttpError(
      422,
      "Online Lichess play is only available for board game divisions",
      "ONLINE_PLAY_SPORT",
    );
  }
  return mode;
}

/** Apply a validated onlinePlay value onto a parsed sport config snapshot. */
export function applyOnlinePlayToConfig(
  finalConfig: Record<string, unknown>,
  mode: OnlinePlayMode,
): void {
  if (mode === "off") delete finalConfig.onlinePlay;
  else finalConfig.onlinePlay = mode;
}

/** Strip division-level keys that ride in config but are not sport schema. */
export function withoutDivisionMetaKeys(config: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (k !== "entrants" && k !== "onlinePlay") rest[k] = v;
  }
  return rest;
}
