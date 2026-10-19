// A credential that rides a request BODY must not reach Sentry: the event of a one-time-token route loses `request.data`.
//
// The URL rules do not see a body. A POST that spends a one-time token sends it as JSON (`{ token, next }`), so a Sentry
// error on that route carries the working credential in `request.data` after the URL has been scrubbed. The scrubber
// drops the body of an event whose request URL or transaction names such a route, the way a capture route's event is
// recognised (`isCaptureEvent`, A18):
//  - the POST routes that read a credential from the body (`BODY_CREDENTIAL_ROUTES`): the sign-in consume, the email
//    verification, the password reset (its body also holds the NEW password), the email-change confirmation, the funnel
//    claim, and the registrant's access-token calls (withdraw, checkout, resend); and the routes whose body is a PASSWORD,
//    log-in and sign-up (a standing credential rather than a one-time token, but the same leak);
//  - every route whose PATH carries a secret (`SECRET_PATH_PREFIXES`): `/api/invites/<token>/accept|claim`,
//    `/api/claims/<token>/accept`, `/api/checkin/<token>`, `/api/orgs/<id>/invites/<token>/revoke`.
//
// The route lists are not typed here. They come from the app's own directories:
//  - the body credentials: every `app/api/**/route.ts` that names a `token` AND reads a request body is found by a scan, and
//    must carry a verdict in BODY_VERDICTS (a credential, or why its body is not one). A new route that takes a token in
//    its body fails the first test until it takes a side; a verdict whose route is gone fails too;
//  - the passwords: every body-reading route whose schema has a password field (inline, or an exported schema found by
//    scanning src, aliases followed) is derived the same way, so a new change-password or set-password route fails the
//    table-equality test until it is listed; the detector itself is proved on synthetic route sources;
//  - the path secrets: `secretRoutes()` + `VERDICTS` (_route-scan.ts), the same table scrub-path-secrets.test.ts sweeps;
//  - the link routes: `linkBuilders()` (every `<path>?token=${…}` the app emails); the ones under /api/ are routes too.
// The scrubber's own table is exported and must equal what the scan derives, in both directions.
//
// Witnesses are REAL tokens where a minter can run over the fake `sql` tag (the sign-in link, the verification token,
// the reset token, the invite, the check-in code, the claim secret); the funnel and registration tokens are minted by a
// private function or one that needs `sql.json`, so those two are random values of the same shape. The drop does not
// read the value; that is why the assertion is "the body is gone and the token is nowhere in the event".
//
// Sport: not applicable — account and invite credentials are sport-agnostic.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@sentry/nextjs";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
// Only the Postgres round trip is a stand-in: the real minters run on top of it.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));

import { USER_ID } from "./_fake-sql";
import { APP_DIR, SRC_DIR, VERDICTS, linkBuilders, NOT_ONE_TIME, secretRoutes } from "./_route-scan";
import { createLoginLink } from "@/lib/login-link";
import { createVerificationToken } from "@/lib/verification";
import { createPasswordResetToken } from "@/lib/password-reset";
import { createInvite } from "@/server/usecases/invites";
import { mintCheckinToken } from "@/server/usecases/checkin-token";
import { mintClaimSecret } from "@/server/usecases/person-claims";
import { BODY_CREDENTIAL_ROUTES, scrubSentryEvent } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
const MINTS = 12;

// ---- real tokens ---------------------------------------------------------------------------------------------------

const pool = { login: [] as string[], verification: [] as string[], reset: [] as string[], invite: [] as string[], checkin: [] as string[], claim: [] as string[] };
await (async () => {
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  for (let i = 0; i < MINTS; i++) {
    pool.login.push(await createLoginLink(USER_ID));
    pool.verification.push(await createVerificationToken(USER_ID));
    pool.reset.push(await createPasswordResetToken(USER_ID));
    pool.invite.push((await createInvite(randomUUID(), USER_ID, { role: i % 2 ? "admin" : "viewer", max_uses: 1 })).token);
    pool.checkin.push(await mintCheckinToken(randomUUID(), tomorrow));
    pool.claim.push(mintClaimSecret());
  }
})();
/** The two shapes with no runnable minter: a funnel draft token (`randomBytes(32)` base64url) and a registration token (`rg_` + 24). */
const shaped = {
  funnel: randomBytes(32).toString("base64url"),
  registration: "rg_" + randomBytes(24).toString("base64url"),
};
/** What a body-credential route's body can carry: each kind of token the app mints for a body. */
const BODY_WITNESSES = [pool.login[0]!, pool.verification[0]!, pool.reset[0]!, shaped.funnel, shaped.registration];

