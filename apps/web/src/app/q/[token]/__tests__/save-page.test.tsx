// Quick match plan 3, Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7 as amended 2026-11-08, C2, C3,
// C13, C19; plan 3 Amend T5 [D2, B22, B24, B25], branch review B I1): the save page, `GET /q/<token>/save`, and the home's
// Save control.
//
// The save page NEVER writes. It is where the sign-in hand-off lands (`next=/q/<token>/save`) and where the reminder mail's
// "Save it" opens, and it shows one of four things:
//   - an unknown, malformed, expired or deleted token: plan 2's dead screen (`qm-dead-link`), which never says which;
//   - signed in and the match is already yours: straight to the home;
//   - saved by somebody else: the taken line, `quickMatch.flash.taken`, and a way back to the match;
//   - anything else: one button. The match's name in `quickMatch.save.title`, `quickMatch.save.hint`, and a plain
//     `<form method="post">` to `/q/<token>/save/confirm` labelled `quickMatch.home.save`, so it works with no script.
// Its words are the VIEWER's (`resolveLocale()` with no org default), it is never indexed, and everything on it that holds
// the token carries `ph-no-capture` (the token is the match's credential, O3).
//
// The home's Save (the actions row plan 2 D13 left without it): the same form on a match nobody has saved, for anyone,
// signed in or not (C3); "Saved" for its saver; nothing for anyone else.
//
// Branch review B I1: the reminder mail's "Save it" must open THIS page. That case drives the real chain: a match made with an
// address by the real create, reminded by the real sweep, its mail sent by the real outbox worker through the one mocked
// seam (the transport); the link is taken from the HTML that was sent, matched against this page's own route on disk, and
// the page rendered from it.
//
// The real producers: every quick match by `createQuickMatch` (the save rig), every session by the real `createSession` on a
// Map-backed jar, the saves by the real `saveQuickMatchForUser` (behind a spy that counts its calls, so "never writes" is two
// facts: the row unchanged, and the save never called). Expected values come from the spec and the plan (the codes, the
// paths), the dictionaries (each line by its key) and the rows the producers wrote.
//
// Sport: not applicable; the page reads only the `quick_matches` row (the save rig's header says why one sport).
// Real Postgres required; the DB cases skip without DATABASE_URL.
import { randomBytes as kekBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every create seals a home token
vi.stubEnv("EMAIL_OUTBOX_KEK", "ab".repeat(32)); // the reminder's body is sealed at enqueue, as in production
vi.stubEnv("RESEND_API_KEY", "re_test_quick_match_save_page"); // the worker's attempt reaches the transport (the mock)

const h = vi.hoisted(() => ({ jar: new Map<string, string>(), locale: "en" as "en" | "fr" | "es" | "nl" }));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (name: string) => void h.jar.delete(name),
  }),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => h.locale) }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(async () => {}),
}));
vi.mock("@/server/usecases/quick-match-save", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-save")>();
  return { ...real, saveQuickMatchForUser: vi.fn(real.saveQuickMatchForUser) };
});

import en from "@/dictionaries/en/ui.json";
import enEmails from "@/dictionaries/en/emails.json";
import fr from "@/dictionaries/fr/ui.json";
import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { FIRST_ATTEMPT_WINDOW_MS } from "@/server/email-outbox";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { saveQuickMatchForUser } from "@/server/usecases/quick-match-save";
import { sweepQuickMatches } from "@/server/usecases/quick-match-sweep";
import { mintHomeToken } from "@/server/usecases/quick-match-tokens";
import {
  addressFor,
  createTypedMatch,
  deleteMadeMatches,
  saveStateOf,
} from "@/server/usecases/__tests__/_quick-match-save-rig";
import QuickMatchSavePage, { generateMetadata } from "../save/page";
import QuickMatchHomePage from "../page";

const HAS_DB = !!process.env.DATABASE_URL;
const saveSpy = vi.mocked(saveQuickMatchForUser);
/** The class session replay never records (scrub-secret-painters.test.ts). */
const NO_CAPTURE = "ph-no-capture";

