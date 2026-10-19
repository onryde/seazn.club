// /login, rendered — the sentence a person reads after Google refuses their
// unverified address.
//
// The callback redirects here with `?google=email_unverified`. A redirect code
// nothing renders is the inert-seam failure this repo has shipped before: the
// existing `?error=` codes (`oauth_state`, `oauth_userinfo`, ...) are written by
// the Google routes and read by NO page, so a person who is refused sees a
// plain login form and no reason. This suite renders the real page and asserts
// the sentence, in every locale.
//
// Rendered through react-dom/server (vitest runs `environment: "node"`, no
// jsdom). Stand-ins: the session lookup (signed out) and the locale resolver.
// The page, the dictionary loader, the night stage and the real `AuthForm`
// island are the real ones.
//
// Sport: not applicable. The login page is sport-agnostic.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import es from "@/dictionaries/es/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

const state = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => state.locale }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => null,
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import LoginPage from "../page";

const KEY = "login.flash.google.email_unverified" as const;
const DICT: Record<Locale, Record<string, string>> = { en, fr, es, nl };

/** React's static renderer escapes these five characters in text. */
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function render(params: { google?: string; error?: string; next?: string }, locale: Locale = "en") {
  state.locale = locale;
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  state.locale = "en";
});

describe("/login — the Google refusal notice", () => {
  it("says, in English, exactly what the owner approved", async () => {
    const html = await render({ google: "email_unverified" });
    expect(html).toContain(
      escapeHtml("Google hasn't verified this email address. Verify it with Google, or sign in with an email link."),
    );
  });

  it("shows it as an alert in every locale, in that locale's own words", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const text = DICT[locale][KEY];
      expect(text, `${locale}: the key is missing`).toBeTruthy();
      if (locale !== "en") expect(text, `${locale}: left as English`).not.toBe(DICT.en[KEY]);

      const html = await render({ google: "email_unverified" }, locale);

      expect(html, `${locale}: notice text`).toContain(escapeHtml(text!));
      expect(html, `${locale}: announced as an alert`).toMatch(/role="alert"[^>]*>[^<]*Google/);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(checked).toBe(4);
  });

  it("keeps both ways in: the Google button and the email-link form are still on the page", async () => {
    const html = await render({ google: "email_unverified" });
    expect(html).toContain('href="/api/auth/google"');
    expect(html).toContain('type="email"');
  });

  it("shows nothing without the code, and nothing for a code it does not know", async () => {
    const quiet = await render({});
    expect(quiet).not.toContain('role="alert"');
    for (const other of [{ google: "bogus" }, { google: "" }, { google: "<script>x</script>" }, { google: "constructor" }, { google: "__proto__" }, { google: "toString" }, { error: "oauth_userinfo" }]) {
      const html = await render(other);
      expect(html, JSON.stringify(other)).not.toContain('role="alert"');
      expect(html, JSON.stringify(other)).not.toContain(escapeHtml(en[KEY]));
      expect(html, JSON.stringify(other)).not.toContain("<script>x");
    }
  });

  it("the invite destination still reaches the Google button after a refusal", async () => {
    const html = await render({ google: "email_unverified", next: "/invite/abc123" });
    expect(html).toContain(escapeHtml("/api/auth/google?next=%2Finvite%2Fabc123"));
  });
});
