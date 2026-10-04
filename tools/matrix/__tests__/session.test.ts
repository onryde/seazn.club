// The case browser's wiring, proven against a structural fake Browser (no
// chromium): the context a case gets carries its width's viewport, en, the
// run's base, every cookie in the session jar, and the bench's consent
// pre-answer (ruling 38). openBrowser itself is proven live (Task 8). Product
// names (the session cookie, the onboarding route and step) are read from the
// product's text.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSENT_SEED, seedConsent } from "../../../scripts/bench/lib/tap-play.ts";
import { VIEWPORT } from "../lib/browser/viewports.ts";
import { NoSessionCookie, ONBOARDING_PATH, OnboardingRefused, SESSION_COOKIE, contextCookies, ensureOnboarded, newCaseBrowser } from "../lib/browser/session.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const BASE = "http://localhost:3999";

function fakeBrowser(o: { failCookies?: boolean } = {}) {
  const log: unknown[][] = [];
  const page = { tag: "page" };
  const context = {
    async addCookies(c: unknown) { log.push(["addCookies", c]); if (o.failCookies) throw new Error("cookies refused"); },
    async addInitScript(fn: unknown, arg: unknown) { log.push(["addInitScript", fn, arg]); },
    async newPage() { log.push(["newPage"]); return page; },
    async close() { log.push(["close"]); },
  };
  const browser = { async newContext(opts: unknown) { log.push(["newContext", opts]); return context; } };
  return { browser: browser as unknown as Parameters<typeof newCaseBrowser>[0], log, page };
}

function onboardPage(path: string, completeStatus = 200) {
  const posts: string[] = [];
  const page = {
    url: () => `${BASE}${path}`,
    request: {
      async post(url: string, _o: { data: unknown }) {
        posts.push(url);
        const status = url === "/api/onboarding/complete" ? completeStatus : 200;
        return { ok: () => status >= 200 && status < 300, status: () => status };
      },
    },
  };
  return { page, posts };
}

describe("the case browser", () => {
  it("the session cookie and the onboarding route are the product's own names", () => {
    const auth = src("apps/web/src/lib/auth.ts");
    expect(auth).toContain(`const COOKIE_NAME = "${SESSION_COOKIE}";`);
    expect(auth).toContain(`redirect: "${ONBOARDING_PATH}"`);
    expect(src("apps/web/src/app/onboarding/page.tsx")).toContain("OnboardingWizard");
  });

  it("the onboarding step is auth.setup.ts's own: complete, then the tour", () => {
    const setup = src("apps/web/e2e/auth.setup.ts");
    expect(setup).toContain('await page.request.post("/api/onboarding/complete", { data: {} });');
    expect(setup).toContain('await page.request.post("/api/tour", { data: {} }).catch(() => undefined);');
  });

  it("a context gets the width's viewport, en, the base, every cookie in the jar at the base's origin, and the consent pre-answer", async () => {
    const f = fakeBrowser();
    const cb = await newCaseBrowser(f.browser, { base: `${BASE}/`, cookies: { [SESSION_COOKIE]: "s1", seazn_org: "o1" }, width: 320 });
    expect(cb.page).toBe(f.page);
    expect(f.log[0]).toEqual(["newContext", { viewport: { width: VIEWPORT[320].width, height: VIEWPORT[320].height }, locale: "en", baseURL: `${BASE}/` }]);
    expect(f.log[1]).toEqual(["addCookies", [
      { name: SESSION_COOKIE, value: "s1", url: BASE },
      { name: "seazn_org", value: "o1", url: BASE },
    ]]);
    // The bench's own pre-answer, by identity (ruling 38: imported, not copied).
    expect(f.log[2]).toEqual(["addInitScript", seedConsent, CONSENT_SEED]);
    expect(f.log[2][1]).toBe(seedConsent);
    expect(f.log.map((l) => l[0])).toEqual(["newContext", "addCookies", "addInitScript", "newPage"]);
    await cb.close();
    expect(f.log.at(-1)).toEqual(["close"]);
  });

  it("a second case gets its own context at its own width", async () => {
    const f = fakeBrowser();
    await newCaseBrowser(f.browser, { base: BASE, cookies: { [SESSION_COOKIE]: "s1" }, width: 1280 });
    await newCaseBrowser(f.browser, { base: BASE, cookies: { [SESSION_COOKIE]: "s2" }, width: 834 });
    const opened = f.log.filter((l) => l[0] === "newContext").map((l) => (l[1] as { viewport: unknown }).viewport);
    expect(opened).toEqual([{ ...VIEWPORT[1280] }, { ...VIEWPORT[834] }]);
  });

  it("a jar without the session cookie is refused BEFORE a context opens (an anonymous case would click as nobody)", async () => {
    const jars: readonly Readonly<Record<string, string>>[] = [{}, { seazn_org: "o1" }, { [SESSION_COOKIE]: "" }];
    for (const jar of jars) {
      const f = fakeBrowser();
      await expect(newCaseBrowser(f.browser, { base: BASE, cookies: jar, width: 390 }), JSON.stringify(jar)).rejects.toThrow(NoSessionCookie);
      expect(f.log).toEqual([]);
    }
    expect(() => contextCookies(BASE, {})).toThrow(NoSessionCookie);
  });

  it("an undeclared width is refused before a context opens", async () => {
    const f = fakeBrowser();
    await expect(newCaseBrowser(f.browser, { base: BASE, cookies: { [SESSION_COOKIE]: "s" }, width: 1024 as 1280 }), "1024").rejects.toThrow(/not a browser width/);
    expect(f.log).toEqual([]);
  });

  it("a context that fails to set up is closed, not leaked", async () => {
    const f = fakeBrowser({ failCookies: true });
    await expect(newCaseBrowser(f.browser, { base: BASE, cookies: { [SESSION_COOKIE]: "s" }, width: 390 })).rejects.toThrow("cookies refused");
    expect(f.log.map((l) => l[0])).toEqual(["newContext", "addCookies", "close"]);
  });

  it("ensureOnboarded does nothing off the onboarding route, and the pinned step on it", async () => {
    const off = onboardPage("/o/matrix-org/dashboard");
    expect(await ensureOnboarded(off.page)).toBe(false);
    expect(off.posts).toEqual([]);
    const on = onboardPage(ONBOARDING_PATH);
    expect(await ensureOnboarded(on.page)).toBe(true);
    expect(on.posts).toEqual(["/api/onboarding/complete", "/api/tour"]);
  });

  it("ensureOnboarded refuses by name when the product refuses to complete onboarding", async () => {
    const on = onboardPage(ONBOARDING_PATH, 403);
    await expect(ensureOnboarded(on.page)).rejects.toThrow(OnboardingRefused);
    expect(on.posts).toEqual(["/api/onboarding/complete"]);
  });
});
