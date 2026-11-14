// The emailed claim link's card (start wizard T2 follow-up, owner-ordered): every state is worded from the visitor's
// own dictionary — never the route's English `error` — and a claim that failed AFTER it signed the organiser in points
// them at their dashboard (the event may be partly built, or the plan refused it and nothing was added; the token is
// spent) instead of "start again or sign in", and refreshes the page so the nav shows them signed in. A first day that
// has passed (refused before anything was written) is its own card: nothing was set up, start again on /<lang>/start. A limiter's 429 is
// "try again shortly": the link is still unused, so the card retries the same token.
//
// The island is driven through the real effect: `api` is the one stand-in, answering as the route answers (an ApiError
// carrying the route's `code`), so the code → copy join is what is witnessed, not a fixture on both ends. Copy is read
// off disk per locale, strictly (a missing key throws; msgFor would fall back to English and hide it).
//
// Sweep: every shipped language. Sport: the card words none; the first-day-passed link carries the page's sport key
// (two sports and none — the key is the page's to read, pinned in app/start/claim/__tests__/page.test.tsx).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import {
  FUNNEL_CLAIM_DATE_PAST,
  FUNNEL_CLAIM_INVALID,
  FUNNEL_CLAIM_PLAN_LIMIT,
  FUNNEL_CLAIM_REPLACED,
  FUNNEL_CLAIM_SIGNED_IN,
} from "@/lib/funnel-claim-codes";

/** `{name}` placeholders filled as the real `t` fills them; a placeholder left over stays, so a missing value shows. */
const fill = vi.hoisted(
  () => (s: string, vars?: Record<string, string | number>) =>
    Object.entries(vars ?? {}).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s),
);
const h = vi.hoisted(() => ({
  locale: "en" as string,
  dicts: {} as Record<string, Record<string, string>>,
  pushes: [] as string[],
  refreshes: 0,
  posts: [] as unknown[],
  answer: (async () => ({ redirect: "/o/x/c/y" })) as () => Promise<unknown>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (url: string) => void h.pushes.push(url), refresh: () => void h.refreshes++ }),
}));
vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client")>()),
  api: vi.fn(async (_url: string, init: unknown) => {
    h.posts.push(init);
    return h.answer();
  }),
}));
// The visitor's language, as <DictProvider> would hand it down (the island harness has no provider tree). A key the
// dictionary lacks throws, so an untranslated key reds instead of rendering its name.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const s = h.dicts[h.locale]?.[key];
      if (typeof s !== "string") throw new Error(`${h.locale}/ui.json has no ${key}`);
      return fill(s, vars);
    },
    useLocaleOrDefault: () => h.locale,
  };
});

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { ApiError } from "@/lib/client";
import { FunnelClaim } from "../funnel-claim";

for (const l of LOCALES) {
  h.dicts[l] = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../dictionaries", l, "ui.json"), "utf8")) as Record<
    string,
    string
  >;
}
/** The draft reference the page hands the card (V518): what the replaced-link card names. */
const REF = "SZ-7KQ4MX";
const ui = (l: Locale, key: string): string => {
  const s = h.dicts[l]![key];
  if (typeof s !== "string") throw new Error(`${l}/ui.json has no ${key}`);
  return fill(s, { reference: REF });
};
const CARD_KEYS = Object.keys(h.dicts.en!).filter((k) => k.startsWith("funnel.claim.card."));

/** Every string the card renders, one per text node — so a leak check compares whole sentences, never substrings.
 *  `els` is the island's flattened element list (every element once), so only each one's DIRECT strings are read. */
const strings = (els: ReactElement[]): string[] =>
  els
    .flatMap((el) => [(el.props as { children?: ReactNode }).children].flat())
    .filter((c): c is string | number => typeof c === "string" || typeof c === "number")
    .map((c) => String(c).trim())
    .filter(Boolean);
const hrefs = (els: ReactElement[]): string[] =>
  els.map((el) => (el.props as { href?: unknown }).href).filter((x): x is string => typeof x === "string");

