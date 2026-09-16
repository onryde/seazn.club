// Privacy hotfix (2026-09-16) — the player card's strictest-policy read.
//
// 1. Its cache entry carries the ORG tag. The policy it reads spans every
//    division in the org, and `patchDivision` expires that tag when a
//    division's name policy changes (`division-policy-revalidate.test.ts`).
//
// 2. It fails CLOSED.
//
// `getPublicPlayer` finds the person in `public_players_v`, which already
// requires a roster row in a public competition, and then reads every roster
// the person has in the org to pick the strictest name policy. If that second
// read comes back empty while the first matched (a database role that RLS
// filters, or a roster removed between the two reads), there is no evidence
// the full name may be published. If it throws, no card may be served at all.
//
// The real database, with ONE query intercepted when a case arms it: the
// roster-policy read, matched by its own select list.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  rosters: "real" as "real" | "empty" | "fail",
  cacheCalls: [] as { keyParts: unknown[]; tags: string[] }[],
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: unknown[], opts?: { tags?: string[] }) => {
    probe.cacheCalls.push({ keyParts, tags: opts?.tags ?? [] });
    return fn;
  },
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const isRosterPolicyRead = (args: unknown[]) => {
    const strings = args[0];
    return (
      Array.isArray(strings) &&
      "raw" in strings &&
      strings.join("").includes("select d.youth, d.player_name_display, p.consent")
    );
  };
  return {
    ...actual,
    sql: new Proxy(actual.sql, {
      apply(target, thisArg, args: unknown[]) {
        if (probe.rosters !== "real" && isRosterPolicyRead(args)) {
          return probe.rosters === "empty"
            ? Promise.resolve([])
            : Promise.reject(new Error("simulated roster read failure"));
        }
        return Reflect.apply(target, thisArg, args);
      },
    }),
  };
});

import { getPublicPlayer, orgTag } from "../data";
import { closeSql, OPEN_FULL, seedYouthNameScene, type YouthNameScene } from "./_youth-name-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await closeSql();
});

describe.skipIf(!HAS_DB)("getPublicPlayer — the card's cache entry is tagged with the org", () => {
  let s: YouthNameScene;
  beforeAll(async () => {
    s = await seedYouthNameScene();
  });

  it("the pub-player entry carries orgTag, so a division policy change anywhere in the org expires it", async () => {
    probe.cacheCalls.length = 0;
    const data = await getPublicPlayer(s.orgSlug, s.compSlug, s.youth.personId);
    expect(data, "precondition: the card is served").not.toBeNull();
    const card = probe.cacheCalls.find((c) => String(c.keyParts[0]).startsWith("pub-player-"));
    expect(card, `cache calls: ${JSON.stringify(probe.cacheCalls)}`).toBeDefined();
    expect(card!.tags).toContain(orgTag(s.orgSlug));
  });
});

describe.skipIf(!HAS_DB)("getPublicPlayer — the strictest-policy roster read fails closed", () => {
  let s: YouthNameScene;
  beforeAll(async () => {
    s = await seedYouthNameScene();
  });
  afterEach(() => {
    probe.rosters = "real";
  });

  it("control (positive pair): with the real read, a consented adult's card keeps the full name and photo", async () => {
    const data = await getPublicPlayer(s.orgSlug, s.compSlug, s.open.personId);
    expect(data!.player.name).toBe(OPEN_FULL);
    expect(data!.player.photo).toBe(s.open.photo);
  });

  it("the roster read comes back EMPTY while the card is served: the name is masked and the photo withheld", async () => {
    probe.rosters = "empty";
    const data = await getPublicPlayer(s.orgSlug, s.compSlug, s.open.personId);
    expect(data, "precondition: public_players_v still matches, so a card is served").not.toBeNull();
    expect(data!.player.name).toBe("Dev P.");
    expect(data!.player.photo).toBeNull();
    expect(JSON.stringify(data)).not.toContain("Patel");
  });

  it("the roster read FAILS: no card is served at all, so no name is published", async () => {
    probe.rosters = "fail";
    await expect(getPublicPlayer(s.orgSlug, s.compSlug, s.open.personId)).rejects.toThrow(
      "simulated roster read failure",
    );
  });
});