describe("premise: the tokens are real and varied", () => {
  it("each minter returned its full pool of distinct tokens", () => {
    for (const [kind, tokens] of Object.entries(pool)) {
      expect(tokens, kind).toHaveLength(MINTS);
      expect(new Set(tokens).size, `${kind}: unique`).toBe(MINTS);
    }
    expect(new Set([...BODY_WITNESSES]).size, "five distinct body witnesses").toBe(5);
  });
});

// ---- which routes read a credential from their body: the app's own route files -----------------------------------------

/** A route file reads a request body: `req.json()`, `request.text()`, `req.formData()` or the API's `parseBody(`. */
const READS_BODY = /\b(?:req|request)\.(?:json|text|formData)\(\)|\bparseBody\(/;
const NAMES_TOKEN = /\btoken\b/;

/** Every `app/api/**\/route.ts` that names a `token` AND reads a request body, by its directory under app/. */
function bodyReaders(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        const text = fs.readFileSync(full, "utf8");
        if (READS_BODY.test(text) && NAMES_TOKEN.test(text)) found.push({ key: path.relative(APP_DIR, dir), file: path.relative(APP_DIR, full) });
      }
    }
  };
  walk(path.join(APP_DIR, "api"));
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

/** The verdict on each body reader: `true` = the body carries a credential and is dropped; a string = why it is not one. */
const BODY_VERDICTS: Record<string, true | string> = {
  "api/auth/magic-link/consume": true,
  "api/auth/verify-email": true,
  "api/auth/reset-password": true,
  "api/funnel/claim": true,
  "api/v1/public/registrations/[id]/checkout": true,
  "api/v1/public/registrations/[id]/withdraw": true,
  "api/v1/public/registrations/by-ref/[ref]/withdraw": true,
  "api/v1/public/registrations/groups/[id]/resend": true,
  "api/auth/change-email": "the body is the new address; the token is minted and emailed, never received",
  "api/auth/forgot-password": "the body is an email address; the token is minted and emailed, never received",
  "api/auth/login": "no token in the body (the verification token is minted and emailed); its PASSWORD is dropped by the password scan below",
  "api/auth/signup": "no token in the body (the verification token is minted and emailed); its PASSWORD is dropped by the password scan below",
  "api/auth/magic-link": "the body is an email and a `next`; the token is minted and emailed, never received; a `next` secret path is scrubbed in place",
  "api/funnel/start": "the body is an email and the draft; the claim token is minted and emailed, never received",
  "api/orgs/[id]/invites": "the body is the invite's role, email and limits; the token is only in the response",
  "api/users/me": "the body is a profile patch or the delete confirmation; `token` is a comment about a sealed Lichess token held server-side",
  "api/internal/relay/sessions/[sid]/heartbeat": "the relay token is the Bearer header; the body is heartbeat metrics",
  "api/v1/competitions/[id]/schedule/apply": "`token` is the plan's sequence token (a concurrency check); the body is the plan",
  "api/v1/fixtures/[id]/external-play/arbiter": "the body names the entrant side; the arbiter's token is minted and returned, never received",
  "api/v1/fixtures/[id]/external-play/room/act": "the body is the move; the player's token stays server-side",
  "api/v1/fixtures/[id]/external-play/room": "the body is the held participant's id; `token` is a comment about the seat's token",
};

/** The route directory (`api/v1/public/registrations/[id]/withdraw`) as a URL path, every dynamic segment filled in. */
const pathOf = (key: string) =>
  "/" +
  key
    .split("/")
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .map((seg) => (seg === "[ref]" ? "AB12CD34" : /^\[.*\]$/.test(seg) ? "00000000-0000-4000-8000-000000000001" : seg))
    .join("/");

// ---- which routes read a PASSWORD from their body ---------------------------------------------------------------------

