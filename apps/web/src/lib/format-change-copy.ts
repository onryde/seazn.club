// FMT5: what the Format dialog says when the server refuses a format change, in the reader's language off the refusal's
// CODE — never the wire's English. Said here: `replaceStages`' own FORMAT_* codes (lib/format-change.ts), the board
// writes' shared ones (a frozen schedule, an online game), the body's (a Swiss with no rounds, chess individual-only), and
// the rule refusals `settingsSaveErrorText` already says (a match with its own format, a config the sport refuses).
// NOT said here: the knockout refusals the replace path can also raise (lib/knockout-refusals.ts — W4 T16's
// STEPLADDER_/PAGE_PLAYOFF_NEEDS_TABLE_SOURCE, which `assertStageBatchGates` asks of the dialog's PUT too). They fall
// through to `settingsSaveErrorText`, which prints the server's English sentence (B5 review M1, parked).
import { CHESS_INDIVIDUAL_ONLY } from "@/lib/chess-individual-only";
import { settingsSaveErrorText } from "@/lib/config-issue-copy";
import { FORMAT_CHANGE_REFUSALS, isFormatChangeCode } from "@/lib/format-change";
import type { MessageKey } from "@/lib/messages";
import { ONLINE_GAME_EXISTS_CODE, ONLINE_GAME_EXISTS_KEY } from "@/lib/open-round";
import { SCHEDULE_LOCKED_CODE } from "@/lib/schedule-lock";
import { SWISS_ROUNDS_REQUIRED_CODE } from "@/lib/swiss-shell";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The sentence for a refused format change. `fallback` is said for a failure that carries no code at all. */
export function formatChangeRefusalText(err: unknown, m: Msg, fallback: string): string {
  const { code, extra } = (err ?? {}) as { code?: unknown; extra?: Record<string, unknown> };
  if (isFormatChangeCode(code)) {
    const key = FORMAT_CHANGE_REFUSALS[code].key;
    if (code !== "FORMAT_STREAM_LIVE") return m(key);
    const n = extra?.fixture_no;
    return m(key, { match: typeof n === "number" ? m("rules.err.match", { n }) : m("rules.err.thisMatch") });
  }
  if (code === SCHEDULE_LOCKED_CODE) return m("stage.error.scheduleFrozen");
  if (code === ONLINE_GAME_EXISTS_CODE) return m(ONLINE_GAME_EXISTS_KEY as MessageKey);
  if (code === SWISS_ROUNDS_REQUIRED_CODE) return m("stage.err.swissRoundsRequired");
  if (code === CHESS_INDIVIDUAL_ONLY) return m("divset.err.chessIndividualOnly");
  return settingsSaveErrorText(err, m, fallback);
}
