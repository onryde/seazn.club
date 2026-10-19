// The path-secret rules match at the ROUTE ROOT only: a slug that happens to be named like a secret route is not a secret.
//
// `/join/<token>`, `/claim/<secret>`, `/checkin/<code>` and the API twins are root routes (src/app/join, claim, checkin,
// api/invites, api/claims, api/checkin). A competition or club slug is free text: `/o/x/c/join/d/claim` is a perfectly good
// address, and an unanchored `/join/` rule turned it into `/o/x/c/join/[token]/claim`, and dropped the request body of a
// Sentry event on it. The rule now starts at the start of a path: the start of the string, after whitespace or a
// delimiter (a transaction name's `GET `, a quote, `=`, `&`, `?`), after an origin, or after the marketing locale prefix
// (`/fr`), and for the URL-encoded form after the encoded equivalents at any depth.
//
// The probes are built by the app's own route builders (routes.ts), every builder, with every reserved word as every slug
// argument; nothing here types a URL where a builder exists. The positive pair (a real secret at a root path is still
// scrubbed, in every context a URL reaches telemetry in) lives in scrub-path-secrets.test.ts, which sweeps the app's
// secret routes from the file system; the contexts are repeated here once, against the anchor itself.
//
// Sport: not applicable — routes are sport-agnostic.
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@sentry/nextjs";

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));

import { USER_ID } from "./_fake-sql";
import { createInvite } from "@/server/usecases/invites";
import { mintCheckinToken } from "@/server/usecases/checkin-token";
import { mintClaimSecret } from "@/server/usecases/person-claims";
import { routes } from "@/lib/routes";
import { LOCALES } from "@/lib/i18n-constants";
import { scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
/** The words that name a secret route at the root (and `claims`, the API twin's plural). */
const RESERVED = ["join", "claim", "checkin", "invites", "claims"] as const;
/** The builders that take a SECRET and so are scrubbed by design; every other builder takes slugs and ids. */
const SECRET_BUILDERS = new Set(["claim", "checkin"]);

const encode = (value: string, depth: number) => {
  let out = value;
  for (let i = 0; i < depth; i++) out = encodeURIComponent(out);
  return out;
};

type Builder = (...args: string[]) => string;
const builders = Object.entries(routes).filter(([name]) => !SECRET_BUILDERS.has(name)) as [string, Builder][];

/** Every route builder called with a reserved word for every argument (`fn.length` counts declared parameters, optional ones included). */
function probes(): { name: string; word: string; url: string }[] {
  const out: { name: string; word: string; url: string }[] = [];
  for (const [name, fn] of builders) {
    for (const word of RESERVED) out.push({ name, word, url: fn(...Array.from({ length: Math.max(fn.length, 4) }, () => word)) });
  }
  return out;
}

describe("a slug named like a secret route is not a secret (probes built by the app's own route builders)", () => {
  const all = probes();
  const withWord = all.filter((p) => p.url.includes(`/${p.word}`));

  it("the probes exist (anti-vacuity): many builders, and most put the word in the path as a slug", () => {
    expect(builders.length).toBeGreaterThanOrEqual(20);
    expect(all.length).toBe(builders.length * RESERVED.length);
    expect(withWord.length).toBeGreaterThanOrEqual(80);
    // The shapes the review found: a slug `join` below a competition, and below a public page.
    expect(all.some((p) => p.word === "join" && p.url.includes("/c/join/d/join"))).toBe(true);
    expect(all.some((p) => p.word === "claim" && p.url.startsWith("/shared/claim/claim"))).toBe(true);
  });

  it("scrubScoreUrl leaves each URL alone: bare, after an origin, with a query, in a login next= at every depth and hex case, in a transaction name", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const { name, word, url } of all) {
      const contexts: [string, string][] = [
        ["bare", url],
        ["origin", `${ORIGIN}${url}`],
        ["origin + query", `${ORIGIN}${url}${url.includes("?") ? "&" : "?"}from=qr#top`],
        ["transaction", `GET ${url}`],
        ["sentence", `Failed to fetch RSC payload for ${ORIGIN}${url}`],
        ...[1, 2, 3].flatMap((depth): [string, string][] => [
          [`login next= depth ${depth}`, `${ORIGIN}/login?next=${encode(url, depth)}`],
          [`login next= (with origin) depth ${depth}`, `${ORIGIN}/login?lang=en&next=${encode(`${ORIGIN}${url}`, depth)}&x=1`],
          [`login next= lower hex depth ${depth}`, `${ORIGIN}/login?next=${encode(url, depth).replace(/(%(?:25)*)([0-9A-F]{2})/g, (_m, p: string, h: string) => p + h.toLowerCase())}`],
        ]),
      ];
      for (const [context, input] of contexts) {
        if (scrubScoreUrl(input) !== input) failures.push(`${name}(${word}) / ${context}: ${input} -> ${scrubScoreUrl(input)}`);
        checked++;
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} changed`).toEqual([]);
    expect(checked).toBe(all.length * 14);
  });

  it("a Sentry event on such a URL keeps its URL, its transaction and its request body", () => {
    const body = { note: "hello", count: 2 };
    const failures: string[] = [];
    let checked = 0;
    for (const { name, word, url } of all) {
      const events: [string, Event][] = [
        ["request URL", { event_id: "a", request: { method: "POST", url: `${ORIGIN}${url}`, data: body } }],
        ["transaction", { event_id: "b", transaction: `POST ${url}`, request: { method: "POST", data: body } }],
      ];
      for (const [form, event] of events) {
        const out = scrubSentryEvent(structuredClone(event));
        if (JSON.stringify(out) !== JSON.stringify(event)) failures.push(`${name}(${word}) / ${form}: ${JSON.stringify(out).slice(0, 160)}`);
        checked++;
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} changed`).toEqual([]);
    expect(checked).toBe(all.length * 2);
  });

  it("API paths with such a slug keep their request body too (the shapes the API builds around a club, a competition, a division)", () => {
    const body = { note: "hello" };
    const urls = RESERVED.flatMap((w) => [
      `/api/v1/public/orgs/${w}/competitions/${w}/register`,
      `/api/v1/orgs/${w}/competitions/${w}/divisions`,
      `/api/v1/competitions/${w}/divisions/${w}/fixtures`,
      `/api/orgs/${w}/${w}`,
    ]);
    for (const url of urls) {
      const out = scrubSentryEvent({ event_id: "a", request: { method: "POST", url: `${ORIGIN}${url}`, data: body } } as Event);
      expect(out.request?.data, url).toEqual(body);
      expect(out.request?.url, url).toBe(`${ORIGIN}${url}`);
    }
    expect(urls.length).toBe(RESERVED.length * 4);
  });
});

