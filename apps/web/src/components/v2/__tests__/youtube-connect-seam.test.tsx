// The seam between the Streaming page's YouTube forms and the connect route (T9 producer, T7 consumer): the fields the forms POST are
// read by the REAL `POST /api/youtube/connect` and land as the right pending grant. youtube-connect-panel.test.tsx proves what the forms
// DECLARE (their field names and values); this proves the route ACCEPTS exactly that — a form that named a field `visibility`, or sent a
// value the route's enum refuses, passes every markup assertion and then fails for every customer who presses Continue (AGENTS.md,
// recurring failure class 1: the inert seam; "a fixture on both ends proves the fixture").
//
// So the PRODUCER is the real component, rendered; the browser's job (serialising a form) is done by `formFields` below, from the markup
// alone; the CONSUMER is the real route, the real FakeYouTube behind the port, and real Postgres for the pending row. Expected values are
// literals typed from the spec (§6.1: Unlisted and "not for kids" by default; consent version 1), never read back from the code under test.
// Skipped without DATABASE_URL like every DB suite here.
//
// Sport: not applicable — connecting a YouTube channel is sport-agnostic.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));
const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const { AuthError } = await import("@/lib/errors");
  return {
    ...actual,
    requireUser: async () => {
      if (!session.user) throw new AuthError("Not authenticated");
      return session.user;
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/streaming",
  useSearchParams: () => new URLSearchParams(""),
}));

import { sql } from "@/lib/db";
import { YOUTUBE_SCOPE } from "@/lib/youtube";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { FakeYouTube } from "@/server/youtube/fake";
import { insertConnectionWithToken } from "@/server/youtube/token-store";
import { seedOrg } from "@/server/usecases/__tests__/_rig";
import { POST as START } from "@/app/api/youtube/connect/route";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { KidsChoice, PrivacyChoice, YoutubeChannelRow, YoutubeConnectCard } from "../youtube-connect-panel";

const HAS_DB = !!process.env.DATABASE_URL;
const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const saved = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  jar.values.clear();
  session.user = null;
  vi.stubEnv("YOUTUBE_DRIVER", "fake");
  vi.stubEnv("ENV_NAME", "ci");
  vi.stubEnv("RELAY_DRIVERS", "fake");
  for (const k of ["OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "YOUTUBE_REDIRECT_URI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) vi.stubEnv(k, undefined);
  setYoutubeDriverForTest(new FakeYouTube());
});
afterEach(() => {
  vi.unstubAllEnvs();
  setYoutubeDriverForTest(null);
  setRelayDriversForTest(null);
});

// ─── the browser's side of the seam: serialise a form from its markup ───────────────────────────────────────────────────────
/** What a browser would POST for the first <form> in `html`: every named, enabled field — hidden inputs, the CHECKED radio of each
 *  group, and a checkbox only when ticked. `tick` ticks the named checkboxes (the user's click), which static markup cannot carry. */
function formFields(html: string, opts: { tick?: string[] } = {}): URLSearchParams {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(html);
  if (!form) throw new Error("no <form> in the markup");
  const out = new URLSearchParams();
  let fields = 0;
  for (const [, a = ""] of form[1]!.matchAll(/<input\b([^>]*)>/g)) {
    const name = /\bname="([^"]*)"/.exec(a)?.[1];
    const value = /\bvalue="([^"]*)"/.exec(a)?.[1] ?? "on";
    const type = /\btype="([^"]*)"/.exec(a)?.[1] ?? "text";
    if (!name || /\bdisabled(=""|\s|$)/.test(a)) continue;
    const checked = /\bchecked(=""|\s|$)/.test(a);
    if (type === "checkbox" ? checked || opts.tick?.includes(name) : type === "radio" ? checked : true) {
      out.append(name, value);
      fields++;
    }
  }
  if (fields === 0) throw new Error("the form serialised to nothing — the seam test would assert nothing");
  return out;
}
const withField = (p: URLSearchParams, name: string, value: string): URLSearchParams => {
  const next = new URLSearchParams(p);
  next.set(name, value);
  return next;
};
const post = (fields: URLSearchParams) => START(new Request("http://localhost/api/youtube/connect", { method: "POST", body: fields }));

// ─── rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const newUser = async (): Promise<string> =>
  (await sql<{ id: string }[]>`insert into users (email, display_name) values (${`yt9-${randomUUID()}@example.test`}, 'Seam Tester') returning id`)[0]!.id;
async function rig(): Promise<{ orgId: string; userId: string }> {
  const { auth } = await seedOrg();
  const userId = await newUser();
  await sql`insert into org_members (org_id, user_id, role) values (${auth.orgId}, ${userId}, 'owner')`;
  session.user = { id: userId };
  return { orgId: auth.orgId, userId };
}
interface Pending { user_id: string; connection_id: string | null; default_privacy: string; made_for_kids: boolean; consent_version: number }
const pendingRows = (orgId: string): Promise<Pending[]> =>
  sql<Pending[]>`select user_id, connection_id, default_privacy, made_for_kids, consent_version from youtube_connect_pending where org_id = ${orgId} order by created_at, id`;