/** Mount the card on `token`, let the claim POST answer, and return what it then shows. */
async function settle(token: string | null, restartSport: string | null = null, reference: string | null = REF) {
  const island = renderIsland(FunnelClaim, { token, restartSport, reference });
  // The POST's promise, then its .then/.catch handler: a few microtask turns.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const els = island.tree();
  return { island, texts: strings(els), hrefs: hrefs(els), text: island.text() };
}

/** The states a visitor can land in, the route answer that leads there, and the copy each one owes. */
const SERVER_TEXT = "SERVER-ENGLISH: relation \"divisions\" violates something";
const STATES = [
  {
    name: "missing token",
    token: null,
    answer: null,
    keys: ["invalidTitle", "missingToken", "retryHint", "startAgain", "or", "signIn"],
    links: ["/start", "/login"],
  },
  {
    name: "used or expired link",
    token: "tok-invalid",
    answer: () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_INVALID)),
    keys: ["invalidTitle", "invalidDetail", "retryHint", "startAgain", "or", "signIn"],
    links: ["/start", "/login"],
  },
  {
    name: "failed before signing in",
    token: "tok-failed",
    answer: () => Promise.reject(new ApiError(SERVER_TEXT, 500)),
    keys: ["failedTitle", "failedDetail", "retryHint", "startAgain", "or", "signIn"],
    links: ["/start", "/login"],
  },
  {
    name: "network failure",
    token: "tok-offline",
    answer: () => Promise.reject(new TypeError("Failed to fetch")),
    keys: ["failedTitle", "failedDetail", "retryHint", "startAgain", "or", "signIn"],
    links: ["/start", "/login"],
  },
  {
    name: "failed after signing in",
    token: "tok-signed-in",
    answer: () => Promise.reject(new ApiError(SERVER_TEXT, 500, FUNNEL_CLAIM_SIGNED_IN)),
    keys: ["signedInTitle", "signedInBody", "dashboard"],
    links: ["/dashboard"],
  },
  {
    name: "a signed-in failure the build refused with a 4xx",
    token: "tok-signed-in-409",
    answer: () => Promise.reject(new ApiError(SERVER_TEXT, 409, FUNNEL_CLAIM_SIGNED_IN)),
    keys: ["signedInTitle", "signedInBody", "dashboard"],
    links: ["/dashboard"],
  },
  {
    name: "the plan refused the competition (nothing added)",
    token: "tok-limit",
    answer: () => Promise.reject(new ApiError(SERVER_TEXT, 402, FUNNEL_CLAIM_PLAN_LIMIT)),
    keys: ["signedInTitle", "limitBody", "dashboard"],
    links: ["/dashboard"],
  },
  {
    // Refused before anything was written (lib/funnel.ts createFromDraft's first check), though the visitor IS signed in:
    // never the "may be partly set up" card, and the way on is a fresh start in their own language.
    name: "the first day has passed (nothing set up)",
    token: "tok-date-past",
    answer: () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_DATE_PAST)),
    keys: ["datePast", "startAgain"],
    links: (l: Locale) => [`/${l}/start`],
  },
  {
    // V518: a newer start replaced this draft. Signed out, nothing built; the way on is the latest email, named by its reference.
    name: "replaced by a newer link",
    token: "tok-replaced",
    answer: () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_REPLACED)),
    keys: ["replacedTitle", "replacedBody"],
    links: [],
  },
  {
    name: "rate limited (the link is unused)",
    token: "tok-429",
    answer: () => Promise.reject(new ApiError("Too many requests", 429)),
    keys: ["tryLaterTitle", "tryLaterBody", "tryAgain"],
    links: [],
  },
  {
    name: "claimed",
    token: "tok-ok",
    answer: () => Promise.resolve({ redirect: "/o/x/c/y/d/z?tab=entrants" }),
    keys: ["done"],
    links: [],
  },
] as const;

beforeEach(() => {
  h.locale = "en";
  h.pushes.length = 0;
  h.refreshes = 0;
  h.posts.length = 0;
});

