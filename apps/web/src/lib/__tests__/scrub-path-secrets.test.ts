// The invite token and the check-in code must not reach telemetry; the public lookups next to them must.
//
// Credentials that ride the URL PATH (the scrubber's `SECRET_PATH_ROUTES`):
//  - the org invite, `/join/<token>` and its calls `/api/invites/<token>[/accept|/claim]` and
//    `/api/orgs/<id>/invites/<token>/revoke`. 24 random bytes; an hour to never; up to 1000 uses (0 = unlimited); it joins the
//    org as an ADMIN or a viewer, and `/claim` mints a SESSION for a new or unverified invitee. The team screen masks it
//    on purpose (shoulder-surfing). A credential: scrubbed.
//  - the fixture check-in code, `/checkin/<token>` and `/api/checkin/<token>`. An HS256 JWT valid until the fixture's local
//    midnight, the proof that a scanner stood at the venue. The printed QR is for the people in the room; the URL in a
//    telemetry vendor's store is not. A credential: scrubbed.
//  - NOT credentials, so left alone and said so: `/r/<ref>`, with `/api/v1/public/registrations/by-ref/<ref>` (a registration
//    reference is "a lookup, not auth"; the emailed `token` authorises a withdrawal, and that rides the body).
//
// The tokens are minted by the REAL minters (`createInvite`, `mintCheckinToken`; only the Postgres round trip is a
// stand-in, see _fake-sql.ts). The URLs are the app's own routes: every route directory with a secret segment is
// instantiated from the file system, so a new `[token]` route cannot ship without this file taking a side, and a scan
// of every `/<path>/${token}` template (routes.ts included) does the same for builders. The expected value of each case
// is the same string with the token swapped for the placeholder.
//
// Sport: not applicable — invites and check-in are sport-agnostic.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";
import type { Event } from "@sentry/nextjs";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// Only the Postgres round trip is a stand-in: the real minters run on top of it.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));

