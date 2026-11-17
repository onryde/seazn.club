// W5 T8b Part 3 (X-WDT-10, owner ruling 289's condition) — the consequence of a Disqualify, shown BEFORE it is confirmed, in
// the one block every surface renders: the organiser's Entrants → Disqualify confirmation, the pad's sanction ending (its
// read-back step and its pending-ending prompt) and the console's Forfeit dialog when the reason is "disqualified". One preview
// (`WithdrawalPreview`, the cascade's own decision) → `previewConsequence` → these lines, so the pad and the organiser read the
// same sentences (withdrawal-consequence-render.test.tsx).
//
// A quiet amber notice under the confirmation's own sentence: it names what else changes, it is not the question. No hooks, so
// it renders inside a confirm dialog's static body and inside the pad's plain-function sheet rows alike.
import type { ReactNode } from "react";
import { consequenceSentences, isWithdrawalPreview, previewConsequence, type WithdrawalPreview } from "@/lib/withdrawal-consequence";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Where the preview stands: still being read (the pad asks as the sheet opens), read, or not readable (the write still
 *  follows the event's rules; the block says so rather than staying silent). */
export type ConsequenceState = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; preview: WithdrawalPreview };

/** A "ready" answer that is not a preview (review m1) is treated as unreadable. */
function checked(state: ConsequenceState): ConsequenceState {
  return state.kind === "ready" && !isWithdrawalPreview(state.preview) ? { kind: "failed" } : state;
}

/** Null when there is nothing to say: a ready preview that settles nothing beyond the match (`cascade: false`). */
export function WithdrawalConsequence({ state: given, t, locale = "en" }: { state: ConsequenceState; t: TFn; locale?: string }): ReactNode {
  const state = checked(given);
  const lines = state.kind === "ready" ? consequenceSentences(previewConsequence(state.preview), t, locale) : [];
  if (state.kind === "ready" && lines.length === 0) return null;
  return (
    <section
      data-testid="withdrawal-consequence"
      data-state={state.kind}
      aria-live="polite"
      className="min-w-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left"
    >
      <p className="text-sm font-semibold text-amber-900">{t("withdrawal.consequence.title")}</p>
      {state.kind === "ready" ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-snug text-slate-800 [overflow-wrap:anywhere]">
          {lines.map((line, i) => (
            <li key={i} data-testid="withdrawal-consequence-line">
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm leading-snug text-slate-700">
          {t(state.kind === "loading" ? "withdrawal.consequence.loading" : "withdrawal.consequence.failed")}
        </p>
      )}
    </section>
  );
}

/** The Entrants → Disqualify confirmation's body: its lead sentence, then the consequence. When the preview could not be read
 *  the general per-format policy (ruling 260's body) stands in, so the confirmation is never less truthful than it was. */
export function disqualifyConfirmBody(given: ConsequenceState, t: TFn, locale: string): ReactNode {
  const state = checked(given);
  return (
    <>
      <p>{t("confirm.disqualifyEntrant.lead")}</p>
      <WithdrawalConsequence state={state} t={t} locale={locale} />
      {state.kind === "failed" && <p>{t("confirm.withdrawEntrant.body")}</p>}
    </>
  );
}
