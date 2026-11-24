// The Online Chess package doors' refusals, said in the organiser's own language (spec 2026-11-23-online-chess-credits-design.md §8.1).
// The server's words are English-only by design, so a screen never shows `err.message` for these: it maps the code to localized copy,
// as `online-entrant-cap-refusal.ts` does for the entrant cap's three.
//
//   ONLINE_FORMAT_NOT_SUPPORTED    a stage kind Online Chess does not run (a league, a group, a ladder): `kind` carried;
//   ONLINE_ROUNDS_NEED_SIZE        more Swiss rounds than the size includes: the next size that covers them (`nextSize`) is offered;
//   ONLINE_ROUNDS_ABOVE_MAX        more Swiss rounds than any size includes (the most is the leaf's: 256's);
//   ONLINE_CAMERAS_NEED_UPGRADE    the Fair-play camera is not paid for on these divisions (`divisions`, each with its name).
//
// A code whose numbers or names are missing keeps the server's own words (null): a half-filled sentence is worse than English.
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, includedRounds } from "@/lib/online-chess-package";

const FORMAT = ONLINE_PACKAGE_CODES.formatNotSupported;
const NEED_SIZE = ONLINE_PACKAGE_CODES.roundsNeedSize;
const ABOVE_MAX = ONLINE_PACKAGE_CODES.roundsAboveMax;
const CAMERAS = ONLINE_PACKAGE_CODES.camerasNeedUpgrade;

/** The copy keys, one per code. */
export const ONLINE_PACKAGE_REFUSAL_KEYS = {
  [FORMAT]: "onlineChess.format.refused",
  [NEED_SIZE]: "onlineChess.roundsNeedSize",
  [ABOVE_MAX]: "onlineChess.roundsAboveMax",
  [CAMERAS]: "onlineChess.camerasNeedUpgrade",
} as const;

export function isOnlinePackageRefusalCode(code: unknown): code is keyof typeof ONLINE_PACKAGE_REFUSAL_KEYS {
  return typeof code === "string" && Object.hasOwn(ONLINE_PACKAGE_REFUSAL_KEYS, code);
}

/** The most Swiss rounds any size includes (P10): the largest size's. */
export const ONLINE_MAX_ROUNDS = includedRounds(ONLINE_SIZES.at(-1)!);

/** The refusal's text, or null when `err` is none of the four codes or lacks what its sentence names (the caller keeps its own
 *  handling). `text` is the screen's own message function (`useMsg`). */
export function onlinePackageRefusalText(
  err: { code?: string; extra?: Record<string, unknown> },
  text: (key: string, vars: Record<string, string | number>) => string,
): string | null {
  if (!isOnlinePackageRefusalCode(err.code)) return null;
  const extra = err.extra ?? {};
  switch (err.code) {
    case FORMAT:
      // `kind` null is the pay door's "this division does not play online": that sentence is not about the format.
      return typeof extra.kind === "string" ? text(ONLINE_PACKAGE_REFUSAL_KEYS[FORMAT], {}) : null;
    case NEED_SIZE:
      return typeof extra.nextSize === "number" ? text(ONLINE_PACKAGE_REFUSAL_KEYS[NEED_SIZE], { nextSize: extra.nextSize }) : null;
    case ABOVE_MAX:
      return text(ONLINE_PACKAGE_REFUSAL_KEYS[ABOVE_MAX], { max: ONLINE_MAX_ROUNDS });
    case CAMERAS: {
      const names = Array.isArray(extra.divisions)
        ? extra.divisions.flatMap((d) => (typeof (d as { name?: unknown } | null)?.name === "string" ? [(d as { name: string }).name] : []))
        : [];
      return names.length > 0 ? text(ONLINE_PACKAGE_REFUSAL_KEYS[CAMERAS], { names: names.join(", ") }) : null;
    }
  }
}
