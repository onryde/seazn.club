// Browser Sentry (src/instrumentation-client.ts, owner decision 2026-10-19) posts its envelopes straight to the DSN's ingest host
// (no `tunnelRoute` is configured, so there is no same-origin hop), which is a cross-origin fetch the page's CSP `connect-src`
// governs. CSP is Report-Only today (CSP_MODE is unset in fly.toml and fly.stg.toml) and would block it the day it is enforced
// unless the policy admits the host. The hosts are read from the DEPLOY CONFIGS that ship the DSN, not typed here: both DSNs are
// on the EU region (`o<org>.ingest.de.sentry.io`), which `*.ingest.sentry.io` does NOT match (`.de.` sits between the labels), so
// it is `https://*.sentry.io` that admits them, and tightening that entry is what this test would catch.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cspHeader } from "../proxy";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const connectSrc = (): string[] => cspHeader("n").value.split("; ").find((d) => d.startsWith("connect-src "))!.split(" ").slice(1);

/** CSP host-source matching (CSP3 §6.7.2.6), enough for scheme + host: `scheme://host`, with a leading `*.` matching any
 *  subdomain, at any depth. */
function allows(sources: string[], url: string): boolean {
  const u = new URL(url);
  return sources.some((src) => {
    const m = /^([a-z]+):\/\/(\*\.)?([^/:]+)$/.exec(src);
    if (!m || `${m[1]}:` !== u.protocol) return false;
    return m[2] ? u.hostname.endsWith(`.${m[3]}`) : u.hostname === m[3];
  });
}

/** The ingest URL a DSN posts to (`https://<key>@<host>/<project>` -> `https://<host>/api/<project>/envelope/`). */
function envelopeUrl(dsn: string): string {
  const u = new URL(dsn);
  return `${u.protocol}//${u.host}/api/${u.pathname.replace(/^\//, "")}/envelope/`;
}

/** Every uncommented `NEXT_PUBLIC_SENTRY_DSN = "<dsn>"` a deploy config ships. */
function shippedDsns(file: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  return [...text.matchAll(/^[ \t]*NEXT_PUBLIC_SENTRY_DSN[ \t]*=[ \t]*"([^"]+)"/gm)].map((m) => m[1]!);
}

describe("CSP connect-src for browser Sentry", () => {
  it("admits the ingest host of every DSN the deploy configs ship", () => {
    const shipped = ["fly.toml", "fly.stg.toml"].flatMap((file) => shippedDsns(file).map((dsn) => ({ file, dsn })));
    expect(shipped.map((s) => s.file), "anti-vacuity: both deploy configs ship a DSN").toEqual(["fly.toml", "fly.stg.toml"]);
    for (const { file, dsn } of shipped) {
      const url = envelopeUrl(dsn);
      expect(url, `${file}: premise, the ingest host is the EU region`).toMatch(/^https:\/\/o\d+\.ingest\.de\.sentry\.io\/api\/\d+\/envelope\/$/);
      expect(allows(connectSrc(), url), `${file}: ${url}`).toBe(true);
    }
  });

  it("is admitted by `*.sentry.io` alone, not by `*.ingest.sentry.io` (the matcher sees the difference, so the test can go red)", () => {
    const url = "https://o1.ingest.de.sentry.io/api/2/envelope/";
    expect(allows(["https://*.ingest.sentry.io"], url)).toBe(false);
    expect(allows(["https://*.sentry.io"], url)).toBe(true);
    expect(allows(connectSrc().filter((s) => s !== "https://*.sentry.io"), url), "the policy depends on the `*.sentry.io` entry").toBe(false);
    // The ordinary US-region shape is admitted either way, and an unrelated host is not.
    expect(allows(connectSrc(), "https://o1.ingest.sentry.io/api/2/envelope/")).toBe(true);
    expect(allows(connectSrc(), "https://sentry.io.evil.test/api/2/envelope/")).toBe(false);
  });
});
