import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { FORMAT_FAMILIES, FormatDiagram, formatFamily } from "@/config/format-gallery";
import { previewDivisionFixtures } from "@/server/usecases/stages";
import { FormatPreviewView } from "@/components/format-preview-view";
import { HelpBreadcrumb, HelpShell } from "@/components/help/help-shell";

export const revalidate = 3600;

type Props = { params: Promise<{ family: string }> };

export function generateStaticParams(): { family: string }[] {
  return FORMAT_FAMILIES.map((f) => ({ family: f.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { family } = await params;
  const f = formatFamily(family);
  if (!f) return {};
  return { title: `${f.title} — format guide`, description: f.tagline };
}

export default async function FormatExplainerPage({ params }: Props) {
  const { family } = await params;
  const f = formatFamily(family);
  if (!f) notFound();

  // The example is the REAL generated draw over a canned 8-entrant set — not
  // an illustration, the actual generator output.
  const phases = previewDivisionFixtures(f.cannedStages, 8);

  return (
    <HelpShell currentHref="/help/formats">
    <article>
      <HelpBreadcrumb trail={[{ href: "/help/formats", label: "Format gallery" }]} />
      <h1 className="mt-3 flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
        {f.title}
        {f.pro ? (
          <span className="rounded-full bg-purple-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-purple-700">
            Pro
          </span>
        ) : null}
      </h1>
      <p className="mt-2 text-lg text-slate-600">{f.tagline}</p>

      <div className="mt-6 rounded-2xl border border-purple-100 bg-purple-50/40 p-5">
        {/* The shared diagram is an <svg role="img"> with no name (config/format-gallery.tsx, also used by the
            console's explainer panel). Here it gets one, from the format's name: the picture is named once, and
            the unnamed svg inside is hidden from assistive tech. */}
        <div role="img" aria-label={`Diagram of the ${f.title} format`}>
          <div aria-hidden>
            <FormatDiagram slug={f.slug} />
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-slate-700">
        {f.body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      <dl className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 p-4">
          <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Best for
          </dt>
          <dd className="mt-1 text-sm text-slate-700">{f.bestFor}</dd>
        </div>
        <div className="rounded-2xl border border-slate-200 p-4">
          <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            The trade-off
          </dt>
          <dd className="mt-1 text-sm text-slate-700">{f.tradeoff}</dd>
        </div>
      </dl>

      <h2 className="mt-10 font-display text-xl font-semibold uppercase tracking-wide text-slate-900">
        What you get with 8 entrants
      </h2>
      <p className="mb-4 mt-1 text-sm text-slate-500">
        This is the draw the app generates for eight entrants. Your real
        fixtures are built the same way.
      </p>
      <FormatPreviewView phases={phases} />
    </article>
    </HelpShell>
  );
}