const en_ = (key: keyof typeof en, vars?: Record<string, string | number>) => tRuntime(en, key, vars);
const fr_ = (key: keyof typeof fr, vars?: Record<string, string | number>) => tRuntime(fr, key, vars);
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const textOf = (html: string, id: string): string | null => {
  const m = new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</(p|span|div|section|h1|a|button)>`).exec(html);
  return m ? unescape(m[1]!.replace(/<[^>]+>/g, "")).trim() : null;
};
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
/** An element's opening tag by its test id. */
const tagOf = (html: string, id: string): string | null => new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? null;
const attr = (tag: string | null, name: string): string | null => (tag ? (new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null) : null);

/** The save page, as Next renders it; a redirect comes back as its target. */
async function savePage(token: string): Promise<{ html: string } | { redirect: string }> {
  try {
    const tree = await QuickMatchSavePage({ params: Promise.resolve({ token }) });
    return { html: renderToStaticMarkup(tree as ReactElement) };
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? "");
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    // NEXT_REDIRECT;<type>;<url>;<status>;
    return { redirect: digest.split(";")[2]! };
  }
}
async function htmlOf(token: string): Promise<string> {
  const out = await savePage(token);
  if (!("html" in out)) throw new Error(`expected a page, got a redirect to ${out.redirect}`);
  return out.html;
}
/** The home, as Next renders it (no flash). */
async function homeOf(token: string): Promise<string> {
  const tree = await QuickMatchHomePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(tree as ReactElement);
}

const users: string[] = [];
async function account(tag: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${addressFor(tag)}, 'QM save page', true) returning id`;
  users.push(id);
  return id;
}
async function signIn(userId: string): Promise<void> {
  h.jar.clear();
  await createSession(userId);
}

/** The confirm form a page draws: its method, its action, its button's words, and whether replay is blocked on it. */
function confirmForm(html: string) {
  const form = tagOf(html, "qm-save-form");
  if (!form) return null;
  const button = /<form[^>]*data-testid="qm-save-form"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
  return {
    method: attr(form, "method"),
    action: attr(form, "action"),
    blocked: (attr(form, "class") ?? "").split(/\s+/).includes(NO_CAPTURE),
    label: unescape(button.replace(/<[^>]+>/g, "")).trim(),
    submit: /<button[^>]*type="submit"/.test(button),
  };
}

