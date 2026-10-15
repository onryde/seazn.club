// Route→scope allowlist (v3/08 §2). Two guarantees under test:
//  1. default-deny — an unlisted (method, path) is null, whatever the scope;
//  2. total classification — every route file under app/api/v1 is either in
//     the allowlist, the never-key list, or the public surface, so a new
//     route cannot ship without declaring what keys may do to it.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEY_ROUTE_RULES,
  NEVER_KEY_ROUTES,
  matchKeyRoute,
  scopeSatisfies,
  keyRank,
  v1Path,
} from "../key-scopes";
import { addressedKind } from "./_key-route-addressing";

describe("scope ranking", () => {
  it("read < score < manage, legacy write ⇒ manage", () => {
    expect(scopeSatisfies(["read"], "read")).toBe(true);
    expect(scopeSatisfies(["read"], "score")).toBe(false);
    expect(scopeSatisfies(["read"], "manage")).toBe(false);
    expect(scopeSatisfies(["score"], "read")).toBe(true);
    expect(scopeSatisfies(["score"], "manage")).toBe(false);
    expect(scopeSatisfies(["manage"], "score")).toBe(true);
    expect(scopeSatisfies(["write"], "manage")).toBe(true); // legacy
    expect(keyRank(["bogus"])).toBe(0);
  });
});

