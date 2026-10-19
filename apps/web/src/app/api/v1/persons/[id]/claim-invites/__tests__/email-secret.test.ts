// The organiser invite routes and the EMAIL secret (owner-approved 2026-10-19, "split design").
// A claim has two secrets: the CONSOLE one (the organiser's copyable link + QR) and one that goes
// ONLY into the invite email. This file drives the REAL producers — POST /persons/{id}/claim-invites
// and POST /officials/{id}/invite — over a real database, capturing what they hand the mailer, and
// proves, on the real wire:
//   - the email carries the EMAIL secret and NOT the console one;
//   - the organiser's JSON never carries the email secret, its hash, or any field that names it;
//   - what the mailer was handed really is the secret stored as email_token_hash (a fixture on both
//     ends proves the fixture: here the producer's own output is folded through the REAL accept route);
//   - a re-invite through the route kills the previously emailed link.
// Only the cookie door and the mailer are faked. Skipped without DATABASE_URL (nothing touches `sql`
// at module level — CI unit shards have no database).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const world = vi.hoisted(() => ({
  organiserId: "",
  sessions: [] as string[],
  mail: [] as { kind: "claim" | "official"; to: string; claimUrl: string; personName: string }[],
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    // The organiser is signed in on the v1 routes (requireUser)...
    requireUser: async () => ({ id: world.organiserId }),
    // ...while the invitee, opening the emailed link, is signed OUT.
    getCurrentUser: async () => null,
    createSession: async (userId: string) => {
      world.sessions.push(userId);
    },
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendClaimInviteEmail: async (to: string, a: { claimUrl: string; personName: string }) => {
      world.mail.push({ kind: "claim", to, claimUrl: a.claimUrl, personName: a.personName });
      return true;
    },
    sendOfficialInviteEmail: async (to: string, a: { claimUrl: string; personName: string }) => {
      world.mail.push({ kind: "official", to, claimUrl: a.claimUrl, personName: a.personName });
      return true;
    },
  };
});

import { sql } from "@/lib/db";
import { POST as acceptRoute } from "@/app/api/claims/[token]/accept/route";
import { POST as inviteOfficialRoute } from "@/app/api/v1/officials/[id]/invite/route";
import { createOfficial } from "@/server/usecases/officials";
import { createPerson } from "@/server/usecases/persons";
import type { AuthCtx } from "@/server/api-v1/auth";
import { GET as getOpenRoute, POST as inviteRoute } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const tokenOf = (url: string) => /\/claim\/(pc_[A-Za-z0-9_-]+)/.exec(url)![1]!;