describe("the anchor still finds a real secret at a route root, in every context a URL reaches telemetry in", () => {
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const cases = async () => {
    const invite = (await createInvite("00000000-0000-4000-8000-000000000002", USER_ID, { role: "admin", max_uses: 1 })).token;
    const checkin = await mintCheckinToken("00000000-0000-4000-8000-000000000003", tomorrow);
    const claim = mintClaimSecret();
    return [
      { secret: invite, path: `/join/${invite}` },
      { secret: invite, path: `/api/invites/${invite}/claim` },
      { secret: invite, path: `/api/orgs/00000000-0000-4000-8000-000000000002/invites/${invite}/revoke` },
      { secret: checkin, path: routes.checkin(checkin) },
      { secret: checkin, path: `/api/checkin/${checkin}` },
      { secret: claim, path: routes.claim(claim) },
      { secret: claim, path: `/api/claims/${claim}/accept` },
    ];
  };

  it("start of string, origin (with a port), transaction name, sentence, quote, next=, a locale prefix, an encoded origin: all scrubbed", async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const { secret, path: p } of await cases()) {
      const forms: [string, string][] = [
        ["start", p],
        ["origin", `${ORIGIN}${p}`],
        ["origin + port", `http://localhost:3000${p}`],
        ["transaction", `POST ${p}`],
        ["sentence", `Failed to fetch RSC payload for ${ORIGIN}${p}`],
        ["quoted", `{"to":"${p}"}`],
        ["next=", `${ORIGIN}/login?next=${p}`],
        ["&next=", `${ORIGIN}/login?lang=en&next=${p}`],
        ...LOCALES.map((l): [string, string] => [`locale ${l}`, `${ORIGIN}/${l}${p}`]),
        ...[1, 2, 3].flatMap((depth): [string, string][] => [
          [`encoded depth ${depth}`, `${ORIGIN}/login?next=${encode(p, depth)}`],
          [`encoded origin depth ${depth}`, `${ORIGIN}/login?next=${encode(`${ORIGIN}${p}`, depth)}`],
          [`encoded origin + port depth ${depth}`, `${ORIGIN}/login?next=${encode(`http://localhost:3000${p}`, depth)}`],
          [`encoded in a query depth ${depth}`, `${ORIGIN}/x?from=a&ret=${encode(p, depth)}&b=1`],
        ]),
      ];
      for (const [form, input] of forms) {
        const out = scrubScoreUrl(input);
        if (out.includes(secret)) failures.push(`${p} / ${form}: ${out}`);
        else if (!out.includes("[token]")) failures.push(`${p} / ${form}: no placeholder in ${out}`);
        if (scrubScoreUrl(out) !== out) failures.push(`${p} / ${form}: not idempotent`);
        checked++;
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(7 * (8 + LOCALES.length + 12));
  });

  it("the same word one level down is not the root: a segment before it takes it off the root, for every route", async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const { path: p } of await cases()) {
      for (const prefix of ["/o/x", "/shared/org/comp", "/api/v1/x", "/c/y"]) {
        // `/api/...` twins are routes of their own; a prefix before `/api` is a different route entirely.
        const input = `${ORIGIN}${prefix}${p}`;
        const out = scrubScoreUrl(input);
        // `/api/orgs/<id>/invites/` is anchored at `/api/orgs`, so only a prefix before THAT is off the root.
        if (out !== input) failures.push(`${prefix}${p}: ${out}`);
        checked++;
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} changed`).toEqual([]);
    expect(checked).toBe(7 * 4);
  });
});
