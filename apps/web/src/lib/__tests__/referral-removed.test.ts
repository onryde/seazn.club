// The referral programme is removed (owner, 2026-11-11: "We don't want to have referral and don't using that in prod
// yet"). This guard keeps it removed: no production module imports or names the retired symbols, no route lives under
// `app/refer`, and — with a database — the two `organizations` columns are gone while the ledger's `earn_grant` source
// still admits the historical rows.
//
// Anti-vacuity: every scan reports how many files it read and fails on zero.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR, SRC_DIR } from "./_route-scan";

const REPO_ROOT = path.resolve(SRC_DIR, "../../..");

/** Production code: `apps/web/src`, the smoke harness and the matrix tools — tests excluded (this file names the
 *  symbols on purpose, and a deleted test leaves nothing behind to import). */
const ROOTS = [SRC_DIR, path.join(REPO_ROOT, "scripts"), path.join(REPO_ROOT, "tools")];
const SKIP_DIR = new Set(["node_modules", ".next", "__tests__", "__fixtures__", "dist"]);

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(full);
      } else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !/\.(test|spec)\.[mt]?[jt]sx?$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  for (const root of ROOTS) if (fs.existsSync(root)) walk(root);
  return out;
}

/** The retired symbols, by their exact spelling: the module, its exports, the columns, the grant reasons. */
const RETIRED = [
  /@\/lib\/referral\b/,
  /\bgetOrCreateReferralCode\b/,
  /\bconsumeReferralCookie\b/,
  /\bresolveReferralCode\b/,
  /\bREFERRAL_(?:COOKIE|EARN|WELCOME_EARN|CODE_LEN)\b/,
  /\breferredByOrgId\b/,
  /\breferred_by_org_id\b/,
  /\breferral_code\b/,
  /["']referral(?:_welcome)?["']/,
  /\breferralSuite\b/,
];

describe("the referral programme stays removed", () => {
  it("no production module imports or names a retired referral symbol (counted)", () => {
    const files = productionFiles();
    const hits: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of RETIRED) if (re.test(text)) hits.push(`${path.relative(REPO_ROOT, f)}: ${re}`);
    }
    console.info(`[referral-removed] scanned ${files.length} production files for ${RETIRED.length} symbols`);
    expect(files.length, "the scan read no files — the roots moved").toBeGreaterThan(500);
    expect(hits).toEqual([]);
  });

  it("no route lives under app/refer (counted)", () => {
    const dirs: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        dirs.push(path.relative(APP_DIR, full));
        walk(full);
      }
    };
    walk(APP_DIR);
    // Route groups `(x)` do not reach the URL, so `/refer` is any directory whose URL path starts with `refer`.
    const urlOf = (rel: string) => rel.split(path.sep).filter((s) => !/^\(.*\)$/.test(s)).join("/");
    const refer = dirs.filter((d) => /^refer(?:\/|$)/.test(urlOf(d)));
    console.info(`[referral-removed] scanned ${dirs.length} app directories`);
    expect(dirs.length, "the scan read no app directories").toBeGreaterThan(100);
    expect(refer).toEqual([]);
  });
});

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("the referral schema is dropped (DB)", () => {
  it("organizations has neither referral column nor the code index; earn_grant stays a valid ledger source", async () => {
    const { sql } = await import("@/lib/db");
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'organizations'`;
    expect(cols.length, "organizations has no columns in this schema — wrong schema").toBeGreaterThan(5);
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain("referral_code");
    expect(names).not.toContain("referred_by_org_id");
    const [idx] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_indexes
       where schemaname = current_schema() and indexname = 'organizations_referral_code_key'`;
    expect(idx!.n).toBe(0);
    // Historical `earn_grant` rows (onboarding, first_paid, and the retired referral reasons) must stay valid.
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = current_schema() and t.relname = 'ai_credit_ledger'
         and c.conname = 'ai_credit_ledger_source_check'`;
    expect(check?.def).toContain("'earn_grant'");
  });
});