beforeAll(() => {
  process.env.AUTH_SECRET ??= "auth-secret-for-quick-match-save-page-test-0123456789-0123456789";
});
beforeEach(() => {
  h.jar.clear();
  h.locale = "en";
  saveSpy.mockClear();
  deliverMock.mockReset();
  deliverMock.mockImplementation(async () => ({ ok: true, providerId: `re_qmsavepage_${crypto.randomUUID()}` }));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  await deleteMadeMatches();
  if (users.length > 0) {
    await sql`delete from organizations where created_by = any(${users}::uuid[])`;
    await sql`delete from users where id = any(${users}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("the save page's metadata", () => {
  it("is never indexed, and is titled in the viewer's words", async () => {
    h.locale = "fr";
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.title).toBe(fr_("quickMatch.home.save"));
  });
});

describe.skipIf(!HAS_DB)("GET /q/<token>/save", () => {
  it("signed out, unsaved: one button, the match's name, the hint; a plain post to /save/confirm that replay never records", async () => {
    const qm = await createTypedMatch(null);
    const [row] = await sql<{ name: string }[]>`select name from quick_matches where id = ${qm.id}`;

    const html = await htmlOf(qm.token);

    expect(textOf(html, "qm-save-title")).toBe(en_("quickMatch.save.title", { name: row!.name }));
    expect(textOf(html, "qm-save-hint")).toBe(en_("quickMatch.save.hint"));
    expect(confirmForm(html)).toEqual({
      method: "post",
      action: `/q/${qm.token}/save/confirm`,
      blocked: true,
      label: en_("quickMatch.home.save"),
      submit: true,
    });
    const back = tagOf(html, "qm-save-back");
    expect(attr(back, "href")).toBe(`/q/${qm.token}`);
    expect((attr(back, "class") ?? "").split(/\s+/)).toContain(NO_CAPTURE);
    expect(textOf(html, "qm-save-back")).toBe(en_("quickMatch.save.backHome"));
    expect(has(html, "qm-dead-link")).toBe(false);
    expect(has(html, "qm-save-taken")).toBe(false);
  });

  it("never writes: signed in on an unsaved match, the row is unchanged and the save is never called (the button does it)", async () => {
    const me = await account("get-never-writes");
    const qm = await createTypedMatch(addressFor("typed"));
    const before = await saveStateOf(qm.id);
    await signIn(me);

    const html = await htmlOf(qm.token);

    expect(confirmForm(html)?.action).toBe(`/q/${qm.token}/save/confirm`);
    expect(await saveStateOf(qm.id)).toEqual(before);
    expect(saveSpy).not.toHaveBeenCalled();
    // A second visit is the same page: still nothing written.
    await htmlOf(qm.token);
    expect(await saveStateOf(qm.id)).toEqual(before);
  });

  it("signed in and already yours: straight to the home", async () => {
    const me = await account("already-mine");
    const qm = await createTypedMatch(null);
    expect(await saveQuickMatchForUser(me, qm.id)).toBe("saved");
    saveSpy.mockClear();
    await signIn(me);

    expect(await savePage(qm.token)).toEqual({ redirect: `/q/${qm.token}` });
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("saved by somebody else: the taken line and the way back, no button; the same signed out (it cannot be theirs to save)", async () => {
    const saver = await account("saver");
    const viewer = await account("viewer");
    const qm = await createTypedMatch(null);
    expect(await saveQuickMatchForUser(saver, qm.id)).toBe("saved");
    const held = await saveStateOf(qm.id);

    let checked = 0;
    for (const session of [viewer, null]) {
      h.jar.clear();
      if (session) await createSession(session);
      const html = await htmlOf(qm.token);
      const why = session ? "signed in as another" : "signed out";
      expect(textOf(html, "qm-save-taken"), why).toBe(en_("quickMatch.flash.taken"));
      expect(attr(tagOf(html, "qm-save-back"), "href"), why).toBe(`/q/${qm.token}`);
      expect(confirmForm(html), `${why}: no button`).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
    expect(await saveStateOf(qm.id)).toEqual(held);
  });

  it("an unknown, malformed, expired or deleted token is the dead screen, never a button", async () => {
    const expired = await createTypedMatch(null);
    await sql`update quick_matches set expires_at = now() - interval '1 minute' where id = ${expired.id}`;
    const deleted = await createTypedMatch(null);
    await hardDeleteQuickMatchCompetition(deleted.competitionId);
    const live = await createTypedMatch(null);
    let checked = 0;
    for (const [token, why] of [
      [mintHomeToken(), "a well-formed token no row holds"],
      ["qm_short", "a malformed token"],
      [expired.token, "an expired, unswept match (never revived, D13)"],
      [deleted.token, "a deleted match"],
    ] as const) {
      const html = await htmlOf(token);
      expect(has(html, "qm-dead-link"), why).toBe(true);
      expect(confirmForm(html), why).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
    // The positive pair: a live token is the button, and its stray whitespace is trimmed as the home trims it.
    expect(confirmForm(await htmlOf(` ${live.token}\n`))?.action).toBe(`/q/${live.token}/save/confirm`);
  });

  it("speaks the viewer's language, not the match's: French copy on a match made in English", async () => {
    h.locale = "fr";
    const qm = await createTypedMatch(null);
    const [row] = await sql<{ name: string; locale: string }[]>`select name, locale from quick_matches where id = ${qm.id}`;
    expect(row!.locale, "premise: made in English").toBe("en");

    const html = await htmlOf(qm.token);

    expect(textOf(html, "qm-save-title")).toBe(fr_("quickMatch.save.title", { name: row!.name }));
    expect(textOf(html, "qm-save-hint")).toBe(fr_("quickMatch.save.hint"));
    expect(confirmForm(html)?.label).toBe(fr_("quickMatch.home.save"));
    expect(textOf(html, "qm-save-back")).toBe(fr_("quickMatch.save.backHome"));
    expect(html).toContain(`lang="fr"`);
  });

  it("branch review B I1: the reminder mail's real \"Save it\" link opens this page's button", async () => {
    // This page's route, read off the disk: the link must name a path this file serves, or it 404s.
    const appDir = path.resolve(import.meta.dirname, "../../..");
    const pageFile = path.resolve(import.meta.dirname, "../save/page.tsx");
    expect(fs.existsSync(pageFile), "premise: the save page is on disk").toBe(true);
    const segments = path.relative(appDir, path.dirname(pageFile)).split(path.sep);
    const served = new RegExp(`^/${segments.map((s) => (/^\[.+\]$/.test(s) ? "([^/]+)" : s)).join("/")}$`);
    expect(segments).toEqual(["q", "[token]", "save"]);

    const to = addressFor("reminded");
    const qm = await createTypedMatch(to);
    // The clock: 23 hours to go, inside the reminder's window (C2: one reminder ~24h before expiry).
    await sql`update quick_matches set expires_at = now() + interval '23 hours' where id = ${qm.id}`;
    const base = "https://qm-save-page.test";
    expect((await sweepQuickMatches({ baseUrl: base, onlyIds: [qm.id] })).reminded).toBe(1);
    const [row] = await sql<{ id: string }[]>`
      select id from email_outbox where ref_type = 'quick_match' and ref_id = ${qm.id} and kind = 'quick_match_reminder'`;
    expect(row, "the sweep queued the reminder").toBeDefined();
    await sql`update email_outbox set created_at = now() - make_interval(secs => ${FIRST_ATTEMPT_WINDOW_MS / 1000 + 60}) where id = ${row!.id}`;
    await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });
    const sent = deliverMock.mock.calls.map((c) => c[0] as { to: string; html: string }).filter((m) => m.to === to);
    expect(sent, "the worker sent the reminder").toHaveLength(1);

    // The anchor whose words are the mail's own "Save it" (the match's language: the rig makes it in English).
    const anchors = [...sent[0]!.html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
      href: unescape(m[1]!),
      words: unescape(m[2]!.replace(/<[^>]+>/g, "")).trim(),
    }));
    const saveIt = anchors.filter((a) => a.words === enEmails["quickMatchReminder.save"]);
    expect(saveIt, `one "Save it" among ${anchors.length} links`).toHaveLength(1);
    const link = new URL(saveIt[0]!.href);
    expect(link.origin).toBe(base);
    const match = served.exec(link.pathname);
    expect(match, `${link.pathname} is served by app/q/[token]/save/page.tsx`).not.toBeNull();
    expect(link.search, "a path, never a query (C19)").toBe("");

    const html = await htmlOf(decodeURIComponent(match![1]!));

    expect(has(html, "qm-dead-link"), "the link is alive").toBe(false);
    expect(confirmForm(html)?.action).toBe(`/q/${qm.token}/save/confirm`);
    expect(await saveStateOf(qm.id).then((s) => s.saved_by_user_id), "opening it saves nothing").toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the home's Save (the actions row plan 2 D13 left without it)", () => {
  it("unsaved: the same plain form for anyone, signed in or not, beside Share; replay never records it", async () => {
    const someone = await account("home-unsaved");
    const qm = await createTypedMatch(null);
    let checked = 0;
    for (const session of [null, someone]) {
      h.jar.clear();
      if (session) await createSession(session);
      const html = await homeOf(qm.token);
      expect(confirmForm(html), session ? "signed in" : "signed out").toEqual({
        method: "post",
        action: `/q/${qm.token}/save/confirm`,
        blocked: true,
        label: en_("quickMatch.home.save"),
        submit: true,
      });
      expect(has(html, "qm-saved")).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("saved: 'Saved' for its saver only; nothing at all for anyone else, signed in or not", async () => {
    const saver = await account("home-saver");
    const other = await account("home-other");
    const qm = await createTypedMatch(null);
    expect(await saveQuickMatchForUser(saver, qm.id)).toBe("saved");

    await signIn(saver);
    const mine = await homeOf(qm.token);
    expect(textOf(mine, "qm-saved")).toBe(en_("quickMatch.home.saved"));
    expect(confirmForm(mine)).toBeNull();

    let checked = 0;
    for (const session of [other, null]) {
      h.jar.clear();
      if (session) await createSession(session);
      const html = await homeOf(qm.token);
      expect(has(html, "qm-saved"), session ? "another account" : "signed out").toBe(false);
      expect(confirmForm(html), session ? "another account" : "signed out").toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });
});
