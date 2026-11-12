// The quick match smoke's sweep leg calls the real expiry route, which takes no scope: it deletes every expired unsaved quick
// match on its target (quick match plan 3 Amend T7 [A9], "never prod"), and it back-dates rows through DATABASE_URL. The leg's
// guard runs only when the server AND the database are on this machine (review m2, m3), and it runs before the leg's first
// write (review m1). COUNTED: zero cases or zero guarded sites checked is a failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepTargetAllowed } from "../smoke/suites/quickMatch.ts";

const LOCAL_DB = "postgresql://postgres@127.0.0.1:54566/seazn_x";

describe("quickMatch smoke — sweepTargetAllowed", () => {
  it("allows a local server with a local database, and refuses staging, production and everything else", () => {
    const allowed: [string, string][] = [
      ["http://localhost:3000", "postgresql://postgres:postgres@localhost:5432/postgres"], // CI's smoke job
      ["http://localhost:3325", LOCAL_DB], // a seazn-env label
      ["http://127.0.0.1:3300", LOCAL_DB],
      ["http://[::1]:3000", "postgresql://postgres@[::1]:5432/x"],
    ];
    const refused: [string, string | undefined][] = [
      ["https://seazn.club", LOCAL_DB],
      ["https://www.seazn.club", LOCAL_DB],
      ["https://stg.seazn.club", LOCAL_DB],
      ["https://seazn-club.fly.dev", LOCAL_DB],
      ["http://localhost.evil.example", LOCAL_DB],
      ["not a url", LOCAL_DB],
      ["", LOCAL_DB],
      // A local server handed a remote database: the back-dating would land there.
      ["http://localhost:3000", "postgresql://u:p@db.example.supabase.co:6543/postgres"],
      ["http://localhost:3000", "postgresql:///seazn?host=/tmp/sock"], // a socket path names no host
      ["http://localhost:3000", undefined],
      ["http://localhost:3000", ""],
    ];
    let checked = 0;
    for (const [base, db] of allowed) {
      expect(sweepTargetAllowed(base, db), `${base} + ${db}`).toBe(true);
      checked++;
    }
    for (const [base, db] of refused) {
      expect(sweepTargetAllowed(base, db), `${base} + ${String(db)}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(allowed.length + refused.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the suite calls the guard, and returns on a refusal, before the sweep leg's first write and before the sweep itself", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "smoke", "suites", "quickMatch.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function quickMatchSuite"));
    expect(body.length, "premise: the suite function was found").toBeLessThan(src.length);
    const guard = /if \(!sweepTargetAllowed\(BASE, process\.env\.DATABASE_URL\)\) \{[\s\S]*?\n\s*return;\n\s*\}/.exec(body);
    expect(guard, "the guard block, ending in return").not.toBeNull();
    // Every write the leg makes, and the sweep: the leg's creates, the Save post, the back-dating UPDATEs, the cron route.
    const sites = ["createMatch(expiringName", "/save/confirm", "update quick_matches", "/api/cron/quick-match-expiry"];
    let checked = 0;
    for (const site of sites) {
      const at = body.indexOf(site);
      expect(at, `premise: ${site} is in the suite`).toBeGreaterThan(-1);
      expect(guard!.index, `the guard runs before ${site}`).toBeLessThan(at);
      checked++;
    }
    expect(checked).toBe(sites.length);
  });
});
