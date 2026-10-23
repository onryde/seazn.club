// A pinned API key FAILS CLOSED: when the addressed resource resolves to no
// competition — a missing id, a malformed one, a row declaring the wrong pin
// kind, a resolver join that finds nothing — the key is refused exactly as it
// is for a foreign competition. Fail-open let a key pinned to competition A
// reach competition B through any lookup that missed.
//
// DB-free on purpose. The real-row proof (usecases/__tests__/api-key-pin-sweep.test.ts)
// skips in a job without Postgres; a revert to fail-open must red there too.
// `@/lib/db` is a scripted fake that answers each query by what it selects.
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  key: null as null | { id: string; org_id: string; scopes: string[]; competition_id: string | null },
  /** What resolvePinCompetition's lookup finds; null = no row. */
  owner: null as string | null,
  /** How many resolver lookups ran — proves the refusal came from the pin. */
  lookups: 0,
}));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (/\bfrom api_keys\b/.test(text)) return Promise.resolve(db.key ? [db.key] : []);
    if (/^\s*select (d\.)?competition_id from/.test(text)) {
      db.lookups += 1;
      return Promise.resolve(db.owner ? [{ competition_id: db.owner }] : []);
    }
    if (/\bfrom subscriptions\b/.test(text)) return Promise.resolve([{ plan_key: "pro" }]);
    return Promise.resolve([]); // the fire-and-forget last_used_at update
  },
}));
vi.mock("@/lib/entitlements", () => ({ requireFeature: async () => undefined }));
vi.mock("@/lib/cache", () => ({ cacheEnabled: () => false, incrWindow: async () => null }));
vi.mock("@/lib/auth", () => ({ getOrgRole: vi.fn(), requireUser: vi.fn(), resolveActiveOrg: vi.fn() }));

import { requireAuth } from "../auth";
import { KEY_ROUTE_RULES } from "../key-scopes";
import { addressedKind } from "./_key-route-addressing";

const PIN_REFUSAL = "This key is pinned to a different competition.";
const ORG = "00000000-0000-4000-8000-0000000000aa";
const COMP_A = "00000000-0000-4000-8000-00000000000a";
const COMP_B = "00000000-0000-4000-8000-00000000000b";
const RESOURCE = "00000000-0000-4000-8000-000000000001";

/** One pinned row per kind whose lookup can MISS (a `competition` pin resolves
 *  to the id itself, so it has no lookup to miss). */
const ROW_PER_KIND = new Map<string, { method: string; path: string; idSegment: number }>();
for (const rule of KEY_ROUTE_RULES) {
  if (!rule.pin || rule.pin === "competition") continue;
  const { kind, idSegment } = addressedKind(rule.method, rule.path);
  if (!ROW_PER_KIND.has(kind)) ROW_PER_KIND.set(kind, { method: rule.method, path: rule.path, idSegment });
}

function keyedAt(row: { method: string; path: string; idSegment: number }, id: string): Request {
  const path = row.path
    .split("/")
    .map((s, i) => (i === row.idSegment ? id : s.startsWith(":") ? RESOURCE : s))
    .join("/");
  return new Request(`https://test.local/api/v1${path}`, {
    method: row.method,
    headers: { authorization: "Bearer sc_unit" },
  });
}

beforeEach(() => {
  db.key = { id: "k1", org_id: ORG, scopes: ["manage"], competition_id: COMP_A };
  db.owner = null;
  db.lookups = 0;
});

describe("a pinned key fails closed when its resource resolves to no competition", () => {
  it("every kind with a lookup: no row ⇒ 403, the same refusal a foreign competition gets", async () => {
    let checked = 0;
    for (const [kind, row] of ROW_PER_KIND) {
      db.owner = null;
      db.lookups = 0;
      await expect(requireAuth(keyedAt(row, RESOURCE), "read"), `${kind}: ${row.method} ${row.path}`).rejects.toMatchObject({
        status: 403,
        message: PIN_REFUSAL,
      });
      expect(db.lookups, `${kind}: the refusal came from the pin's lookup`).toBe(1);
      checked += 1;
    }
    console.info(`api-key-pin-fail-closed — kinds checked: ${checked} (${[...ROW_PER_KIND.keys()].sort().join(",")})`);
    // division, stage, fixture, entrant, registration, pool — every PinKind but competition.
    expect(checked, "anti-vacuity: kinds checked").toBe(6);
  });

  it("a malformed id resolves to nothing and is refused too (no lookup runs)", async () => {
    const row = ROW_PER_KIND.get("pool")!;
    await expect(requireAuth(keyedAt(row, "not-a-uuid"), "read")).rejects.toMatchObject({
      status: 403,
      message: PIN_REFUSAL,
    });
    expect(db.lookups).toBe(0);
  });

  it("the pairs: its own competition passes, a foreign one is refused", async () => {
    const row = ROW_PER_KIND.get("pool")!;
    db.owner = COMP_A;
    const ctx = await requireAuth(keyedAt(row, RESOURCE), "read");
    expect(ctx).toMatchObject({ via: "api_key", orgId: ORG, keyId: "k1" });
    db.owner = COMP_B;
    await expect(requireAuth(keyedAt(row, RESOURCE), "read")).rejects.toMatchObject({
      status: 403,
      message: PIN_REFUSAL,
    });
  });

  it("an unpinned key never asks: no lookup, no refusal", async () => {
    db.key = { id: "k2", org_id: ORG, scopes: ["manage"], competition_id: null };
    const ctx = await requireAuth(keyedAt(ROW_PER_KIND.get("pool")!, RESOURCE), "read");
    expect(ctx.via).toBe("api_key");
    expect(db.lookups).toBe(0);
  });
});
