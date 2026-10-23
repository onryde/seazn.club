// The Match rules form's clock, while Online play is Lichess (owner staging test 2026-10-19).
//
// Lichess only plays the server's curated time controls (`SHIP1_TIME_CONTROLS`, the setup gate's own catalogue), so
// instead of three free clock inputs the form offers ONE select of those controls. This module is the select's brain:
// the options, which one a set of form values IS, and the form values a choice writes. It is UX only — the server
// still validates (`assertTimeControl`) — and it writes through the SAME form fields the free inputs write
// (`clockBaseMinutes`, `clockIncrementSeconds`, `clockDelaySeconds`, `variant`), so the saved config is identical to a
// hand-typed one and `buildRuleOverride` stays the one place that turns them into `config.clock`.
//
// `@/server/external-play/time-controls` is pure (no `server-only`, no I/O) and is read by VALUE here: the options must
// be the catalogue itself, never a retyped copy that could drift from what the gate accepts.
import { buildRuleOverride, rulesFor } from "@/lib/match-rules";
import { variantWord, variantWordKey } from "@/lib/variant-label-keys";
import type { MessageKey } from "@/lib/messages";
import {
  findTimeControl,
  lichessSpeedOf,
  SHIP1_TIME_CONTROLS,
  type TimeControl,
} from "@/server/external-play/time-controls";
import type { BoardgameClockInput } from "@/server/external-play/clock";

/** The chess rule fields the picker replaces: free time, increment, move delay (Lichess has none), and the clock
 *  family (which follows from the choice). The Match rules grid omits these while the picker stands in. */
export const LICHESS_CLOCK_FIELD_KEYS: readonly string[] = [
  "variant",
  "clockBaseMinutes",
  "clockIncrementSeconds",
  "clockDelaySeconds",
];

/** Rebase ruling D1 (2026-10-23) - the CONFIG keys the picker's fields write (`variant` and `clock`), read off those
 *  fields' own `edits` so the keys cannot drift from the fields the picker stands in for. */
export const LICHESS_CLOCK_CONFIG_KEYS: ReadonlySet<string> = new Set(
  rulesFor("boardgame")
    .filter((f) => LICHESS_CLOCK_FIELD_KEYS.includes(f.key))
    .flatMap((f) => f.edits.map((path) => path.split(".")[0]!)),
);
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Rebase ruling D1 (2026-10-23): on a division that plays online (chess, Online play = Lichess) the clock is the
 * DIVISION's alone. The challenge is built from `divisions.config.clock` only (`guard.ts` `onlinePlayClock`), so a stage's
 * own clock - or the clock family the picker writes beside it - would be an inert seam: saved, shown, never played.
 * The keys a stage of THIS division may not set; none for any other division (over-the-board chess keeps its stage
 * clock). The ONE answer both halves read: the stage save's allowlist refuses them (`refuseUnsettableKeys`,
 * RULE_NOT_SETTABLE) and the stage editor does not draw them (`StageRuleFields`). Client-safe, so it restates the
 * server's `divisionPlaysOnline` (server-only); stage-rules.test.ts sweeps the two against each other.
 */
export function divisionOnlyStageKeys(sportKey: string, divisionConfig: unknown): ReadonlySet<string> {
  const onlinePlay = (divisionConfig as { onlinePlay?: unknown } | null | undefined)?.onlinePlay;
  return sportKey === "boardgame" && onlinePlay === "lichess" ? LICHESS_CLOCK_CONFIG_KEYS : NO_KEYS;
}

/** The clock a save of these form values would leave in the config: what the fields build, else the stored clock.
 *  The fields' own builder decides ("Leave blank to skip a clock override entirely" — a blank time per side builds no
 *  clock at all), so this cannot disagree with what Save writes. */
export function effectiveClock(
  values: Record<string, string>,
  savedConfig: unknown,
): BoardgameClockInput | undefined {
  const built = buildRuleOverride("boardgame", values).clock;
  const clock = built !== undefined ? built : (savedConfig as { clock?: unknown } | null | undefined)?.clock;
  return typeof clock === "object" && clock !== null ? (clock as BoardgameClockInput) : undefined;
}

/** The catalogue key these form values ARE ("" when they are none of the supported controls). Decided by the
 *  server's own matcher, so the picker opens on exactly the control the setup gate would accept. */
export function selectedTimeControlKey(values: Record<string, string>, savedConfig: unknown): string {
  return findTimeControl(effectiveClock(values, savedConfig))?.key ?? "";
}

/** "10+5 · Rapid": the control and the clock-family word Lichess files it under (the same word the public pages use
 *  for an online division — `variantLabel`'s speed rule — so the organiser and the spectator read one name). */
export function timeControlLabel(tc: TimeControl, msg: (key: MessageKey) => string): string {
  return `${tc.key} · ${variantWord("boardgame", lichessSpeedOf(tc), msg)}`;
}

/** The picker's options, in the catalogue's order. */
export function timeControlOptions(msg: (key: MessageKey) => string): { key: string; label: string }[] {
  return SHIP1_TIME_CONTROLS.map((tc) => ({ key: tc.key, label: timeControlLabel(tc, msg) }));
}

/** The form values choosing `key` writes (the free inputs' own fields), or undefined for a key not in the catalogue.
 *  The move delay is cleared — Lichess has none — and the clock family follows the speed Lichess files the control
 *  under, where the chess family set has a word for it. */
export function timeControlRuleValues(key: string): Record<string, string> | undefined {
  const tc = SHIP1_TIME_CONTROLS.find((t) => t.key === key);
  if (!tc) return undefined;
  const speed = lichessSpeedOf(tc);
  return {
    clockBaseMinutes: String(tc.limitSeconds / 60),
    clockIncrementSeconds: String(tc.incrementSeconds),
    clockDelaySeconds: "",
    ...(variantWordKey("boardgame", speed) !== undefined ? { variant: speed } : {}),
  };
}
