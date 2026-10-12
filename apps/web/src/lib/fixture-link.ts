// #858 — parse an organiser match URL (`/o/{org}/c/{comp}/d/{div}/f/{no}`)
// pasted into `/admin/fixtures`. Pure so it is unit-testable; the slug chain
// is resolved to a fixture id server-side (`fixtureIdFromLink`).

export interface FixtureLink {
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  fixtureNo: number;
}

// Same shape `org-scope.ts` accepts for a slug. Anything else cannot be a
// live slug, so it is refused here rather than sent to Postgres.
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PATH = /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/]+)\/f\/([^/]+)\/?$/;

/** The match address in `input`, absolute (`https://host/o/…`) or relative
 *  (`/o/…`), ignoring any query string or hash. Null when it is not one. */
export function parseFixtureLink(input: string): FixtureLink | null {
  const trimmed = input.trim();
  let pathname: string;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      pathname = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  } else if (trimmed.startsWith("/")) {
    pathname = trimmed.split(/[?#]/, 1)[0]!;
  } else {
    return null;
  }
  const m = PATH.exec(pathname);
  if (!m) return null;
  const [, orgSlug, compSlug, divSlug, no] = m as unknown as [string, string, string, string, string];
  if (![orgSlug, compSlug, divSlug].every((s) => SLUG.test(s))) return null;
  if (!/^[1-9][0-9]{0,9}$/.test(no)) return null;
  const fixtureNo = Number(no);
  if (!Number.isSafeInteger(fixtureNo) || fixtureNo > 2_147_483_647) return null;
  return { orgSlug, compSlug, divSlug, fixtureNo };
}
