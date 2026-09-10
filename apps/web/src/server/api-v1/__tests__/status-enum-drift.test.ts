// The org news feed and the division suspension list both took an optional
// `?status=` and both got it wrong in the same way:
//
//     const status = raw && STATUSES.has(raw) ? (raw as PostStatus) : undefined;
//
// against a hand-copied `new Set([...])`. Two failures in one line. A typo
// (`?status=publish`) fell through to `undefined` and returned EVERY row while
// the caller believed the filter had applied — drafts served as published,
// waived suspensions served as pending. And the accepted values were written
// out three times: the route's Set, the OpenAPI query enum, and the zod enum
// in schemas.ts that neither of them used.
//
// `/divisions/{id}/registrations` had already been through this (RS005 W1b:
// a hand-copied five-value array missing `expired`/`rejected`, so a legal
// status 400d) and is now derived. These two routes were missed by that pass.
// This file is that route test's "no fourth hand-copy" guard, for the two
// enums it did not cover.
import { describe, expect, it } from "vitest";
import { PostStatus, SuspensionStatus } from "@/server/api-v1/schemas";
import { ROUTES } from "@/server/api-v1/openapi";

function queryEnum(path: string, param: string): readonly string[] | undefined {
  const route = ROUTES.find((r) => r.path === path && r.method === "get");
  expect(route, `${path} GET is missing from ROUTES`).toBeDefined();
  const query = route!.query as
    | Record<string, { schema: { enum?: readonly string[] } }>
    | undefined;
  return query?.[param]?.schema.enum;
}

describe("status query enums derive from one source", () => {
  it("GET /orgs/{id}/posts publishes exactly PostStatus.options", () => {
    expect(queryEnum("/orgs/{id}/posts", "status")).toEqual(PostStatus.options);
  });

  it("GET /divisions/{id}/suspensions publishes exactly SuspensionStatus.options", () => {
    expect(queryEnum("/divisions/{id}/suspensions", "status")).toEqual(SuspensionStatus.options);
  });

  // Order is part of the contract, not an accident: `toEqual` on an array is
  // ordered, so a re-ordered hand-copy reds here rather than shipping a spec
  // whose enum ordering drifts from the schema's.
  it("the published order matches the schema's, not merely the membership", () => {
    expect(queryEnum("/orgs/{id}/posts", "status")).toEqual(["draft", "published", "archived"]);
    expect(queryEnum("/divisions/{id}/suspensions", "status")).toEqual([
      "pending",
      "active",
      "served",
      "waived",
    ]);
  });

  // The values these routes accept must be the values the usecases can return.
  // If a new post status lands in the DB CHECK and the zod enum but the route
  // still carried its own Set, a legal `?status=` would 400 — which is exactly
  // how RS005 W1b's defect presented.
  it("both enums are non-empty and free of duplicates", () => {
    for (const [name, options] of [
      ["PostStatus", PostStatus.options],
      ["SuspensionStatus", SuspensionStatus.options],
    ] as const) {
      expect(options.length, name).toBeGreaterThan(0);
      expect(new Set(options).size, name).toBe(options.length);
    }
  });
});
