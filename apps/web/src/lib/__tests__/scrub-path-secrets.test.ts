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
//  - NOT credentials, so left alone and said so: `/refer/<code>` (a referral link is shared in public on purpose; it
//    only drops an attribution cookie) and `/r/<ref>`, with `/api/v1/public/registrations/by-ref/<ref>` (a registration
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
import { reportLinkPath } from "@/lib/sponsor-report";
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

// ---- real tokens -------------------------------------------------------------------------------------------------

const MINTS = 300;
const INVITES: string[] = [];
const CHECKINS: string[] = [];
const REPORTS: string[] = [];
const tomorrow = new Date(Date.now() + 24 * 3600_000);
await (async () => {
  for (let i = 0; i < MINTS; i++) {
    const invite = await createInvite(randomUUID(), USER_ID, { role: i % 2 ? "admin" : "viewer", max_uses: 1 });
    INVITES.push(invite.token);
    CHECKINS.push(await mintCheckinToken(randomUUID(), tomorrow));
    REPORTS.push(mintReportToken());
  }
})();
const KINDS: [string, string[]][] = [
  ["invite", INVITES],
  ["check-in", CHECKINS],
  ["sponsor report", REPORTS],
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
    expect(keys.length).toBeGreaterThanOrEqual(12);
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
              expect(scrubScoreUrl(url), `${route.key} (${verdict}): ${url}`).toBe(url);
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
  "/refer": "a referral link is shared in public on purpose",
  "/r": "a registration reference is a lookup, not auth",
  "/api/v1/public/registrations/by-ref": "the same reference, in the public API",
  "/s": "a sponsor's short link is printed on the stream for every viewer on purpose; it only counts a click and redirects",
};

describe("every /<path>/${token} template is scrubbed, or is knowingly public", () => {
  const builders = pathBuilders();

  it("the scan found the builders (anti-vacuity)", () => {
    expect([...builders.keys()].sort()).toEqual(
      expect.arrayContaining(["/join", "/checkin", "/api/checkin", "/claim", "/api/claims", "/api/invites", "/api/orgs/[id]/invites", "/score", "/api/v1/capture/codes", "/refer", "/r", "/api/v1/public/registrations/by-ref", "/r/sponsor"]),
    );
    expect(builders.size).toBeGreaterThanOrEqual(12);
  });

  it("each builder's URL loses its token, or is on the public list with its reason; no public entry is stale", () => {
    let scrubbed = 0;
    let kept = 0;
    for (const [prefix, file] of builders) {
      for (const [kind, tokens] of KINDS) {
        const url = `${ORIGIN}${prefix.replace(/\[id\]/g, "00000000-0000-4000-8000-000000000002")}/${tokens[0]!}`;
        if (prefix in PUBLIC_BUILDERS) {
          expect(scrubScoreUrl(url), `${prefix} (${PUBLIC_BUILDERS[prefix]})`).toBe(url);
          kept++;
        } else {
          expect(scrubScoreUrl(url), `${prefix} / ${kind} (built in ${file}) must be scrubbed, or added to PUBLIC_BUILDERS with a reason`).not.toContain(tokens[0]!);
          scrubbed++;
        }
      }
    }
    for (const prefix of Object.keys(PUBLIC_BUILDERS)) expect(builders.has(prefix), `${prefix} is no longer built anywhere: delete it`).toBe(true);
    expect(scrubbed).toBeGreaterThanOrEqual(18);
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
    expect(credentialRoutes.length).toBeGreaterThanOrEqual(9);
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
      "/shared/chess-club/autumn-open/register/join",
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
    for (const bare of ["/join/", "/checkin/", "/api/invites/", "/api/checkin/", "/r/sponsor/", `${ORIGIN}/join/?from=qr`]) expect(scrubScoreUrl(bare), bare).toBe(bare);
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
