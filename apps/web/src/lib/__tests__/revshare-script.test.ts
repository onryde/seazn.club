// Who may load Revshare's tracking.js, and what it can read (lib/revshare-script.ts).
//
// The third-party script (read 2026-11-26, never run against the service) stores `location.href`, the path and
// `document.referrer` in localStorage `revshare_visits_<program>` (last 50) and, on a first `?via=` / `?ref=` landing,
// posts them all to revshare.so. So an address that holds a credential must never be in front of it.
//
// The route lists here are read from app/ itself: a new page, a new `[token]` route, a new credential query reader or a
// new `?token=` link builder is in this sweep without anyone editing it.
//
// Sport: not applicable - credentials and affiliate attribution are sport-agnostic.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { APP_DIR, VERDICTS, linkBuilders, queryCredentialReaders, secretRoutes } from "./_route-scan";
import { LOCALES } from "../i18n-constants";
import { holdsCredential } from "../scrub-score-url";
import { REVSHARE_COOKIE, REVSHARE_PROGRAM_ID, isAffiliateLandingPath } from "../revshare-shared";
import { REVSHARE_PROGRAM_ID as SERVER_PROGRAM_ID } from "../revshare";
import {
  REVSHARE_SCRIPT_SRC,
  captureRevshareRef,
  carriesSecret,
  mountRevshare,
  purgeRevshareVisits,
  shouldLoadRevshare,
} from "../revshare-script";

const ORIGIN = "https://seazn.club";
const secret = () => randomBytes(32).toString("base64url");
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJmaXh0dXJlSWQiOiJhYmMifQ.s1gnatur3s1gnatur3s1gnatur3";

// ---- the route tree ---------------------------------------------------------------------------------------------------

/** Every `app/**` page.tsx, relative to app/. */
function pageFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name === "page.tsx") found.push(path.relative(APP_DIR, full));
    }
  };
  walk(APP_DIR);
  return found.sort();
}

/** Every dynamic segment name under app/. */
function dynamicSegments(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("[")) found.add(entry.name);
      walk(path.join(dir, entry.name));
    }
  };
  walk(APP_DIR);
  return [...found].sort();
}

