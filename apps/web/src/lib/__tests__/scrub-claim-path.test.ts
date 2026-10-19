// The profile-claim secret must not reach telemetry.
//
// An organiser invites a player to claim their profile; the invite is `/claim/<pc_secret>` (routes.claim), lives 14 days,
// is shown in the organiser's console as a copyable link plus a QR, and is mailed. The secret rides the URL's PATH: the
// page itself, the accept call the page's button makes (`/api/claims/<secret>/accept`), and a sign-in `next=/claim/<secret>`
// (AuthForm sends it, so the magic-link and verification links carry it encoded). Anyone holding it can link the profile
// to their account. Every `/claim/<secret>` and `/api/claims/<secret>` becomes `…/[token]`, plain or URL-encoded at any
// depth, either hex case, by the `/capture/codes/` rules.
//
// The secret is minted by the REAL `mintClaimSecret()`, the page URL is the REAL `routes.claim()`, and the accept URL is
// the one the REAL <ClaimAccept> island sends when its button is pressed. The expected value of each case is the same
// string with the secret swapped for the placeholder.
//
// Sport: not applicable — claims are sport-agnostic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@sentry/nextjs";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { routes } from "@/lib/routes";
import { mintClaimSecret } from "@/server/usecases/person-claims";
import { ClaimAccept } from "@/components/claim-accept";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { posthogBeforeSend, scrubRecordingEvent, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
const PLACEHOLDER = "[token]";
const APP_DIR = path.join(fileURLToPath(new URL("../../", import.meta.url)), "app");

const without = (url: string, ...secrets: string[]) => secrets.reduce((s, secret) => s.split(secret).join(PLACEHOLDER), url);
const encode = (value: string, depth: number) => {
  let out = value;
  for (let i = 0; i < depth; i++) out = encodeURIComponent(out);
  return out;
};
const lowerHex = (value: string) => value.replace(/(%(?:25)*)([0-9A-F]{2})/g, (_, pct: string, hex: string) => pct + hex.toLowerCase());

// 300 real secrets, so the base64url alphabet's `-` and `_` are among them and a pattern that stops at one fails.
const SECRETS = Array.from({ length: 300 }, () => mintClaimSecret());
const S = SECRETS[0]!;

describe("premise: the secrets are real and varied", () => {
  it("unique, URL-safe, `pc_`-prefixed, and both `-` and `_` occur after the prefix", () => {
    expect(new Set(SECRETS).size).toBe(SECRETS.length);
    for (const s of SECRETS) {
      expect(s.startsWith("pc_")).toBe(true);
      expect(encodeURIComponent(s)).toBe(s);
    }
    expect(SECRETS.some((s) => s.slice(3).includes("-"))).toBe(true);
    expect(SECRETS.some((s) => s.slice(3).includes("_"))).toBe(true);
  });
  it("routes.claim() is the page URL the organiser copies", () => {
    expect(routes.claim(S)).toBe(`/claim/${S}`);
  });
});

describe("the claim page URL, /claim/<secret>", () => {
  const FORMS: [string, (s: string) => string][] = [
    ["a bare path (routes.claim)", (s) => routes.claim(s)],
    ["an absolute URL", (s) => `${ORIGIN}${routes.claim(s)}`],
    ["a trailing slash", (s) => `${ORIGIN}${routes.claim(s)}/`],
    ["a query", (s) => `${ORIGIN}${routes.claim(s)}?from=qr`],
    ["a hash", (s) => `${ORIGIN}${routes.claim(s)}#me`],
    ["quoted in a message", (s) => `GET "${ORIGIN}${routes.claim(s)}" failed`],
    ["twice in one string", (s) => `from ${ORIGIN}${routes.claim(s)} to ${ORIGIN}${routes.claim(s)}`],
    ["the claim API (status)", (s) => `${ORIGIN}/api/claims/${s}`],
    ["the claim API (accept)", (s) => `${ORIGIN}/api/claims/${s}/accept`],
    ["the claim API, bare path", (s) => `/api/claims/${s}/accept`],
  ];
  it.each(FORMS)("%s", (_name, build) => {
    let checked = 0;
    for (const secret of SECRETS) {
      const input = build(secret);
      expect(input).toContain(secret);
      const out = scrubScoreUrl(input);
      expect(out).toBe(without(input, secret));
      expect(out).not.toContain(secret);
      expect(scrubScoreUrl(out), "idempotent").toBe(out);
      checked++;
    }
    expect(checked).toBe(SECRETS.length);
  });

  it("keeps the rest of the URL: the route, its query and its hash", () => {
    expect(scrubScoreUrl(`${ORIGIN}${routes.claim(S)}?from=qr#me`)).toBe(`${ORIGIN}/claim/${PLACEHOLDER}?from=qr#me`);
    expect(scrubScoreUrl(`${ORIGIN}/api/claims/${S}/accept`)).toBe(`${ORIGIN}/api/claims/${PLACEHOLDER}/accept`);
  });
});

describe("the claim URL inside another URL (the sign-in next=): encoded at any depth, either hex case", () => {
  const WRAPS: [string, (inner: string) => string][] = [
    ["a login next=", (inner) => `${ORIGIN}/login?next=${inner}`],
    ["a login next= with parameters either side", (inner) => `${ORIGIN}/login?lang=en&next=${inner}&x=1`],
    ["a magic-link page's next=", (inner) => `${ORIGIN}/other?a=1&next=${inner}`],
  ];
  const INNERS: [string, (s: string) => string][] = [
    ["the page", (s) => routes.claim(s)],
    ["the page, absolute", (s) => `${ORIGIN}${routes.claim(s)}`],
    ["the accept API", (s) => `/api/claims/${s}/accept`],
  ];
  it("sweeps every wrap x inner x depth x hex case x secret", () => {
    let checked = 0;
    for (const [wrapName, wrap] of WRAPS) {
      for (const [innerName, inner] of INNERS) {
        for (const depth of [1, 2, 3]) {
          for (const hex of ["upper", "lower"] as const) {
            for (const secret of SECRETS.slice(0, 40)) {
              const encoded = encode(inner(secret), depth);
              const input = hex === "lower" ? lowerHex(wrap(encoded)) : wrap(encoded);
              const label = `${wrapName} / ${innerName} / depth ${depth} / ${hex}`;
              expect(input, `${label}: premise`).toContain(secret);
              const out = scrubScoreUrl(input);
              expect(out, label).toBe(without(input, secret));
              expect(scrubScoreUrl(out), `${label}: idempotent`).toBe(out);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(WRAPS.length * INNERS.length * 3 * 2 * 40);
  });
});

describe("the real consumer: the URL <ClaimAccept> sends when its button is pressed", () => {
  it("is /api/claims/<secret>/accept, and the scrub removes the secret from it (and from a Sentry fetch breadcrumb of it)", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      sent.push(String(input));
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const island = renderIsland(ClaimAccept, { token: S, personName: "Ada" });
      const button = island.tree().find((el) => el.type === "button");
      expect(button, "the island renders its accept button").toBeDefined();
      await (button!.props as { onClick: () => Promise<void> }).onClick();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.length, "the button sent a request").toBeGreaterThan(0);
    const url = sent[0]!;
    expect(url).toBe(`/api/claims/${S}/accept`);
    expect(scrubScoreUrl(url)).toBe(`/api/claims/${PLACEHOLDER}/accept`);
    const event: Event = { event_id: "e1", breadcrumbs: [{ category: "fetch", data: { url, method: "POST" } }] };
    expect(JSON.stringify(scrubSentryEvent(event))).not.toContain(S);
  });
});

describe("what must not be mangled", () => {
  it("routes that merely look like /claim/ are left alone, in every encoding", () => {
    const notClaims = [
      "/claims/abc",
      "/claim",
      "/claimant/abc",
      "/myclaim/abc",
      "/api/claimsx/abc",
      "/api/funnel/claim",
      "/api/v1/persons/00000000-0000-4000-8000-000000000001/claim-invites",
      "/api/v1/me/officiating-claims/00000000-0000-4000-8000-000000000001/accept",
      "/start/claim?lang=en",
    ];
    let checked = 0;
    for (const p of notClaims) {
      for (const form of [p, `${ORIGIN}${p}`, `${ORIGIN}/login?next=${encodeURIComponent(p)}`, `${ORIGIN}/login?next=${encode(p, 2)}`]) {
        // Each URL ALSO names the claim route harmlessly (an encoded `/claim/` with nothing after it), so the cheap
        // pre-check passes and the PATTERN has to leave the look-alike alone.
        const input = `${form}&seen=%2Fclaim%2F`;
        expect(scrubScoreUrl(input), input).toBe(input);
        checked++;
      }
    }
    expect(checked).toBe(notClaims.length * 4);
  });

  it("a claim route with no secret after it is left alone; the positive pair: the real routes DO lose the secret", () => {
    for (const bare of ["/claim/", "/api/claims/", `${ORIGIN}/claim/?from=qr`]) expect(scrubScoreUrl(bare), bare).toBe(bare);
    for (const p of [routes.claim(S), `/api/claims/${S}`, `/api/claims/${S}/accept`]) {
      expect(scrubScoreUrl(`${ORIGIN}${p}?seen=%2Fclaim%2F`)).not.toContain(S);
    }
  });

  it("every claim-named route directory in the app is accounted for here (a new one forces a decision)", () => {
    const dirs: string[] = [];
    const walkDirs = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (/claim/i.test(entry.name)) dirs.push(path.relative(APP_DIR, full));
        walkDirs(full);
      }
    };
    walkDirs(APP_DIR);
    const accounted: Record<string, string> = {
      "claim": "scrubbed: /claim/<secret>",
      "api/claims": "scrubbed: /api/claims/<secret>[/accept]",
      "start/claim": "scrubbed by the one-time token rule: /start/claim?token=",
      "api/funnel/claim": "no secret in the path: the token rides the POST body",
      "api/invites/[token]/claim": "NOT scrubbed here: an invite token is a different credential and has no rule yet",
      "api/v1/me/officiating-claims": "the id of the caller's own pending invite, not a secret",
      "api/v1/persons/[id]/claim-invites": "an id, not a secret",
    };
    expect(dirs.length).toBeGreaterThanOrEqual(5);
    expect([...dirs].sort()).toEqual(Object.keys(accounted).sort());
  });
});

describe("the hooks scrub it wherever an event carries one", () => {
  it("PostHog: a pageview of the claim page, its referrer and an autocaptured link", () => {
    const page = `${ORIGIN}${routes.claim(S)}`;
    const out = posthogBeforeSend({
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: page, $pathname: routes.claim(S), $referrer: page, $elements: [{ attr__href: page }] },
      $set_once: { $initial_current_url: page },
    } as never);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(S);
    expect(out!.properties.$current_url).toBe(`${ORIGIN}/claim/${PLACEHOLDER}`);
  });

  it("Sentry: request URL, transaction, breadcrumbs, spans; a replay's URL list; a recording frame", () => {
    const page = `${ORIGIN}${routes.claim(S)}`;
    const api = `${ORIGIN}/api/claims/${S}/accept`;
    const event: Event = {
      event_id: "e1",
      transaction: `POST /api/claims/${S}/accept`,
      request: { url: api, headers: { Referer: page } },
      breadcrumbs: [{ category: "navigation", data: { from: page, to: `${ORIGIN}/me` } }, { category: "fetch", data: { url: api } }],
      spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": api } }],
    };
    expect(JSON.stringify(scrubSentryEvent(event))).not.toContain(S);
    expect(JSON.stringify(scrubSentryEvent({ type: "replay_event", urls: [page, api] } as unknown as Event))).not.toContain(S);
    const frame = { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { description: api } } };
    expect(JSON.stringify(scrubRecordingEvent(frame))).not.toContain(S);
  });
});
