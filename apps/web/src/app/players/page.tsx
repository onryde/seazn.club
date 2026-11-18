// Players tab of the unified Directory (Players + Clubs). One hop to the org's own Directory (owner, 2026-11-18).
import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";
import { requirePageAuth } from "@/server/page-auth";

export default async function PlayersPage() {
  const { org } = await requirePageAuth();
  redirect(routes.orgDirectory(org.slug, "players"));
}
