// Test-only stand-in for the `sql` tag, shared by the scrub suites that need a REAL minted credential without a
// database: `createLoginLink`, `createVerificationToken`, `createPasswordResetToken` and `createImpersonationToken`
// each mint their token (`crypto.randomBytes(..).toString(..)`) and then insert it. With this in place of `sql`, the
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
  // signup's `insert into users … returning id` and forgot-password's `select id from users`: one user exists.
  if (/insert into users/i.test(text) || /select id from users/i.test(text)) return Promise.resolve([{ id: USER_ID }]);
  return Promise.resolve([]);
}
