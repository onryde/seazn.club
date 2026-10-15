// LocaleSwitcher (ESLint L3): the cookie used to be copied into state by an
// effect keyed on the pathname; it is now read through `useSyncExternalStore`
// with the path as the server snapshot. The e2e (`i18n-switcher.spec.ts`) is
// the browser witness; this pins the three states without one — server render,
// after hydration, and after a pick — plus the empty case.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

const h = vi.hoisted(() => ({
  pathname: "/",
  pushed: [] as string[],
  refreshed: 0,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useRouter: () => ({
    push: (to: string) => h.pushed.push(to),
    refresh: () => {
      h.refreshed += 1;
    },
  }),
}));

import { LocaleSwitcher } from "../locale-switcher";

let jar = "";
beforeEach(() => {
  h.pathname = "/";
  h.pushed = [];
  h.refreshed = 0;
  jar = "";
  vi.stubGlobal("document", {
    get cookie() {
      return jar;
    },
    set cookie(v: string) {
      // Enough of a cookie jar for one cookie: keep the name=value pair.
      jar = v.split(";")[0]!;
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const selectOf = (island: { tree: () => ReactElement[] }) =>
  island.tree().find((el) => el.type === "select")!;

describe("LocaleSwitcher", () => {
  it("server render follows the path, never the cookie (the server cannot see it)", () => {
    jar = "seazn_locale=es";
    h.pathname = "/fr/scheduling";
    expect(renderToStaticMarkup(<LocaleSwitcher />)).toMatch(/<option value="fr" selected="">/);
  });

  it("after hydration the cookie wins on an unprefixed route", () => {
    jar = "seazn_locale=es";
    const island = renderIsland(LocaleSwitcher, {}, undefined, { hydrate: true });
    expect(propsOf(selectOf(island)).value).toBe("es");
  });

  it("empty case: no cookie falls back to the path (en on an unprefixed route)", () => {
    const island = renderIsland(LocaleSwitcher, {}, undefined, { hydrate: true });
    expect(propsOf(selectOf(island)).value).toBe("en");
  });

  it("a pick writes the cookie, shows at once, and refreshes in place on an unprefixed route", () => {
    const island = renderIsland(LocaleSwitcher, {}, undefined, { hydrate: true });
    (propsOf(selectOf(island)).onChange as (e: unknown) => void)({ target: { value: "fr" } });
    expect(jar).toBe("seazn_locale=fr");
    expect(propsOf(selectOf(island)).value, "the select must not snap back to en").toBe("fr");
    expect(h.refreshed).toBe(1);
    expect(h.pushed).toEqual([]);
  });

  it("a second pick on a [lang] route swaps the segment", () => {
    h.pathname = "/fr/scheduling";
    jar = "seazn_locale=fr";
    const island = renderIsland(LocaleSwitcher, {}, undefined, { hydrate: true });
    (propsOf(selectOf(island)).onChange as (e: unknown) => void)({ target: { value: "nl" } });
    expect(h.pushed).toEqual(["/nl/scheduling"]);
    expect(propsOf(selectOf(island)).value).toBe("nl");
  });
});
