// Quick match plan 3, Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7 as amended 2026-11-08, C3,
// C13, C19; plan 3 Amend T5 [D2, B22], ledger carries m5 and "QUICK_MATCH_ERRORS + FLASH, never a raw ?e=taken"): the Save
// button's post, `POST /q/<token>/save/confirm`, the ONE write of the save flow (the save page's GET never writes).
//
// The contract, in the order the route checks it:
//   - a post from another site is refused 403 before anything is read (the proxy's Origin check covers `/api/**` only), and a
//     post that shows no proof of its page at all (neither `Origin` nor `Sec-Fetch-Site`) lands on the generic line unsaved;
//   - an unknown, expired or deleted token lands on its own `/q/<token>`, the dead screen, never on a sign-in;
//   - signed out lands on the sign-in with `next=/q/<token>/save` (C19 amended: the sign-in hand-off is the one place the
//     token may ride a query);
//   - a session staff impersonation started is refused (ledger m5): the match is never saved to the person staff is viewing as;
//   - signed in: `saveQuickMatchForUser` (plan 3 Task 4). Saved, or already yours, lands on the bare home; someone else's
//     lands on the home with `?e=QUICK_MATCH_TAKEN`, printed as `quickMatch.flash.taken`; a match that expired since its
//     token was read lands on the bare home, the dead screen; a fault lands on the generic line and is reported.
// Every answer is a 303 with a relative Location (plan 2's refusal pattern, G6), and the home each one names is the REAL page,
// rendered from that Location.
//
// The real producers: every quick match is made by `createQuickMatch` (the save rig), every session by the real
// `createSession` on a Map-backed cookie jar (so the session the route reads is the one a door SET), the impersonated session
// by the real impersonation page from a real staff token, and the account deletion by the real `DELETE /api/users/me`.
// Stand-ins: `next/headers` (the jar), the limiter, Stripe, the outbox transport, PostHog, Sentry's capture (a spy), the
// viewer's locale, and wrapped seams a case arms: the token read (a row that expires between the read and the save), and the
// save's own transaction (a fault AFTER its UPDATE, inside it: the reminder's cancel, the step that follows the write).
//
// Expected values come from the spec and the plan (the codes' names, the `next` path, 7 days), the dictionaries (each line by
// its key) and the rows the real producers wrote; never from the route's own answer.
//
// Sport: not applicable; saving reads only the `quick_matches` row, so every match is the save rig's one sport (its header).
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every create seals a home token
vi.stubEnv("EMAIL_OUTBOX_KEK", kekBytes(32).toString("hex")); // the account deletion's notice is a sealed outbox row
vi.stubEnv("RESEND_API_KEY", "re_test_quick_match_save_route"); // an attempt reaches the transport (the stand-in), never Resend

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  locale: "en" as "en" | "fr" | "es" | "nl",
  /** Run once, right after the token read answers for this quick match id (a race the route cannot see coming). */
  afterRead: new Map<string, () => Promise<void>>(),
  /** Make the save's transaction fail for this quick match id, AFTER its UPDATE ran (a database fault inside the save). */
  failSave: new Set<string>(),
  /** What the failing transaction itself read back before it threw: the save had written, in the transaction. */
  inTx: new Map<string, string | null>(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.97" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (name: string) => void h.jar.delete(name),
  }),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => h.locale) }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { cancel: vi.fn(async () => ({})) } }) }));
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: vi.fn(async () => ({ ok: true, providerId: `re_qmsave_${crypto.randomUUID()}` })),
}));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(async () => {}),
}));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));
vi.mock("@/server/usecases/quick-match-home", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-home")>();
  return {
    ...real,
    resolveQuickMatchToken: async (token: string) => {
      const row = await real.resolveQuickMatchToken(token);
      const hook = row ? h.afterRead.get(row.id) : undefined;
      if (row && hook) {
        h.afterRead.delete(row.id);
        await hook();
      }
      return row;
    },
  };
});
vi.mock("@/server/usecases/quick-match-save", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-save")>();
  return { ...real, saveQuickMatchForUser: vi.fn(real.saveQuickMatchForUser) };
});
// The save's transaction runs its UPDATE, then cancels the match's queued reminder on the same transaction. An armed match's
// cancel reads the row on that transaction (the write is there) and throws: the fault lands INSIDE the save, after the write.
vi.mock("@/server/email-outbox/cancel", async (orig) => {
  const real = await orig<typeof import("@/server/email-outbox/cancel")>();
  return {
    ...real,
    cancelQueuedEmails: async (...args: Parameters<typeof real.cancelQueuedEmails>) => {
      const [tx, which] = args;
      const armed = (which.refIds ?? []).find((id) => h.failSave.has(id));
      if (armed) {
        const [row] = await tx<{ saved_by_user_id: string | null }[]>`
          select saved_by_user_id from quick_matches where id = ${armed}`;
        h.inTx.set(armed, row?.saved_by_user_id ?? null);
        throw new Error("armed: the save's transaction failed after its UPDATE (test)");
      }
      return real.cancelQueuedEmails(...args);
    },
  };
});