describe("matchKeyRoute", () => {
  it("default-denies a route that is not in the map", () => {
    // A plausible-looking future route — MUST stay null until declared.
    expect(matchKeyRoute("POST", "/api/v1/divisions/abc/frobnicate")).toBeNull();
    expect(matchKeyRoute("DELETE", "/api/v1/fixtures/abc")).toBeNull(); // method not offered
  });

  it("denies the structurally excluded surfaces", () => {
    expect(matchKeyRoute("POST", "/api/v1/orgs/o1/api-keys")).toBeNull();
    expect(matchKeyRoute("POST", "/api/v1/registrations/r1/refund")).toBeNull();
    expect(matchKeyRoute("POST", "/api/v1/fixtures/f1/device-links")).toBeNull();
    expect(matchKeyRoute("PATCH", "/api/v1/me/fixtures/f1/officiating-response")).toBeNull();
    expect(matchKeyRoute("POST", "/api/v1/orgs/o1/connect")).toBeNull();
    // Competition delete cascades registrations/passes (money records) —
    // barred from keys (payments-hardening P0-1); console has no button either.
    expect(matchKeyRoute("DELETE", "/api/v1/competitions/c1")).toBeNull();
    expect(NEVER_KEY_ROUTES).toContain("DELETE /competitions/:id");
  });

  it("capture QR v2 (T8a, A16): the phone's descriptor is never key-reachable — an explicit ban, matched on a concrete path", () => {
    expect(NEVER_KEY_ROUTES).toContain("GET /capture/codes/:code");
    expect(matchKeyRoute("GET", "/api/v1/capture/codes/0123456789ab")).toBeNull();
  });

  it("capture QR v2 (T8b, A16): the phone's beats are never key-reachable — an explicit ban, matched on a concrete path", () => {
    expect(NEVER_KEY_ROUTES).toContain("POST /capture/codes/:code/beats");
    expect(matchKeyRoute("POST", "/api/v1/capture/codes/0123456789ab/beats")).toBeNull();
  });

  it("the match-room routes and every shipped external-play route are explicit NEVER_KEY_ROUTES entries (a player's seat and a Lichess token, never a key)", () => {
    const entries = [
      "GET /fixtures/:id/external-play/room",
      "POST /fixtures/:id/external-play/room",
      "POST /fixtures/:id/external-play/room/act",
      "POST /fixtures/:id/external-play/room/clock-zero",
      "POST /fixtures/:id/external-play/room/camera-fault",
      // D21-fix-3: an optional camera's token, asked for again.
      "POST /fixtures/:id/external-play/room/camera",
      // F2: shipped before T14 and classified nowhere. T16: the lobby is a GET
      // only (its POST is deleted — check-in is the room's).
      "GET /fixtures/:id/external-play/lobby",
      "POST /fixtures/:id/external-play/resend",
      "POST /fixtures/:id/external-play/resolve",
      // T16: "Let the game go on".
      "POST /fixtures/:id/external-play/flags/close",
      // Spec 2026-10-09 §3.2.2: "+5 min" on one board's check-in, and on a whole round's. The audit row names the user.
      "POST /fixtures/:id/external-play/extend-checkin",
      "POST /stages/:id/extend-checkin",
    ];
    let checked = 0;
    for (const e of entries) {
      expect(NEVER_KEY_ROUTES, e).toContain(e);
      const [method, path] = e.split(" ") as [string, string];
      expect(matchKeyRoute(method, `/api/v1${path.replace(/:id/g, "seg")}`), e).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: external-play routes checked").toBe(12);
  });

  it("capture QR v2 (T8c, A16; W27): the phone's start and its scoring link are never key-reachable — and an org API key on EACH of the four phone routes finds no key rule", () => {
    expect(NEVER_KEY_ROUTES).toContain("POST /capture/codes/:code/start");
    expect(NEVER_KEY_ROUTES).toContain("POST /capture/codes/:code/scoring-link");
    const phoneRoutes: [string, string][] = [
      ["GET", "/capture/codes/:code"],
      ["POST", "/capture/codes/:code/beats"],
      ["POST", "/capture/codes/:code/start"],
      ["POST", "/capture/codes/:code/scoring-link"],
    ];
    let checked = 0;
    for (const [method, path] of phoneRoutes) {
      expect(NEVER_KEY_ROUTES, `${method} ${path}`).toContain(`${method} ${path}`);
      expect(matchKeyRoute(method, `/api/v1${path.replace(":code", "0123456789ab")}`), `${method} ${path}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("maps the scoring doors to the score scope with a pin", () => {
    const events = matchKeyRoute("POST", "/api/v1/fixtures/11111111-1111-1111-1111-111111111111/events");
    expect(events).toMatchObject({ scope: "score", pin: "fixture" });
    expect(events?.resourceId).toBe("11111111-1111-1111-1111-111111111111");
    const start = matchKeyRoute("POST", "/api/v1/divisions/d1/start");
    expect(start).toMatchObject({ scope: "score", pin: "division", resourceId: "d1" });
  });

  it("keeps reads at read and mutations at manage", () => {
    expect(matchKeyRoute("GET", "/api/v1/competitions")?.scope).toBe("read");
    expect(matchKeyRoute("POST", "/api/v1/competitions")?.scope).toBe("manage");
    expect(matchKeyRoute("POST", "/api/v1/format-preview")?.scope).toBe("read"); // pure compute
    expect(matchKeyRoute("POST", "/api/v1/stages/s1/generate")?.scope).toBe("manage");
  });

  it("GET /fixtures/:id/rules is a read pinned to its fixture - the same match as GET /fixtures/:id/state (and its PUT stays a manage)", () => {
    const id = "3f2b1c9e-0d4a-4b7e-9a51-6c8d2e7f1a30";
    const rules = matchKeyRoute("GET", `/api/v1/fixtures/${id}/rules`);
    expect(rules).toEqual({ scope: "read", pin: "fixture", resourceId: id });
    expect(rules, "the same door as the scoreboard's state read").toEqual(matchKeyRoute("GET", `/api/v1/fixtures/${id}/state`));
    // The write at the same path keeps its own scope: the read row did not widen it.
    expect(matchKeyRoute("PUT", `/api/v1/fixtures/${id}/rules`)).toEqual({ scope: "manage", pin: "fixture", resourceId: id });
  });

  it("accepts full URLs and bare paths", () => {
    expect(v1Path("https://seazn.club/api/v1/teams")).toBe("/teams");
    expect(matchKeyRoute("GET", "https://seazn.club/api/v1/teams")?.scope).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// Pin kinds. auth.ts resolves a pinned key's competition by looking the row's
// resourceId up in the table its `pin` names. A row that declares the WRONG
// kind misses on every lookup: before 2026-10-23 a miss fell through and a key
// pinned to competition A reached competition B; auth.ts now fails closed, so
// the same row locks pinned keys out of the route instead. Either way the
// declaration is wrong, and this refuses it. The expected kind is read off the
// URL (addressedKind), never off the row. The null branch is pinned DB-free in
// api-key-pin-fail-closed.test.ts; real rows in usecases/__tests__/api-key-pin-sweep.test.ts.
// ---------------------------------------------------------------------------

describe("every pinned row's pin kind is the kind its URL addresses", () => {
  it("pin === the collection that owns the resourceId slot, for EVERY pinned row", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const rule of KEY_ROUTE_RULES) {
      if (!rule.pin) continue;
      const { kind } = addressedKind(rule.method, rule.path);
      if (kind !== rule.pin) {
        wrong.push(`${rule.method} ${rule.path}: declares pin '${rule.pin}' but its id is a ${kind} id`);
      }
      checked += 1;
    }
    expect(wrong, `pinned rows whose lookup misses on every request:\n${wrong.join("\n")}`).toEqual([]);
    expect(checked, "anti-vacuity: pinned rows checked").toBeGreaterThan(0);
  });

  it("reads the id's OWNER, not the last collection in the path", () => {
    // The right answer differs from the wrong one here: a guard that read the
    // last collection would say `lineup` / `checkpoint`.
    expect(addressedKind("GET", "/fixtures/:id/lineups/:entrantId")).toEqual({ kind: "fixture", idSegment: 2 });
    expect(addressedKind("DELETE", "/divisions/:id/checkpoints/:checkpointId")).toEqual({
      kind: "division",
      idSegment: 2,
    });
  });

  it("refuses — never skips — a row it cannot read", () => {
    expect(() => addressedKind("GET", "/clubs/:id")).toThrow(/no resourceId/); // unpinned
    expect(() => addressedKind("POST", "/divisions/:id/frobnicate")).toThrow(/does not match its own template/);
  });
});

// ---------------------------------------------------------------------------
// Total classification: enumerate app/api/v1/**/route.ts and their exported
// methods; every (method, route) must be allowlisted, never-listed or public.
// ---------------------------------------------------------------------------

const V1_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "app", "api", "v1",
);

function routeFiles(dir: string, prefix = ""): { path: string; file: string }[] {
  const out: { path: string; file: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...routeFiles(join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name === "route.ts") {
      out.push({ path: prefix || "/", file: join(dir, entry.name) });
    }
  }
  return out;
}

/** `[divisionSlug]` → `:x` — same shape the rules use. */
function templatePath(fsPath: string): string {
  return fsPath.replace(/\[[^\]]+\]/g, ":x");
}

function exportedMethods(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/export (?:async )?function (GET|POST|PATCH|PUT|DELETE)/g)].map(
    (m) => m[1]!,
  );
}

function ruleMatches(method: string, path: string): boolean {
  return matchKeyRoute(method, `/api/v1${path}`) !== null;
}

const NEVER = new Set(
  NEVER_KEY_ROUTES.map((r) => {
    const [m, p] = r.split(" ") as [string, string];
    return `${m} ${p.replace(/:[^/]+/g, ":x")}`;
  }),
);

describe("every v1 route is consciously classified for keys", () => {
  const files = routeFiles(V1_DIR);
  it("found the v1 route tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { path, file } of files) {
    const template = templatePath(path);
    const isPublic = template.startsWith("/public/") || template === "/openapi.json";
    for (const method of exportedMethods(file)) {
      it(`${method} ${template}`, () => {
        if (isPublic) return; // no auth surface at all
        const allowlisted = ruleMatches(method, template.replace(/:x/g, "seg"));
        const neverListed = NEVER.has(`${method} ${template}`);
        expect(
          allowlisted || neverListed,
          `${method} ${path} is neither allowlisted in KEY_ROUTE_RULES nor in NEVER_KEY_ROUTES — declare a scope (or exclusion) in key-scopes.ts`,
        ).toBe(true);
        expect(allowlisted && neverListed).toBe(false); // not both
      });
    }
  }

  it("rules do not point at files that no longer exist", () => {
    const templates = new Set(files.map((f) => templatePath(f.path)));
    for (const rule of KEY_ROUTE_RULES) {
      const t = rule.path.replace(/:[^/]+/g, ":x");
      expect(templates.has(t), `rule ${rule.method} ${rule.path} has no route file`).toBe(true);
    }
  });
});
