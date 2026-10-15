// MagicLink / VerifyEmail / FunnelClaim with NO token (ESLint L3). The
// "missing token" error used to be set from the mount effect, so the server
// markup — and the first paint — said "Signing you in… / Creating your
// competition…" for a link that could never work, and the copy was frozen in
// the locale of the mount. It is now derived in render from the prop.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "es", posts: [] as string[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: vi.fn(async (url: string) => {
    h.posts.push(url);
    return { redirect: "/dashboard" };
  }),
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { msgFor } = await import("@/lib/messages-i18n");
  type Key = Parameters<typeof msgFor>[1];
  const bound = {
    en: (k: Key, v?: Record<string, string | number>) => msgFor("en", k, v),
    es: (k: Key, v?: Record<string, string | number>) => msgFor("es", k, v),
  };
  return { ...actual, useMsg: () => bound[h.locale] };
});

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { MagicLink } from "../magic-link";
import { VerifyEmail } from "../verify-email";
import { FunnelClaim } from "../funnel-claim";
import { msgFor } from "@/lib/messages-i18n";

beforeEach(() => {
  h.locale = "en";
  h.posts.length = 0;
});

describe.each([
  ["MagicLink", MagicLink, "magicLink"],
  ["VerifyEmail", VerifyEmail, "verifyEmail"],
] as const)("%s without a token", (_name, Component, ns) => {
  const missing = (l: "en" | "es") => msgFor(l, `${ns}.missingToken`);
  const working = (l: "en" | "es") => msgFor(l, ns === "magicLink" ? "magicLink.signingIn" : "verifyEmail.verifying");

  it("the server markup already states the error — no 'working' frame", () => {
    expect(missing("en"), "anti-vacuity: a real sentence").toMatch(/\w{3}/);
    const html = renderToStaticMarkup(<Component token={null} next={null} />);
    expect(html).toContain(missing("en"));
    expect(html).not.toContain(working("en"));
  });

  it("follows a locale change after mount, and still posts nothing", () => {
    expect(missing("es")).not.toBe(missing("en"));
    const island = renderIsland(Component, { token: null, next: null });
    h.locale = "es";
    island.rerender({ token: null, next: null });
    expect(island.text()).toContain(missing("es"));
    expect(h.posts).toEqual([]);
  });

  it("the positive pair: WITH a token the first render is the working state", () => {
    const html = renderToStaticMarkup(<Component token="tok" next={null} />);
    expect(html).toContain(working("en"));
    expect(html).not.toContain(missing("en"));
  });
});

describe("FunnelClaim without a token", () => {
  it("the server markup already states the error; with a token it is the working state", () => {
    expect(renderToStaticMarkup(<FunnelClaim token={null} />)).toContain("Missing setup token.");
    const working = renderToStaticMarkup(<FunnelClaim token="tok" />);
    expect(working).toContain("Creating your competition");
    expect(working).not.toContain("Missing setup token.");
  });
});