import en from "@/dictionaries/en/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { createImpersonationToken } from "@/lib/admin";
import { plural as pluralRuntime } from "@/lib/i18n-runtime";
import { createQuickMatch, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { saveQuickMatchForUser } from "@/server/usecases/quick-match-save";
import { hashVisitorKey, mintHomeToken, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import {
  addressFor,
  createTypedMatch,
  deleteMadeMatches,
  saveStateOf,
} from "@/server/usecases/__tests__/_quick-match-save-rig";
import ImpersonatePage from "@/app/admin/impersonate/page";
import { DELETE as DELETE_ACCOUNT } from "@/app/api/users/me/route";
import * as confirmRoute from "../save/confirm/route";
import QuickMatchHomePage from "../page";

const { POST } = confirmRoute;
const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://qm-save-route.test";
const DAY_MS = 24 * 3600 * 1000;
/** C1: an unsaved quick match is kept this many days after its last activity. The spec's number, typed. */
const SPEC_EXPIRY_DAYS = 7;
/** The codes the plan names for the two refusals this route lands on the home (ledger carry: a QUICK_MATCH_ERRORS
 *  constant, never a raw `?e=taken`), and the generic one; typed here, so a renamed constant reds. */
const CODE = {
  taken: "QUICK_MATCH_TAKEN",
  impersonated: "QUICK_MATCH_SAVE_IMPERSONATED",
  failed: "QUICK_MATCH_ACTION_FAILED",
} as const;
const saveSpy = vi.mocked(saveQuickMatchForUser);
const reported = () => vi.mocked(Sentry.captureException).mock.calls.map(([err]) => err);

const users: string[] = [];
async function account(tag: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${addressFor(tag)}, 'QM saver', true) returning id`;
  users.push(id);
  return id;
}
/** Sign `userId` in on the jar, as every door does: the real `createSession`. */
async function signIn(userId: string): Promise<void> {
  h.jar.clear();
  await createSession(userId);
}

const madeHere: string[] = [];
/** A quick match the real create makes in another language than the viewer's (the "from another locale" case). */
async function createIn(locale: "fr" | "en"): Promise<CreatedQuickMatch> {
  const [variant] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  const out = await createQuickMatch(
    {
      name: `QM save ${locale} ${randomUUID().slice(0, 8)}`,
      sport_key: "badminton",
      variant_key: variant!.key,
      kind: "pair",
      format: "league",
      sides: ["Ravi & Sam", "Priya & Tom"],
      plays: 1,
      email: null,
      locale,
    },
    { visitorHash: hashVisitorKey(mintVisitorKey()), mailAllowed: async () => true },
  );
  madeHere.push(out.competitionId);
  return out;
}

/** The Save button's post, as a browser sends it from one of our own pages: same origin, no body. */
function confirm(token: string, headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }) {
  return POST(new Request(`${ORIGIN}/q/${token}/save/confirm`, { method: "POST", headers }), {
    params: Promise.resolve({ token }),
  });
}

/** Every Location this file saw: each must be a relative path (the sweep at the end, anti-vacuity). */
const seen: string[] = [];
async function landed(res: Response): Promise<URL> {
  const location = res.headers.get("location") ?? "";
  seen.push(location);
  expect(res.status, `a 303, never JSON (${await res.clone().text()})`).toBe(303);
  return new URL(location, "http://relative.invalid");
}
/** The bare home: `/q/<token>`, nothing in the query. */
async function home(res: Response, token: string): Promise<void> {
  const url = await landed(res);
  expect(`${url.pathname}${url.search}`).toBe(`/q/${token}`);
}
/** The home with one refusal code, `?e=<code>` and nothing else. */
async function refused(res: Response, token: string): Promise<string> {
  const url = await landed(res);
  expect(url.pathname).toBe(`/q/${token}`);
  expect([...url.searchParams.keys()], url.search).toEqual(["e"]);
  return url.searchParams.get("e")!;
}

/** The REAL home a Location names, rendered as Next renders it. */
async function homeAt(res: Response): Promise<string> {
  const url = new URL(res.headers.get("location")!, "http://relative.invalid");
  const token = decodeURIComponent(url.pathname.slice("/q/".length));
  const tree = await QuickMatchHomePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(Object.fromEntries(url.searchParams)),
  });
  return renderToStaticMarkup(tree as ReactElement);
}
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const flashOf = (html: string): string | null => {
  const m = /<p[^>]*data-testid="qm-flash"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  return m ? unescape(m[1]!) : null;
};
const textOf = (html: string, id: string): string | null => {
  const m = new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</(p|span|div|section|h1|button)>`).exec(html);
  return m ? unescape(m[1]!.replace(/<[^>]+>/g, "")).trim() : null;
};
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

