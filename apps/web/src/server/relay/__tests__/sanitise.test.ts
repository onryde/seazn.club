// The sanitiser is an ALLOWLIST: a key it has not heard of does not survive,
// whatever its value. A denylist ("drop anything called password") misses the
// next secret; this misses nothing it was not told to keep. Pure — no DB.
import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_MAX_STRING } from "../config";
import { ALLOWED_KEYS, pathTemplate, sanitise } from "../sanitise";

const SECRET = "sekrit-9f3a1c";

describe("sanitise — allowlist", () => {
  it("keeps an allowed key and drops an unknown one, whatever it holds", () => {
    expect(sanitise({ state: "live", passphrase: SECRET, streamKey: SECRET, token: SECRET })).toEqual({ state: "live" });
  });
  it("recurses into nested objects and arrays, with the same list", () => {
    const out = sanitise({ exit: { exitCode: 0, oomKilled: false, env: { RELAY_KEK: SECRET } }, outputs: [{ uid: "o1", streamKey: SECRET }] });
    expect(out).toEqual({ exit: { exitCode: 0, oomKilled: false }, outputs: [{ uid: "o1" }] });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  it("cuts every string at its first `?` — a URL keeps its path, never its query", () => {
    expect(sanitise({ url: `https://live.cloudflare.com/x/y?passphrase=${SECRET}&streamid=abc` })).toEqual({ url: "https://live.cloudflare.com/x/y" });
    expect(sanitise({ reason: `q?${SECRET}` })).toEqual({ reason: "q" });
  });
  it("caps a string at EVENT_PAYLOAD_MAX_STRING and an array at 50 (a stack trace cannot become a row)", () => {
    const long = "x".repeat(EVENT_PAYLOAD_MAX_STRING + 1);
    expect((sanitise({ reason: long }).reason as string).length).toBe(EVENT_PAYLOAD_MAX_STRING);
    expect((sanitise({ outputs: Array.from({ length: 60 }, () => ({ uid: "o" })) }).outputs as unknown[]).length).toBe(50);
  });
  it("stops at depth 4 and returns {} for a non-object (null, a string, a number)", () => {
    const deep = { exit: { exit: { exit: { exit: { exit: { exitCode: 1 } } } } } };
    expect(JSON.stringify(sanitise(deep))).not.toContain("exitCode");
    expect(sanitise(null)).toEqual({});
    expect(sanitise(SECRET)).toEqual({});
    expect(sanitise(42)).toEqual({});
  });
  it("every payload key the usecase's forced destroys write survives (a key the list lacks never reaches the ledger — `staleAttempt` did not, Task 10 → lane-close sweep)", () => {
    // The keys stream-sessions.ts hands forceDestroy at its three sites, typed here from those call sites.
    const written = { machineId: "m1", staleAttempt: 1, machineName: "relay-x-r1", reason: "sweep" };
    expect(sanitise(written)).toEqual(written);
    expect(Object.keys(written).filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  });
  it("the allowlist holds no key that names a credential (the list is the guard; this pins it)", () => {
    for (const k of ALLOWED_KEYS) expect(k).not.toMatch(/key|secret|pass|token|auth|cookie|env/i);
  });
});

describe("pathTemplate — a template, never a URL", () => {
  it("drops origin and query, replaces each given id with {id}, any residual uuid with {uuid}, any residual long-hex segment (a Fly machine id, a Cloudflare uid) with {id}", () => {
    const sid = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    expect(pathTemplate(`https://api.machines.dev/v1/apps/relay/machines/abc123?x=${SECRET}`, ["abc123"])).toBe("/v1/apps/relay/machines/{id}");
    expect(pathTemplate(`/accounts/acct9/stream/live_inputs/in77/outputs`, ["acct9", "in77"])).toBe("/accounts/{id}/stream/live_inputs/{id}/outputs");
    expect(pathTemplate(`/x/${sid}/y`, [])).toBe("/x/{uuid}/y");
    expect(pathTemplate(`/v1/apps/relay/machines/3d8d9e4b1234ab/stop`, [])).toBe("/v1/apps/relay/machines/{id}/stop");
    expect(pathTemplate(`/stream/live_inputs/0123456789abcdef0123456789abcdef`, [])).toBe("/stream/live_inputs/{id}");
    // A short word that happens to be hex is NOT an id (the empty/short case): "cafe" stays.
    expect(pathTemplate(`/apps/cafe/machines`, [])).toBe("/apps/cafe/machines");
  });
  it("an empty id never matches (the empty case: '' would replace every position)", () => {
    expect(pathTemplate("/a/b", [""])).toBe("/a/b");
    // "/a/b" alone cannot witness the guard: it has no `//` and no trailing `/` for '' to hit, so it
    // passes with `if (!id) continue` deleted. These two can — unguarded, a trailing slash collapses
    // the whole path to "{id}" and a `//` becomes "/{id}/".
    expect(pathTemplate("/a/b/", [""])).toBe("/a/b/");
    expect(pathTemplate("/a//b", [""])).toBe("/a//b");
  });
});
