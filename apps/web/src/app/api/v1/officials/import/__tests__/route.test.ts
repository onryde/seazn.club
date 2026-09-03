// W2 T19 — the route, not the usecase.
//
// `importOfficials` now consults `import.bulk`, and its own suite pins the
// boundary. This file exists because a usecase call cannot show that the
// refusal SURVIVES the route: that `v1()` maps `PaymentRequiredError` to a
// 402 rather than a 500, and that the envelope a client actually parses
// carries `feature_key` plus the cap-quoting sentence. Those live in
// `server/api-v1/http.ts`, not in the usecase, and nothing else here reaches
// them for this route.
//
// Real handler over a real (community) org; only the session door is faked,
// the same pattern as officials/[id]/availability/__tests__/route.test.ts.
// The expected cap is read from `plan_entitlements` — never typed.
import { afterAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { bulkImportRowsReason } from "@/lib/feature-copy";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { listOfficials } from "@/server/usecases/officials";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope {
  ok: boolean;
  data?: { created: number; skipped: number };
  error?: {
    code: string;
    message: string;
    feature?: string;
    feature_key?: string;
    reason?: string;
    limit?: number;
  };
}

async function communityRowCap(): Promise<number> {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = 'community' and feature_key = 'import.bulk'`;
  if (row?.int_value == null) throw new Error("no finite community import.bulk cap");
  return row.int_value;
}

function importReq(rows: number, tag: string): Request {
  const lines = ["Name,Roles,MaxPerDay"];
  for (let i = 0; i < rows; i++) lines.push(`Route Ref ${tag} ${i},referee,`);
  const form = new FormData();
  form.append("file", new Blob([lines.join("\n")], { type: "text/csv" }), "officials.csv");
  return new Request("https://test.local/api/v1/officials/import", {
    method: "POST",
    body: form,
  });
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  await globalForDb._sql?.end();
});

describe.skipIf(!HAS_DB)("POST /api/v1/officials/import — the import.bulk refusal", () => {
  it("one row over the free cap is a 402 whose envelope quotes the live cap", async () => {
    const cap = await communityRowCap();
    // Anti-vacuity: the sentence below quotes this number, and the stale copy
    // this wave removed said 20.
    expect(cap).not.toBe(20);

    const { auth } = await seedOrg("community");
    authState.userId = auth.userId!;

    const { status, body } = await read(await POST(importReq(cap + 1, "over")));

    expect(status).toBe(402);
    expect(body.error?.code).toBe("PAYMENT_REQUIRED");
    expect(body.error?.feature_key).toBe("import.bulk");
    expect(body.error?.limit).toBe(cap);
    // `extra` is spread AFTER the key-only `reason` in this envelope, which is
    // the whole reason the cap-quoting sentence survives the route.
    expect(body.error?.reason).toBe(bulkImportRowsReason(cap));
    expect(body.error?.reason).toContain(`over ${cap} rows`);

    // Refused before the transaction — the route wrote nothing.
    expect(await listOfficials(auth)).toEqual([]);
  });

  it("a file under the cap still returns 201 — the gate refuses, it does not close the route", async () => {
    const { auth } = await seedOrg("community");
    authState.userId = auth.userId!;

    const { status, body } = await read(await POST(importReq(2, "under")));
    expect(status).toBe(201);
    expect(body.data).toEqual({ created: 2, skipped: 0 });
    expect((await listOfficials(auth)).length).toBe(2);
  });
});