import { USER_ID } from "./_fake-sql";
import { VERDICTS, secretRoutes, SRC_DIR } from "./_route-scan";
import { createInvite } from "@/server/usecases/invites";
import { mintCheckinToken } from "@/server/usecases/checkin-token";
import { mintReportToken } from "@/server/sponsors/report-token";
import { mintPayToken } from "@/server/usecases/registrations/pay-token";
import { registrationPayPath } from "@/lib/registration-pay";
import { reportLinkPath } from "@/lib/sponsor-report";
import { invoicePath } from "@/lib/sponsor-invoice";
import { mintHomeToken } from "@/server/usecases/quick-match-tokens";
import { routes } from "@/lib/routes";
import { JoinInvite } from "@/components/join-invite";
import { ClaimInvite } from "@/components/claim-invite";
import { CheckinAction } from "@/components/checkin-action";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { posthogBeforeSend, scrubRecordingEvent, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
const PLACEHOLDER = "[token]";

const without = (url: string, ...secrets: string[]) => secrets.reduce((s, secret) => s.split(secret).join(PLACEHOLDER), url);
const encode = (value: string, depth: number) => {
  let out = value;
  for (let i = 0; i < depth; i++) out = encodeURIComponent(out);
  return out;
};
/** The capture rule's placeholder is `[code]`, every other rule's `[token]`: both mean "a secret was here". */
const normalised = (value: string) => value.split("[code]").join(PLACEHOLDER);
const lowerHex = (value: string) => value.replace(/(%(?:25)*)([0-9A-F]{2})/g, (_, pct: string, hex: string) => pct + hex.toLowerCase());
/** What a PUBLIC route's URL becomes: nothing of the route's own is scrubbed, but a quick match home token is a credential
 *  wherever it stands (the bare `qm_` rule, quick match plan 3 Task 5), so one that sits in a public segment becomes
 *  `qm_[token]`. Every other kind of token is left exactly as it was. */
const publicOut = (url: string, kind: string, token: string) => (kind === "home" ? url.split(token).join(`qm_${PLACEHOLDER}`) : url);

// ---- real tokens -------------------------------------------------------------------------------------------------

const MINTS = 300;
const INVITES: string[] = [];
const CHECKINS: string[] = [];
const REPORTS: string[] = [];
/** Player payment page tokens (`/r/pay/<token>`), from the REAL producer. */
const PAYS: string[] = [];
/** A quick match's home token (plan 1's minter; the `/q/<token>` route is plan 2 Task 5's): the fifth kind of credential, after
 *  the player payment page's. */
const HOMES: string[] = Array.from({ length: MINTS }, () => mintHomeToken());
const tomorrow = new Date(Date.now() + 24 * 3600_000);
await (async () => {
  for (let i = 0; i < MINTS; i++) {
    const invite = await createInvite(randomUUID(), USER_ID, { role: i % 2 ? "admin" : "viewer", max_uses: 1 });
    INVITES.push(invite.token);
    CHECKINS.push(await mintCheckinToken(randomUUID(), tomorrow));
    REPORTS.push(mintReportToken());
    PAYS.push(mintPayToken().token);
  }
})();
const KINDS: [string, string[]][] = [
  ["invite", INVITES],
  ["check-in", CHECKINS],
  ["sponsor report", REPORTS],
  ["player pay page", PAYS],
  ["home", HOMES],
];

describe("premise: the tokens are real and varied", () => {
  it("each minter returned its full pool, unique and URL-safe, with `-` and `_` among them (and a JWT's dots in the check-in codes)", () => {
    for (const [kind, tokens] of KINDS) {
      expect(tokens, kind).toHaveLength(MINTS);
      expect(new Set(tokens).size, `${kind}: unique`).toBe(MINTS);
      for (const t of tokens) expect(encodeURIComponent(t), `${kind}: needs no escaping in a URL`).toBe(t);
      expect(tokens.some((t) => t.includes("-")), `${kind} has a '-'`).toBe(true);
      expect(tokens.some((t) => t.includes("_")), `${kind} has a '_'`).toBe(true);
    }
    expect(CHECKINS.every((t) => t.split(".").length === 3), "a check-in code is a three-segment JWT").toBe(true);
  });
  it("routes.checkin() is the page URL the organiser prints", () => {
    expect(routes.checkin(CHECKINS[0]!)).toBe(`/checkin/${CHECKINS[0]}`);
  });
  it("registrationPayPath() is the player payment page URL the mail carries (Task 4 scrubs it)", () => {
    expect(registrationPayPath(PAYS[0]!)).toBe(`/r/pay/${PAYS[0]}`);
    expect(PAYS.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t)), "32 random bytes, base64url").toBe(true);
  });
  it("reportLinkPath() is the sponsor report URL the club shares (S13 builds it, S14 serves it)", () => {
    expect(reportLinkPath(REPORTS[0]!)).toBe(`/r/sponsor/${REPORTS[0]}`);
    expect(REPORTS.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t)), "32 random bytes, base64url").toBe(true);
  });
});

// ---- every route with a secret segment, from the file system (_route-scan.ts) -----------------------------------------------

describe("every route with a secret segment is scrubbed, or is knowingly public", () => {
  const routesFound = secretRoutes();

  it("the scan found the routes (anti-vacuity), and every one has a verdict; no verdict is stale", () => {
    const keys = routesFound.map((r) => r.key).sort();
    expect(keys.length).toBeGreaterThanOrEqual(13);
    expect(keys, "a new [token]/[code]/[secret]/[ref] route needs a verdict in VERDICTS").toEqual(Object.keys(VERDICTS).sort());
  });

  it("each credential route's every URL loses the token, with either kind of real token; each public route's URL is untouched", () => {
    let scrubbed = 0;
    let kept = 0;
    for (const route of routesFound) {
      const verdict = VERDICTS[route.key];
      for (const [kind, tokens] of KINDS) {
        for (const token of [tokens[0]!, tokens[1]!, tokens[150]!, tokens[299]!]) {
          const urls = route.urls(token);
          expect(urls.length, `${route.key} serves at least one URL`).toBeGreaterThan(0);
          for (const url of urls.flatMap((u) => [u, `${ORIGIN}${u}`, `${ORIGIN}${u}?from=qr#top`])) {
            expect(url, "premise: the URL carries the token").toContain(token);
            if (verdict === true) {
              const out = scrubScoreUrl(url);
              expect(out, `${route.key} / ${kind}: ${url}`).not.toContain(token);
              expect(out, `${route.key} / ${kind}: the placeholder is there`).toMatch(/\[(token|code)\]/);
              expect(scrubScoreUrl(out), "idempotent").toBe(out);
              scrubbed++;
            } else {
              expect(scrubScoreUrl(url), `${route.key} (${verdict}): ${url}`).toBe(publicOut(url, kind, token));
              kept++;
            }
          }
        }
      }
    }
    expect(scrubbed).toBeGreaterThan(200);
    expect(kept).toBeGreaterThan(30);
  });
});

