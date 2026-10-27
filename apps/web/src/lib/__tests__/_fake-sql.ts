// Test-only stand-in for the `sql` tag, shared by the scrub suites that need a REAL minted credential without a
// database: `createLoginLink`, `createVerificationToken` and `createImpersonationToken`
// each mint their token (`crypto.randomBytes(..).toString(..)`) and then insert it; `createInvite` mints the org-invite token and
// reads the inserted row back. With this in place of `sql`, the
// real minter runs end to end; only the Postgres round trip is a stand-in, and the row it would have written is
// recorded so a test can read the token a ROUTE minted (a route returns the emailed link, not the token).
//
// Not a test file (no `.test.` in the name), so vitest never collects it. The caller owns the `vi.mock("@/lib/db")`
// that points `sql` here, because `vi.mock` is per file.
export interface RecordedInsert {
  table: string;
  values: unknown[];
}

/** Every `insert into <table>` since the last `inserts.length = 0`. */
export const inserts: RecordedInsert[] = [];

export const USER_ID = "00000000-0000-4000-8000-000000000001";

export function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
  const text = strings.join("?").replace(/\s+/g, " ");
  const insert = /insert into (\w+)/i.exec(text);
  if (insert) inserts.push({ table: insert[1]!, values });
  // The staff resend-verification route reads its target first: one unverified user exists.
  if (/select id, email, email_verified from users/i.test(text)) return Promise.resolve([{ id: USER_ID, email: "unverified@example.test", email_verified: false }]);
  // createInvite's `insert … returning`: the row it just wrote, columns (org_id, role, email, token, created_by, expires_at, max_uses).
  if (/insert into org_invites/i.test(text)) {
    const [org_id, role, email, token, , expires_at, max_uses] = values;
    return Promise.resolve([{ id: "inv-1", org_id, role, email, token, expires_at, max_uses, used_count: 0, revoked: false, created_at: new Date().toISOString() }]);
  }
  // The invite route names the club in the email, in the club's default language (none set: English).
  if (/select name, default_locale from organizations/i.test(text)) return Promise.resolve([{ name: "Lagos Chess Club", default_locale: null }]);
  return Promise.resolve([]);
}

/** `sql.begin(fn)`: the callback runs against the same stand-in (there is no transaction to open or roll back). The sign-in
 *  route writes its token and its outbox row inside one, so the scrub suites that drive it need this. */
fakeSql.begin = <T>(fn: (tx: typeof fakeSql) => Promise<T>): Promise<T> => fn(fakeSql);
