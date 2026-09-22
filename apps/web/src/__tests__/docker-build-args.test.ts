import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `fly.toml` / `fly.stg.toml` [build.args] reach `next build` only through the
 * root Dockerfile, and Docker silently DROPS any --build-arg the Dockerfile
 * never declares with `ARG`. For a NEXT_PUBLIC_* var that means the value is
 * never inlined into the client bundle — no build error, no server symptom.
 *
 * Shipped once: NEXT_PUBLIC_POSTHOG_KEY/HOST sat in both fly configs but not in
 * the Dockerfile, so `posthog.init` never ran in any browser (zero pageviews,
 * zero replays) and the /ingest rewrite fell back to the US region against an
 * EU project. Server-side capture kept working off the runtime env, which is
 * what hid it.
 */
const REPO_ROOT = join(__dirname, "../../../..");

function buildArgKeys(file: string): string[] {
  const toml = readFileSync(join(REPO_ROOT, file), "utf8");
  const section = toml.split(/^\s*\[build\.args\]\s*$/m)[1] ?? "";
  const body = section.split(/^\s*\[/m)[0] ?? "";
  return [...body.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]!);
}

const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
const declaredArgs = new Set(
  [...dockerfile.matchAll(/^\s*ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]!),
);
const declaredEnv = new Set(
  [...dockerfile.matchAll(/^\s*ENV\s+([A-Z0-9_]+)=\$\1\b/gm)].map((m) => m[1]!),
);

describe.each(["fly.toml", "fly.stg.toml"])("%s [build.args] reach the build", (file) => {
  const keys = buildArgKeys(file);

  it("has build args to check", () => {
    expect(keys).toContain("NEXT_PUBLIC_POSTHOG_KEY");
  });

  it("every build arg is declared as an ARG in the Dockerfile", () => {
    expect(keys.filter((k) => !declaredArgs.has(k))).toEqual([]);
  });

  it("every NEXT_PUBLIC_* build arg is exported as ENV for next build", () => {
    const pub = keys.filter((k) => k.startsWith("NEXT_PUBLIC_"));
    expect(pub.filter((k) => !declaredEnv.has(k))).toEqual([]);
  });
});
