// W2c owner P-5 (fix round 1): a refused match-rules save (CONFIG_INVALID) names the PROBLEM in `data.issues` - the
// rule's own sentence on the field's path. `server/api-v1/http.ts` forwards the issues on the wire; this is the reader.
// The engine's sentences are English; a sentence this codebase owns (the share-on-abandon refusals) maps to a dictionary
// key in all four locales, and anything else shows the engine's own message rather than the generic "invalid config".
// No `server-only`: the settings forms read it.
import {
  BO1_MATCH_TIEBREAK,
  MAX_OVERS_PER_BOWLER_EXCEEDS_INNINGS,
  MIN_OVERS_FOR_RESULT_EXCEEDS_INNINGS,
  SET_TARGET_BELOW_FLOOR,
  SHARE_NEEDS_DRAWN_GAME,
  SHARE_NEEDS_DRAWS,
} from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import { ruleRefusalSentence } from "@/lib/rule-errors";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface ConfigIssue {
  path: (string | number)[];
  message: string;
}

/** The issues of a CONFIG_INVALID envelope (`path` and `message` only), or null when it carries none this reader can
 *  use: not an object, no list, an empty list, or no entry with a message. Entries without a message are dropped. */
export function configIssuesOf(data: unknown): ConfigIssue[] | null {
  if (typeof data !== "object" || data === null) return null;
  const list = (data as { issues?: unknown }).issues;
  if (!Array.isArray(list)) return null;
  const out: ConfigIssue[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const { path, message } = raw as { path?: unknown; message?: unknown };
    if (typeof message !== "string" || message === "") continue;
    const cleanPath = Array.isArray(path) ? path.filter((p): p is string | number => typeof p === "string" || typeof p === "number") : [];
    out.push({ path: cleanPath, message });
  }
  return out.length === 0 ? null : out;
}

/** The engine sentences this app localizes, keyed by the engine's own constants (never retyped here). A sentence may be a
 *  TEMPLATE with `{name}` slots (`SET_TARGET_BELOW_FLOOR`'s `{min}`): the issue then matches it with a number in each slot,
 *  and the numbers fill the same slots of the localized copy. */
export const LOCALIZED_CONFIG_ISSUES: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  [SHARE_NEEDS_DRAWS, "rules.err.shareNeedsDraws"],
  [SHARE_NEEDS_DRAWN_GAME, "rules.err.shareNeedsDrawnGame"],
  // W2e (spec §5.5; VB-CF-1, TT-CF-1, TN-CF-1): the write doors' refusals of ruling 31's floor and RB2A-13.
  [SET_TARGET_BELOW_FLOOR, "rules.err.setTargetBelowFloor"],
  [BO1_MATCH_TIEBREAK, "rules.err.bo1MatchTiebreak"],
  // W2e T33a (cricket): the schema's two over-count refusals - schema messages, not write-door ones, so they ride the same issues.
  [MAX_OVERS_PER_BOWLER_EXCEEDS_INNINGS, "rules.err.maxOversPerBowlerExceedsInnings"],
  [MIN_OVERS_FOR_RESULT_EXCEEDS_INNINGS, "rules.err.minOversForResultExceedsInnings"],
]);

/** A sentence as a whole-message matcher: literal text, each `{name}` slot a named run of digits. */
function sentenceMatcher(sentence: string): RegExp {
  const literal = sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literal.replace(/\\\{(\w+)\\\}/g, "(?<$1>\\d+)")}$`);
}

/** The numbers a message carries in the slots of `template` (`{min}` -> `{ min: "5" }`), or null when the message is not that
 *  sentence. The same whole-message match `configIssueText` localizes by, for a caller that needs the numbers themselves. */
export function sentenceSlots(message: string, template: string): Record<string, string> | null {
  const found = sentenceMatcher(template).exec(message);
  return found === null ? null : { ...found.groups };
}

const CONFIG_ISSUE_MATCHERS: readonly (readonly [RegExp, MessageKey])[] = [...LOCALIZED_CONFIG_ISSUES].map(([sentence, key]) => [sentenceMatcher(sentence), key] as const);

/** One issue as the reader should see it: the localized sentence when this app owns it (its slots filled from the
 *  engine's), else the engine's message. */
export function configIssueText(issue: ConfigIssue, msg: Msg): string {
  for (const [matcher, key] of CONFIG_ISSUE_MATCHERS) {
    const found = matcher.exec(issue.message);
    if (found !== null) return found.groups === undefined ? msg(key) : msg(key, { ...found.groups });
  }
  return issue.message;
}

/** What a failed settings save says. A rule-lock refusal says itself first (`ruleRefusalSentence`); a CONFIG_INVALID that names its problems says them (all of them, in order); any
 *  other error keeps its own message, and a non-Error falls back to `fallback`. `err.extra` is the envelope's detail. */
export function settingsSaveErrorText(err: unknown, msg: Msg, fallback: string): string {
  // W2c Task 19: a rule-lock refusal (a walkover that no longer fits the format, a locked stage or match...) is said in the
  // reader's language off its CODE and facts, never as the server's English message.
  if (err instanceof Error) {
    const { code, extra } = err as Error & { code?: unknown; extra?: unknown };
    const said = ruleRefusalSentence(
      typeof code === "string" ? code : undefined,
      typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>) : undefined,
      err.message,
      msg,
    );
    if (said !== null) return said;
  }
  const extra = (err as { code?: unknown; extra?: unknown } | null)?.code === "CONFIG_INVALID" ? (err as { extra?: unknown }).extra : undefined;
  const issues = configIssuesOf(extra);
  if (issues !== null) return issues.map((i) => configIssueText(i, msg)).join(" ");
  return err instanceof Error ? err.message : fallback;
}

/** What a failed RULES write says, wherever the organiser made it: the match block's Save and "Use stage rules", the stage
 *  row's Save and "Use division rules". One reader for all four, so a refusal (a locked match, a format the play does not
 *  fit) is said in the reader's language off its code at every one of them - never the wire's English (W2c Task 19). */
export function rulesWriteErrorText(err: unknown, msg: Msg): string {
  return settingsSaveErrorText(err, msg, msg("schedule.error.failed"));
}
