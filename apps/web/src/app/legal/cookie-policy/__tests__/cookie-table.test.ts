// T16 fix round 1, R2 — the signed-in hint is a cookie we set, so the cookie policy names it. Read from the page's
// source (the table is static English, like the rest of /legal); the name comes from the constant the app writes, so a
// rename reds here until the policy says the new name.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";

const page = readFileSync(fileURLToPath(new URL("../page.tsx", import.meta.url)), "utf8");
const names = [...page.matchAll(/<td className="font-mono">([^<]+)<\/td>/g)].map((m) => m[1]);

describe("cookie policy — the cookies we set", () => {
  it("lists the session and the signed-in hint beside it", () => {
    expect(names.length, "anti-vacuity: the table's names were read").toBeGreaterThan(3);
    expect(names).toContain("seazn_session");
    expect(names).toContain(SESSION_HINT_COOKIE);
  });
});
