// The old, org-less /streaming and /directory (owner, 2026-11-18): each redirects to the org path of the cookie's org (else the first
// membership, which is what `requirePageAuth` resolves), keeping the query, so bookmarks and the old connect landing still arrive.
// An org-less visitor gets what requirePageAuth always gave them (its own redirect), unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ requirePageAuth: vi.fn() }));
vi.mock("@/server/page-auth", () => ({ requirePageAuth: m.requirePageAuth }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));

import LegacyStreaming from "../page";
import LegacyDirectory from "../../directory/page";
import Clubs from "../../clubs/page";
import Players from "../../players/page";
import People from "../../people/page";

const to = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { to: string }).to;
  }
  throw new Error("did not redirect");
};
beforeEach(() => {
  m.requirePageAuth.mockReset().mockResolvedValue({ org: { slug: "riverside" } });
});

describe("legacy /streaming", () => {
  it("goes to the org's path with the connect landing's query", async () => {
    expect(await to(LegacyStreaming({ searchParams: Promise.resolve({ youtube: "pick", pending: "abc" }) }))).toBe("/o/riverside/streaming?youtube=pick&pending=abc");
  });
  it("goes to the bare org path when there is no query", async () => {
    expect(await to(LegacyStreaming({ searchParams: Promise.resolve({}) }))).toBe("/o/riverside/streaming");
  });
  it("a visitor with no org gets requirePageAuth's own redirect, untouched", async () => {
    m.requirePageAuth.mockImplementation(async () => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { to: "/orgs/new" });
    });
    expect(await to(LegacyStreaming({ searchParams: Promise.resolve({}) }))).toBe("/orgs/new");
  });
});

describe("legacy /directory", () => {
  it("goes to the org's path with its tab", async () => {
    expect(await to(LegacyDirectory({ searchParams: Promise.resolve({ tab: "venues" }) }))).toBe("/o/riverside/directory?tab=venues");
  });
  it("goes to the bare org path when there is no query", async () => {
    expect(await to(LegacyDirectory({ searchParams: Promise.resolve({}) }))).toBe("/o/riverside/directory");
  });
});

describe("/clubs, /players, /people: one hop straight to the org's Directory tab", () => {
  it.each([
    ["clubs", Clubs, "/o/riverside/directory?tab=clubs"],
    ["players", Players, "/o/riverside/directory?tab=players"],
    ["people", People, "/o/riverside/directory?tab=players"],
  ])("%s", async (_n, Page, want) => {
    expect(await to((Page as () => Promise<unknown>)())).toBe(want);
  });
});