/** A zod field named like a password: `password: z.`, `new_password: z.`, `currentPassword: z.`. Not `password_hash: string`. */
const PASSWORD_FIELD = /\b\w*[pP]assword\b\s*:\s*z\b/;
/** A body destructured straight off the request: `const { email, password } = await req.json()`. */
const PASSWORD_DESTRUCTURED = /\{[^}]*\b\w*[pP]assword\b[^}]*\}\s*=\s*(?:await\s+)?(?:req|request)\.json\(\)/;

/** The exported schemas that carry a password field, and every `export const X = <one of them>` alias, to a fixed point. */
function passwordSchemaNames(sources: string[]): string[] {
  const defs: { name: string; text: string }[] = [];
  for (const source of sources) {
    const parts = source.split(/\n(?=export const \w+\s*=)/);
    for (const part of parts) {
      const m = /^(?:\n)?export const (\w+)\s*=/.exec(part);
      if (m) defs.push({ name: m[1]!, text: part });
    }
  }
  const known = new Set(defs.filter((d) => PASSWORD_FIELD.test(d.text)).map((d) => d.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of defs) {
      if (!known.has(d.name) && [...known].some((k) => new RegExp(`\\b${k}\\b`).test(d.text))) {
        known.add(d.name);
        grew = true;
      }
    }
  }
  return [...known].sort();
}

/** A route file takes a password in its body: it reads a body AND (a password field inline, a destructured one, or a password schema by name). */
function holdsPassword(text: string, schemas: string[]): boolean {
  if (!READS_BODY.test(text)) return false;
  return PASSWORD_FIELD.test(text) || PASSWORD_DESTRUCTURED.test(text) || schemas.some((s) => new RegExp(`\\b${s}\\b`).test(text));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `app/api/**\/route.ts` that takes a password in its body, by its directory under app/. */
function passwordRoutes(): { key: string; schemas: string[] }[] {
  const texts = sourceFiles(SRC_DIR).map((f) => fs.readFileSync(f, "utf8")).filter((s) => /assword/.test(s));
  const schemas = passwordSchemaNames(texts);
  const found: { key: string; schemas: string[] }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts" && holdsPassword(fs.readFileSync(full, "utf8"), schemas)) found.push({ key: path.relative(APP_DIR, dir), schemas });
    }
  };
  walk(path.join(APP_DIR, "api"));
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

const readers = bodyReaders();
const passwordBodies = passwordRoutes();
const passwordKeys = new Set(passwordBodies.map((r) => r.key));
const credentialReaders = readers.filter((r) => BODY_VERDICTS[r.key] === true);
const innocentReaders = readers.filter((r) => typeof BODY_VERDICTS[r.key] === "string" && !passwordKeys.has(r.key));
/** The links the app emails that land on an API route (not a page): `/api/auth/change-email/confirm`. */
const apiLinkRoutes = [...linkBuilders().keys()].filter((r) => r.startsWith("/api/") && !(r in NOT_ONE_TIME));

describe("which routes take a credential in their body: found from the route files, not typed", () => {
  it("the scan found the readers (anti-vacuity), and every one has a verdict; no verdict is stale", () => {
    expect(readers.length).toBeGreaterThanOrEqual(20);
    expect(credentialReaders.length).toBeGreaterThanOrEqual(8);
    expect(
      readers.map((r) => r.key),
      "a route that names a token and reads a body needs a verdict in BODY_VERDICTS",
    ).toEqual(Object.keys(BODY_VERDICTS).sort((a, b) => a.localeCompare(b)));
  });

  it("the password scan found the routes (anti-vacuity): log-in, sign-up and the password reset, and nothing that only mentions a password", () => {
    const keys = passwordBodies.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["api/auth/login", "api/auth/signup", "api/auth/reset-password"]));
    expect(keys.length).toBeGreaterThanOrEqual(3);
    // magic-link/consume and forgot-password mention a password in prose or a function name; neither takes one.
    for (const not of ["api/auth/magic-link/consume", "api/auth/forgot-password", "api/users/me"]) expect(keys, not).not.toContain(not);
    expect(passwordBodies[0]!.schemas, "the exported schemas are found, with their aliases").toEqual(expect.arrayContaining(["loginSchema", "signupSchema"]));
  });

  it("the scrubber's table is exactly the credential readers, the password routes and the API routes a link lands on", () => {
    const derived = [...new Set([...credentialReaders.map((r) => `/${r.key}`), ...passwordBodies.map((r) => `/${r.key}`), ...apiLinkRoutes])].sort();
    expect(derived.length).toBeGreaterThanOrEqual(11);
    expect([...BODY_CREDENTIAL_ROUTES].sort()).toEqual(derived);
    for (const route of BODY_CREDENTIAL_ROUTES) {
      expect(fs.existsSync(path.join(APP_DIR, route, "route.ts")), `${route} is a real route handler`).toBe(true);
    }
  });
});