// ---- the player payment page (Task 4): `/r/pay/<token>` and its Pay handler --------------------------------------------------

describe("the player payment page's token is scrubbed from every URL shape (counted)", () => {
  it("the sweep reaches /r/pay/[token] and its Pay handler, and each URL's token is gone: plain, encoded at depth 1 and 2, after an origin and a locale prefix", () => {
    const route = secretRoutes().find((r) => r.key === "(public)/r/pay/[token]");
    expect(route, "the file-system scan found the route").toBeDefined();
    expect(VERDICTS["(public)/r/pay/[token]"]).toBe(true);
    expect(route!.handlers.map((h) => h.key)).toEqual(["(public)/r/pay/[token]/pay"]);
    let checked = 0;
    for (const token of [PAYS[0]!, PAYS[1]!, PAYS[150]!, PAYS[299]!]) {
      const shapes = [
        registrationPayPath(token),
        `${registrationPayPath(token)}/pay`,
        `${registrationPayPath(token)}/pay?x=1`,
        `${registrationPayPath(token)}?checkout=success&session_id=cs_test_a1`,
        `/r/pay/${token}#top`,
      ];
      for (const shape of shapes) {
        const forms = [
          shape,
          `${ORIGIN}${shape}`,
          `${ORIGIN}/fr${shape}`,
          `${ORIGIN}/login?next=${encode(shape, 1)}`,
          `${ORIGIN}/login?next=${encode(shape, 2)}`,
          lowerHex(`${ORIGIN}/login?next=${encode(shape, 2)}`),
        ];
        for (const url of forms) {
          expect(url, "premise: the URL carries the token (plain or encoded)").toMatch(new RegExp(`${token}`));
          const out = scrubScoreUrl(url);
          expect(out, url).not.toContain(token);
          expect(out, url).toContain(PLACEHOLDER);
          checked++;
        }
      }
    }
    expect(checked).toBe(4 * 5 * 6);
  });

  it("the regression pair: a registration reference and a sponsor report URL behave as before", () => {
    expect(scrubScoreUrl("/r/ABC123")).toBe("/r/ABC123");
    expect(scrubScoreUrl(`${ORIGIN}/r/ABC123?src=email`)).toBe(`${ORIGIN}/r/ABC123?src=email`);
    expect(scrubScoreUrl(`/r/sponsor/${REPORTS[0]}`)).toBe(`/r/sponsor/${PLACEHOLDER}`);
    // A sponsor token is not mistaken for a pay token and a pay token is not left half-scrubbed.
    expect(scrubScoreUrl(`/r/pay/${PAYS[0]}`)).toBe(`/r/pay/${PLACEHOLDER}`);
  });
});

// ---- builders: every /<path>/${token}-style template -----------------------------------------------------------------

/** Every `/<path>/${<expression naming a token, secret or code>}` template in the app (routes.ts included), by its path, with each
 *  interpolated segment (`${orgId}`) as `[id]`: the invite revoke call is `/api/orgs/[id]/invites/<token>/revoke`, and the path rules are
 *  anchored at the route root, so the tail `/invites` alone is no longer one. */
function pathBuilders(): Map<string, string> {
  const found = new Map<string, string>();
  const segment = "(?:[a-z][a-z0-9-]*|\\$\\{[^}]*\\})";
  const builder = new RegExp(`(\\/${segment}(?:\\/${segment})*)\\/\\$\\{([^}]*)\\}`, "g");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && entry.name !== "scrub-score-url.ts") {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(builder)) {
          // The expression NAMES a secret (`.token`, `invite.token`, `got.secret`, `c.code`, `refCode`), not merely contains the
          // letters (`encodeURIComponent`).
          const key = m[1]!.replace(/\$\{[^}]*\}/g, "[id]");
          if (/(?:^|[.(!\s])(?:token|secret|code|ref_code|refCode|referralCode)\b/.test(m[2]!) && !found.has(key)) {
            found.set(key, path.relative(SRC_DIR, full));
          }
        }
      }
    }
  };
  walk(SRC_DIR);
  return found;
}

