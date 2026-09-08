// Spectator surface W1 — a shared, deliberately-empty `DecidedOutcomeTemplates`
// for every match-centre caller of `LiveScoreBody` that has no dictionary
// namespace to build real ones from ("ui", not "public" — see
// `DECIDED_METHOD_KEY`/`decidedOutcomeTemplates` in `@/lib/scoring-vocab`).
// `renderDecidedOutcome`'s `interpolate("", …)` always resolves to `""`,
// which `LiveScoreBody`'s own `{decidedLine ? <p>…</p> : null}` treats as
// falsy and renders nothing for — never a raw, unresolvable key leaked onto
// the page. Consolidated here (review fix round 2 minor) after
// `summary-tab.tsx` and `match-centre.tsx` each defined their own identical
// copy.
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";

export const EMPTY_DECIDED_TEMPLATES: DecidedOutcomeTemplates = {
  tie: "",
  plain: "",
  shootoutPlain: "",
  byMethod: {},
};
