import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { FORMAT_FAMILIES, FormatDiagram } from "@/config/format-gallery";
import { HelpBreadcrumb, HelpShell } from "@/components/help/help-shell";
import { familyNeedsPaidPlan } from "@/lib/format-plan-badge";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import { HelpRelated } from "@/components/help/help-related";
import { helpBlogLinks } from "@/server/blog-help-links";

// Prerendered and cached at the edge (layout.tsx): a request-time read fails the build. 300 s: the badge reads the plan table.
export const dynamic = "error";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Format gallery",
  description:
    "League, knockout, groups, swiss, double elimination, americano, ladder — every tournament format explained with a diagram and a live example.",
};

export default async function FormatGalleryPage() {
  // The badge reads the live plan table. At build there is no database, so an unreadable table shows no badge rather
  // than a guess; at runtime the failure throws, so Next keeps the last good page instead of caching a badge-less one.
  const matrix = await loadPricingMatrix().catch((e: unknown) => {
    if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return {} as Awaited<ReturnType<typeof loadPricingMatrix>>;
    throw e;
  });
  const blogLinks = await helpBlogLinks("formats/overview");
  return (
    <HelpShell currentHref="/help/formats">
      <HelpBreadcrumb trail={[{ href: "/help#formats", label: "Formats" }]} />
      <h1 className="mk-display mt-3 text-4xl font-bold text-purple-950">
        Pick the right shape for your day
      </h1>
      <p className="mt-3 max-w-2xl text-slate-600">
        Every format, explained the same way: what it is, who it suits and the
        trade-off, with a diagram and an example drawn for eight entrants.
      </p>

      <ul className="mt-8 space-y-4">
        {FORMAT_FAMILIES.map((f) => (
          <li key={f.slug}>
            <Link
              href={`/help/formats/${f.slug}`}
              className="group grid gap-4 rounded-2xl border border-slate-200 p-5 transition hover:-translate-y-0.5 hover:border-purple-300 hover:shadow-md sm:grid-cols-[1fr_260px] sm:items-center"
            >
              <div>
                <h2 className="flex items-center gap-1.5 font-semibold text-slate-900">
                  {f.title}
                  {familyNeedsPaidPlan(f, matrix) ? (
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
                      Paid plan
                    </span>
                  ) : null}
                  <ArrowRight
                    className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-purple-500"
                    strokeWidth={2}
                  />
                </h2>
                <p className="mt-1 text-sm text-slate-600">{f.tagline}</p>
                <p className="mt-2 text-xs text-slate-500">{f.bestFor}</p>
              </div>
              <div aria-hidden className="hidden sm:block">
                <FormatDiagram slug={f.slug} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <HelpRelated related={[]} prev={null} next={null} blogLinks={blogLinks} />
    </HelpShell>
  );
}
