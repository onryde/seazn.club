import { readFileSync } from "node:fs";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, raw, call, check, signIn, tag, html } from "../harness.ts";

/** PROMPT-36 (v3/07 §6): /start funnel — draft → dev claim link → signed in
 *  inside the created competition; the token is single-use. */
// --- PROMPT-40 marketing redesign: matchday-arc home, public format-preview
// API, /scheduling page (free path — no session anywhere).
export async function i18nSuite(): Promise<void> {
  const fr = await fetch(`${BASE}/fr/start`);
  const frHtml = await fr.text();
  check("i18n: /fr/start 200", fr.status === 200);
  // The wizard's heading, read from the dictionary the page renders (never a typed copy of it).
  const startHeading = (lang: string): string =>
    (JSON.parse(readFileSync(new URL(`../../../apps/web/src/dictionaries/${lang}/marketing.json`, import.meta.url), "utf8")) as Record<string, string>)["start.heading"];
  check("i18n: /fr/start renders French", frHtml.includes(`>${startHeading("fr")}<`));

  const en = await fetch(`${BASE}/en/start`);
  const enHtml = await en.text();
  check("i18n: /en/start renders English", enHtml.includes(`>${startHeading("en")}<`) && !enHtml.includes(`>${startHeading("fr")}<`));

  const bare = await fetch(`${BASE}/start`, { redirect: "manual" });
  check("i18n: /start rewrites to en (200, no redirect)", bare.status === 200);

  const bad = await fetch(`${BASE}/de/start`);
  check("i18n: unsupported locale 404s", bad.status === 404);

  // The /discover directory and its sport chips are deleted (2026-11-16); /live takes over as the public listing page.
  const frLive = await fetch(`${BASE}/fr/live`);
  check("i18n: /fr/live 200", frLive.status === 200);
  check("i18n: /fr/live is French", (await frLive.text()).replace(/<[^>]+>/g, "").includes("En direct, maintenant."));

  const enHome = await fetch(`${BASE}/en`);
  const enHomeHtml = await enHome.text();
  check("i18n: /en home English", enHomeHtml.includes("Any sport. Live in minutes."));

  const frHome = await fetch(`${BASE}/fr`);
  const frHomeHtml = await frHome.text();
  check("i18n: /fr home French", frHomeHtml.includes("importe quel sport"));

  const root = await fetch(`${BASE}/`, { redirect: "manual" });
  check("i18n: / rewrites to en home (200, no redirect)", root.status === 200);

  // Email localization end-to-end (spec cycle 46): a user whose stored locale is
  // French gets the French transactional templates. change-email renders the
  // subject+html+text from the fr emails dict server-side before sending, so a
  // missing key or broken {placeholder} would surface as a 500 here. Emails are
  // not tier-gated, so this exercises the path for free and pro accounts alike.
  const mailer = newSession();
  await signIn(mailer, `delivered+i18nmail_${tag}@resend.dev`);
  await call(mailer, "/api/users/me", "PATCH", { locale: "fr" });
  const chg = await raw(mailer, "/api/auth/change-email", "POST", {
    new_email: `delivered+i18nmail2_${tag}@resend.dev`,
  });
  check("i18n: fr-locale user renders French change-email server-side", chg.status === 200);

  // Console chrome (spec cycle 46): the shared authed nav resolves the same
  // fr locale (cookie → user.locale) and renders from the `console` dict. The
  // signed-in mailer has locale=fr, so its nav shows the French Dashboard label.
  const chrome = await html(mailer, "/directory");
  check(
    "i18n: fr-locale user sees translated console chrome (nav)",
    chrome.status === 200 && chrome.body.includes("Tableau de bord"),
  );
}