/** Every key anywhere in a JSON value, so a renamed leak (`emailClaimUrl`, `emailSecret`) cannot hide. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

async function rig() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`org-owner-${suffix}@test.local`}, 'owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Wire Org " + suffix}, ${"wire-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  world.organiserId = ownerId;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  return { owner, email: `wire-${suffix}@test.local` };
}

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", host: "seazn.test" },
    body: JSON.stringify(body),
  });
const accept = (token: string) =>
  acceptRoute(new Request(`http://localhost/api/claims/${token}/accept`, { method: "POST" }), {
    params: Promise.resolve({ token }),
  });

const claimRowFor = async (personId: string) =>
  (
    await sql<{ id: string; token_hash: string; email_token_hash: string | null; revoked_at: string | null }[]>`
      select id, token_hash, email_token_hash, revoked_at from person_claims
      where person_id = ${personId} order by created_at desc limit 1`
  )[0]!;

beforeEach(() => {
  world.sessions = [];
  world.mail = [];
});
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("POST /persons/{id}/claim-invites: two secrets, two audiences", () => {
  async function invite() {
    const { owner, email } = await rig();
    const person = await createPerson(owner, { full_name: "Wire Player", consent: {} } as never);
    const res = await inviteRoute(
      post(`http://seazn.test/api/v1/persons/${person.id}/claim-invites`, { email }),
      { params: Promise.resolve({ id: person.id }) },
    );
    const wire = await res.text();
    return { owner, person, email, status: res.status, wire, json: JSON.parse(wire) as { data: Record<string, unknown> } };
  }

  it("the email carries the EMAIL secret; the organiser's response carries the CONSOLE one; they differ and match the row", async () => {
    const { person, email, status, json } = await invite();

    expect(status).toBe(201);
    expect(world.mail).toHaveLength(1);
    expect(world.mail[0]).toMatchObject({ kind: "claim", to: email, personName: "Wire Player" });

    const consoleToken = tokenOf(json.data.claim_url as string);
    const emailToken = tokenOf(world.mail[0]!.claimUrl);
    expect(emailToken).not.toBe(consoleToken);
    const row = await claimRowFor(person.id);
    expect(row.token_hash).toBe(sha256(consoleToken)); // the console link is the console secret
    expect(row.email_token_hash).toBe(sha256(emailToken)); // the MAIL is the email secret
  });

  it("the organiser's JSON never contains the email secret, its hash, or a field named for either", async () => {
    const { person, wire, json } = await invite();
    const emailToken = tokenOf(world.mail[0]!.claimUrl);
    const row = await claimRowFor(person.id);

    expect(wire).not.toContain(emailToken);
    expect(wire).not.toContain(row.email_token_hash!);
    const keys = allKeys(json);
    expect(keys.length).toBeGreaterThan(5); // anti-vacuity: the envelope really was walked
    for (const k of keys) expect(k).not.toMatch(/email_?token|email_?secret|email_?claim/i);
    // The positive pair: the console link IS in the response, so the exclusion is not an empty-body artefact.
    expect(json.data.claim_url).toMatch(/\/claim\/pc_/);

    // Nor does reading the open claim back (GET) reveal it.
    const read = await getOpenRoute(new Request(`http://seazn.test/api/v1/persons/${person.id}/claim-invites`), {
      params: Promise.resolve({ id: person.id }),
    });
    const readWire = await read.text();
    expect(readWire).toContain(row.id); // it IS the open claim
    expect(readWire).not.toContain(emailToken);
    expect(readWire).not.toContain(row.email_token_hash!);
  });

  it("folded through the REAL accept route: the emailed link signs the invitee in; the organiser's link does not", async () => {
    const { person, email, json } = await invite();
    const emailToken = tokenOf(world.mail[0]!.claimUrl);
    const consoleToken = tokenOf(json.data.claim_url as string);

    // The organiser's console link, opened signed out: refused.
    const viaConsole = await accept(consoleToken);
    expect(viaConsole.status).toBe(401);
    expect(world.sessions).toEqual([]);

    // The link that went to the inbox: signs the invitee in and claims.
    const viaEmail = await accept(emailToken);
    expect(viaEmail.status).toBe(200);
    const [user] = await sql<{ id: string }[]>`select id from users where email = ${email}`;
    expect(world.sessions).toEqual([user!.id]);
    const [linked] = await sql<{ user_id: string | null }[]>`select user_id from persons where id = ${person.id}`;
    expect(linked!.user_id).toBe(user!.id);
  });

  it("inviting again through the route kills the previously emailed link; the new one works", async () => {
    const { person, email } = await invite();
    const oldMail = tokenOf(world.mail[0]!.claimUrl);

    const again = await inviteRoute(
      post(`http://seazn.test/api/v1/persons/${person.id}/claim-invites`, { email }),
      { params: Promise.resolve({ id: person.id }) },
    );
    expect(again.status).toBe(201);
    expect(world.mail).toHaveLength(2);
    const newMail = tokenOf(world.mail[1]!.claimUrl);
    expect(newMail).not.toBe(oldMail);

    const stale = await accept(oldMail);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ code: "CLAIM_REVOKED" });
    expect(world.sessions).toEqual([]);
    expect((await accept(newMail)).status).toBe(200);
    expect(world.sessions).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("POST /officials/{id}/invite: the officiating mail carries the email secret too", () => {
  async function inviteOfficial() {
    const { owner, email } = await rig();
    const official = await createOfficial(owner, { display_name: "Wire Referee", role_keys: ["referee"] });
    const res = await inviteOfficialRoute(
      post(`http://seazn.test/api/v1/officials/${official.id}/invite`, { email }),
      { params: Promise.resolve({ id: official.id }) },
    );
    const wire = await res.text();
    return { official, email, status: res.status, wire, json: JSON.parse(wire) as { data: Record<string, unknown> } };
  }

  it("mail = email secret, response = console secret, response never names the email secret, and the mail signs in", async () => {
    const { email, status, wire, json } = await inviteOfficial();

    expect(status).toBe(201);
    expect(world.mail).toHaveLength(1);
    expect(world.mail[0]).toMatchObject({ kind: "official", to: email });
    const consoleToken = tokenOf(json.data.claim_url as string);
    const emailToken = tokenOf(world.mail[0]!.claimUrl);
    expect(emailToken).not.toBe(consoleToken);

    const [row] = await sql<{ token_hash: string; email_token_hash: string }[]>`
      select token_hash, email_token_hash from person_claims where email = ${email}`;
    expect(row!.token_hash).toBe(sha256(consoleToken));
    expect(row!.email_token_hash).toBe(sha256(emailToken));

    expect(wire).not.toContain(emailToken);
    expect(wire).not.toContain(row!.email_token_hash);
    const keys = allKeys(json);
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(k).not.toMatch(/email_?token|email_?secret|email_?claim/i);

    expect((await accept(consoleToken)).status).toBe(401);
    expect((await accept(emailToken)).status).toBe(200);
    expect(world.sessions).toHaveLength(1);
  });
});