/** The builder paths that are knowingly public, each with the reason (the file-system verdicts above, seen from the template). */
const PUBLIC_BUILDERS: Record<string, string> = {
  "/r": "a registration reference is a lookup, not auth",
  "/api/v1/public/registrations/by-ref": "the same reference, in the public API",
  "/s": "a sponsor's short link is printed on the stream for every viewer on purpose; it only counts a click and redirects",
};

describe("every /<path>/${token} template is scrubbed, or is knowingly public", () => {
  const builders = pathBuilders();

  it("the scan found the builders (anti-vacuity)", () => {
    // No `/refer/${code}` builder or route any more: the referral programme is removed (2026-11-11).
    // No `/api/orgs/[id]/invites/${token}/revoke` builder any more: since 2026-11-07 the Team panel revokes by the
    // invite's ID (an email-bound invite's token never reaches it). The route still takes a link's token, so its PATH
    // stays a credential route (VERDICTS, swept above); there is just no template building it from a token.
    expect([...builders.keys()].sort()).toEqual(
      // `/q`: the scoring pad's way back to a quick match's home (app/score/[token]/page.tsx, quick match plan 1 Task 9).
      expect.arrayContaining(["/join", "/checkin", "/api/checkin", "/claim", "/api/claims", "/api/invites", "/score", "/api/v1/capture/codes", "/r", "/api/v1/public/registrations/by-ref", "/r/sponsor", "/r/sponsor/invoice", "/q", "/r/pay"]),
    );
    expect(builders.size).toBeGreaterThanOrEqual(11);
  });

  it("each builder's URL loses its token, or is on the public list with its reason; no public entry is stale", () => {
    let scrubbed = 0;
    let kept = 0;
    for (const [prefix, file] of builders) {
      for (const [kind, tokens] of KINDS) {
        const url = `${ORIGIN}${prefix.replace(/\[id\]/g, "00000000-0000-4000-8000-000000000002")}/${tokens[0]!}`;
        if (prefix in PUBLIC_BUILDERS) {
          expect(scrubScoreUrl(url), `${prefix} (${PUBLIC_BUILDERS[prefix]})`).toBe(publicOut(url, kind, tokens[0]!));
          kept++;
        } else {
          expect(scrubScoreUrl(url), `${prefix} / ${kind} (built in ${file}) must be scrubbed, or added to PUBLIC_BUILDERS with a reason`).not.toContain(tokens[0]!);
          scrubbed++;
        }
      }
    }
    for (const prefix of Object.keys(PUBLIC_BUILDERS)) expect(builders.has(prefix), `${prefix} is no longer built anywhere: delete it`).toBe(true);
    // (11 builders - 3 public) x 5 kinds (invite, check-in, sponsor report, player pay page, home) = 40; 16 at 2 kinds, before
    // plan 2 Task 5 added the home token as a kind, and 32 at 4, before the rebase onto main brought the player pay page token.
    expect(scrubbed).toBeGreaterThanOrEqual(40);
    expect(kept).toBe(Object.keys(PUBLIC_BUILDERS).length * KINDS.length);
  });
});

// ---- the URL inside another URL: encoded at any depth ------------------------------------------------------------------