describe("the password detector, on synthetic route sources (so a new password route is found)", () => {
  const reads = "const body = await req.json();\n";
  it("finds an inline field, a renamed field, a destructured body and an imported schema, and follows an alias", () => {
    expect(holdsPassword(`${reads}const s = z.object({ new_password: z.string() });`, [])).toBe(true);
    expect(holdsPassword(`${reads}const s = z.object({ currentPassword: z.string().min(6) });`, [])).toBe(true);
    expect(holdsPassword("const { current_password, next } = await req.json();", [])).toBe(true);
    expect(holdsPassword("const input = await parseBody(req, SetPassword);", ["SetPassword"])).toBe(true);
    const sources = [
      "export const SetPassword = z.object({\n  password: z.string(),\n}).strict();\nexport const SetPasswordAlias = SetPassword;\nexport const Rename = z.object({\n  name: z.string(),\n});",
    ];
    expect(passwordSchemaNames(sources)).toEqual(["SetPassword", "SetPasswordAlias"]);
  });
  it("ignores a hash column, prose, a route that reads no body, and a schema with no password", () => {
    expect(holdsPassword(`${reads}select password_hash: string | null`, [])).toBe(false);
    expect(holdsPassword(`${reads}// passwordless sign-in\nconst s = z.object({ email: z.string() });`, ["SetPassword"])).toBe(false);
    expect(holdsPassword("const s = z.object({ password: z.string() }); return Response.json({});", [])).toBe(false);
    expect(passwordSchemaNames(["export const Rename = z.object({\n  name: z.string(),\n});"])).toEqual([]);
  });
});

// ---- the sweep: every credential route x every witness x every way an event names it --------------------------------

type Request = NonNullable<Event["request"]>;
const requestOf = (out: Event): Request => out.request ?? {};

/** The three ways an event reaches `beforeSend` naming a route: the request URL, the URL with a query string, the transaction alone. */
const FORMS: { name: string; event: (route: { key: string; url: string }, body: Record<string, unknown>) => Event }[] = [
  {
    name: "request URL, a JSON string body",
    event: ({ url }, body) => ({
      event_id: "e1",
      request: { method: "POST", url: `${ORIGIN}${url}`, headers: { "content-type": "application/json" }, data: JSON.stringify(body) },
    }),
  },
  {
    name: "request URL with a query string, an object body",
    event: ({ url }, body) => ({ event_id: "e2", request: { method: "POST", url: `${ORIGIN}${url}?utm_source=mail`, data: body } }),
  },
  {
    name: "the transaction alone, no request URL",
    event: ({ key }, body) => ({ event_id: "e3", transaction: `POST /${key}`, request: { method: "POST", data: body } }),
  },
];

/** What every dropped event must satisfy, and the failures it collects instead of asserting 100s of times. */
function checkDropped(label: string, input: Event, secret: string, failures: string[]): void {
  const snapshot = structuredClone(input);
  const out = scrubSentryEvent(input);
  if (JSON.stringify(input) !== JSON.stringify(snapshot)) failures.push(`${label}: the input was mutated`);
  if (Object.hasOwn(requestOf(out), "data")) failures.push(`${label}: request.data survived`);
  if (JSON.stringify(out).includes(secret)) failures.push(`${label}: the secret is still in the event`);
  if (requestOf(out).method !== "POST") failures.push(`${label}: the rest of the request was not kept`);
  if (JSON.stringify(scrubSentryEvent(out)) !== JSON.stringify(out)) failures.push(`${label}: not idempotent`);
}