beforeAll(async () => {
  process.env.AUTH_SECRET ??= "auth-secret-for-quick-match-save-route-test-0123456789-0123456789";
  if (!HAS_DB) return;
  // The account deletion's landing imports these lazily; loaded once here, as the deletion suite does.
  await import("@/server/usecases/me");
  await import("@/lib/activation");
});
beforeEach(() => {
  h.jar.clear();
  h.locale = "en";
  h.afterRead.clear();
  h.failSave.clear();
  h.inTx.clear();
  saveSpy.mockClear();
  vi.mocked(Sentry.captureException).mockClear();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  await deleteMadeMatches();
  for (const id of madeHere) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  if (users.length > 0) {
    await sql`delete from impersonation_sessions where actor_id = any(${users}::uuid[]) or target_id = any(${users}::uuid[])`;
    await sql`delete from staff_audit_log where actor_id = any(${users}::uuid[])`;
    await sql`delete from organizations where created_by = any(${users}::uuid[])`;
    await sql`delete from subscriptions where owner_user_id = any(${users}::uuid[])`;
    await sql`delete from users where id = any(${users}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("the route's shape", () => {
  it("answers POST only: a GET of /save/confirm is Next's 405, never a write (plan: the GET page never writes)", () => {
    expect(Object.keys(confirmRoute).sort()).toEqual(["POST"]);
  });
});

describe.skipIf(!HAS_DB)("POST /q/<token>/save/confirm", () => {
  it("signed out: the sign-in, carrying next=/q/<token>/save, and nothing written", async () => {
    const qm = await createTypedMatch(null);
    const before = await saveStateOf(qm.id);

    const url = await landed(await confirm(qm.token));

    expect(url.pathname).toBe("/login");
    expect([...url.searchParams.keys()]).toEqual(["next"]);
    // Spec C19 amended: the save page's own path, the one place the token may ride a query.
    expect(url.searchParams.get("next")).toBe(`/q/${qm.token}/save`);
    expect(await saveStateOf(qm.id)).toEqual(before);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("signed in: saved for the person who pressed it, no longer expiring, the typed address forgotten; the home then says Saved", async () => {
    const me = await account("saver");
    const typed = addressFor("typed-by-a-guest");
    const qm = await createTypedMatch(typed); // someone else's address: the button saves for whoever presses it (C3)
    expect((await saveStateOf(qm.id)).email, "premise: an address was typed").toBe(typed);
    await signIn(me);

    const res = await confirm(qm.token);

    await home(res, qm.token);
    const after = await saveStateOf(qm.id);
    expect([after.saved_by_user_id, after.expires_at, after.email]).toEqual([me, null, null]);
    const page = await homeAt(res);
    expect(textOf(page, "qm-saved")).toBe(en["quickMatch.home.saved"]);
    expect(has(page, "qm-save-form"), "no Save on a match the viewer has saved").toBe(false);
    // A saved match is kept until its owner deletes it: its played line has no countdown (branch-fix A I3).
    expect(textOf(page, "qm-played")).toBe(pluralRuntime(en, "quickMatch.home.playedSaved", 1, "en", { played: 0 }));
    expect(flashOf(page)).toBeNull();
  });

  it("twice: the second post is 'already yours', lands on the bare home, and changes nothing", async () => {
    const me = await account("twice");
    const qm = await createTypedMatch(null);
    await signIn(me);
    await home(await confirm(qm.token), qm.token);
    const first = await saveStateOf(qm.id);
    expect(first.saved_by_user_id).toBe(me);

    const res = await confirm(qm.token);

    await home(res, qm.token);
    expect(await saveStateOf(qm.id)).toEqual(first);
    expect(await saveSpy.mock.results.at(-1)!.value).toBe("already_yours");
    expect(flashOf(await homeAt(res)), "no refusal for your own match").toBeNull();
  });

  it("someone else's: refused with QUICK_MATCH_TAKEN, read as the taken line; the match keeps its saver, and the viewer sees neither Save nor Saved", async () => {
    const first = await account("first");
    const second = await account("second");
    const qm = await createTypedMatch(null);
    await signIn(first);
    await home(await confirm(qm.token), qm.token);
    const held = await saveStateOf(qm.id);
    await signIn(second);

    const res = await confirm(qm.token);

    expect(await refused(res, qm.token)).toBe(CODE.taken);
    expect(await saveStateOf(qm.id), "unchanged: still the first saver's").toEqual(held);
    const page = await homeAt(res);
    expect(flashOf(page)).toBe(en["quickMatch.flash.taken"]);
    expect(page).toMatch(/data-testid="qm-flash"[^>]*role="alert"|role="alert"[^>]*data-testid="qm-flash"/);
    expect(has(page, "qm-save-form"), "no Save on someone else's match").toBe(false);
    expect(has(page, "qm-saved"), "and no Saved: it is not theirs").toBe(false);
  });

  it("an expired match (not swept yet) is the dead link: the bare home, nothing saved, never a sign-in", async () => {
    const me = await account("late");
    const qm = await createTypedMatch(null);
    await sql`update quick_matches set expires_at = now() - interval '1 minute' where id = ${qm.id}`;
    const before = await saveStateOf(qm.id);
    for (const session of [null, me]) {
      h.jar.clear();
      if (session) await createSession(session);
      const res = await confirm(qm.token);
      await home(res, qm.token);
      expect(has(await homeAt(res), "qm-dead-link"), `${session ? "signed in" : "signed out"}: the dead screen`).toBe(true);
    }
    expect(await saveStateOf(qm.id)).toEqual(before);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("a match that expires between the token's read and the save is 'gone': the bare home, the dead screen, nothing saved (D13)", async () => {
    const me = await account("race");
    const qm = await createTypedMatch(null);
    h.afterRead.set(qm.id, async () => {
      await sql`update quick_matches set expires_at = now() - interval '1 minute' where id = ${qm.id}`;
    });
    await signIn(me);

    const res = await confirm(qm.token);

    await home(res, qm.token);
    expect(await saveSpy.mock.results.at(-1)!.value, "premise: the save itself answered gone").toBe("gone");
    expect((await saveStateOf(qm.id)).saved_by_user_id).toBeNull();
    expect(has(await homeAt(res), "qm-dead-link")).toBe(true);
  });

  it("an unknown or malformed token lands on its own dead link, signed in or not; a deleted match too", async () => {
    const me = await account("unknown");
    const qm = await createTypedMatch(null);
    await hardDeleteQuickMatchCompetition(qm.competitionId);
    let checked = 0;
    for (const token of [mintHomeToken(), "qm_short", qm.token]) {
      for (const session of [null, me]) {
        h.jar.clear();
        if (session) await createSession(session);
        const res = await confirm(token);
        await home(res, token);
        expect(has(await homeAt(res), "qm-dead-link"), token).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(6);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("a post from another site is 403 before anything is read; the same post from our own page saves (the positive pair)", async () => {
    const me = await account("csrf");
    const qm = await createTypedMatch(null);
    await signIn(me);
    const foreign: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site", origin: "https://games.qm-save-route.test" },
      { origin: "null" },
      // Our own Origin, but the browser says the page was not ours (review m4: the Sec-Fetch-Site rule on its own; a
      // sibling subdomain is `same-site`, an address-bar or extension post `none`).
      { "sec-fetch-site": "same-site", origin: ORIGIN },
      { "sec-fetch-site": "cross-site", origin: ORIGIN },
      { "sec-fetch-site": "none", origin: ORIGIN },
    ];
    let checked = 0;
    for (const headers of foreign) {
      const res = await confirm(qm.token, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.get("location"), JSON.stringify(headers)).toBeNull();
      checked++;
    }
    expect(checked).toBe(8);
    expect((await saveStateOf(qm.id)).saved_by_user_id, "nothing saved by a foreign post").toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();

    // Our own page's post, as each kind of browser sends it: both headers (today's), and either one alone (an older browser
    // with no Sec-Fetch-Site; a same-origin request with no Origin). Each reaches the save.
    let saved = 0;
    for (const headers of [
      { origin: ORIGIN, "sec-fetch-site": "same-origin" },
      { origin: ORIGIN },
      { "sec-fetch-site": "same-origin" },
    ] as Record<string, string>[]) {
      const match = saved === 0 ? qm : await createTypedMatch(null);
      await home(await confirm(match.token, headers), match.token);
      expect((await saveStateOf(match.id)).saved_by_user_id, JSON.stringify(headers)).toBe(me);
      saved++;
    }
    expect(saved).toBe(3);
  });

  it("review m1: a post with no proof of its page (no Origin, no Sec-Fetch-Site, or an empty Origin) is refused: the generic line, nothing saved, not a fault", async () => {
    const me = await account("no-proof");
    await signIn(me);
    let checked = 0;
    for (const headers of [{}, { origin: "" }] as Record<string, string>[]) {
      const qm = await createTypedMatch(null);
      const res = await confirm(qm.token, headers);
      expect(await refused(res, qm.token), JSON.stringify(headers)).toBe(CODE.failed);
      expect((await saveStateOf(qm.id)).saved_by_user_id, JSON.stringify(headers)).toBeNull();
      expect(flashOf(await homeAt(res))).toBe(en["quickMatch.flash.generic"]);
      checked++;
    }
    expect(checked).toBe(2);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(reported(), "a refusal, never reported").toHaveLength(0);
  });

  it("m5: a session staff impersonation started never saves to the person staff is viewing as; their own sign-in then does", async () => {
    const target = await account("impersonated");
    const staff = await account("staff");
    const qm = await createTypedMatch(null);
    const token = await createImpersonationToken(staff, target);
    const thrown = await ImpersonatePage({ searchParams: Promise.resolve({ token }) }).then(
      () => null,
      (e: unknown) => e as { digest?: string },
    );
    expect(String(thrown?.digest), "premise: the page signed the target in and redirected").toContain("/dashboard");

    const res = await confirm(qm.token);

    expect(await refused(res, qm.token)).toBe(CODE.impersonated);
    expect((await saveStateOf(qm.id)).saved_by_user_id, "never saved to the impersonated person").toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(flashOf(await homeAt(res))).toBe(en["quickMatch.flash.impersonating"]);

    // The positive pair, in sequence: the same person, signed in by a door of their own, saves it.
    await signIn(target);
    await home(await confirm(qm.token), qm.token);
    expect((await saveStateOf(qm.id)).saved_by_user_id).toBe(target);
  });

  it("after an account deletion releases the match, it is anybody's to save again; the deleted account's old session is signed out", async () => {
    const leaver = await account("leaver");
    const next = await account("next-saver");
    const qm = await createTypedMatch(null);
    await signIn(leaver);
    await home(await confirm(qm.token), qm.token);
    expect((await saveStateOf(qm.id)).saved_by_user_id).toBe(leaver);
    const leaversCookie = new Map(h.jar);

    // The real deletion, signed in as the leaver (plan 3 Task 4's release runs inside it).
    const del = await DELETE_ACCOUNT(
      new Request(`${ORIGIN}/api/users/me`, { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }),
    );
    expect(del.status, await del.text()).toBe(200);
    const released = await saveStateOf(qm.id);
    expect(released.saved_by_user_id, "released").toBeNull();
    expect(released.expires_at?.getTime(), "7 days after its last activity (C1)").toBe(
      released.last_activity_at.getTime() + SPEC_EXPIRY_DAYS * DAY_MS,
    );

    // The leaver's old cookie, replayed: the deleted account is nobody, so the post goes to the sign-in, nothing saved.
    h.jar.clear();
    for (const [k, v] of leaversCookie) h.jar.set(k, v);
    expect((await landed(await confirm(qm.token))).pathname).toBe("/login");
    expect((await saveStateOf(qm.id)).saved_by_user_id).toBeNull();

    await signIn(next);
    await home(await confirm(qm.token), qm.token);
    const saved = await saveStateOf(qm.id);
    expect([saved.saved_by_user_id, saved.expires_at]).toEqual([next, null]);
  });

  it("from another locale: a match made in French, saved by a Dutch viewer; the save is the same and the home answers in Dutch", async () => {
    const me = await account("nl-viewer");
    const qm = await createIn("fr");
    const [row] = await sql<{ locale: string }[]>`select locale from quick_matches where id = ${qm.id}`;
    expect(row!.locale, "premise: made in French").toBe("fr");
    h.locale = "nl";
    await signIn(me);

    const res = await confirm(qm.token);

    await home(res, qm.token);
    expect((await saveStateOf(qm.id)).saved_by_user_id).toBe(me);
    const page = await homeAt(res);
    expect(textOf(page, "qm-saved")).toBe(nl["quickMatch.home.saved"]);
    expect(textOf(page, "qm-played")).toBe(pluralRuntime(nl, "quickMatch.home.playedSaved", 1, "nl", { played: 0 }));
    // ... and someone else's, refused in Dutch.
    const other = await account("nl-second");
    await signIn(other);
    const taken = await confirm(qm.token);
    expect(await refused(taken, qm.token)).toBe(CODE.taken);
    expect(flashOf(await homeAt(taken))).toBe(nl["quickMatch.flash.taken"]);
  });

  it("a fault inside the save's transaction, after its UPDATE, is reported, lands on the generic line, and rolls the whole save back", async () => {
    const me = await account("fault");
    const typed = addressFor("fault-typed");
    const qm = await createTypedMatch(typed);
    const before = await saveStateOf(qm.id);
    h.failSave.add(qm.id);
    await signIn(me);

    const res = await confirm(qm.token);

    expect(h.inTx.get(qm.id), "premise: the UPDATE had written the saver, inside the transaction, when it failed").toBe(me);
    expect(await refused(res, qm.token)).toBe(CODE.failed);
    expect(reported(), "a fault, not a refusal: reported once").toHaveLength(1);
    expect(await saveStateOf(qm.id), "nothing half-saved: saver, expiry and the typed address all as they were").toEqual(before);
    expect(flashOf(await homeAt(res))).toBe(en["quickMatch.flash.generic"]);
  });

  it("every Location this file saw is a relative path on this site (anti-vacuity: and there were some)", () => {
    expect(seen.length).toBeGreaterThanOrEqual(20);
    for (const location of seen) expect(location, location).toMatch(/^\/(?![/\\])/);
  });
});
