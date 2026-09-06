import { test, expect } from "@playwright/test";
import { TAG, apiJson, communityLimit } from "./helpers";

// W2 T19 — `POST /api/v1/officials/import` starts refusing.
//
// The officials import shipped with no entitlement check at all, so the free
// `import.bulk` row cap was unenforceable through it. The usecase tests
// (`server/usecases/__tests__/officials-import-cap.test.ts`) pin the gate's
// boundary; THIS file exists because the change is to a live, shipped HTTP
// route. A usecase call cannot prove that the refusal survives the route:
// that it arrives as a 402 rather than a 500, and that the paywall envelope
// carries the feature key and the cap-quoting sentence a client renders.
// Driving it through the real door is the only thing that shows that.
//
// Free plan, so the community storage state. The cap is READ from
// `plan_entitlements` (`communityLimit`) — a literal here would be the next
// stale copy of a figure that has already drifted once.
test.use({ storageState: "e2e/.auth/community.json" });

const ENDPOINT = "/api/v1/officials/import";

function officialsCsv(rows: number, tag: string): Buffer {
  const lines = ["Name,Roles,MaxPerDay"];
  for (let i = 0; i < rows; i++) lines.push(`Cap Ref ${tag} ${i},referee,`);
  return Buffer.from(lines.join("\n"));
}

test.describe.serial("officials import: the import.bulk cap is enforced at the route", () => {
  test("a file one row over the free cap comes back 402 with the paywall envelope", async ({
    request,
  }) => {
    const cap = await communityLimit("import.bulk");
    // Anti-vacuity: the sentence asserted below quotes this number, and the
    // stale copy this wave removed said 20. If the two ever coincide the
    // assertion stops witnessing anything.
    expect(cap).not.toBe(20);

    const res = await request.post(ENDPOINT, {
      multipart: {
        file: {
          name: "officials.csv",
          mimeType: "text/csv",
          buffer: officialsCsv(cap + 1, TAG),
        },
      },
    });

    expect(res.status()).toBe(402);
    const body = (await res.json()) as {
      error?: { code?: string; feature_key?: string; reason?: string; limit?: number };
    };
    expect(body.error?.code).toBe("PAYMENT_REQUIRED");
    // The contextual <UpgradeGate> selects on feature_key; the machine hint and
    // the human sentence both carry the cap that actually refused the file.
    expect(body.error?.feature_key).toBe("import.bulk");
    expect(body.error?.limit).toBe(cap);
    expect(body.error?.reason).toContain(`over ${cap} rows`);

    // Refused BEFORE the transaction — the route wrote nothing.
    const after = await apiJson<{ id: string; display_name: string }[]>(request, "/api/v1/officials");
    expect(
      (after.data ?? []).filter((o) => o.display_name.startsWith(`Cap Ref ${TAG} `)),
      "a refused import must not have created any officials",
    ).toEqual([]);
  });

  test("a file under the cap still imports — the gate refuses, it does not close the route", async ({
    request,
  }) => {
    // The over-refusing half. A gate that 402s everything would pass the test
    // above and break the product; this is what stops that reading as green.
    const res = await request.post(ENDPOINT, {
      multipart: {
        file: {
          name: "officials.csv",
          mimeType: "text/csv",
          buffer: officialsCsv(2, `${TAG}u`),
        },
      },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { data?: { created: number; skipped: number } };
    expect(body.data).toEqual({ created: 2, skipped: 0 });

    // Leave the shared community org as we found it.
    const listed = await apiJson<{ id: string; display_name: string }[]>(
      request,
      "/api/v1/officials",
    );
    for (const o of listed.data ?? []) {
      if (o.display_name.startsWith(`Cap Ref ${TAG}u `)) {
        await apiJson(request, `/api/v1/officials/${o.id}`, "DELETE");
      }
    }
  });
});