/** The browser paths a page file answers (a `[lang]` page is also reached unprefixed, through proxy.ts's rewrite). */
function pathsOf(file: string): string[] {
  const segments = path.dirname(file).split("/").filter((s) => s !== "." && !/^\(.*\)$/.test(s));
  const fill = (lang: string | null) =>
    "/" +
    segments
      .flatMap((seg) => {
        if (seg === "[lang]") return lang === null ? [] : [lang];
        if (/^\[(token|code|secret)\]$/.test(seg)) return [secret()];
        if (/^\[\[?\.\.\./.test(seg)) return ["a", "b"];
        if (seg.startsWith("[")) return [randomUUID()];
        return [seg];
      })
      .join("/");
  return segments[0] === "[lang]" ? [fill(null), ...LOCALES.map((l) => fill(l))] : [fill(null)];
}

/** The owner's allow-list as directories: the marketing tree, the blog and the help tree. */
const PUBLIC_LANDING_DIRS = ["[lang]/(marketing)/", "blog/", "help/"];
const isLandingFile = (file: string) => PUBLIC_LANDING_DIRS.some((d) => file.startsWith(d));

const landing = (url: string, referrer = "") => shouldLoadRevshare({ href: url, referrer });

describe("which pages may be an affiliate landing (swept over every page in app/)", () => {
  const files = pageFiles();

  it("every marketing, blog and help page loads the script on ?via= and on ?ref=", () => {
    let checked = 0;
    const refused: string[] = [];
    for (const file of files.filter(isLandingFile)) {
      for (const p of pathsOf(file)) {
        for (const param of ["via", "ref"]) {
          if (!landing(`${ORIGIN}${p}?${param}=aff_1`)) refused.push(`${p}?${param}`);
          checked++;
        }
      }
    }
    expect(refused, "a public landing page lost affiliate attribution").toEqual([]);
    console.log(`[revshare] public landing URLs checked: ${checked}`);
    expect(checked).toBeGreaterThanOrEqual(80);
  });

  it("no other page loads it, ?ref= or not (admin, signed-in, credential and club pages)", () => {
    let checked = 0;
    const loaded: string[] = [];
    for (const file of files.filter((f) => !isLandingFile(f))) {
      for (const p of pathsOf(file)) {
        if (landing(`${ORIGIN}${p}?ref=aff_1`) || landing(`${ORIGIN}${p}?via=aff_1`)) loaded.push(`${file} -> ${p}`);
        checked++;
      }
    }
    expect(loaded, "a page outside the public allow-list would run the third-party script").toEqual([]);
    console.log(`[revshare] refused pages checked: ${checked}`);
    expect(checked).toBeGreaterThanOrEqual(90);
  });

  it("the allow-list matches whole segments: look-alikes are refused", () => {
    const lookalikes = [
      "/pricing-admin", "/pricing/extra", "/start/claim", "/live/some-club", "/blogs", "/helpdesk",
      "/productx/y", "/sportsx", "/de/pricing", "/frx", "/fr/dashboard", "/admin", "/admin/capture-records",
      // A public tree's name DEEPER in a path (a club or competition slug is free text) is not that tree.
      "/live/some-club/blog", "/o/help/c/cup", "/o/club/c/sports/x", "/live/club/product/streaming",
    ];
    for (const p of lookalikes) expect(isAffiliateLandingPath(p), p).toBe(false);
    for (const p of ["/", "/fr", "/fr/", "/pricing/", "/nl/sports/cricket", "/product/streaming", "/blog", "/help/a/b"]) {
      expect(isAffiliateLandingPath(p), p).toBe(true);
    }
  });
});

describe("the credential predicate covers every credential the app puts in a URL", () => {
  it("every dynamic segment name in app/ is classified, so a new secret-shaped one reds here", () => {
    const SECRET = ["[code]", "[ref]", "[token]"]; // `secretRoutes()` reads these (and `[secret]`) and VERDICTS judges each
    const PLAIN = [
      "[...slug]", "[[...rest]]", "[checkpointId]", "[compSlug]", "[competitionSlug]", "[connectionId]", "[contactId]",
      "[courtId]", "[dealId]", "[divSlug]", "[divisionSlug]", "[entrantId]", "[family]", "[fixtureId]",
      "[fixtureOfficialId]", "[id]", "[inputId]", "[key]", "[keyId]", "[kind]", "[lang]", "[linkId]", "[momentId]",
      "[no]", "[orgSlug]", "[packageId]", "[participantId]", "[pendingId]", "[personId]", "[postSlug]", "[promoId]",
      "[replayId]", "[seq]", "[sid]", "[slug]", "[sponsorId]", "[sport]", "[stageId]", "[tab]", "[targetId]",
      "[userId]", "[venueId]", "[widget]",
    ];
    const found = dynamicSegments();
    expect(found.length).toBeGreaterThanOrEqual(30);
    expect(
      found.filter((s) => !SECRET.includes(s) && !PLAIN.includes(s)),
      "a new dynamic segment: if its value is a credential, name it [token]/[code]/[secret] and add a VERDICT",
    ).toEqual([]);
  });

  it("every secret route: the predicate sees it, and it is refused as the address and as either kind of referrer", () => {
    let checked = 0;
    const missed: string[] = [];
    for (const route of secretRoutes()) {
      const verdict = VERDICTS[route.key];
      expect(verdict, `${route.key}: a new secret-named route needs a verdict`).toBeDefined();
      if (verdict !== true) continue;
      const value = route.key.startsWith("score/") ? `dl_${secret()}` : secret();
      for (const p of route.urls(value)) {
        const url = `${ORIGIN}${p}`;
        if (!carriesSecret(url)) missed.push(`predicate: ${p}`);
        if (!carriesSecret(`${ORIGIN}/login?next=${encodeURIComponent(p)}`)) missed.push(`predicate (next=): ${p}`);
        if (landing(`${url}?ref=aff_1`)) missed.push(`address: ${p}`);
        if (landing(`${ORIGIN}/?ref=aff_1`, url)) missed.push(`same-origin referrer: ${p}`);
        if (landing(`${ORIGIN}/?ref=aff_1`, `https://www.seazn.club${p}`)) missed.push(`cross-origin referrer: ${p}`);
        if (landing(`${ORIGIN}/pricing?ref=aff_1&next=${encodeURIComponent(p)}`)) missed.push(`address next=: ${p}`);
        checked++;
      }
    }
    expect(missed).toEqual([]);
    console.log(`[revshare] secret route URLs checked: ${checked}`);
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it("every page or route that reads a credential-looking query parameter: refused on an allowed page too", () => {
    const readers = queryCredentialReaders();
    const missed: string[] = [];
    for (const key of readers) {
      const param = key.split(":")[1]!;
      const value = param === "t" ? JWT : secret();
      const url = `${ORIGIN}/pricing?ref=aff_1&${param}=${value}`;
      if (!carriesSecret(url)) missed.push(`predicate: ${key}`);
      if (landing(url)) missed.push(`address: ${key}`);
      if (landing(`${ORIGIN}/?ref=aff_1`, url)) missed.push(`same-origin referrer: ${key}`);
      if (landing(`${ORIGIN}/?ref=aff_1`, `https://elsewhere.example/x?${param}=${value}`)) missed.push(`cross-origin referrer: ${key}`);
    }
    expect(missed).toEqual([]);
    console.log(`[revshare] credential query readers checked: ${readers.length}`);
    expect(readers.length).toBeGreaterThanOrEqual(15);
  });

  it("every ?token= link the app builds, the reusable cart token included (the scrubber leaves that one alone)", () => {
    const builders = [...linkBuilders().keys()];
    for (const route of builders) expect(carriesSecret(`${ORIGIN}${route}?token=${secret()}`), route).toBe(true);
    expect(builders.length).toBeGreaterThanOrEqual(5);
    // Why this module has a predicate of its own, wider than the telemetry scrubber's.
    expect(builders).toContain("/register/status");
    const status = `${ORIGIN}/live/club/cup/register/status?rid=${randomUUID()}&token=${secret()}`;
    expect(holdsCredential(status)).toBe(false);
    expect(carriesSecret(status)).toBe(true);
  });

  it("sees an encoded parameter at depth, a fragment, a checkout session and an email address", () => {
    const inner = `/register/status?token=${secret()}`;
    let once = inner;
    for (let depth = 1; depth <= 3; depth++) {
      once = encodeURIComponent(once);
      expect(carriesSecret(`${ORIGIN}/pricing?next=${once}`), `depth ${depth}`).toBe(true);
    }
    for (const u of [
      `${ORIGIN}/pricing#access_token=abc`,
      `${ORIGIN}/pricing?checkout=success&session_id=cs_live_abc`,
      `${ORIGIN}/start?email=a%40b.example`,
      `${ORIGIN}/pricing?%74oken=abc`,
    ]) expect(carriesSecret(u), u).toBe(true);
  });

  it("leaves the parameters an affiliate or ad landing really carries (negative pair)", () => {
    const url =
      `${ORIGIN}/pricing?via=aff_1&ref=aff_1&rs_cid=rc_0123456789abcdef&uid=u1&uid2=u2&utm_source=yt&utm_medium=video` +
      "&utm_campaign=autumn&utm_content=a&utm_term=b&fbclid=IwAR0abc&fbadid=1&ad_id=2&campaign_id=3&d_id=4&tm_id=5&gclid=Cj0abc&t=90s";
    expect(carriesSecret(url)).toBe(false);
    expect(landing(url)).toBe(true);
  });
});

describe("the load decision", () => {
  const cases: [string, string, string, boolean][] = [
    ["an affiliate landing, no referrer", `${ORIGIN}/?via=aff_1`, "", true],
    ["an external referrer", `${ORIGIN}/?ref=aff_1`, "https://youtube.com/", true],
    ["a same-origin public referrer", `${ORIGIN}/pricing?ref=aff_1`, `${ORIGIN}/blog/a`, true],
    ["no affiliate parameter", `${ORIGIN}/`, "", false],
    ["only utm parameters", `${ORIGIN}/pricing?utm_source=x`, "", false],
    ["an empty affiliate parameter", `${ORIGIN}/?ref=&via=`, "", false],
    ["a look-alike parameter name", `${ORIGIN}/?preref=1&viaduct=2`, "", false],
    ["the staff GET form", `${ORIGIN}/admin/capture-records?ref=abc`, "", false],
    ["a credential path", `${ORIGIN}/claim/pc_${"a".repeat(43)}?ref=aff_1`, "", false],
    // Same origin, not a public page, nothing credential-looking in it: only the same-origin path rule refuses it.
    ["a same-origin signed-in referrer", `${ORIGIN}/?ref=aff_1`, `${ORIGIN}/dashboard`, false],
    // Cross-origin: only the predicate can refuse these.
    ["a cross-origin credential referrer", `${ORIGIN}/?ref=aff_1`, `https://stg.seazn.club/magic-link?token=abc`, false],
    ["a same-origin allowed page with a secret in its query", `${ORIGIN}/?ref=aff_1`, `${ORIGIN}/pricing?token=abc`, false],
    ["an unreadable referrer", `${ORIGIN}/?ref=aff_1`, "not a url", false],
  ];
  it.each(cases)("%s", (_name, href, referrer, want) => {
    expect(shouldLoadRevshare({ href, referrer })).toBe(want);
  });
});

// ---- the fake window --------------------------------------------------------------------------------------------------

interface FakeScript { src?: string; async?: boolean; onload?: () => void; attrs: Record<string, string>; setAttribute(k: string, v: string): void }

function fakeWindow(opts: { href: string; referrer?: string; storage?: Record<string, string>; cookie?: string }) {
  const log: string[] = [];
  const store = new Map(Object.entries(opts.storage ?? {}));
  const scripts: FakeScript[] = [];
  const jar = new Map<string, string>((opts.cookie ?? "").split("; ").filter(Boolean).map((c) => [c.split("=")[0]!, c.slice(c.indexOf("=") + 1)]));
  const written: string[] = [];
  type Listener = (e: { stopImmediatePropagation(): void; persisted?: boolean }) => void;
  const listeners: Record<string, Listener[]> = {};
  const popstate: Listener[] = (listeners.popstate = []);
  let current = new URL(opts.href);
  const location = {
    get href() { return current.href; },
    get origin() { return current.origin; },
    get protocol() { return current.protocol; },
    assign: (u: string) => log.push(`assign ${u}`),
    replace: (u: string) => log.push(`replace ${u}`),
    reload: () => log.push("reload"),
  };
  const history = {
    pushState(this: unknown, _d: unknown, _u: string, url?: string | URL | null) {
      if (this !== history) throw new TypeError("Illegal invocation");
      log.push(`push ${String(url)}`);
      if (url) current = new URL(url, current);
    },
    replaceState(this: unknown, _d: unknown, _u: string, url?: string | URL | null) {
      if (this !== history) throw new TypeError("Illegal invocation");
      log.push(`swap ${String(url)}`);
      if (url) current = new URL(url, current);
    },
  };
  const localStorage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    removeItem: (k: string) => { log.push(`remove ${k}`); store.delete(k); },
  };
  const document = {
    referrer: opts.referrer ?? "",
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
    set cookie(v: string) {
      written.push(v);
      const [pair] = v.split(";");
      jar.set(pair!.split("=")[0]!, pair!.slice(pair!.indexOf("=") + 1));
    },
    createElement: (): FakeScript => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
    querySelector: (sel: string) => scripts.find((s) => sel === `script[src="${s.src}"]`) ?? null,
    head: { appendChild: (s: FakeScript) => { log.push(`append ${s.src}`); scripts.push(s); } },
  };
  const raw = {
    location, history, localStorage, document,
    addEventListener: (name: string, fn: Listener) => { (listeners[name] ??= []).push(fn); },
    revshare_metadata: undefined as { ref_code?: string } | undefined,
  };
  return {
    win: raw as unknown as Window,
    raw, log, store, scripts, written, jar, popstate,
    /** A window event; returns how many listeners heard it. */
    fire(name: string, event: { persisted?: boolean } = {}) {
      const heard = listeners[name] ?? [];
      for (const fn of heard) fn({ stopImmediatePropagation: () => {}, ...event });
      return heard.length;
    },
    /** The browser's own traversal: the URL changes first, then popstate fires. */
    traverse(url: string) {
      current = new URL(url, current);
      let stopped = false;
      for (const fn of popstate) fn({ stopImmediatePropagation: () => { stopped = true; } });
      return { stopped };
    },
  };
}

const VISITS = `revshare_visits_${REVSHARE_PROGRAM_ID}`;
const OLD = {
  [VISITS]: JSON.stringify([{ url: `${ORIGIN}/score/dl_${"a".repeat(43)}` }]),
  revshare_visits_another_program: "[]",
  seazn_theme: "dark",
  my_revshare_visits_note: "not ours",
};

describe("the purge of the stored visit history", () => {
  it("removes every revshare_visits_* key, adjacent ones included, and nothing else", () => {
    const f = fakeWindow({ href: `${ORIGIN}/`, storage: OLD });
    expect(purgeRevshareVisits(f.win)).toBe(true);
    expect([...f.store.keys()]).toEqual(["seazn_theme", "my_revshare_visits_note"]);
  });

  it("empty storage: nothing removed, and it reports success", () => {
    const f = fakeWindow({ href: `${ORIGIN}/` });
    expect(purgeRevshareVisits(f.win)).toBe(true);
    expect(f.log).toEqual([]);
  });

  it("storage blocked outright (the access throws): nothing to read, so it reports success", () => {
    const win = {} as Window;
    Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError"); } });
    expect(purgeRevshareVisits(win)).toBe(true);
  });

  it("a removal that fails reports it, and the script is then NOT injected", () => {
    const f = fakeWindow({ href: `${ORIGIN}/?ref=aff_1`, storage: OLD });
    (f.raw.localStorage as { removeItem: (k: string) => void }).removeItem = () => { throw new Error("quota"); };
    expect(purgeRevshareVisits(f.win)).toBe(false);
    mountRevshare(f.win, true);
    expect(f.scripts).toHaveLength(0);
  });
});

describe("mounting on a page load", () => {
  it("an affiliate landing: the purge comes first, then one tag with this program's attributes", () => {
    const f = fakeWindow({ href: `${ORIGIN}/?ref=aff_1`, storage: OLD });
    mountRevshare(f.win, true);
    expect(f.log).toEqual([`remove ${VISITS}`, "remove revshare_visits_another_program", `append ${REVSHARE_SCRIPT_SRC}`]);
    expect(f.scripts[0]).toMatchObject({ src: REVSHARE_SCRIPT_SRC, async: true });
    expect(f.scripts[0]!.attrs).toEqual({
      "data-program-id": REVSHARE_PROGRAM_ID,
      "data-domain": ".seazn.club",
      "data-cookie-duration": "30",
    });
    expect(SERVER_PROGRAM_ID).toBe(REVSHARE_PROGRAM_ID);
  });

  it("a second call adds no second tag and wraps history once", () => {
    const f = fakeWindow({ href: `${ORIGIN}/?ref=aff_1` });
    mountRevshare(f.win, true);
    const wrapped = f.raw.history.pushState;
    mountRevshare(f.win, true);
    expect(f.scripts).toHaveLength(1);
    expect(f.raw.history.pushState).toBe(wrapped);
    expect(f.popstate).toHaveLength(1);
  });

  it.each([
    ["flag off, on an affiliate landing", `${ORIGIN}/?ref=aff_1`, "", false],
    ["no affiliate parameter", `${ORIGIN}/`, "", true],
    ["the staff GET form", `${ORIGIN}/admin/capture-records?ref=abc`, "", true],
    ["a credential path", `${ORIGIN}/magic-link?token=abc&ref=aff_1`, "", true],
    ["a credential referrer", `${ORIGIN}/?ref=aff_1`, `${ORIGIN}/magic-link?token=abc`, true],
  ] as const)("%s: old history is purged, no tag, history and popstate untouched", (_n, href, referrer, enabled) => {
    const f = fakeWindow({ href, referrer, storage: OLD });
    const push = f.raw.history.pushState;
    mountRevshare(f.win, enabled);
    expect(f.store.has(VISITS)).toBe(false);
    expect(f.scripts).toHaveLength(0);
    expect(f.raw.history.pushState).toBe(push);
    expect(f.popstate).toHaveLength(0);
  });

  it("the purge keeps every cookie attribution needs", () => {
    const cookie = `${REVSHARE_COOKIE}=aff_1; revshare_ref_${REVSHARE_PROGRAM_ID}=aff_1; revshare_cid_${REVSHARE_PROGRAM_ID}=rc_1`;
    const f = fakeWindow({ href: `${ORIGIN}/`, storage: OLD, cookie });
    mountRevshare(f.win, true);
    expect(f.written).toEqual([]);
    expect(f.raw.document.cookie).toBe(cookie);
  });
});

describe("a document that runs the script never takes an address it may not see", () => {
  // The script reads location.href when it EXECUTES (after the load), and it is a third party's to change: so the rule
  // holds for the whole life of the document, not only until onload.
  const live = () => {
    const f = fakeWindow({ href: `${ORIGIN}/?ref=aff_1` });
    mountRevshare(f.win, true);
    f.log.length = 0;
    return f;
  };

  it("pushState to a credential page becomes a full navigation: the address does not change in this document", () => {
    const f = live();
    f.raw.history.pushState({}, "", "/magic-link?token=abc");
    expect(f.log).toEqual([`assign ${ORIGIN}/magic-link?token=abc`]);
    expect(f.raw.location.href).toBe(`${ORIGIN}/?ref=aff_1`);
  });

  it("replaceState likewise, as a replacement; a URL object is read too", () => {
    const f = live();
    f.raw.history.replaceState({}, "", new URL(`${ORIGIN}/dashboard`));
    expect(f.log).toEqual([`replace ${ORIGIN}/dashboard`]);
    expect(f.raw.location.href).toBe(`${ORIGIN}/?ref=aff_1`);
  });

  it("the router writing the same target again does not navigate twice", () => {
    const f = live();
    f.raw.history.pushState({}, "", "/dashboard");
    f.raw.history.replaceState({}, "", "/dashboard");
    f.raw.history.pushState({}, "", "/login");
    expect(f.log).toEqual([`assign ${ORIGIN}/dashboard`, `assign ${ORIGIN}/login`]);
  });

  // The load can fail to replace this document, and the same link must then still work: otherwise the router renders
  // the other page in place, under this address, with the script still here.
  const LOGIN = `assign ${ORIGIN}/login`;
  const twice = (f: ReturnType<typeof live>, between: () => void) => {
    f.raw.history.pushState({}, "", "/login");
    between();
    f.raw.history.pushState({}, "", "/login");
  };

  it("restored from the back/forward cache after leaving: the same click leaves again", () => {
    const f = live();
    twice(f, () => expect(f.fire("pageshow", { persisted: true })).toBeGreaterThan(0));
    expect(f.log).toEqual([LOGIN, LOGIN]);
    expect(f.raw.location.href).toBe(`${ORIGIN}/?ref=aff_1`);
  });

  it("the first load's own pageshow (not persisted) forgets nothing", () => {
    const f = live();
    twice(f, () => f.fire("pageshow", { persisted: false }));
    expect(f.log).toEqual([LOGIN]);
  });

  it("a Back within this document overtakes the load: the same click leaves again", () => {
    const f = live();
    twice(f, () => f.traverse("/pricing"));
    expect(f.log).toEqual([LOGIN, LOGIN]);
  });

  // Stop, Escape or an answer with no page leaves the document and fires no event: the next press is a new request.
  it.each(["pointerdown", "keydown"])("a stopped load, then a %s: the same click leaves again", (input) => {
    const f = live();
    twice(f, () => expect(f.fire(input)).toBeGreaterThan(0));
    expect(f.log).toEqual([LOGIN, LOGIN]);
  });

  it("public pages, state-only writes and an allowed page with no ?ref= pass straight through", () => {
    const f = live();
    f.raw.history.pushState({}, "", "/pricing");
    f.raw.history.replaceState({}, "", undefined);
    f.raw.history.replaceState({}, "", "");
    f.raw.history.pushState({}, "", "#faq");
    expect(f.log).toEqual(["push /pricing", "swap undefined", "swap ", "push #faq"]);
    expect(f.raw.location.href).toBe(`${ORIGIN}/pricing#faq`);
  });

  it("another origin is left to the browser, which refuses it itself", () => {
    const f = live();
    f.raw.history.pushState({}, "", "https://other.example/score/x");
    expect(f.log).toEqual(["push https://other.example/score/x"]);
  });

  it("Back onto a page it may not see: reloaded, and no later popstate listener hears of it", () => {
    const f = live();
    expect(f.traverse(`/score/dl_${"a".repeat(43)}`).stopped).toBe(true);
    expect(f.log).toEqual(["reload"]);
  });

  it("Back onto a public page is left alone", () => {
    const f = live();
    expect(f.traverse("/pricing").stopped).toBe(false);
    expect(f.log).toEqual([]);
  });
});

describe("the ref_code reaches our first-party cookie", () => {
  const vendor = `revshare_ref_${REVSHARE_PROGRAM_ID}`;

  it("the script's onload writes it at once (a quick full navigation cannot lose it)", () => {
    const f = fakeWindow({ href: `${ORIGIN}/?ref=aff_1` });
    mountRevshare(f.win, true);
    f.raw.revshare_metadata = { ref_code: "aff_1" };
    f.scripts[0]!.onload!();
    expect(f.written).toHaveLength(1);
    expect(f.written[0]).toMatch(new RegExp(`^${REVSHARE_COOKIE}=aff_1; Max-Age=\\d+; Path=/; SameSite=Lax; Secure$`));
  });

  it("a page without the script mirrors the vendor's first-click cookie", () => {
    const f = fakeWindow({ href: `${ORIGIN}/start`, cookie: `other=1; ${vendor}=aff%5F9` });
    expect(captureRevshareRef(f.win)).toBe(true);
    expect(f.jar.get(REVSHARE_COOKIE)).toBe("aff_9");
  });

  it("the script's answer wins over the cookie", () => {
    const f = fakeWindow({ href: `${ORIGIN}/`, cookie: `${vendor}=from_cookie` });
    f.raw.revshare_metadata = { ref_code: "from_script" };
    captureRevshareRef(f.win);
    expect(f.jar.get(REVSHARE_COOKIE)).toBe("from_script");
  });

  it.each([
    ["nothing at all", ""],
    ["another program's cookie", "revshare_ref_other=aff"],
    ["a hostile value", `${vendor}=a%20b`],
    ["a broken escape", `${vendor}=%E0%A4%A`],
    ["the last-click cookie only", `revshare_last_${REVSHARE_PROGRAM_ID}=aff`],
  ])("%s: nothing is written", (_n, cookie) => {
    const f = fakeWindow({ href: `${ORIGIN}/`, cookie });
    expect(captureRevshareRef(f.win)).toBe(false);
    expect(f.written).toEqual([]);
  });
});

describe("the tag lives in one place", () => {
  const prior = process.env.NEXT_PUBLIC_REVSHARE_ENABLED;
  afterEach(() => { process.env.NEXT_PUBLIC_REVSHARE_ENABLED = prior; });

  it("no component or layout renders the tracking script into the HTML any more", () => {
    const layout = fs.readFileSync(path.join(APP_DIR, "layout.tsx"), "utf8");
    expect(layout).toContain("<RevshareCapture />");
    expect(layout).not.toContain("tracking.js\"");
    expect(layout).not.toMatch(/<script\b/);
    const capture = fs.readFileSync(path.join(APP_DIR, "../components/revshare-capture.tsx"), "utf8");
    expect(capture).toContain("mountRevshare(window, revshareEnabled())");
  });
});
