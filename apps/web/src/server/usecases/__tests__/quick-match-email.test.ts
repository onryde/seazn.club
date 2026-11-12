// Quick match plan 3, Task 1: the link mail at creation (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.6, §7.9,
// C19; plan 3 Amend T1 [B1, B2, B4, D4, A8], the plan-1 carries m3 and G3). A guest who types an address while creating a quick match
// is sent the match's link, once, in the language of the setup form, so they can find the match again.
//
// Driven through the REAL producer: POST /api/quick-match (the guest's setup form) → `createQuickMatch` → the enqueue in the create's
// last transaction (the system org's tenant) → `dispatchNow` after the commit → the outbox's one network seam, the transport, which
// is the only thing replaced here (it is the network). The rows are read back from Postgres.
//
// Expected values come from the spec, the plan and the dictionaries on disk (the copy's authority), never from the code under test:
// the ref type 'quick_match', the system org, `transactional`, the link `<base>/q/<token>` (C19: the token rides the path), the
// subject in the guest's locale, the email limit's 5 per 300 s (EMAIL_LIMIT, plan 3 Amend T1 [B4]), the locale set (LOCALES).
//
// C19: the home token may appear in the mail and nowhere else. Every token this file mints is recorded (a call-through spy on
// `mintHomeToken`), and every log line, Sentry report, PostHog event and console line is searched for each one; the positive pair is
// the mail itself, where the same search finds the token.
//
// One sport, badminton: the mail names no sport, division or fixture, only the match's name and link (§7.6); the offer sweep across
// every sport is plan 1's probe, through the same create.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The outbox's one network seam (the house pattern: trial-ending-outbox.test.ts, outbox-kind-sweep.test.ts).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
// PostHog: a mock, never the live project; its calls are searched for the token.
const ph = vi.hoisted(() => ({ capture: vi.fn<(args: unknown) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: ph.capture,
}));
// The route's fault report, never sent anywhere; searched for the token.
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
// Every log line, recorded (and searched for the token).
const logs = vi.hoisted(() => {
  const lines: unknown[][] = [];
  const rec = (...args: unknown[]) => void lines.push(args);
  const log: Record<string, unknown> = { error: rec, warn: rec, info: rec, debug: rec, fatal: rec, trace: rec };
  log.child = () => log;
  return { lines, log };
});
vi.mock("@/server/logger", () => ({ log: logs.log }));
// Every home token minted in this file, recorded as it is minted (a call-through spy).
const minted = vi.hoisted(() => ({ tokens: [] as string[] }));
vi.mock("@/server/usecases/quick-match-tokens", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-tokens")>();
  return {
    ...real,
    mintHomeToken: () => {
      const token = real.mintHomeToken();
      minted.tokens.push(token);
      return token;
    },
  };
});
// The real post-commit work of the create, through a switch: the compensation case fails it once, AFTER the last transaction committed.
const failAfterCommit = vi.hoisted(() => ({ armed: false }));
vi.mock("@/server/usecases/stages", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/stages")>();
  return {
    ...real,
    afterGenerateCommit: async (...args: Parameters<typeof real.afterGenerateCommit>) => {
      if (failAfterCommit.armed) {
        failAfterCommit.armed = false;
        throw new Error("armed: the work after the create's last commit failed");
      }
      return real.afterGenerateCommit(...args);
    },
  };
});

import * as Sentry from "@sentry/nextjs";
import { sql } from "@/lib/db";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { quickMatchLinkEmail, quickMatchReminderEmail } from "@/lib/email";
import {
  QUICK_MATCH_EXPIRY_DAYS,
  QUICK_MATCH_REMINDER_HOURS_BEFORE,
  QUICK_MATCH_SYSTEM_ORG_ID,
} from "@/lib/quick-match-constants";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { MAX_EXPIRY_MS } from "@/server/email-outbox";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { POST } from "@/app/api/quick-match/route";
import { createQuickMatch, createQuickMatchTree, sealNewHomeToken } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";

