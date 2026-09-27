import { getPublicDivision, readPublicDivisionDetail, type PublicDivision } from "./data";

type PublicDivisionPage = NonNullable<Awaited<ReturnType<typeof getPublicDivision>>>;
type PublicDivisionDetail = Awaited<ReturnType<typeof readPublicDivisionDetail>>;

/**
 * Every division at once: the one way to read more than one division (the
 * competition hub, the competition poster and the slideshow). Each division's
 * own read runs its four lanes one after another (`sequential`, see
 * `readPublicDivisionDetail`), so the fan-out holds at most one pooled
 * connection per division instead of four (prod runs 12 a machine).
 *
 * Results come back in `divisions` order. A division the shell no longer lists
 * reads as null, as from `getPublicDivision`. `uncached` reads each detail
 * straight from Postgres: the hub's Redis rebuild only (see
 * `loadCompetitionHub`).
 *
 * Its own module rather than data.ts so that it reads through data.ts's
 * exports: a test that stands in for `getPublicDivision` stands in for it here
 * too.
 */
export function readEveryPublicDivision(
  orgSlug: string,
  compSlug: string,
  divisions: readonly PublicDivision[],
): Promise<(PublicDivisionPage | null)[]>;
export function readEveryPublicDivision(
  orgSlug: string,
  compSlug: string,
  divisions: readonly PublicDivision[],
  read: { uncached: boolean },
): Promise<(PublicDivisionDetail | PublicDivisionPage | null)[]>;
export function readEveryPublicDivision(
  orgSlug: string,
  compSlug: string,
  divisions: readonly PublicDivision[],
  { uncached = false }: { uncached?: boolean } = {},
): Promise<(PublicDivisionDetail | PublicDivisionPage | null)[]> {
  const oneQueryAtATime = { sequential: true };
  return Promise.all(
    divisions.map((d) =>
      uncached
        ? readPublicDivisionDetail(d, oneQueryAtATime)
        : getPublicDivision(orgSlug, compSlug, d.slug, oneQueryAtATime),
    ),
  );
}
