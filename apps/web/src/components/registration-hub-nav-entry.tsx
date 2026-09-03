import Link from "@/components/ui/console-link";
import { UserPlus } from "lucide-react";

/**
 * Competition overview — the "Registration" nav entry (RS004 W2 scope item
 * 2). Pattern-matches the existing header action links (Schedule Board,
 * Settings: icon + label, label hidden under `sm`, 44px touch target) rather
 * than inventing a new nav shape.
 *
 * ONE number on the button, the rest on hover/focus (owner call, 2026-08-25).
 * It shipped as three filled pills spelling out every count, which put two
 * saturated badges and ~40 characters into a header rail whose other entries
 * (QR, Settings) are quiet ghost buttons — the entry outshouted the page it
 * links to. The counts still matter, so they move into a tooltip instead of
 * being deleted: the button carries the headline number and, when something
 * needs the organiser, one amber dot.
 *
 * WHY THE TOOLTIP IS NOT THE ACCESSIBLE PATH. It is `aria-hidden`, and the
 * page composes the same lines into `ariaLabel`. A hover-revealed panel is
 * unreachable on touch and awkward under a screen reader; making the link's
 * own accessible name carry the breakdown means nobody has to find the
 * tooltip to learn what it says. `group-focus-within` still reveals it for a
 * sighted keyboard user.
 *
 * A dumb component: `label`/`ariaLabel`/`count`/`details` are resolved
 * strings the page hands down (same convention as CompetitionPassEntry) —
 * no dict/locale import here, so this never becomes a second i18n lookup
 * path alongside `lib/i18n`.
 */
export function RegistrationHubNavEntry({
  href,
  label,
  ariaLabel,
  count,
  details,
  awaiting = false,
  className = "",
}: {
  href: string;
  label: string;
  /** The FULL sentence, breakdown included — see the note above on why the
   *  tooltip is not the accessible path. */
  ariaLabel: string;
  /** The one number on the button, e.g. "56" — already formatted by the
   *  caller for the active locale. */
  count: string;
  /** Tooltip lines, already localized and pluralized, e.g.
   *  ["4 divisions open", "34 confirmed", "22 awaiting confirmation"]. The
   *  awaiting line is simply absent when nothing is outstanding — this
   *  component never renders a line reading zero. */
  details: string[];
  /** Something is waiting on the organiser: renders the amber dot. Distinct
   *  from `details` so the dot cannot drift out of step with the line that
   *  explains it. */
  awaiting?: boolean;
  /** Layout hook for the caller's own row (the desk masthead orders its
   *  phone stack with it). Never styling this component owns. */
  className?: string;
}) {
  return (
    <span className={`group relative inline-flex max-sm:flex max-sm:w-full ${className}`}>
      <Link
        href={href}
        aria-label={ariaLabel}
        className="btn btn-ghost gap-1.5 max-sm:min-h-11 max-sm:w-full max-sm:justify-start max-sm:px-4"
        data-registration-hub-entry
      >
        <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        {/* F2 (round J): label and count were both `hidden sm:inline`, so at
            phone widths this was an unlabelled icon tile carrying no number —
            the one tool on this row that reports STATUS, with its status
            hidden behind nothing at all. Visible at every width now. The
            hover tooltip below stays desktop-only (`hidden sm:contents`):
            there is no hover on a phone, and its lines are already in the
            accessible name. */}
        <span className="inline">{label}</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center rounded-full bg-purple-600 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white">
            {count}
          </span>
          {awaiting && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-amber-500"
              data-registration-hub-awaiting
              aria-hidden
            />
          )}
        </span>
      </Link>
      {details.length > 0 && (
        // `sm:contents` rather than `sm:block`: the panel is positioned
        // against the `relative` wrapper above, and a `contents` parent adds
        // no box of its own to the header rail's flex line. Under `sm` the
        // counts are hidden anyway and there is no hover to speak of, so the
        // whole panel stays out of the tree's rendered output.
        <span className="hidden sm:contents">
          <span
            role="tooltip"
            aria-hidden
            className="pointer-events-none absolute top-full left-0 z-20 mt-1 hidden w-max max-w-64 rounded-lg border border-zinc-200 bg-surface p-2 text-left text-[11px] leading-relaxed font-medium text-zinc-700 shadow-lg group-hover:block group-focus-within:block"
            data-registration-hub-tooltip
          >
            {details.map((line) => (
              <span key={line} className="block whitespace-nowrap">
                {line}
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
