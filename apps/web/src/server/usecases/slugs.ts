// Slug hygiene for console URLs (PROMPT-30, v3/01 §2). Generated slugs never
// 409 — collisions suffix "-2", "-3", …; "new" is reserved because the static
// /c/new and /d/new routes win over the dynamic [slug] segments. Renames keep
// the old slug redirecting via slug_history (console /o/... and /shared).
import type postgres from "postgres";

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export const RESERVED_ENTITY_SLUGS: ReadonlySet<string> = new Set(["new"]);

/** First free slug: `base`, then `base-2`, `base-3`, … Reserved bases skip
 *  straight to `-2`.
 *
 *  READ-ONLY, and nothing holds the answer: by the time the caller inserts,
 *  a concurrent request may have claimed the same candidate. Use this alone
 *  only where no row is being written (a preview, a rename dry-run). Anything
 *  that persists the slug must go through `withUniqueSlug`, which lets the
 *  unique index arbitrate. */
export async function uniqueSlug(
  base: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const start = RESERVED_ENTITY_SLUGS.has(base) ? 2 : 1;
  for (let n = start; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
}

/** The unique constraints that mean "this generated slug is taken". Passed
 *  explicitly rather than matched on a 23505 alone, because a table can carry
 *  more than one: `org_posts` also has `org_posts_auto_once`, and retrying THAT
 *  one would spin until the attempt cap with the same slug every time. */
export const SLUG_CONSTRAINT = {
  organizations: "organizations_slug_key",
  competitions: "competitions_org_id_slug_key",
  divisions: "divisions_competition_id_slug_key",
  clubs: "clubs_slug_key",
  org_posts: "org_posts_org_id_slug_key",
} as const;

export type SlugConstraint = (typeof SLUG_CONSTRAINT)[keyof typeof SLUG_CONSTRAINT];

/** Attempts before giving up. Only ever consumed by genuine concurrent
 *  claimants, since `taken` already skips the slugs that were settled before
 *  this call started — 25 simultaneous creates of one name is not a workload,
 *  it is a loop that should surface rather than spin. */
const MAX_SLUG_ATTEMPTS = 25;

function isSlugConflict(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === "23505" && e?.constraint_name === constraint;
}

/**
 * Persist a row under a generated slug, letting the unique index be the
 * arbiter instead of a prior read.
 *
 * `taken` still runs first — it picks the starting candidate in one round trip
 * so the 50th "Friendly" does not cost 50 rolled-back inserts. What changed is
 * that its answer is no longer trusted: if the index rejects the candidate we
 * take the next one and try again.
 *
 * The retry MUST be savepointed. `withTenant` is one `begin()`, and in Postgres
 * a rejected statement aborts the WHOLE transaction — a bare try/catch around
 * the insert compiles, passes against a mocked `taken`, and then fails every
 * following statement with 25P02 against a real server. `attempt` therefore
 * receives the savepoint handle and must issue its writes on THAT, not on the
 * outer `tx`.
 *
 * Keep `attempt` to the write itself. It runs again on conflict, so anything
 * non-transactional inside it (analytics, mail, audit posts to another system)
 * would fire twice.
 */
export async function withUniqueSlug<T>(
  tx: postgres.TransactionSql,
  opts: {
    base: string;
    constraint: SlugConstraint;
    taken: (slug: string) => Promise<boolean>;
  },
  attempt: (slug: string, sp: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const candidate = (n: number): string => (n === 1 ? opts.base : `${opts.base}-${n}`);
  let n = RESERVED_ENTITY_SLUGS.has(opts.base) ? 2 : 1;
  while (await opts.taken(candidate(n))) n++;

  for (let tries = 0; tries < MAX_SLUG_ATTEMPTS; tries++, n++) {
    try {
      // postgres types savepoint() as Promise<UnwrapPromiseArray<T>>; for a
      // non-array T that equals T at runtime but TS cannot prove it — the same
      // safe cast lib/db.ts's withTenant makes over begin().
      return (await tx.savepoint((sp) =>
        attempt(candidate(n), sp as postgres.TransactionSql),
      )) as T;
    } catch (err) {
      if (!isSlugConflict(err, opts.constraint)) throw err;
    }
  }
  throw new Error(
    `could not settle a unique slug for '${opts.base}' after ${MAX_SLUG_ATTEMPTS} attempts`,
  );
}

/** Rename bookkeeping. Latest rename wins when an old slug is recycled —
 *  live rows always beat history at resolve time. */
export async function recordSlugHistory(
  tx: postgres.Sql | postgres.TransactionSql,
  entityType: "org" | "competition" | "division",
  parentId: string | null,
  oldSlug: string,
  entityId: string,
): Promise<void> {
  await tx`
    insert into slug_history (entity_type, parent_id, old_slug, entity_id)
    values (${entityType}, ${parentId}, ${oldSlug}, ${entityId})
    on conflict (entity_type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), old_slug)
    do update set entity_id = excluded.entity_id, created_at = now()`;
}
