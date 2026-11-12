// Quick match Save (plan 3 Task 5; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7, C3, C19; mockup
// docs/superpowers/specs/mockups/2026-11-03-quick-match/home.html `.qm-ghost.qm-save`, layout only): the one control that
// keeps a guest's match in an account. A plain `<form method="post">` to `/q/<token>/save/confirm`, built by the page, so it
// works with no script at all; the route saves for the signed-in person or sends a signed-out one to sign in and back to the
// save page. A SERVER component: there is nothing to guard on the client, because a second post is the route's
// `already_yours` (the same landing), never a second write.
//
// Two looks, one post: on the home it is the mockup's lime-outlined ghost beside Share (the hero's Score stays the page's one
// lime fill); on the save page it is that page's only action, so it is the filled lime button.
//
// `ph-no-capture` on the form: its action holds the home token, the quick match's credential (O3), so session replay must never
// record it (scrub-secret-painters.test.ts).
import { Bookmark } from "lucide-react";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream";
const LOOK = {
  ghost:
    "min-h-11 rounded-lg border border-[color:var(--mk-lime)] bg-transparent px-4 py-2 text-sm font-semibold text-[color:var(--mk-lime)] transition-colors hover:bg-[rgb(163_230_53/0.08)] motion-reduce:transition-none",
  primary: "min-h-12 rounded-xl bg-[color:var(--mk-lime)] px-5 py-2.5 text-base font-bold text-night",
} as const;

export interface QuickMatchSaveFormProps {
  /** `/q/<token>/save/confirm` (`routes.quickMatchSaveConfirm`), built by the page. */
  action: string;
  /** "Save this match", in the viewer's language. */
  label: string;
  look: keyof typeof LOOK;
}

export function QuickMatchSaveForm({ action, label, look }: QuickMatchSaveFormProps) {
  return (
    <form method="post" action={action} data-testid="qm-save-form" className="ph-no-capture w-full min-w-0">
      <button
        type="submit"
        data-testid="qm-save"
        className={`app-display inline-flex w-full max-w-full items-center justify-center gap-2 text-center leading-tight [overflow-wrap:anywhere] ${LOOK[look]} ${FOCUS}`}
      >
        <Bookmark aria-hidden="true" className="h-4 w-4 flex-none" strokeWidth={2} />
        <span className="min-w-0">{label}</span>
      </button>
    </form>
  );
}
