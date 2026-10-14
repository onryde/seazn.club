// A stale public page is served for at most 5 minutes (owner ruling
// 2026-10-14). Next's `expireTime` bounds it: the header Next composes for an
// ISR page is `s-maxage=<revalidate>, stale-while-revalidate=<expire −
// revalidate>`, so the page's whole public life — fresh plus stale — is
// `expireTime`. The expected values come from the ruling (5 minutes) and the
// public pages' own 30 s, not from the config under test.
import { describe, expect, it } from "vitest";
import { getCacheControlHeader } from "next/dist/server/lib/cache-control";
import { defaultConfig } from "next/dist/server/config-shared";
// next.config.js is wrapped in withSentryConfig for the default export; the
// pre-wrap object is re-exported by name (see image-config.test.ts).
import { nextConfig } from "../../../next.config.js";

/** Owner ruling 2026-10-14: stale public pages are capped at 5 minutes. */
const OWNER_STALE_CAP_SECONDS = 5 * 60;
/** A public competition / division / fixture page's `revalidate` (doc 09 §3). */
const PUBLIC_PAGE_REVALIDATE_SECONDS = 30;

describe("public pages are never served more than 5 minutes stale", () => {
  const expire = (nextConfig as { expireTime?: number }).expireTime;

  it("expireTime is the owner's 5 minutes, not Next's one-year default", () => {
    expect(defaultConfig.expireTime, "premise: Next's default is a year").toBe(365 * 24 * 60 * 60);
    expect(expire).toBe(OWNER_STALE_CAP_SECONDS);
  });

  it("a found 30 s public page sends s-maxage=30 and at most 270 s of stale-while-revalidate", () => {
    expect(getCacheControlHeader({ revalidate: PUBLIC_PAGE_REVALIDATE_SECONDS, expire })).toBe(
      `s-maxage=${PUBLIC_PAGE_REVALIDATE_SECONDS}, stale-while-revalidate=${OWNER_STALE_CAP_SECONDS - PUBLIC_PAGE_REVALIDATE_SECONDS}`,
    );
    expect(OWNER_STALE_CAP_SECONDS - PUBLIC_PAGE_REVALIDATE_SECONDS, "premise: the ruling's arithmetic").toBe(270);
  });
});
