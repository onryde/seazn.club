"use client";
// Breadcrumb trail + universal back button for the /o console (v3/01 §3–4).
// Derived entirely from the pathname — zero per-page wiring. The org segment
// is plain text (org switching lives in the account menu). Mobile collapses to "‹ parent", which IS
// the back affordance; desktop gets a 44px chevron whose parent name shows
// on hover. Back always targets the structural parent, never history.back().
import Link from "@/components/ui/console-link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { buildCrumbs, type BreadcrumbNameMap } from "@/lib/breadcrumb-chain";
import { useMsg } from "@/components/i18n/dict-provider";

export type { BreadcrumbNameMap };

interface BreadcrumbsProps {
  orgName: string;
  names: BreadcrumbNameMap;
}

/** The org segment is the trail's root and plain text: switching organisation lives in the gantry's account menu. */
function OrgCrumb({ orgName }: Pick<BreadcrumbsProps, "orgName">) {
  return <span className="truncate font-medium text-cream/90">{orgName}</span>;
}

export function Breadcrumbs({ orgName, names }: BreadcrumbsProps) {
  const pathname = usePathname();
  const msg = useMsg();
  const crumbs = buildCrumbs({ pathname, orgName, names, t: msg });
  if (crumbs.length === 0) return null;
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2]! : null;

  return (
    // Night apron under the gantry (floodlit-console spec §4).
    <div className="app-crumbs">
      <div className="mx-auto flex max-w-6xl items-center px-4 text-xs text-cream/60">
        {/* Universal back button (§4): structural parent, 44px target,
            hidden on org home. Parent name slides in on desktop hover. */}
        {parent && (
          <Link
            href={parent.href}
            aria-label={`Back to ${parent.label}`}
            className="group -ml-3 flex h-11 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-cream/70 transition hover:text-cream"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            <span className="hidden max-w-0 truncate opacity-0 transition-all duration-150 group-hover:max-w-40 group-hover:opacity-100 sm:inline-block">
              {parent.label}
            </span>
          </Link>
        )}

        {/* Mobile (§3 wireframe): the trail collapses to "‹ parent" — the
            back link above IS the affordance, so just show where it goes.
            Org home shows the org's name. */}
        {parent ? (
          <Link href={parent.href} className="min-w-0 truncate py-3 sm:hidden">
            {parent.label}
          </Link>
        ) : (
          <div className="flex min-w-0 items-center py-2 sm:hidden">
            <OrgCrumb orgName={orgName} />
          </div>
        )}

        {/* Desktop trail: every level links; the current page is plain text. */}
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 py-2 sm:flex">
          <OrgCrumb orgName={orgName} />
          {crumbs.slice(1).map((crumb, i) => {
            const isLast = i === crumbs.length - 2;
            return (
              <span key={crumb.href} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="h-3 w-3 shrink-0 text-cream/30" strokeWidth={2} />
                {isLast ? (
                  <span aria-current="page" className="truncate font-medium text-cream/90">
                    {crumb.label}
                  </span>
                ) : (
                  <Link href={crumb.href} className="truncate transition hover:text-cream">
                    {crumb.label}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
