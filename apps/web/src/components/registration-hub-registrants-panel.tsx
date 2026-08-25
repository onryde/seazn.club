import Link from "@/components/ui/console-link";
import { ClipboardList } from "lucide-react";

/**
 * Registration hub — Registrants tab, RS004 W2's placeholder.
 *
 * Genuinely empty rather than unfinished: public registration is down until
 * RS006 ships, so there is nothing to list yet regardless of UI. RS005 wires
 * the real table (filters, row expand, approve/reject/promote/CSV) — the
 * copy names that capability in plain language, no ticket reference, and the
 * CTA sends the organiser to the one thing that IS live this wave: Settings.
 */
export function RegistrationHubRegistrantsPanel({
  title,
  body,
  ctaLabel,
  ctaHref,
}: {
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  return (
    <div
      data-registration-hub-registrants-panel
      className="card flex flex-col items-center gap-3 px-6 py-14 text-center"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-100 text-purple-600">
        <ClipboardList className="h-6 w-6" strokeWidth={1.75} aria-hidden />
      </span>
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="max-w-md text-sm text-slate-500">{body}</p>
      <Link href={ctaHref} className="btn btn-ghost mt-1">
        {ctaLabel}
      </Link>
    </div>
  );
}
