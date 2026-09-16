// The "Save ticket" PNG draws its words in the VISITOR's locale — the locale
// `/r/[ref]/page.tsx` resolves for the ticket the same visitor is reading
// (Task 16 fix round 2). It drew "Entrant", "Your reference", "Scan at the
// desk", "ADMIT ONE" and an English status stamp in every locale.
//
// satori's pixels cannot be read, but the element handed to `ImageResponse`
// is markup: it is captured here, rendered, and put through the /shared
// sweep's own classifier — every text node must be data (a `zq` marker),
// punctuation, or a value of THAT locale's dictionaries.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import {
  classify,
  dictionaryHits,
  extractSegments,
  formatFinding,
  type Finding,
} from "@/app/(public)/shared/__tests__/_english-sweep";
import { createElement } from "react";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";

const state = vi.hoisted(() => ({ locale: "en", status: "paid", drawn: [] as unknown[], options: [] as unknown[] }));

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => state.locale }));
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: unknown, options: unknown) {
      state.drawn.push(element);
      state.options.push(options);
    }
  },
}));
vi.mock("@/server/usecases/registrations", () => ({
  publicRegistrationStatusByRef: async () => ({
    ref_code: "9zqref",
    status: state.status,
    org_name: "9zqclub",
    competition_name: "9zqautumn 8zqcup",
    division_name: "9zqopen",
    display_name: "1zqana 9zqplayer",
    starts_on: "2026-09-05",
    ends_on: "2026-09-06",
  }),
}));

import { GET } from "../ticket.png/route";

async function draw(locale: Locale, status = "paid"): Promise<string> {
  state.locale = locale;
  state.status = status;
  state.drawn.length = 0;
  state.options.length = 0;
  await GET(new Request("https://example.test/r/9zqref/ticket.png"), { params: Promise.resolve({ ref: "9zqref" }) });
  expect(state.drawn, "the route handed satori one element").toHaveLength(1);
  return renderToStaticMarkup(state.drawn[0] as ReactElement);
}

const WORDS = ["register.ticket.entrant", "register.ticket.refLabel", "register.ticket.scanAtDesk", "register.ticket.admitOne", "ticket.stamp.paid"] as const;

// Re-review m4. The picture depends on the VISITOR's locale (cookie, session,
// Accept-Language), so no shared cache may keep one visitor's copy for the
// next. `/r/[ref]/page.tsx` is `force-dynamic`, which Next serves as
// `private, no-cache, no-store, max-age=0, must-revalidate`
// (next/dist/server/lib/cache-control.js); the PNG now says the same, where
// `ImageResponse` alone would send `public, max-age=0, must-revalidate`.
const DYNAMIC_PAGE_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

describe("ticket.png — never shared-cached, since its words are the visitor's", () => {
  it("the route hands ImageResponse the dynamic page's own Cache-Control", async () => {
    await draw("es");
    expect(state.options).toHaveLength(1);
    const headers = new Headers((state.options[0] as { headers?: HeadersInit } | undefined)?.headers);
    expect(headers.get("cache-control")).toBe(DYNAMIC_PAGE_CACHE_CONTROL);
  });

  it("the REAL ImageResponse serves those options' header over its public default", async () => {
    await draw("es");
    const { ImageResponse } = await vi.importActual<typeof import("next/og")>("next/og");
    const served = new ImageResponse(createElement("div", null, "x"), state.options[0] as ConstructorParameters<typeof ImageResponse>[1]);
    await served.arrayBuffer();
    expect(served.headers.get("cache-control")).toBe(DYNAMIC_PAGE_CACHE_CONTROL);
    const bare = new ImageResponse(createElement("div", null, "x"), { width: 10, height: 10 });
    await bare.arrayBuffer();
    expect(bare.headers.get("cache-control"), "premise: the default is shareable").toMatch(/^public/);
  });
});

describe("ticket.png — every word in the visitor's locale", () => {
  it("premise: each word asserted differs between Spanish and English", () => {
    for (const k of WORDS) expect(es[k], k).not.toBe(en[k]);
  });

  it("en draws the English words from the dictionary (the positive pair)", async () => {
    const html = await draw("en");
    for (const k of WORDS) expect(html, k).toContain(`>${en[k]}<`);
  });

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    it(`${locale}: no English and nothing hardcoded; the five words are ${locale}'s`, async () => {
      const segments = extractSegments(await draw(locale));
      const findings = segments.map((seg) => classify(seg, locale, [])).filter((f): f is Finding => f !== null);
      expect(findings.length, findings.map(formatFinding).join("\n")).toBe(0);
      expect(dictionaryHits(segments, locale)).toBeGreaterThanOrEqual(WORDS.length);
    });
  }

  it.each(["pending", "paid", "confirmed", "waitlisted", "withdrawn"] as const)(
    "the %s stamp is the on-page ticket's own word, in Spanish",
    async (status) => {
      const html = await draw("es", status);
      expect(html).toContain(`>${es[`ticket.stamp.${status}`]}<`);
      expect(html).not.toContain(`>${en[`ticket.stamp.${status}`]}<`);
    },
  );
});
