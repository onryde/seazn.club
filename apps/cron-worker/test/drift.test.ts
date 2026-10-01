import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { JOBS, triggersOf } from "../src/schedule";

const REPO = join(__dirname, "../../..");
const WEB_API = join(REPO, "apps/web/src/app/api");
/** x-cron-secret routes that no clock fires. Each entry is deliberate, and must still exist (a stale one reds). */
const NOT_SCHEDULED: Record<string, string> = {
  "/api/internal/revalidate": "event-driven peer cache revalidation between app instances; the app calls it, never a clock",
};

const routeFiles = (readdirSync(WEB_API, { recursive: true }) as string[]).filter(
  (f) => f === "route.ts" || f.endsWith(`${sep}route.ts`),
);
const toPath = (f: string) => `/api/${dirname(f).split(sep).join("/")}`;
// By BEHAVIOUR (m3, AGENTS.md class 16): a route that reads x-cron-secret is cron-shaped wherever it lives...
const secretRoutes = routeFiles
  .filter((f) => readFileSync(join(WEB_API, f), "utf8").includes("x-cron-secret"))
  .map(toPath)
  .sort();
// ...and by PLACE: anything under /api/cron is cron-shaped, however it spells its auth.
const cronDirRoutes = routeFiles.map(toPath).filter((p) => p.startsWith("/api/cron/")).sort();

describe("schedule ↔ routes drift guard", () => {
  it("the scans read the tree (anti-vacuity; floors measured 2026-10-01)", () => {
    expect(routeFiles.length, "route files scanned").toBeGreaterThanOrEqual(300); // 306 measured
    expect(secretRoutes.length, "x-cron-secret routes").toBeGreaterThanOrEqual(9); // 8 scheduled + revalidate
    expect(cronDirRoutes.length, "/api/cron routes").toBeGreaterThanOrEqual(7); // relay-sweep included (A4)
  });

  it("every cron-shaped route has exactly one schedule row, and every row a route", () => {
    const shaped = [...new Set([...secretRoutes, ...cronDirRoutes])].filter((p) => !(p in NOT_SCHEDULED)).sort();
    expect(JOBS.map((j) => j.path).sort()).toEqual(shaped);
  });

  it("every exemption is still a real x-cron-secret route", () => {
    expect(Object.keys(NOT_SCHEDULED).length, "exemptions checked").toBeGreaterThan(0);
    for (const p of Object.keys(NOT_SCHEDULED)) expect(secretRoutes, p).toContain(p);
  });

  it("every scheduled path resolves to a real route file", () => {
    for (const j of JOBS) expect(existsSync(join(WEB_API, j.path.replace(/^\/api\//, ""), "route.ts")), j.path).toBe(true);
  });
});

describe("R3 failure counters ↔ the usecases' return types", () => {
  const WEB_SRC = join(REPO, "apps/web/src");
  /** The source text of every module a route imports through the `@/` alias. */
  const importedSource = (routePath: string) => {
    const route = readFileSync(join(WEB_API, routePath.replace(/^\/api\//, ""), "route.ts"), "utf8");
    const specs = [...route.matchAll(/from "@\/([^"]+)"/g)].map((m) => m[1]!);
    return specs.map((s) => [`${s}.ts`, `${s}/index.ts`].map((f) => join(WEB_SRC, f)).find(existsSync)).filter((f): f is string => !!f).map((f) => readFileSync(f, "utf8")).join("\n");
  };

  it("every counter's field is declared as a number in a module its route imports (a renamed field cannot read as healthy)", () => {
    let checked = 0;
    for (const j of JOBS) {
      if (!j.failureCounts) continue;
      const src = importedSource(j.path);
      expect(src.length, `${j.id}: imported modules found`).toBeGreaterThan(0);
      for (const path of j.failureCounts) {
        const leaf = path.split(".").at(-1)!;
        expect(new RegExp(`\\b${leaf}\\s*:\\s*number\\b`).test(src), `${j.id}: ${path} → a "${leaf}: number" field`).toBe(true);
        checked++;
      }
    }
    expect(checked, "counters checked").toBe(6);
  });
});

describe("wrangler.json ↔ schedule drift guard", () => {
  const cfg = JSON.parse(readFileSync(join(__dirname, "../wrangler.json"), "utf8"));

  it.each(["stg", "prod"])("%s registers exactly the triggers the table uses (R4)", (env) => {
    expect([...cfg.env[env].triggers.crons].sort()).toEqual(triggersOf().sort());
  });

  // Owner 2026-10-01: ACTIVE is "true" by default in both envs, and stays the kill switch ("false" runs no job).
  it.each(["stg", "prod"])("%s declares ENV_NAME, BASE_URL and ACTIVE=true", (env) => {
    const vars = cfg.env[env].vars;
    expect(vars.ENV_NAME).toBe(env);
    expect(vars.BASE_URL).toMatch(/^https:\/\//);
    expect(vars.ACTIVE).toBe("true");
  });

  it("the top-level (env-less) Worker has no trigger, so a bare `wrangler deploy` schedules nothing", () => {
    expect(cfg.triggers).toBeUndefined();
  });
});

describe("repo wiring", () => {
  it("A2: the Fly image's build context excludes this workspace", () => {
    // ci.yml's container job runs `turbo run typecheck` inside the builder image,
    // which never installs this workspace's devDependencies.
    const lines = readFileSync(join(REPO, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("apps/cron-worker");
  });
});
