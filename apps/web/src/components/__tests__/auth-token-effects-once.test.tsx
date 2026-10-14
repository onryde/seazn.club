// `MagicLink` and `VerifyEmail` each consume a ONE-TIME token in a mount
// effect. `react-hooks/exhaustive-deps` asked for `msg` in that effect's deps,
// and `msg`'s identity follows the DictProvider's `dict` prop — so with it
// listed, the effect re-runs whenever the copy catalog object changes. That is
// only safe because of the `ran` ref guard each effect opens with: a second
// run must be a no-op, or the second POST spends a token the first already
// consumed and the page shows "link expired" over a sign-in that worked.
//
// No true red exists for this (the guard predates the dep); it is pinned by
// mutation instead: delete the `if (ran.current) return;` line and the
// "consumed once" assertions fail with 2 calls.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { MagicLink } from "@/components/magic-link";
import { VerifyEmail } from "@/components/verify-email";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "es",
  posts: [] as string[],
  router: { push: () => {}, refresh: () => {} },
}));

vi.mock("next/navigation", () => ({ useRouter: () => h.router }));

vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: vi.fn(async (url: string) => {
    h.posts.push(url);
    return { redirect: "/dashboard" };
  }),
}));

// A copy catalog per locale, each a STABLE function — the way `useMsg` hands
// back one identity per `dict`. Switching `h.locale` is the catalog changing.
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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe.each([
  ["MagicLink", MagicLink, "/api/auth/magic-link/consume"],
  ["VerifyEmail", VerifyEmail, "/api/auth/verify-email"],
] as const)("%s — the one-time token is consumed once", (_name, Component, endpoint) => {
  beforeEach(() => {
    h.locale = "en";
    h.posts.length = 0;
  });

  it("a copy-catalog change after mount never sends a second POST", async () => {
    const island = renderIsland(Component, { token: "tok-1", next: null });
    await flush();
    expect(h.posts).toEqual([endpoint]);

    h.locale = "es";
    island.rerender({ token: "tok-1", next: null });
    await flush();
    island.rerender({ token: "tok-1", next: null });
    await flush();

    expect(h.posts).toEqual([endpoint]);
  });

  it("empty case: no token posts nothing, before or after a catalog change", async () => {
    const island = renderIsland(Component, { token: null, next: null });
    await flush();
    h.locale = "es";
    island.rerender({ token: null, next: null });
    await flush();

    expect(h.posts).toEqual([]);
  });
});
