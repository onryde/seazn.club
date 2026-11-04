// The entrant-kind refusals, said in the reader's language off their CODE and facts (FU1 fix round 1, m2 and I1) - never
// the server's English, which names the kind as a raw slug ("'team'"). The house pattern of `ruleRefusalSentence`
// (lib/rule-errors.ts): a code this reader knows, with the facts it needs, maps to a dictionary sentence; anything else is
// null and the caller keeps its own handling (usually the server's message).
//
// Three codes, two audiences:
//   - ENTRANT_KIND_NOT_ALLOWED at an organiser door (approve, mark paid, promote): the division no longer takes this
//     entry's kind, so it cannot be seated;
//   - ENTRANT_KIND_IN_USE and REGISTRATION_KIND_IN_USE on a division save (the Entrants tab): taking a kind out while
//     entrants, or live registrations, still hold it.
//
// Pure and client-safe: no server imports.
import { ENTRANT_KIND_NOT_ALLOWED } from "@/lib/division-entrant-kinds";
import type { MessageKey } from "@/lib/messages";

/** A narrowing refused because ENTRANTS of the removed kind still exist (divisions.ts). */
export const ENTRANT_KIND_IN_USE = "ENTRANT_KIND_IN_USE";
/** A narrowing refused because live REGISTRATIONS of the removed kind still exist (divisions.ts, FU1 fix round 1 I1).
 *  Carries `kind` and `count`. */
export const REGISTRATION_KIND_IN_USE = "REGISTRATION_KIND_IN_USE";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

const KINDS = ["team", "individual", "pair"] as const;
type Kind = (typeof KINDS)[number];
const isKind = (k: unknown): k is Kind => typeof k === "string" && (KINDS as readonly string[]).includes(k);

/** The kind as a word inside a sentence: the Entrants tab's own label, lower-cased ("team", "équipe", "duo"). */
const kindWord = (kind: Kind, msg: Msg): string => msg(`divset.entrants.kind.${kind}` as MessageKey).toLocaleLowerCase();

function codeAndExtra(err: unknown): { code: string | undefined; extra: Record<string, unknown> } {
  if (typeof err !== "object" || err === null) return { code: undefined, extra: {} };
  const { code, extra } = err as { code?: unknown; extra?: unknown };
  return {
    code: typeof code === "string" ? code : undefined,
    extra: typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>) : {},
  };
}

/** An organiser door's refusal to seat an entry whose kind the division no longer takes. Null for any other error, or one
 *  that does not name a kind this app knows. */
export function registrantKindRefusalText(err: unknown, msg: Msg): string | null {
  const { code, extra } = codeAndExtra(err);
  if (code !== ENTRANT_KIND_NOT_ALLOWED || !isKind(extra.kind)) return null;
  return msg("reg.hub.registrants.kindNotAllowed", { kind: kindWord(extra.kind, msg) });
}

/** A division save's refusal to take a kind out while entrants or live registrations still hold it. Null for any other
 *  error, or one whose facts this app cannot read (the caller then shows the server's words). */
export function divisionKindRefusalText(err: unknown, msg: Msg): string | null {
  const { code, extra } = codeAndExtra(err);
  if (!isKind(extra.kind)) return null;
  const kind = kindWord(extra.kind, msg);
  if (code === ENTRANT_KIND_IN_USE) return msg("divset.err.entrantKindInUse", { kind });
  if (code === REGISTRATION_KIND_IN_USE) {
    const count = extra.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
    return msg(count === 1 ? "divset.err.registrationKindInUse.one" : "divset.err.registrationKindInUse.other", { count, kind });
  }
  return null;
}
