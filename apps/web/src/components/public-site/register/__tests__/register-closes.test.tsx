// Registration redesign B2 T7 — the heading's closing line ("Registration closes 30 Nov, UTC"). The time is shown in the VIEWER's own
// zone with the zone named, exactly as each division card shows its own closing time (division-card.tsx `windowDate`), so a page
// header and the card under it can never disagree about the day. The server cannot know the viewer's zone: it renders in UTC
// (named), and the render after hydration switches to the browser's — the same `useHydrated` shape the rest of the tree uses so
// hydration never mismatches. `windowDate` is replaced with a recorder so the zone each pass asked for is read directly: the
// process zone does not move `Intl` inside a vitest worker (division-card.test.tsx), so a real format could not tell the two
// passes apart on a machine that happens to be in UTC.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import type { Dict } from "@/lib/i18n-constants";
import { t as tRuntime } from "@/lib/i18n-runtime";

const EN_UI: Dict = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8"),
) as Dict;

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
}));

const windowDateMock = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../division-card", () => ({
  windowDate: (...args: unknown[]) => {
    windowDateMock.calls.push(args);
    return `<${String(args[0])}|${String(args[1])}|${String(args[2])}>`;
  },
}));

import { RegistrationCloses } from "../register-closes";

const ISO = "2026-11-30T23:59:00.000Z";
beforeEach(() => {
  windowDateMock.calls = [];
});

describe("RegistrationCloses", () => {
  it("the server pass (and the hydrating client's first pass) names UTC — the zone it can actually know", () => {
    const html = renderToStaticMarkup(<RegistrationCloses iso={ISO} locale="en" />);
    expect(html).toContain(`Registration closes &lt;${ISO}|en|UTC&gt;`);
    expect(windowDateMock.calls).toEqual([[ISO, "en", "UTC"]]);
  });

  it("after hydration it re-reads in the viewer's own zone (no zone passed = the browser's), with the locale it was given", () => {
    const island = renderIsland(RegistrationCloses, { iso: ISO, locale: "fr" }, undefined, { hydrate: true });
    // First render = the server markup, then the live read — in that order, and the LAST one is what the person sees.
    expect(windowDateMock.calls.map((c) => c[2])).toEqual(["UTC", undefined]);
    expect(windowDateMock.calls.every((c) => c[0] === ISO && c[1] === "fr")).toBe(true);
    expect(textOf(island.tree()[0]!)).toContain("Registration closes <" + ISO + "|fr|undefined>");
  });
});
