import { afterEach, describe, expect, it, vi } from "vitest";
import { cspHeader } from "../proxy";

const connectSrc = () =>
  cspHeader("n").value.split("; ").find((d) => d.startsWith("connect-src "))!;

afterEach(() => vi.unstubAllEnvs());

describe("CSP connect-src for PostHog", () => {
  it("allows the first-party proxy origin when NEXT_PUBLIC_POSTHOG_API_HOST is set", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "https://g.example.test/");
    expect(connectSrc().split(" ")).toContain("https://g.example.test");
  });

  it("adds nothing when events ride the same-origin /ingest rewrite", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "");
    expect(connectSrc()).not.toContain("g.example.test");
    expect(connectSrc().endsWith("https://*.sentry.io")).toBe(true);
  });

  it("ignores a non-https value rather than widening the policy", () => {
    // Parseable, so only the https check (not new URL) can reject it.
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "http://g.example.test");
    expect(connectSrc()).not.toContain("g.example.test");
  });
});
