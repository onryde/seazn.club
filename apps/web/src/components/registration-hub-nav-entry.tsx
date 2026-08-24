import Link from "@/components/ui/console-link";
import { UserPlus } from "lucide-react";

/**
 * Competition overview — the "Registration" nav entry (RS004 W2 scope item
 * 2). Pattern-matches the existing header action links (Schedule Board,
 * Settings: icon + label, label hidden under `sm`, 44px touch target) rather
 * than inventing a new nav shape, with two small pill badges carrying the
 * live counts — open-outline for "how many divisions", solid for "how many
 * people" (the headline number an organiser glances at).
 *
 * A dumb component: `label`/`ariaLabel`/`openBadge`/`registeredBadge` are
 * resolved strings the page hands down (same convention as
 * CompetitionPassEntry) — no dict/locale import here, so this never becomes
 * a second i18n lookup path alongside `lib/i18n`.
 */
export function RegistrationHubNavEntry({
  href,
  label,
  ariaLabel,
  openBadge,
  registeredBadge,
}: {
  href: string;
  label: string;
  ariaLabel: string;
  /** e.g. "2 divisions open" — already pluralized by the caller. */
  openBadge: string;
  /** e.g. "14 registrants" — already pluralized by the caller. */
  registeredBadge: string;
}) {
  return (
    <Link href={href} aria-label={ariaLabel} className="btn btn-ghost gap-1.5" data-registration-hub-entry>
      <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      <span className="hidden sm:inline">{label}</span>
      <span className="hidden items-center gap-1 sm:inline-flex">
        <span className="inline-flex items-center rounded-full border border-purple-300 bg-white px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-purple-700">
          {openBadge}
        </span>
        <span className="inline-flex items-center rounded-full bg-purple-600 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white">
          {registeredBadge}
        </span>
      </span>
    </Link>
  );
}
