export const dynamic = "force-dynamic";
// P11 (D6) — division batch score-event import page (design doc §7, R8).
// Own directory, sibling to schedule/ — an admin-bar surface has no business
// growing the division console's 685-line page.tsx. Functional bar only
// (/admin-grade, standing rule): this file is pure composition — auth/org
// scoping, the entitlement gate, and the one extra read the client island
// needs to link a fixture — every string lives in ImportClient.tsx via
// useMsg(), so there is nothing to localize here.
//
// Feature absent -> notFound(), and the console carries NO link to this
// page during rollout (spec §2.4: import.events has no plan_entitlements
// row on any plan, so only a per-org override grants it) — deliberate, not
// an oversight. The ROUTE (Task 5) is the actual write-path authority and
// answers 402/403 regardless of what this page renders; the check below
// only keeps the surface invisible.
import { notFound } from "next/navigation";
import { requireDivisionPage } from "@/server/page-auth";
import { hasFeature } from "@/lib/entitlements";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { ImportClient } from "./ImportClient";

export default async function DivisionImportPage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string }>;
}) {
  const { orgSlug, compSlug, divSlug } = await params;
  const page = await requireDivisionPage(orgSlug, compSlug, divSlug, { tail: "/import" });
  const { auth } = page;
  const divisionId = page.division.id;
  if (!(await hasFeature(auth.orgId, "import.events"))) notFound();

  // Fixture id -> per-division display ordinal, so the report table can
  // link each row (design doc §7, "fixture (linked)") to the real console
  // fixture page — routes.fixture addresses by that ordinal, never the uuid
  // the import API itself deals in.
  const fixtures = await listDivisionFixtures(auth, divisionId);
  const fixtureNoById = Object.fromEntries(fixtures.map((f) => [f.id, f.fixture_no]));

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <ImportClient
        divisionId={divisionId}
        orgSlug={orgSlug}
        compSlug={compSlug}
        divSlug={divSlug}
        fixtureNoById={fixtureNoById}
      />
    </main>
  );
}
