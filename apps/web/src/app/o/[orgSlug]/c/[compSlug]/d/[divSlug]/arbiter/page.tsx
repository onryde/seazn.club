export const dynamic = "force-dynamic";
// T15 — the arbiter panel (chess design §5.3): the organiser watches the
// division's open round, one board at a time, receive-only. Organisers only
// (a viewer gets a 404, as a page that does not exist for them), and only a
// division that plays online. The round is read here; the video token is NOT
// — the panel's own browser asks for it after mount (spec §10), so the HTML
// carries nothing a copied page could join a meeting with. The org layout
// already provides the `ui` dictionary.
import { notFound } from "next/navigation";
import { requireDivisionPage } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import { loadArbiterRound } from "@/server/usecases/external-play";
import { ArbiterPanel } from "@/components/v2/arbiter-panel";

export default async function DivisionArbiterPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string }>;
  searchParams: Promise<{ fixture?: string | string[] }>;
}) {
  const [{ orgSlug, compSlug, divSlug }, { fixture }] = await Promise.all([params, searchParams]);
  const page = await requireDivisionPage(orgSlug, compSlug, divSlug, { tail: "/arbiter" });
  if (!page.canEdit) notFound();
  const division = await getDivision(page.auth, page.division.id);
  const onlinePlay = (division.config as { onlinePlay?: unknown } | null)?.onlinePlay;
  if (division.sport_key !== "boardgame" || onlinePlay !== "lichess") notFound();
  const round = await loadArbiterRound(page.auth, page.division.id);
  return (
    <ArbiterPanel
      round={round}
      slugs={{ org: orgSlug, comp: compSlug, div: divSlug }}
      initialFixtureId={typeof fixture === "string" ? fixture : null}
    />
  );
}