describe("the funnel claim card", () => {
  it("premise: the card's copy is a real, translated set in every language", () => {
    expect(CARD_KEYS.length, "anti-vacuity: the card has copy keys").toBeGreaterThan(10);
    for (const l of LOCALES.filter((x) => x !== "en")) {
      // Words that are the same in two languages ("dashboard" in nl) cannot witness a leak, so most must differ.
      const differ = CARD_KEYS.filter((k) => ui(l, k) !== ui("en", k));
      expect(differ.length, `premise: ${l} words the card its own way`).toBeGreaterThanOrEqual(CARD_KEYS.length - 1);
    }
  });

  it("every state × every language: the state's own copy, no other state's, no English, never the server's text", async () => {
    let checked = 0;
    for (const l of LOCALES) {
      for (const s of STATES) {
        h.locale = l;
        h.answer = s.answer ?? (async () => ({ redirect: "/unused" }));
        const got = await settle(s.token);
        const label = `${l} ${s.name}`;
        const want = s.keys.map((k) => ui(l, `funnel.claim.card.${k}`));
        for (const w of want) expect(got.texts, `${label}: shows ${w}`).toContain(w);
        // Nothing worded that this state does not own (a fall-through branch would add a second state's lines).
        const owned = new Set(want);
        const foreign = CARD_KEYS.map((k) => ui(l, k)).filter((w) => !owned.has(w));
        expect(got.texts.filter((t) => foreign.includes(t)), `${label}: no other state's copy`).toEqual([]);
        if (l !== "en") {
          const english = CARD_KEYS.map((k) => ui("en", k)).filter((w) => !CARD_KEYS.some((k) => ui(l, k) === w));
          expect(got.texts.filter((t) => english.includes(t)), `${label}: no English`).toEqual([]);
        }
        expect(got.text, `${label}: the route's English is never printed`).not.toContain("SERVER-ENGLISH");
        expect(got.text, `${label}: the network's English is never printed`).not.toContain("Failed to fetch");
        const links: readonly string[] = typeof s.links === "function" ? s.links(l) : s.links;
        expect([...got.hrefs].sort(), `${label}: the way forward`).toEqual([...links].sort());
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every language × every state").toBe(LOCALES.length * STATES.length);
  });

  it("a signed-in failure offers the dashboard, never a fresh start (a second event) or a sign-in they no longer need", async () => {
    h.answer = () => Promise.reject(new ApiError(SERVER_TEXT, 500, FUNNEL_CLAIM_SIGNED_IN));
    const signedIn = await settle("tok");
    expect(signedIn.hrefs).toEqual(["/dashboard"]);
    // The positive pair: the same failure WITHOUT the code is the pre-sign-in card, with its way back in.
    h.answer = () => Promise.reject(new ApiError(SERVER_TEXT, 500));
    const signedOut = await settle("tok");
    expect(signedOut.hrefs.sort()).toEqual(["/login", "/start"]);
    expect(signedOut.texts).not.toContain(ui("en", "funnel.claim.card.signedInTitle"));
  });

  it("posts the token once, and a claim that lands goes where the route says", async () => {
    h.answer = () => Promise.resolve({ redirect: "/o/x/c/y/d/z?tab=entrants" });
    const { island } = await settle("tok-1");
    island.rerender({ token: "tok-1", restartSport: null, reference: REF });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.posts, "one POST for one link").toEqual([{ method: "POST", json: { token: "tok-1" } }]);
    expect(h.pushes).toEqual(["/o/x/c/y/d/z?tab=entrants"]);
  });

  it("signed in by this very response: the page refreshes (the nav still says signed out); a signed-out failure does not", async () => {
    const cases = [
      { name: "signed in, part-built", answer: () => Promise.reject(new ApiError(SERVER_TEXT, 500, FUNNEL_CLAIM_SIGNED_IN)), refresh: 1 },
      { name: "signed in, plan limit", answer: () => Promise.reject(new ApiError(SERVER_TEXT, 402, FUNNEL_CLAIM_PLAN_LIMIT)), refresh: 1 },
      { name: "signed in, first day passed", answer: () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_DATE_PAST)), refresh: 1 },
      { name: "dead link", answer: () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_INVALID)), refresh: 0 },
      { name: "replaced link", answer: () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_REPLACED)), refresh: 0 },
      { name: "failed before the session", answer: () => Promise.reject(new ApiError(SERVER_TEXT, 500)), refresh: 0 },
      { name: "rate limited", answer: () => Promise.reject(new ApiError("Too many requests", 429)), refresh: 0 },
    ];
    let checked = 0;
    for (const c of cases) {
      h.refreshes = 0;
      h.answer = c.answer;
      await settle(`tok-${checked}`);
      expect(h.refreshes, c.name).toBe(c.refresh);
      checked++;
    }
    expect(checked, "anti-vacuity: the three signed-in failures and four signed-out ones").toBe(cases.length);
  });

  it("rate limited: Try again re-posts the SAME token, shows the working state meanwhile, and lands", async () => {
    h.answer = () => Promise.reject(new ApiError("Too many requests", 429));
    const { island } = await settle("tok-retry");
    const button = island.tree().find((el) => el.type === "button");
    expect(button, "the retry control").toBeDefined();
    let release!: (v: unknown) => void;
    h.answer = () => new Promise((r) => (release = r));
    island.batch(() => (button!.props as { onClick: () => void }).onClick());
    expect(island.text(), "working while the retry is in flight").toContain(ui("en", "funnel.claim.card.working"));
    release({ redirect: "/o/x/c/y/d/z?tab=entrants" });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.posts, "the same link, twice").toEqual([
      { method: "POST", json: { token: "tok-retry" } },
      { method: "POST", json: { token: "tok-retry" } },
    ]);
    expect(h.pushes).toEqual(["/o/x/c/y/d/z?tab=entrants"]);
  });

  it("first day passed: Start again opens /<lang>/start on the draft's sport — only the sport rides the link", async () => {
    // The sport is the page's (read from the draft by the token: app/start/claim/page.tsx); the card only words the link.
    const cases = [
      { sport: "badminton", query: "?sport=badminton" },
      { sport: "tabletennis", query: "?sport=tabletennis" },
      { sport: null, query: "" },
    ];
    let checked = 0;
    for (const l of LOCALES) {
      for (const c of cases) {
        h.locale = l;
        h.answer = () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_DATE_PAST));
        const got = await settle("tok-date-past", c.sport);
        expect(got.hrefs, `${l} ${c.sport}`).toEqual([`/${l}/start${c.query}`]);
        expect(got.texts, `${l}: never the part-built card`).not.toContain(ui(l, "funnel.claim.card.signedInBody"));
        expect(got.texts).toContain(ui(l, "funnel.claim.card.datePast"));
        for (const href of got.hrefs) {
          const q = new URL(href, "https://seazn.test").searchParams;
          expect([...q.keys()].filter((k) => k !== "sport"), `${l}: nothing but the sport in the URL`).toEqual([]);
        }
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every language × a sport and none").toBe(LOCALES.length * cases.length);
  });

  it("replaced: the card names the reference the latest email carries — and, without one, says only to check the latest email", async () => {
    let checked = 0;
    for (const l of LOCALES) {
      h.locale = l;
      h.answer = () => Promise.reject(new ApiError(SERVER_TEXT, 400, FUNNEL_CLAIM_REPLACED));
      const named = await settle("tok-replaced", null, "SZ-23HJKZ");
      expect(named.texts, `${l}: the reference in the sentence`).toContain(fill(h.dicts[l]!["funnel.claim.card.replacedBody"]!, { reference: "SZ-23HJKZ" }));
      expect(named.text, `${l}: no placeholder left`).not.toContain("{reference}");
      const unnamed = await settle("tok-replaced", null, null);
      expect(unnamed.texts, `${l}: no reference to name`).toContain(ui(l, "funnel.claim.card.replacedBodyNoReference"));
      expect(unnamed.text, `${l}: never an empty "()"`).not.toContain("()");
      expect(unnamed.text).not.toContain("{reference}");
      expect(unnamed.texts, `${l}: the title either way`).toContain(ui(l, "funnel.claim.card.replacedTitle"));
      checked++;
    }
    expect(checked, "anti-vacuity: every language").toBe(LOCALES.length);
  });

  it("a missing token posts nothing", async () => {
    await settle(null);
    expect(h.posts).toEqual([]);
  });
});
