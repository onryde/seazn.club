// The sponsor-deals seed helpers, moved verbatim out of sponsor-deals.spec.ts so a second spec (walkthrough/sponsor-stream-matrix.spec.ts)
// seeds sponsors, packages and deals through the same product API calls. Nothing here is new behaviour.
import { expect, type APIRequestContext } from "@playwright/test";
import { apiJson } from "../helpers";

export type Deal = { id: string; deal_status: string; payment_status: string; sponsor_id: string };

export async function newSponsor(request: APIRequestContext, orgId: string, name: string): Promise<string> {
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsors`, "POST", { name, tier: "partner", url: "https://sponsor.example/" });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.id;
}

export async function newPackage(request: APIRequestContext, orgId: string, tier: string): Promise<string> {
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", {
    name: `${tier} board`, price_cents: 25_000, currency: "gbp", tier,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.id;
}

export async function newDeal(request: APIRequestContext, orgId: string, sponsorId: string, over: Record<string, unknown>): Promise<string> {
  const res = await apiJson<{ deal: Deal }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/deals`, "POST", {
    competition_id: null, payment_method: "offline", go_live: "on_payment", ...over,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.deal.id;
}

export async function dealStatus(request: APIRequestContext, orgId: string, dealId: string): Promise<string> {
  const res = await apiJson<Deal>(request, `/api/v1/orgs/${orgId}/sponsor-deals/${dealId}`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!.deal_status;
}
