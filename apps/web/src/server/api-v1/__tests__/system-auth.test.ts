// The system actor (Swiss auto-advance spec §4.5, D11): the clock runs the SAME usecase the button runs, as an AuthCtx
// that names no person, holds no key, and is organiser-equivalent without being the owner. No DB: every gate swept
// here refuses BEFORE its first query (the suite runs with DATABASE_URL empty, so a gate that let the actor through
// would fail on the connection, not on a 403).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { EDITOR_ROLES } from "@/lib/types";
import { systemAuth, type AuthCtx } from "@/server/api-v1/auth";
import { getRequestContext, runRequestContext } from "@/server/request-context";
import { requireSessionEditor as streamCodesGate } from "@/server/usecases/stream-codes";
import { assertCanReadStreamHistory } from "@/server/usecases/stream-credit-history";
import { listApiKeys } from "@/server/usecases/api-keys";
import { createDeviceLink } from "@/server/usecases/device-links";
import { createClaimInvite } from "@/server/usecases/person-claims";
import { connectStatus } from "@/server/usecases/stripe-connect";
import { createCheckinLink } from "@/server/usecases/checkin-token";
import { leaveAsArbiter, requireWatcher, resyncExternalPlay } from "@/server/usecases/external-play/arbiter";
import { resolveExternalPlay } from "@/server/usecases/external-play/resolve";
import { closeExternalPlayFlags } from "@/server/usecases/external-play/flags";
import { subjectToScorerCapabilityGates } from "@/server/usecases/scorers";

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "55555555-5555-4555-8555-555555555555";
const USER = "33333333-3333-4333-8333-333333333333";
const FIXTURE = "44444444-4444-4444-8444-444444444444";
const PERSON = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";
const LINK = "88888888-8888-4888-8888-888888888888";

// One ctx per door. A mapped type over AuthCtx["via"]: a fifth door is a tsc error HERE until someone states how the
// session-only gates below treat it — the exhaustiveness the `if (via !== "session")` sites cannot give themselves.
const CTX: { [V in AuthCtx["via"]]: () => AuthCtx } = {
  session: () => ({ orgId: ORG, via: "session", userId: USER, role: "admin", keyId: null }),
  api_key: () => ({ orgId: ORG, via: "api_key", userId: null, role: null, keyId: KEY, keyScopes: ["manage"] }),
  device_link: () => ({ orgId: ORG, via: "device_link", userId: USER, role: null, keyId: null, deviceLinkId: LINK }),
  system: () => systemAuth(ORG),
};
const SESSION_ONLY_ADMITS: { [V in AuthCtx["via"]]: boolean } = {
  session: true,
  api_key: false,
  device_link: false,
  system: false,
};

async function refusal(run: () => unknown): Promise<HttpError | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e; // a DB/connection error means the gate let the caller through — fail loudly, never read it as a refusal
  }
}

describe("systemAuth — the clock's actor", () => {
  it("systemAuth carries no person", () => {
    const ctx = systemAuth(ORG);
    expect(ctx.orgId).toBe(ORG);
    expect(ctx.via).toBe("system");
    expect(ctx.userId).toBeNull();
    expect(ctx.keyId).toBeNull();
    // Organiser-equivalent (an editor role, from the declaration), never the owner: owner-only surfaces stay shut.
    expect((EDITOR_ROLES as readonly (string | null)[]).includes(ctx.role)).toBe(true);
    expect(ctx.role).not.toBe("owner");
    // Neither a key (whose gates read keyScopes fail-closed) nor a device (deviceLinkId rides onto score_events).
    expect("keyScopes" in ctx).toBe(false);
    expect("deviceLinkId" in ctx).toBe(false);
  });

  it("a second call is a fresh ctx for its own org", () => {
    const a = systemAuth(ORG);
    const b = systemAuth(OTHER_ORG);
    expect(a).not.toBe(b);
    expect([a.orgId, b.orgId]).toEqual([ORG, OTHER_ORG]);
    expect(systemAuth(ORG)).not.toBe(a);
  });

  it("refuses an empty or malformed org id rather than minting an org-less actor", () => {
    for (const bad of ["", " ", "not-a-uuid", `${ORG}x`]) {
      expect(() => systemAuth(bad), JSON.stringify(bad)).toThrow(/organisation id/);
    }
  });

  it("passes through recordAuthContext: the request context gets the org and no user", async () => {
    await runRequestContext("req-system-1", async () => {
      systemAuth(ORG);
      expect(getRequestContext()).toEqual({ requestId: "req-system-1", orgId: ORG });
      systemAuth(OTHER_ORG);
      expect(getRequestContext()).toEqual({ requestId: "req-system-1", orgId: OTHER_ORG });
    });
    // Outside any request (the sweep's tick): still a ctx, and nothing leaks into a store that is not there.
    expect(systemAuth(ORG).orgId).toBe(ORG);
    expect(getRequestContext()).toEqual({});
  });

  it("is organiser-equivalent at the scorer capability gate (scorers.ts), unlike a role-less session", () => {
    expect(subjectToScorerCapabilityGates(systemAuth(ORG))).toBe(false);
    // The wrong answer's constant differs: a signed-in non-member official IS bound by the gates.
    expect(subjectToScorerCapabilityGates({ ...CTX.session(), role: null })).toBe(true);
  });
});

