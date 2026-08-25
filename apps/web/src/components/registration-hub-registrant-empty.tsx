import type { ComponentType } from "react";
import Link from "@/components/ui/console-link";

/**
 * Registration hub — Registrants tab, the shared empty-state shell (RS005
 * W2a task 5). One shell, two callers with different icon/copy/cta:
 *
 *  - "no registrations at all" — RS004 W2's designed placeholder treatment,
 *    reused byte-for-byte (icon circle, title, body, cta pointing at
 *    Settings/the register link).
 *  - "filters matched nothing" — same shell, different icon/copy, cta
 *    clears the filters instead. A SEPARATE state on purpose: showing the
 *    same "no one's registered" copy when an organiser has simply
 *    over-filtered would tell them their competition is empty when it
 *    isn't. This is also the reason there is no SECOND row-renderer for
 *    "the filtered set is empty" vs "the table has rows" — task 4's ruling
 *    is one table, one row renderer; this component is the one place that
 *    varies.
 *
 * A single component (not two near-duplicate ones) so the visual treatment
 * can never drift between the two even though their content does.
 */
export function RegistrationHubRegistrantEmpty({
  icon: Icon,
  title,
  body,
  ctaLabel,
  ctaHref,
  variant,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
  /** Tags the root with a data hook so e2e/regression can target either
   *  state without parsing rendered copy. */
  variant: "empty" | "filtered";
}) {
  return (
    <div
      data-registration-hub-registrant-empty={variant}
      className="card flex flex-col items-center gap-3 px-6 py-14 text-center"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-100 text-purple-600">
        <Icon className="h-6 w-6" strokeWidth={1.75} aria-hidden />
      </span>
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="max-w-md text-sm text-slate-500">{body}</p>
      <Link href={ctaHref} className="btn btn-ghost mt-1">
        {ctaLabel}
      </Link>
    </div>
  );
}
