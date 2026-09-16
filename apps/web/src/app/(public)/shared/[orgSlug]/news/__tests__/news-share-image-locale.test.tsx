// Spectator W2, Task 16 — a free org's news share images carry an acquisition
// badge, and it was English in every locale ("Live on seazn.club") on both the
// OG preview and the downloadable story card, while the eyebrow drawn beside it
// was already the org's language.
//
// Both routes build `ImageResponse` from `PostShareCard`; the constructor is
// captured and its tree rendered to markup. Expectations are the dictionary
// VALUES per locale.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { OrgPost } from "@/server/usecases/org-posts";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const captured: { tree: ReactElement | null } = { tree: null };
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(tree: unknown) {
      captured.tree = tree as ReactElement;
    }
  },
}));

const state = vi.hoisted(() => ({ locale: "en", branded: false }));
const ISO = "2026-03-02T12:00:00Z";
const POST: OrgPost = {
  id: "00000000-0000-0000-0000-000000000001",
  orgId: "00000000-0000-0000-0000-0000000000aa",
  competitionId: null,
  divisionId: null,
  kind: "announcement",
  status: "published",
  slug: "hello",
  title: "Hello",
  bodyMd: "",
  heroImagePath: null,
  autoSource: null,
  publishedAt: ISO,
  createdAt: ISO,
  updatedAt: ISO,
};
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: async () => ({
    org: {
      id: POST.orgId,
      name: "Test Org",
      slug: "test-org",
      branded: state.branded,
      branding: {},
      logo: null,
      about: null,
      default_locale: state.locale,
      card_payments: false,
    },
    competitions: [],
  }),
}));
vi.mock("@/server/usecases/org-posts", () => ({ publicPost: async () => POST }));
vi.mock("@/server/og/poster-image", () => ({ posterImageDataUrl: vi.fn(async () => null) }));

import NewsOg from "../[postSlug]/opengraph-image";
import { GET as storyPng } from "../[postSlug]/story.png/route";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const badge = (l: string) => DICTS[l]!["news.card.liveOn"]!.replace("{brand}", "seazn.club");
const params = Promise.resolve({ orgSlug: "test-org", postSlug: POST.slug });

const ROUTES: [string, () => Promise<unknown>][] = [
  ["OG preview", () => NewsOg({ params })],
  ["story card", () => storyPng(new Request("https://seazn.club/x"), { params })],
];

async function draw(run: () => Promise<unknown>): Promise<string> {
  captured.tree = null;
  await run();
  if (!captured.tree) throw new Error("ImageResponse was never constructed");
  return renderToStaticMarkup(captured.tree);
}

describe("news share images — the free-tier badge is the org locale's", () => {
  it("premise: the badge differs from English in at least one of es/fr/nl, and names the brand", () => {
    expect(["es", "fr", "nl"].some((l) => badge(l) !== badge("en"))).toBe(true);
    for (const l of Object.keys(DICTS)) expect(DICTS[l]!["news.card.liveOn"], l).toContain("{brand}");
  });

  for (const [name, run] of ROUTES) {
    for (const locale of Object.keys(DICTS)) {
      it(`${name}, ${locale}: the badge reads ${locale}'s dictionary value`, async () => {
        state.locale = locale;
        state.branded = false;
        const html = await draw(run);
        expect(html).toContain(`>${esc(badge(locale))}<`);
        expect(html).not.toContain("{brand}");
        if (badge(locale) !== badge("en")) expect(html).not.toContain(`>${esc(badge("en"))}<`);
      });
    }

    it(`${name}: a branded (Pro) org draws its own name instead — no badge in any locale`, async () => {
      state.locale = "es";
      state.branded = true;
      const html = await draw(run);
      expect(html).not.toContain(`>${esc(badge("es"))}<`);
      expect(html).toContain(">Test Org<");
    });
  }
});