// Every `via !== "session"` gate in apps/web/src, one entry per site. Each is either a pure gate or an exported
// usecase whose FIRST check is the gate. `file` is relative to apps/web/src; the scan below holds the table to the tree.
const SESSION_ONLY_SITES: readonly { file: string; name: string; run: (ctx: AuthCtx) => unknown; pure: boolean }[] = [
  { file: "server/usecases/stream-codes.ts", name: "requireSessionEditor", run: (c) => streamCodesGate(c), pure: true },
  { file: "server/usecases/stream-credit-history.ts", name: "assertCanReadStreamHistory", run: (c) => assertCanReadStreamHistory(c, ORG), pure: true },
  { file: "server/usecases/external-play/arbiter.ts", name: "requireWatcher", run: (c) => requireWatcher(c), pure: true },
  { file: "server/usecases/api-keys.ts", name: "listApiKeys", run: (c) => listApiKeys(c), pure: false },
  { file: "server/usecases/device-links.ts", name: "createDeviceLink", run: (c) => createDeviceLink(c, FIXTURE, null), pure: false },
  { file: "server/usecases/person-claims.ts", name: "createClaimInvite", run: (c) => createClaimInvite(c, PERSON, "x@example.test"), pure: false },
  { file: "server/usecases/stripe-connect.ts", name: "connectStatus", run: (c) => connectStatus(c, ORG), pure: false },
  { file: "server/usecases/checkin-token.ts", name: "createCheckinLink", run: (c) => createCheckinLink(c, FIXTURE), pure: false },
  { file: "server/usecases/external-play/arbiter.ts", name: "leaveAsArbiter", run: (c) => leaveAsArbiter(c, FIXTURE, "p1"), pure: false },
  { file: "server/usecases/external-play/arbiter.ts", name: "resyncExternalPlay", run: (c) => resyncExternalPlay(c, FIXTURE), pure: false },
  { file: "server/usecases/external-play/resolve.ts", name: "resolveExternalPlay", run: (c) => resolveExternalPlay(c, FIXTURE, "draw"), pure: false },
  { file: "server/usecases/external-play/flags.ts", name: "closeExternalPlayFlags", run: (c) => closeExternalPlayFlags(c, FIXTURE, []), pure: false },
];

const SRC = path.resolve(__dirname, "../../..");
const GATE = /\.via !== "session"/g;

function gateSitesInTree(): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "__tests__" || name === "node_modules") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) {
        const n = readFileSync(full, "utf8").match(GATE)?.length ?? 0;
        if (n > 0) found.set(path.relative(SRC, full).split(path.sep).join("/"), n);
      }
    }
  };
  walk(SRC);
  return found;
}

describe("systemAuth is refused by every session-only gate", () => {
  it("the sweep covers every `via !== \"session\"` site in the tree", () => {
    const inTree = gateSitesInTree();
    const inTable = new Map<string, number>();
    for (const s of SESSION_ONLY_SITES) inTable.set(s.file, (inTable.get(s.file) ?? 0) + 1);
    const treeTotal = [...inTree.values()].reduce((a, b) => a + b, 0);
    expect(treeTotal, "zero gates found — the scan is looking in the wrong place").toBeGreaterThan(0);
    expect(Object.fromEntries([...inTable].sort()), "a session-only gate was added or removed: update this sweep").toEqual(
      Object.fromEntries([...inTree].sort()),
    );
  });

  it("systemAuth is refused by every session-only gate", async () => {
    let checked = 0;
    for (const site of SESSION_ONLY_SITES) {
      const err = await refusal(() => site.run(systemAuth(ORG)));
      expect(err?.status, `${site.name} (${site.file}) let the system actor through`).toBe(403);
      checked++;
    }
    expect(checked).toBe(SESSION_ONLY_SITES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("each pure gate admits a session and refuses every other door (the positive pair)", async () => {
    const pure = SESSION_ONLY_SITES.filter((s) => s.pure);
    let checked = 0;
    for (const site of pure) {
      for (const via of Object.keys(CTX) as AuthCtx["via"][]) {
        const err = await refusal(() => site.run(CTX[via]()));
        expect(err?.status ?? "admitted", `${site.name} as ${via}`).toBe(SESSION_ONLY_ADMITS[via] ? "admitted" : 403);
        checked++;
      }
    }
    expect(pure.length).toBeGreaterThan(0);
    expect(checked).toBe(pure.length * Object.keys(CTX).length);
  });
});