describe("an event on a route that takes a credential in its body loses its body", () => {
  it("every credential reader x every witness x every form", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const reader of credentialReaders) {
      for (const token of BODY_WITNESSES) {
        for (const form of FORMS) {
          checkDropped(`${reader.key} / ${form.name}`, form.event({ key: reader.key, url: pathOf(reader.key) }, { token, next: "/dashboard" }), token, failures);
          checked++;
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(credentialReaders.length * BODY_WITNESSES.length * FORMS.length);
    expect(checked).toBeGreaterThanOrEqual(120);
  });

  it("the API route an emailed link lands on (`/api/auth/change-email/confirm`) loses its body too", () => {
    expect(apiLinkRoutes.length).toBeGreaterThanOrEqual(1);
    const failures: string[] = [];
    let checked = 0;
    for (const route of apiLinkRoutes) {
      for (const token of BODY_WITNESSES) {
        for (const form of FORMS) {
          checkDropped(`${route} / ${form.name}`, form.event({ key: route.slice(1), url: route }, { token, next: "/dashboard" }), token, failures);
          checked++;
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(apiLinkRoutes.length * BODY_WITNESSES.length * FORMS.length);
  });
});

/** What people type: a passphrase, a symbol-heavy one, and one with non-ASCII letters (JSON does not escape those). */
const PASSWORDS = ["correct-horse-battery-1", "Tr0ub4dor&3-xyz", "pässwörd-ß-123"];

describe("an event on a route that takes a PASSWORD in its body loses its body", () => {
  it("every password route x every password x every form", () => {
    expect(passwordBodies.length).toBeGreaterThanOrEqual(3);
    const failures: string[] = [];
    let checked = 0;
    for (const route of passwordBodies) {
      for (const password of PASSWORDS) {
        for (const form of FORMS) {
          const body = { email: "a@example.test", password, next: "/dashboard" };
          checkDropped(`${route.key} / ${form.name}`, form.event({ key: route.key, url: pathOf(route.key) }, body), password, failures);
          checked++;
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(passwordBodies.length * PASSWORDS.length * FORMS.length);
    expect(checked).toBeGreaterThanOrEqual(27);
  });
});

describe("an event on a route that carries a secret in its PATH loses its body", () => {
  const SECRETS: Record<string, string[]> = { invite: pool.invite, checkin: pool.checkin, claim: pool.claim };
  const credentialRoutes = secretRoutes().filter((r) => VERDICTS[r.key] === true);
  const handlers = credentialRoutes.flatMap((r) => r.handlers);

  it("the scan found the handlers (anti-vacuity): the invite, claim, check-in and revoke calls, and the capture routes", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(12);
    const keys = handlers.map((h) => h.key);
    for (const must of ["api/invites/[token]/accept", "api/invites/[token]/claim", "api/claims/[token]/accept", "api/checkin/[token]", "api/orgs/[id]/invites/[token]/revoke"]) {
      expect(keys, must).toContain(must);
    }
  });

  it("every handler x every kind of path secret x every form", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const handler of handlers) {
      for (const secrets of Object.values(SECRETS)) {
        for (const secret of [secrets[0]!, secrets[MINTS - 1]!]) {
          for (const form of FORMS) {
            // The secret is in the URL (scrubbed to `[token]`), and ALSO the body carries it: the body must go.
            const event = form.event({ key: handler.key, url: handler.url(secret) }, { token: secret });
            checkDropped(`${handler.key} / ${form.name}`, event, secret, failures);
            checked++;
          }
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(handlers.length * Object.keys(SECRETS).length * 2 * FORMS.length);
    expect(checked).toBeGreaterThanOrEqual(150);
  });
});

// ---- the positive pair: the same body on any other route is kept ---------------------------------------------------------

describe("the same body on any other route is kept (the positive pair)", () => {
  const body = { email: "a@example.test", note: "hello" };
  const keep = (url: string | undefined, transaction?: string): Event => ({
    event_id: "k",
    ...(transaction ? { transaction } : {}),
    request: { method: "POST", ...(url ? { url } : {}), data: body },
  });

  it("every body reader that is NOT a credential keeps its body, by URL and by transaction", () => {
    expect(innocentReaders.length).toBeGreaterThanOrEqual(11);
    let checked = 0;
    for (const reader of innocentReaders) {
      expect(requestOf(scrubSentryEvent(keep(`${ORIGIN}${pathOf(reader.key)}`))).data, `${reader.key} (${BODY_VERDICTS[reader.key]}): by URL`).toEqual(body);
      expect(requestOf(scrubSentryEvent(keep(undefined, `POST /${reader.key}`))).data, `${reader.key}: by transaction`).toEqual(body);
      checked += 2;
    }
    expect(checked).toBe(innocentReaders.length * 2);
  });

  it("every public secret route (a referral, a registration lookup) keeps its body", () => {
    const publicHandlers = secretRoutes()
      .filter((r) => typeof VERDICTS[r.key] === "string")
      .flatMap((r) => r.handlers)
      .filter((h) => BODY_VERDICTS[h.key] !== true);
    expect(publicHandlers.length).toBeGreaterThanOrEqual(2);
    for (const handler of publicHandlers) {
      expect(requestOf(scrubSentryEvent(keep(`${ORIGIN}${handler.url("AB12CD34")}`))).data, handler.key).toEqual(body);
    }
  });

  it("lookalike routes keep it: a longer name, a nested name, the page route of a POST twin, a route with no body route of its own", () => {
    const urls = [
      `${ORIGIN}/api/auth/verify-email-resend`,
      `${ORIGIN}/api/auth/verify-emails`,
      `${ORIGIN}/api/auth/magic-link/consumed`,
      `${ORIGIN}/api/auth/reset-password/strength`,
      `${ORIGIN}/api/funnel/claim-all`,
      `${ORIGIN}/api/auth/logins`,
      `${ORIGIN}/api/auth/login-history`,
      `${ORIGIN}/api/auth/signup-options`,
      `${ORIGIN}/api/auth/login/google`,
      `${ORIGIN}/api/v1/public/registrations/00000000-0000-4000-8000-000000000001/withdrawn`,
      `${ORIGIN}/api/v1/public/registrations/00000000-0000-4000-8000-000000000001`,
      `${ORIGIN}/api/v1/public/registrations/by-ref/AB12CD34`,
      `${ORIGIN}/api/claims/`,
      `${ORIGIN}/api/claimsets/abc/accept`,
      `${ORIGIN}/api/v1/fixtures/f-1/checkin-link`,
      `${ORIGIN}/api/orgs/00000000-0000-4000-8000-000000000001/invites`,
      `${ORIGIN}/dashboard`,
    ];
    for (const url of urls) expect(requestOf(scrubSentryEvent(keep(url))).data, url).toEqual(body);
    for (const transaction of ["POST /api/auth/verify-emails", "POST /api/funnel/claim-all", "POST /api/orgs/[id]/invites", "POST /api/auth/login-history"]) {
      expect(requestOf(scrubSentryEvent(keep(undefined, transaction))).data, transaction).toEqual(body);
    }
  });

  it("is stateless: events scrubbed back to back, with nothing between them, each lose their body (no regex remembers the last match)", () => {
    // `RegExp.test` on a /g regex resumes at `lastIndex`, so the SECOND event on the same route would slip through.
    // checkDropped scrubs a second time in between, which would hide it; this test does not.
    const withBody = (url: string): Event => ({ event_id: "s", request: { method: "POST", url, data: { token: "t-0123456789" } } });
    const consume = `${ORIGIN}/api/auth/magic-link/consume`;
    const claim = `${ORIGIN}/api/invites/${pool.invite[0]!}/claim`;
    let checked = 0;
    for (const url of [consume, consume, consume, claim, claim, claim, consume, claim]) {
      expect(Object.hasOwn(requestOf(scrubSentryEvent(withBody(url))), "data"), url).toBe(false);
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("an event with no request, and a credential route's event with no body, come back unchanged in shape", () => {
    const bare: Event = { event_id: "n", transaction: "POST /api/funnel/claim" };
    expect(scrubSentryEvent(bare).request).toBeUndefined();
    const noBody: Event = { event_id: "n", request: { method: "POST", url: `${ORIGIN}/api/funnel/claim` } };
    expect(scrubSentryEvent(noBody).request).toEqual({ method: "POST", url: `${ORIGIN}/api/funnel/claim` });
  });
});