describe("the credential URLs inside another URL (a sign-in next=): encoded at any depth, either hex case", () => {
  const WRAPS: [string, (inner: string) => string][] = [
    ["a login next=", (inner) => `${ORIGIN}/login?next=${inner}`],
    ["a login next= with parameters either side", (inner) => `${ORIGIN}/login?lang=en&next=${inner}&x=1`],
  ];
  it("sweeps every credential route's URLs x wrap x depth x hex case x token", () => {
    const credentialRoutes = secretRoutes().filter((r) => VERDICTS[r.key] === true);
    expect(credentialRoutes.length).toBeGreaterThanOrEqual(10);
    let checked = 0;
    const failures: string[] = [];
    for (const route of credentialRoutes) {
      for (const [kind, tokens] of KINDS) {
        for (const token of [tokens[0]!, tokens[7]!, tokens[150]!, tokens[299]!]) {
          for (const url of route.urls(token)) {
            for (const [wrapName, wrap] of WRAPS) {
              for (const depth of [1, 2, 3]) {
                for (const hex of ["upper", "lower"] as const) {
                  const encoded = encode(url, depth);
                  const input = hex === "lower" ? lowerHex(wrap(encoded)) : wrap(encoded);
                  const out = scrubScoreUrl(input);
                  const label = `${route.key} / ${kind} / ${wrapName} / depth ${depth} / ${hex}`;
                  if (!input.includes(token)) failures.push(`${label}: premise, the input does not carry the token`);
                  else if (normalised(out) !== without(input, token)) failures.push(`${label}: ${input} -> ${out}`);
                  else if (scrubScoreUrl(out) !== out) failures.push(`${label}: not idempotent`);
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBeGreaterThan(1500);
  });
});

// ---- the real consumers: the URLs the islands send -------------------------------------------------------------------------

describe("the real consumers: the URL each island sends when its button is pressed", () => {
  async function pressed<P extends object>(Island: (props: P) => ReactNode, props: P): Promise<string> {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      sent.push(String(input));
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const island = renderIsland(Island, props);
      const button = island.tree().find((el) => el.type === "button");
      expect(button, "the island renders its button").toBeDefined();
      await (button!.props as { onClick: () => Promise<void> }).onClick();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.length, "the button sent a request").toBeGreaterThan(0);
    return sent[0]!;
  }

  it.each([
    ["JoinInvite", async (t: string) => pressed(JoinInvite, { token: t }), (t: string) => `/api/invites/${t}/accept`],
    ["ClaimInvite", async (t: string) => pressed(ClaimInvite, { token: t }), (t: string) => `/api/invites/${t}/claim`],
  ])("%s sends the invite token in its path", async (_name, send, expected) => {
    const token = INVITES[0]!;
    const url = await send(token);
    expect(url).toBe(expected(token));
    expect(scrubScoreUrl(url)).toBe(without(url, token));
    const event: Event = { event_id: "e1", breadcrumbs: [{ category: "fetch", data: { url, method: "POST" } }] };
    expect(JSON.stringify(scrubSentryEvent(event))).not.toContain(token);
  });

  it("CheckinAction sends the check-in code in its path", async () => {
    const token = CHECKINS[0]!;
    const url = await pressed(CheckinAction, { token });
    expect(url).toBe(`/api/checkin/${token}`);
    expect(scrubScoreUrl(url)).toBe(`/api/checkin/${PLACEHOLDER}`);
  });
});

// ---- what must not be mangled ---------------------------------------------------------------------------------------------

describe("what must not be mangled", () => {
  it("routes that merely look like a credential prefix are left alone, in every encoding", () => {
    const uuid = "00000000-0000-4000-8000-000000000001";
    const notSecrets = [
      "/live/chess-club/autumn-open/register/join",
      "/api/v1/public/orgs/chess-club/competitions/autumn-open/register/join",
      "/join",
      "/joined/abc",
      "/joiner/abc",
      `/api/v1/fixtures/${uuid}/checkin-link`,
      "/checkins/abc",
      "/checkin",
      `/api/orgs/${uuid}/invites`,
      `/api/v1/officials/${uuid}/invite`,
      "/invite/abc",
      "/uninvites/abc",
      `/api/v1/persons/${uuid}/claim-invites`,
      "/api/v1/me/officiating-claims",
      // `/r/<ref>` is a registration lookup, not auth - a reference literally "sponsor" included - and `/r/sponsor/` is a
      // route root only at the root.
      "/r/RS-4K7Q2M",
      "/r/sponsor",
      "/o/acme/r/sponsor/not-a-root",
      "/r/pay",
      "/o/acme/r/pay/not-a-root",
    ];
    let checked = 0;
    for (const p of notSecrets) {
      for (const form of [p, `${ORIGIN}${p}`, `${ORIGIN}/login?next=${encodeURIComponent(p)}`, `${ORIGIN}/login?next=${encode(p, 2)}`]) {
        // Each URL ALSO names a credential prefix harmlessly (an encoded `/join/` with nothing after it), so the cheap
        // pre-check passes and the PATTERN has to leave the look-alike alone.
        const input = `${form}&seen=%2Fjoin%2F`;
        expect(scrubScoreUrl(input), input).toBe(input);
        checked++;
      }
    }
    expect(checked).toBe(notSecrets.length * 4);
  });

  it("a prefix with no secret after it is left alone; the positive pair: the real routes DO lose the secret", () => {
    for (const bare of ["/join/", "/checkin/", "/api/invites/", "/api/checkin/", "/r/sponsor/", "/r/pay/", `${ORIGIN}/join/?from=qr`]) expect(scrubScoreUrl(bare), bare).toBe(bare);
    for (const p of [`/join/${INVITES[0]}`, `/checkin/${CHECKINS[0]}`, `/api/invites/${INVITES[0]}/claim`, `/api/orgs/${randomUUID()}/invites/${INVITES[1]}/revoke`]) {
      expect(scrubScoreUrl(`${ORIGIN}${p}?seen=%2Fjoin%2F`)).not.toMatch(new RegExp(`${INVITES[0]}|${CHECKINS[0]}|${INVITES[1]}`));
    }
  });
});

// ---- the hooks ------------------------------------------------------------------------------------------------------------

describe("the hooks scrub them wherever an event carries one", () => {
  const invite = INVITES[0]!;
  const checkin = CHECKINS[0]!;
  const joinUrl = `${ORIGIN}/join/${invite}`;
  const checkinUrl = `${ORIGIN}${routes.checkin(checkin)}`;

  it("PostHog: the pageview of the join page and of the check-in page, with their $pathname, referrer and links", () => {
    for (const [url, secret, pathname] of [
      [joinUrl, invite, `/join/${invite}`],
      [checkinUrl, checkin, `/checkin/${checkin}`],
    ] as const) {
      const out = posthogBeforeSend({
        uuid: "u1",
        event: "$pageview",
        properties: { $current_url: url, $pathname: pathname, $referrer: url, $elements: [{ attr__href: url }] },
        $set_once: { $initial_current_url: url },
      } as unknown as CaptureResult);
      expect(out).not.toBeNull();
      expect(JSON.stringify(out)).not.toContain(secret);
      expect(out!.properties.$pathname).toBe(without(pathname, secret));
    }
  });

  it("PostHog and Sentry: the sponsor report page (S14) - $current_url, $pathname, referrer, the transaction and a navigation breadcrumb", () => {
    const report = REPORTS[0]!;
    const url = `${ORIGIN}${reportLinkPath(report)}`;
    const out = posthogBeforeSend({
      uuid: "u2",
      event: "$pageview",
      properties: { $current_url: url, $pathname: reportLinkPath(report), $referrer: url },
      $set_once: { $initial_current_url: url },
    } as unknown as CaptureResult);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(report);
    expect(out!.properties.$pathname).toBe("/r/sponsor/[token]");
    const event = scrubSentryEvent({
      event_id: "e2",
      transaction: `GET /r/sponsor/${report}`,
      request: { url, headers: { Referer: url } },
      breadcrumbs: [{ category: "navigation", data: { from: `${ORIGIN}/`, to: url } }],
    } as Event);
    expect(JSON.stringify(event)).not.toContain(report);
    expect(event.transaction).toBe("GET /r/sponsor/[token]");
  });

  it("the sponsor invoice link (T22, F21): the page, its /pdf and its /pay lose the TOKEN itself, not the segment before it", () => {
    // The invoice token is minted by the same minter as the report's (mintReportToken), so the report pool is a pool of real
    // invoice tokens. "/r/sponsor/" matched first would scrub the segment `invoice` and leave the token: each case reads the
    // token's absence AND where the placeholder landed.
    let checked = 0;
    for (const token of [REPORTS[0]!, REPORTS[1]!, REPORTS[150]!, REPORTS[299]!]) {
      for (const tail of ["", "/pdf", "/pay"]) {
        const page = `${invoicePath(token)}${tail}`;
        expect(page, "premise").toContain(token);
        for (const url of [page, `${ORIGIN}${page}`, `${ORIGIN}/fr${page}?from=mail#top`, `POST ${page}`]) {
          const out = scrubScoreUrl(url);
          expect(out, url).not.toContain(token);
          expect(out, url).toContain(`/r/sponsor/invoice/[token]${tail}`);
          checked++;
        }
        const next = `${ORIGIN}/login?next=${encodeURIComponent(`${ORIGIN}${page}`)}`;
        expect(scrubScoreUrl(next), next).not.toContain(token);
        checked++;
      }
    }
    const url = `${ORIGIN}${invoicePath(REPORTS[2]!)}`;
    const out = posthogBeforeSend({
      uuid: "u3",
      event: "$pageview",
      properties: { $current_url: url, $pathname: invoicePath(REPORTS[2]!), $referrer: url },
      $set_once: { $initial_current_url: url },
    } as unknown as CaptureResult);
    expect(JSON.stringify(out)).not.toContain(REPORTS[2]!);
    expect(out!.properties.$pathname).toBe("/r/sponsor/invoice/[token]");
    expect(checked).toBe(60);
  });

  it("Sentry: request URL, transaction, breadcrumbs, spans, a replay's URL list and a recording frame", () => {
    const api = `${ORIGIN}/api/invites/${invite}/claim`;
    const event: Event = {
      event_id: "e1",
      transaction: `POST /api/invites/${invite}/claim`,
      request: { url: api, headers: { Referer: joinUrl } },
      breadcrumbs: [{ category: "navigation", data: { from: joinUrl, to: checkinUrl } }, { category: "fetch", data: { url: api } }],
      spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": api } }],
    };
    const out = JSON.stringify(scrubSentryEvent(event));
    expect(out).not.toContain(invite);
    expect(out).not.toContain(checkin);
    expect(JSON.stringify(scrubSentryEvent({ type: "replay_event", urls: [joinUrl, checkinUrl] } as unknown as Event))).not.toMatch(
      new RegExp(`${invite}|${checkin}`),
    );
    const frame = { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { description: api } } };
    expect(JSON.stringify(scrubRecordingEvent(frame))).not.toContain(invite);
  });
});

// ---- a quick match's home token, `/q/<token>` -----------------------------------------------------------------------------
//
// Quick match plan 1 Task 9 (spec C12, O3, C19): the scoring pad links back to `/q/<home token>`, and whoever holds that token
// can score every match of the quick match. Plan 2 Task 5 added the page (`app/q/[token]`) and its verdict, so the file-system
// sweeps above now reach the route with every kind of token, and the home tokens are a kind of their own (`KINDS`). This
// block keeps the shapes the file system cannot list: the locale prefix, the calls under the page, a log line.

describe("a quick match's home token, /q/<token>: scrubbed wherever a URL carries it", () => {
  const sample = [HOMES[0]!, HOMES[7]!, HOMES[150]!, HOMES[299]!];
  /** Every shape the home URL takes: the page, behind an origin and the marketing locale prefix, with a query and a
   *  fragment, and the calls under it (plan 2's add-match route; the save hand-off spec C19 amended 2026-11-08 allows in a
   *  sign-in `next`). The first one is the pad's own href. */
  const forms = (t: string) => [
    `/q/${t}`,
    `/q/${t}/`,
    `${ORIGIN}/q/${t}`,
    `${ORIGIN}/q/${t}?from=pad#up-next`,
    `${ORIGIN}/fr/q/${t}`,
    `/q/${t}/add-match`,
    `/q/${t}/save`,
    `GET /q/${t}`,
    `navigated to "/q/${t}"`,
  ];

  it("premise: the tokens are real home tokens, unique, URL-safe, with `-` and `_` in their bodies", () => {
    expect(HOMES).toHaveLength(MINTS);
    expect(new Set(HOMES).size).toBe(MINTS);
    for (const t of HOMES) {
      expect(t.startsWith("qm_"), t).toBe(true);
      expect(encodeURIComponent(t), "needs no escaping in a URL").toBe(t);
    }
    expect(HOMES.some((t) => t.slice(3).includes("-")), "a '-' after the prefix").toBe(true);
    expect(HOMES.some((t) => t.slice(3).includes("_")), "a '_' after the prefix").toBe(true);
  });

  it("every form loses the token and keeps everything else, idempotently", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const t of sample) {
      for (const input of forms(t)) {
        const out = scrubScoreUrl(input);
        if (out !== without(input, t)) failures.push(`${input} -> ${out}`);
        else if (scrubScoreUrl(out) !== out) failures.push(`${input}: not idempotent`);
        checked++;
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(sample.length * forms("x").length);
    expect(checked).toBeGreaterThan(0);
  });

  it("inside another URL (a sign-in next=): encoded at depths 1 to 3, either hex case", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const t of sample) {
      for (const url of [`/q/${t}`, `${ORIGIN}/q/${t}?from=pad`, `/q/${t}/save`]) {
        for (const depth of [1, 2, 3]) {
          for (const hex of ["upper", "lower"] as const) {
            const wrapped = `${ORIGIN}/login?lang=fr&next=${encode(url, depth)}&x=1`;
            const input = hex === "lower" ? lowerHex(wrapped) : wrapped;
            const out = scrubScoreUrl(input);
            if (!input.includes(t)) failures.push(`${input}: premise, the input does not carry the token`);
            else if (out !== without(input, t)) failures.push(`${input} -> ${out}`);
            checked++;
          }
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(sample.length * 3 * 3 * 2);
  });

  it("a `q` that is not the route root is an address and is left alone; the positive pair loses the token", () => {
    const t = HOMES[0]!;
    // The segment after a slug `q`, with no home token's `qm_` in front: what the ROOT anchor alone decides (a home token
    // itself is scrubbed wherever it stands, by the bare rule, below).
    const segment = t.slice("qm_".length);
    // A competition or club slug `q` sits after a path segment, never at the root; `/quick/`, `/qr/` and `/faq/` are other words.
    const addresses = (x: string) => [`/o/club/c/q/${x}`, `/live/club/q/${x}`, `/quick/${x}`, `/qr/${x}`, `/faq/${x}`];
    const plain = [...addresses(segment), "/q", "/q/", `${ORIGIN}/q/?from=pad`];
    let checked = 0;
    for (const p of plain) {
      for (const input of [p, p.startsWith("/") ? `${ORIGIN}${p}` : p]) {
        expect(scrubScoreUrl(input), input).toBe(input);
        checked++;
      }
    }
    expect(checked).toBe(plain.length * 2);
    expect(scrubScoreUrl(`${ORIGIN}/q/${t}`)).toBe(`${ORIGIN}/q/${PLACEHOLDER}`);
    expect(scrubScoreUrl(`${ORIGIN}/q/${segment}`), "the root rule takes any segment after /q/").toBe(`${ORIGIN}/q/${PLACEHOLDER}`);
    // Plan 3 Task 5: a real home token at any of those addresses is still the match's credential, scrubbed by the bare rule.
    let bare = 0;
    for (const p of addresses(t)) {
      expect(scrubScoreUrl(`${ORIGIN}${p}`), p).toBe(`${ORIGIN}${p.split(t).join(`qm_${PLACEHOLDER}`)}`);
      bare++;
    }
    expect(bare).toBe(5);
  });

  it("PostHog: the home's pageview, and an autocaptured click on the pad's back link", () => {
    const t = HOMES[1]!;
    const url = `${ORIGIN}/q/${t}`;
    const out = posthogBeforeSend({
      uuid: "u1",
      event: "$autocapture",
      properties: {
        $current_url: url,
        $pathname: `/q/${t}`,
        $referrer: url,
        $elements: [{ tag_name: "a", attr__href: `/q/${t}`, $el_text: "Back to the quick match" }],
      },
      $set_once: { $initial_current_url: url },
    } as unknown as CaptureResult);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(t);
    expect(out!.properties.$pathname).toBe(`/q/${PLACEHOLDER}`);
  });

  it("Sentry: the navigation from the pad to the home, its transaction, request, spans and a replay's URLs", () => {
    const t = HOMES[2]!;
    const home = `${ORIGIN}/q/${t}`;
    const event: Event = {
      event_id: "e1",
      transaction: `GET /q/${t}`,
      request: { url: home, headers: { Referer: home } },
      breadcrumbs: [{ category: "navigation", data: { from: "/score/[token]", to: `/q/${t}` } }],
      spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": home } }],
    };
    expect(JSON.stringify(scrubSentryEvent(event))).not.toContain(t);
    expect(JSON.stringify(scrubSentryEvent({ type: "replay_event", urls: [home] } as unknown as Event))).not.toContain(t);
  });
});