async function liveConnection(r: { orgId: string; userId: string }, consentVersion: number): Promise<string> {
  const channel = `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const refreshToken = `1//seed-${randomBytes(12).toString("hex")}`;
  const { connectionId } = await sql.begin((tx) =>
    insertConnectionWithToken(tx, {
      orgId: r.orgId, channelId: channel, channelTitle: "Seam FC", googleSub: null, grantedScope: YOUTUBE_SCOPE, defaultPrivacy: "public", madeForKids: true,
      consentBy: r.userId, consentAt: new Date(), consentVersion, createdBy: r.userId, refreshToken,
    }));
  return connectionId;
}
const rowMarkup = (t: StreamTarget, orgId: string): string => renderToStaticMarkup((<ul><YoutubeChannelRow t={t} canEdit orgId={orgId} badge={null} /></ul>) as ReactElement);

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("the consent form -> POST /api/youtube/connect", () => {
  it("the form as shipped, ticked: the route sends the browser to Google (the fake hop) and records the consent with the DEFAULTS the spec names — Unlisted, not for kids, version 1, by this user", async () => {
    const r = await rig();
    const html = renderToStaticMarkup(<YoutubeConnectCard orgId={r.orgId} onCancel={() => {}} />);
    const res = await post(formFields(html, { tick: ["consent"] }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/api/youtube/connect/fake-authorize");
    const rows = await pendingRows(r.orgId);
    expect(rows).toEqual([{ user_id: r.userId, connection_id: null, default_privacy: "unlisted", made_for_kids: false, consent_version: 1 }]);
  });

  it("the form UNTICKED is refused by the route (400, no pending row): the disabled button is the courtesy, this is the guard — and it is the form's own serialisation that lacks consent", async () => {
    const r = await rig();
    const fields = formFields(renderToStaticMarkup(<YoutubeConnectCard orgId={r.orgId} onCancel={() => {}} />));
    expect(fields.has("consent"), "PREMISE: an unticked box posts nothing").toBe(false);
    const res = await post(fields);
    expect(res.status).toBe(400);
    expect(await pendingRows(r.orgId)).toEqual([]);
  });

  it("every visibility x made-for-kids the form can post is one the route accepts and stores — six combinations, each from the choice component's own markup", async () => {
    const r = await rig();
    const base = formFields(renderToStaticMarkup(<YoutubeConnectCard orgId={r.orgId} onCancel={() => {}} />), { tick: ["consent"] });
    let checked = 0;
    for (const privacy of ["unlisted", "public", "private"] as const) {
      for (const kids of ["0", "1"] as const) {
        const chosenPrivacy = formFields(`<form>${renderToStaticMarkup(<PrivacyChoice value={privacy} onChange={() => {}} />)}</form>`).get("privacy")!;
        const chosenKids = formFields(`<form>${renderToStaticMarkup(<KidsChoice value={kids} onChange={() => {}} />)}</form>`).get("madeForKids")!;
        expect([chosenPrivacy, chosenKids], "the choice components post what they show as selected").toEqual([privacy, kids]);
        const res = await post(withField(withField(base, "privacy", chosenPrivacy), "madeForKids", chosenKids));
        expect(res.status, `${privacy}/${kids}`).toBe(303);
        checked++;
      }
    }
    expect(checked).toBe(6);
    const rows = await pendingRows(r.orgId);
    expect(rows.map((x) => `${x.default_privacy}/${x.made_for_kids}`)).toEqual([
      "unlisted/false", "unlisted/true", "public/false", "public/true", "private/false", "private/true",
    ]);
  });
});

describe.skipIf(!HAS_DB)("the Reconnect form -> POST /api/youtube/connect", () => {
  const dead = (connectionId: string, over: Partial<NonNullable<StreamTarget["youtube"]>> = {}): StreamTarget => ({
    id: "t-seam", kind: "youtube", label: "Seam FC", watchUrl: null, createdAt: "2026-10-20T10:00:00.000Z", keyHint: null, inUse: null,
    youtube: { connectionId, channelId: "UC7xK2mQ9rVbN4tLpA1sZ0wE", channelTitle: "Seam FC", privacy: "public", madeForKids: true, status: "reconnect_needed", liveState: "unknown", termsOutdated: false, openBroadcasts: 0, ...over },
  });

  it("a dead connection whose consent is CURRENT: the form as shipped (no consent field) reconnects it — the pending grant is bound to THAT connection (T7-R2)", async () => {
    const r = await rig();
    const connectionId = await liveConnection(r, 1);
    const fields = formFields(rowMarkup(dead(connectionId), r.orgId));
    expect(fields.has("consent"), "PREMISE: the reconnect form posts no consent").toBe(false);
    expect(fields.get("connectionId")).toBe(connectionId);
    const res = await post(fields);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/api/youtube/connect/fake-authorize");
    const rows = await pendingRows(r.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.connection_id).toBe(connectionId);
  });

  it("a dead connection whose consent is on OLDER wording: the route would refuse a bare reconnect (400) — which is why the row offers Review terms FIRST and renders no Reconnect form", async () => {
    const r = await rig();
    const connectionId = await liveConnection(r, 0);
    const html = rowMarkup(dead(connectionId, { termsOutdated: true }), r.orgId);
    expect(html, "the row offers no Reconnect form for it").not.toContain('data-testid="youtube-reconnect-form"');
    expect(html).toContain('data-testid="youtube-review-terms"');
    // What the form WOULD have posted is refused, so the UI's refusal is not gratuitous (and the guard is the route's, not the page's).
    const bare = new URLSearchParams({ orgId: r.orgId, connectionId, privacy: "public", madeForKids: "1" });
    const res = await post(bare);
    expect(res.status).toBe(400);
    expect(await pendingRows(r.orgId)).toEqual([]);
  });
});
