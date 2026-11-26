import Link from "@/components/ui/console-link";
import { ArrowLeft } from "lucide-react";

/** The round back arrow's look. The help and marketing pages' BackButton wears it too, so the two cannot drift; each
 *  sets its own size. */
export const ROUND_BACK_LOOK =
  "inline-flex items-center justify-center rounded-full border border-purple-200 bg-white text-purple-700 transition hover:border-purple-400 hover:bg-purple-50";

/** Structural back affordance for console pages outside the /o breadcrumb
 *  shell — same contract as the breadcrumb back button: a real parent link,
 *  never history.back().
 *
 *  `emphasis="button"` gives it the ghost-button chrome. The settings
 *  sub-pages use it because the breadcrumb apron's chevron was not found:
 *  16px at 70% opacity on the dark bar, its label hidden until hover, sitting
 *  beside a text trail. Reported twice as "there is no back button" (user
 *  picked this treatment over making the apron chevron louder, 2026-07-21).
 *
 *  `emphasis="round"` is the arrow alone in a 44px circle, for a row it shares
 *  with other actions (the match page's top row). `label` is then its accessible
 *  name and tooltip. */
export function BackLink({
  href,
  label,
  emphasis = "quiet",
}: {
  href: string;
  label: string;
  emphasis?: "quiet" | "button" | "round";
}) {
  if (emphasis === "round") {
    return (
      <Link href={href} aria-label={label} title={label} className={`${ROUND_BACK_LOOK} h-11 w-11 shrink-0`}>
        <ArrowLeft className="h-4.5 w-4.5" strokeWidth={2} aria-hidden="true" />
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className={
        emphasis === "button"
          ? "btn btn-ghost mb-3 inline-flex items-center gap-1.5 text-sm"
          : "-ml-1 mb-2 inline-flex items-center gap-1.5 rounded-md px-1 py-1.5 text-sm text-slate-500 transition hover:text-slate-700"
      }
    >
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      {label}
    </Link>
  );
}