const HAS_DB = !!process.env.DATABASE_URL;
const DEVICE_KEK = randomBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", DEVICE_KEK); // every create seals its home token first
/** The base every link is built on, pinned so the expected link is typed here, not read from the code (`baseUrl(req)` prefers it). */
const BASE = "https://qm-mail.test";
/** The plan's values (Amend T1): the outbox reference of a quick match's mails, and EMAIL_LIMIT, 5 per 300 s. */
const REF_TYPE = "quick_match";
const EMAIL_MAX = 5;
const EMAIL_WINDOW_S = 300;
const DAY_MS = 24 * 3600 * 1000;

let BADMINTON_V: string;
const names: string[] = [];
/** A name of this case's own (the system org is shared by every suite and lane, A16), and a client IP of its own (TEST-NET-3). */
const uniq = (): string => {
  const n = `QM mail ${randomUUID().slice(0, 8)}`;
  names.push(n);
  return n;
};
const ip = (): string => `203.0.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const address = (tag: string): string => `delivered+qm_mail-${tag}-${randomUUID().slice(0, 8)}@resend.dev`;
const sides = ["Ravi & Sam", "Priya & Tom"];

type Fields = Record<string, string | string[]>;
/** The setup form's nine fields, as a browser posts them (plan 2 T3). */
const form = (over: Fields = {}): Fields => ({
  name: uniq(), sport_key: "badminton", variant_key: BADMINTON_V, kind: "pair", format: "league",
  sides, plays: "1", email: "", locale: "en", ...over,
});

async function post(fields: Fields, from: string = ip()) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  return POST(new NextRequest("http://localhost/api/quick-match", { method: "POST", body, headers: { "x-forwarded-for": from } }));
}

/** The token a create landed on: `/q/<token>`, the token alone in the path. */
function landedToken(res: Response): string {
  expect(res.status).toBe(303);
  const loc = res.headers.get("location")!;
  expect(loc, "the create landed on its home").toMatch(/^\/q\/qm_[A-Za-z0-9_-]{43}$/);
  return loc.slice("/q/".length);
}

const rowNamed = async (name: string) =>
  (await sql<{ id: string; competition_id: string }[]>`select id, competition_id from quick_matches where name = ${name}`)[0];

type OutboxRow = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  subject: string;
  transactional: boolean;
  status: string;
  attempts: number;
  expires_at: Date;
  created_at: Date;
  meta: Record<string, string>;
};
const mailsAbout = (quickMatchId: string) => sql<OutboxRow[]>`
  select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, transactional, status, attempts, expires_at,
         created_at, meta
    from email_outbox where ref_id = ${quickMatchId} order by created_at`;
const mailsTo = (to: string) => sql<OutboxRow[]>`
  select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, subject, transactional, status, attempts, expires_at,
         created_at, meta
    from email_outbox where lower(recipient) = lower(${to})`;

type Sent = { to: string; subject: string; html: string; text: string; transactional: boolean; idempotencyKey: string };
const sentTo = (to: string): Sent[] => deliverMock.mock.calls.map((c) => c[0] as Sent).filter((m) => m.to === to);

/** The dictionary on disk: the copy's authority. Fills `{name}` tokens as a translator writes them. */
const dictionaries = new Map<Locale, Record<string, string>>();
function copy(locale: Locale, key: string, vars: Record<string, string> = {}): string {
  let d = dictionaries.get(locale);
  if (!d) {
    d = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries", locale, "emails.json"), "utf8")) as Record<string, string>;
    dictionaries.set(locale, d);
  }
  const template = d[key];
  if (typeof template !== "string") throw new Error(`no key ${key} in dictionaries/${locale}/emails.json`);
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), template);
}

/** Every absolute URL in a text. */
const urlsIn = (s: string): string[] => s.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
/** The URLs the shell itself carries on every mail (its footer link, its namespace): read from the shell's file, not typed. */
const SHELL_URLS = new Set(urlsIn(readFileSync(resolve(import.meta.dirname, "../../../lib/email-templates/html/base.html"), "utf8")));
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** Everything a log line, a Sentry report, a PostHog event or a console line carried, as one searchable text (errors included:
 *  `inspect` prints an error's message, stack, cause and own fields). */
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
function sinksText(): { text: string; calls: number } {
  const all: unknown[][] = [
    ...logs.lines,
    ...vi.mocked(Sentry.captureException).mock.calls,
    ...vi.mocked(Sentry.captureMessage).mock.calls,
    ...ph.capture.mock.calls,
    ...consoleSpies.flatMap((s) => s.mock.calls),
  ];
  return { text: all.map((args) => inspect(args, { depth: 20, maxStringLength: Infinity, maxArrayLength: Infinity })).join("\n"), calls: all.length };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
});

beforeEach(() => {
  vi.stubEnv("DEVICE_LINK_KEK", DEVICE_KEK);
  vi.stubEnv("EMAIL_OUTBOX_KEK", "cd".repeat(32)); // the body is sealed at enqueue, as in production
  vi.stubEnv("RESEND_API_KEY", "re_test_quick_match_mail"); // the attempt reaches the transport (the mock), never Resend
  vi.stubEnv("OAUTH_BASE_URL", BASE);
  deliverMock.mockReset();
  deliverMock.mockImplementation(async () => ({ ok: true, providerId: `re_qm_${randomUUID()}` }));
  ph.capture.mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(Sentry.captureMessage).mockClear();
  logs.lines.length = 0;
  for (const s of consoleSpies) s.mockClear();
  minted.tokens.length = 0;
  failAfterCommit.armed = false;
});

afterEach(() => {
  __setRateLimitCounterForTests(null);
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (!HAS_DB) return;
  // The plan-1 delete: the outbox rows by their reference, the row, the competition.
  for (const name of names) {
    const row = await rowNamed(name);
    if (row) await hardDeleteQuickMatchCompetition(row.competition_id);
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the link mail at creation (POST /api/quick-match, the real create, the outbox)", () => {
  it("a create with an email queues exactly one link mail in the guest's locale, sends it in the request, and carries the link", async () => {
    // A clamp premise: the match lives longer than the outbox lets a row live, so the row's expiry is the outbox's bound.
    expect(QUICK_MATCH_EXPIRY_DAYS * DAY_MS, "premise: the match outlives the outbox's row bound").toBeGreaterThan(MAX_EXPIRY_MS);
    let checked = 0;
    for (const locale of LOCALES) {
      const email = address(locale);
      const f = form({ email, locale });
      const before = Date.now();
      const token = landedToken(await post(f));
      const name = f.name as string;
      const row = await rowNamed(name);
      expect(row, `${locale}: the create wrote its row`).toBeDefined();

      const mails = await mailsAbout(row!.id);
      expect(mails, `${locale}: exactly one mail about the match`).toHaveLength(1);
      const [m] = mails;
      expect(m).toMatchObject({
        kind: "quick_match_link",
        ref_type: REF_TYPE,
        ref_id: row!.id,
        org_id: QUICK_MATCH_SYSTEM_ORG_ID, // the tenant insert policy refuses null (V470); the system org's own row
        recipient: email,
        recipient_user_id: null, // a literal address: a guest has no account
        transactional: true,
        meta: {}, // never a token in meta
        subject: copy(locale, "quickMatchLink.subject", { name }),
      });
      if (locale !== "en") {
        expect(m!.subject, `${locale}: the subject is not the English one`).not.toBe(copy("en", "quickMatchLink.subject", { name }));
      }
      // The first attempt is the request's (dispatchNow after the commit): sent, once, under the row's own key.
      expect([m!.status, m!.attempts], `${locale}: sent in the request`).toEqual(["sent", 1]);
      const sent = sentTo(email);
      expect(sent, `${locale}: the transport was reached once for this address`).toHaveLength(1);
      expect(sent[0]!.idempotencyKey).toBe(`email-outbox/${m!.id}`);
      // Worthless once the outbox's bound has passed: the row expires at the bound, never later.
      const bound = before + MAX_EXPIRY_MS;
      expect(m!.expires_at.getTime(), `${locale}: within the outbox's bound`).toBeLessThanOrEqual(Date.now() + MAX_EXPIRY_MS);
      expect(m!.expires_at.getTime(), `${locale}: at the bound, not earlier`).toBeGreaterThan(bound - 60_000);

      // The body: the link (C19: the token rides the PATH) and the name; no other link but the shell's own.
      const link = `${BASE}/q/${token}`;
      const { html, text } = sent[0]!;
      const htmlUrls = urlsIn(html);
      expect(htmlUrls, `${locale}: the html carries the link`).toContain(link);
      expect(htmlUrls.filter((u) => u !== link && !SHELL_URLS.has(u)), `${locale}: no link but the match's and the shell's`).toEqual([]);
      expect(count(html, token), `${locale}: the token only inside the link`).toBe(count(html, link));
      expect(urlsIn(text), `${locale}: the text carries the link and nothing else`).toEqual([link]);
      expect(text).toContain(name);
      expect(html).toContain(name.replaceAll("&", "&amp;"));
      checked++;
    }
    expect(checked, "anti-vacuity: every shipped locale was mailed").toBe(LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a create without an email queues no mail and sends nothing; the next create with one queues exactly one", async () => {
    const quiet = form();
    landedToken(await post(quiet));
    const quietRow = await rowNamed(quiet.name as string);
    expect(quietRow, "premise: the emailless create landed").toBeDefined();
    expect(await mailsAbout(quietRow!.id)).toEqual([]);
    expect(deliverMock).not.toHaveBeenCalled();

    const email = address("second");
    const loud = form({ email });
    landedToken(await post(loud));
    const loudRow = await rowNamed(loud.name as string);
    expect((await mailsAbout(loudRow!.id)).map((m) => m.kind)).toEqual(["quick_match_link"]);
    expect(sentTo(email)).toHaveLength(1);
    expect(await mailsAbout(quietRow!.id), "the first match still has none").toEqual([]);
  });

  it("an address in capitals is mailed as typed, once", async () => {
    // The by-email save compares case-folded (§7.7); the mail goes to the address as the guest typed it.
    const email = address("caps").toUpperCase();
    const f = form({ email });
    landedToken(await post(f));
    expect((await mailsTo(email)).map((m) => m.recipient)).toEqual([email]);
  });

  it("a create that fails after its last transaction committed leaves no link mail behind and sends nothing", async () => {
    const email = address("compensated");
    const f = form({ email });
    failAfterCommit.armed = true;
    const res = await post(f);
    expect(res.status).toBe(303);
    expect(res.headers.get("location"), "a fault, shown as the generic refusal").toBe("/en/play?e=QUICK_MATCH_CREATE_FAILED");
    expect(failAfterCommit.armed, "premise: the failure was reached, after the commit").toBe(false);
    expect(await rowNamed(f.name as string), "the compensation deleted the match").toBeUndefined();
    expect(await mailsTo(email), "and its mail, by its reference").toEqual([]);
    expect(sentTo(email), "nothing was sent for a match that does not exist").toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("the email send limit (plan 3 Amend T1 [B4]): EMAIL_LIMIT, per IP, on emailed creates only", () => {
  /** The limiter's own test seam: a real fixed-window count per key for THIS case's IP; every other key is inert, as with no Redis. */
  function counter(theirIp: string) {
    const counts = new Map<string, number>();
    const seen: { key: string; windowSeconds: number }[] = [];
    __setRateLimitCounterForTests(async (key, windowSeconds) => {
      if (!key.endsWith(`:${theirIp}`)) return null;
      seen.push({ key, windowSeconds });
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { count: n, ttlMs: windowSeconds * 1000 };
    });
    return seen;
  }

  it("five emailed creates land; the sixth is refused before any row is written; an emailless create in the window still lands", async () => {
    const theirs = ip();
    const seen = counter(theirs);
    const emails: string[] = [];
    for (let i = 0; i < EMAIL_MAX; i++) {
      const email = address(`limit${i}`);
      emails.push(email);
      landedToken(await post(form({ email }), theirs)); // no cookie: a new visitor each time, so the alive cap is not what is tested
    }
    expect(emails.filter((e) => sentTo(e).length === 1), "premise: all five were mailed").toHaveLength(EMAIL_MAX);

    const sixth = address("limit-sixth");
    const refused = form({ email: sixth, locale: "nl" });
    const res = await post(refused, theirs);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/nl/play?e=QUICK_MATCH_RATE_LIMITED");
    expect(await rowNamed(refused.name as string), "no row for the refused create").toBeUndefined();
    expect(await mailsTo(sixth), "and no mail").toEqual([]);
    expect(sentTo(sixth)).toEqual([]);
    expect(vi.mocked(Sentry.captureException), "a refusal is not a fault").not.toHaveBeenCalled();

    const quiet = form();
    landedToken(await post(quiet, theirs));
    expect(await rowNamed(quiet.name as string), "an emailless create is not held by the email bucket").toBeDefined();

    // The bucket is its own key, with EMAIL_LIMIT's window, and only an emailed create takes it.
    const emailKey = `rl:quick-match-email:${theirs}`;
    const emailHits = seen.filter((s) => s.key === emailKey);
    expect(emailHits, "one hit per emailed create, the refused one included; none for the emailless one").toHaveLength(EMAIL_MAX + 1);
    expect(new Set(emailHits.map((s) => s.windowSeconds))).toEqual(new Set([EMAIL_WINDOW_S]));
    expect(seen.filter((s) => s.key === `rl:quick-match-create:${theirs}`), "the create's own limit still runs, every time").toHaveLength(
      EMAIL_MAX + 2,
    );
  });
});

describe.skipIf(!HAS_DB)("createQuickMatch: the link mail's own guards (plan 3 Amend T1 [B1, B2])", () => {
  const input = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
    name: uniq(), sport_key: "badminton", variant_key: BADMINTON_V, kind: "pair", format: "league", sides, plays: 1,
    email: null, locale: "en", ...over,
  });
  const visitor = () => hashVisitorKey(mintVisitorKey());

  it("an email with no baseUrl is a programmer error: 500 QUICK_MATCH_BASE_URL_MISSING before anything is minted or written", async () => {
    const reached = vi.fn();
    const i = input({ email: address("nobase") });
    await expect(createQuickMatch(i, { visitorHash: visitor(), _failBeforeGenerateForTests: reached })).rejects.toMatchObject({
      status: 500,
      code: "QUICK_MATCH_BASE_URL_MISSING",
    });
    expect(reached, "the tree was never reached").not.toHaveBeenCalled();
    expect(minted.tokens, "no token was minted").toEqual([]);
    expect(await sql`select 1 from competitions where name = ${i.name}`, "no competition").toHaveLength(0);
    expect(await rowNamed(i.name), "no row").toBeUndefined();
  });

  it("the tree (the probe's way in, unguarded otherwise) refuses an email with no baseUrl too, before it builds anything", async () => {
    const { kind, ...rest } = input({ email: address("tree-nobase") });
    await expect(createQuickMatchTree(rest, kind, { visitorHash: visitor(), home: sealNewHomeToken() })).rejects.toMatchObject({
      status: 500,
      code: "QUICK_MATCH_BASE_URL_MISSING",
    });
    expect(await sql`select 1 from competitions where name = ${rest.name}`, "no competition").toHaveLength(0);
  });

  it("the outbox row id comes back for the route to dispatch: the mail's id with an email, null without (and no baseUrl is needed then)", async () => {
    const email = address("rowid");
    const withMail = await createQuickMatch(input({ email }), { visitorHash: visitor(), baseUrl: BASE });
    const [m] = await mailsAbout(withMail.id);
    expect(withMail.outboxRowId).toBe(m!.id);
    expect(m!.status, "createQuickMatch itself sends nothing: the route dispatches after it returns").toBe("queued");
    expect(sentTo(email)).toEqual([]);

    const without = await createQuickMatch(input(), { visitorHash: visitor() });
    expect(without.outboxRowId).toBeNull();
    expect(await mailsAbout(without.id)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("C19: the home token reaches the mail and nothing else", () => {
  it("no log line, Sentry report, PostHog event or console line carries a token, on a create that mails and on one that faults", async () => {
    // The create that mails.
    const email = address("leak");
    const token = landedToken(await post(form({ email })));
    const [mail] = sentTo(email);
    expect(mail!.html, "positive pair: the search finds the token where it belongs").toContain(token);

    // A create that faults inside its last transaction, after the token was minted: the outbox cannot seal the body (a key that can
    // send but no key to seal with), so the enqueue refuses, the route reports a fault, and the compensation runs.
    vi.stubEnv("EMAIL_OUTBOX_KEK", "");
    const faulted = form({ email: address("leak-fault") });
    const res = await post(faulted);
    expect(res.headers.get("location")).toBe("/en/play?e=QUICK_MATCH_CREATE_FAILED");
    expect(await rowNamed(faulted.name as string), "premise: the fault rolled the match back").toBeUndefined();
    expect(vi.mocked(Sentry.captureException), "premise: the fault was reported").toHaveBeenCalledTimes(1);

    expect(minted.tokens, "premise: both creates minted a token").toHaveLength(2);
    expect(minted.tokens[0]).toBe(token);
    const sinks = sinksText();
    expect(sinks.calls, "anti-vacuity: the sinks recorded something to search").toBeGreaterThan(0);
    for (const t of minted.tokens) expect(sinks.text.includes(t), "a minted token reached a log, Sentry, PostHog or the console").toBe(false);
  });
});

describe("the two templates (no database): the link, the name, and nothing else", () => {
  const link = `${BASE}/q/qm_${"A".repeat(43)}`;
  const saveLink = `${link}/save`;
  const name = `Ravi & Sam's <night>`;

  it("the link mail, in every locale: the dictionary's subject, the link twice at most in the html, once in the text, the name escaped once", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const m = await quickMatchLinkEmail({ name, link, expiresAt: new Date() }, locale);
      expect(m.subject).toBe(copy(locale, "quickMatchLink.subject", { name }));
      expect(urlsIn(m.html).filter((u) => u !== link && !SHELL_URLS.has(u))).toEqual([]);
      expect(urlsIn(m.html)).toContain(link);
      expect(urlsIn(m.text)).toEqual([link]);
      expect(m.html, "the name is escaped").toContain("Ravi &amp; Sam's &lt;night&gt;");
      expect(m.html, "and escaped once, never twice").not.toContain("&amp;amp;");
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the reminder, in every locale: the dictionary's subject, the link and the Save link (a path, never a query), nothing else", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const m = await quickMatchReminderEmail({ name, link, saveLink, expiresAt: new Date() }, locale);
      expect(m.subject).toBe(copy(locale, "quickMatchReminder.subject", { name }));
      const others = urlsIn(m.html).filter((u) => u !== link && u !== saveLink && !SHELL_URLS.has(u));
      expect(others).toEqual([]);
      expect(urlsIn(m.html)).toEqual(expect.arrayContaining([link, saveLink]));
      expect(m.html, "the Save button's label").toContain(copy(locale, "quickMatchReminder.save"));
      expect([...urlsIn(m.text)].sort()).toEqual([link, saveLink].sort());
      expect(m.html).not.toContain("&amp;amp;");
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the reminder's copy says 'tomorrow', which holds only while it goes at most a day before expiry (G3: the constant, not 24)", () => {
    // The sweep (plan 3 Task 2) reminds when expires_at - now <= QUICK_MATCH_REMINDER_HOURS_BEFORE. Moving the constant past a day
    // makes every locale's "tomorrow" false: change quickMatchReminder.* with it.
    expect(QUICK_MATCH_REMINDER_HOURS_BEFORE).toBeGreaterThan(0);
    expect(QUICK_MATCH_REMINDER_HOURS_BEFORE).toBeLessThanOrEqual(24);
  });
});

describe.skipIf(!HAS_DB)("quick_matches.locale is one of the shipped locales (V493, the plan-1 carry m3)", () => {
  it("the CHECK refuses a locale the app does not ship and accepts each one it does; the database's set is LOCALES", async () => {
    const made = await createQuickMatch(
      { name: uniq(), sport_key: "badminton", variant_key: BADMINTON_V, kind: "pair", format: "league", sides, plays: 1, email: null, locale: "en" },
      { visitorHash: hashVisitorKey(mintVisitorKey()) },
    );
    let refused = 0;
    for (const bad of ["xx", "EN", "en-XA", "", "de"]) {
      await expect(sql`update quick_matches set locale = ${bad} where id = ${made.id}`, `'${bad}' is refused`).rejects.toMatchObject({
        code: "23514",
        constraint_name: "quick_matches_locale_valid",
      });
      refused++;
    }
    expect(refused).toBe(5);
    let accepted = 0;
    for (const good of LOCALES) {
      await sql`update quick_matches set locale = ${good} where id = ${made.id}`;
      const [r] = await sql<{ locale: string }[]>`select locale from quick_matches where id = ${made.id}`;
      expect(r!.locale).toBe(good);
      accepted++;
    }
    expect(accepted, "anti-vacuity: every shipped locale was written").toBe(LOCALES.length);

    const [def] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'quick_matches'::regclass and conname = 'quick_matches_locale_valid'`;
    expect(def, "the constraint exists").toBeDefined();
    const members = [...def!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
    expect(members).toEqual([...LOCALES].sort());
  });
});
