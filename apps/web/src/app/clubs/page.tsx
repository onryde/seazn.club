// Clubs merged into the unified Directory (People + Clubs tabs). One hop to the org's own Directory (owner, 2026-11-18).
import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";
import { requirePageAuth } from "@/server/page-auth";

export default async function ClubsPage() {
  const { org } = await requirePageAuth();
  redirect(routes.orgDirectory(org.slug, "clubs"));
}
