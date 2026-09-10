// B06a Task 7 — the news rail, shared by every suite-level fake.
//
// Drafting is a SIDE EFFECT of folding in the real product (`refreshNews`,
// `scoring.ts:132` and `event-import.ts:435`), not a route anyone calls, so a
// fake that only answered the three news routes would leave every draft list
// empty and every news oracle reporting NO SUBJECT — technically honest and
// completely useless as coverage. This world therefore OBSERVES the fold calls
// the fakes already handle and drafts against them, which is the only way the
// suite-level tests can witness the step at all.
//
// Not an echo world. It reproduces the product's own refusals and its own
// silences:
//
//   - `PATCH /divisions/{id}` with `auto_posts: true` needs `news.auto`
//     (`usecases/divisions.ts:652-654`); turning it OFF is always allowed.
//   - Nothing drafts for a division whose `auto_posts` is false
//     (`org-posts.ts:479`), so a run that skipped the enable step gets an
//     empty list rather than a convenient one.
//   - `GET /orgs/{id}/posts?status=` IGNORES an unrecognised status
//     (`route.ts:19`) instead of answering 400 — modelled exactly, so a caller
//     that trusted the query string is caught here and not on a live run.
//   - `published_at` is assigned only when it was null (`org-posts.ts:276,282`),
//     so a republish leaves it alone.
//   - A repeat decide does NOT draft a second post: the `org_posts_auto_once`
//     partial index absorbs it (`org-posts.ts:637,691-697`).
//
// NOT a `.test.ts`, so vitest never collects it — same convention as
// `_claim-routes.ts` / `_oracle-routes.ts` beside it.
import type { RawResult } from "../http.ts";

export interface FakeNewsPost {
  readonly id: string;
  readonly org_id: string;
  readonly competition_id: string | null;
  readonly division_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly published_at: string | null;
  readonly auto_source: { trigger: string; fixture_id: string } | null;
}

export interface NewsRoutesInput extends NewsRoutesOptions {
  /** The fake's own fixture -> division map, read lazily. A callback rather
   *  than a `note...` call at every mint site: the four fakes create fixtures
   *  in two places each, and a hook they can forget is a hook that silently
   *  drafts nothing. Same shape `_advance-routes.ts` takes `getQualifiers` in. */
  readonly divisionOfFixture: (fixtureId: string) => string | undefined;
  /** The competition every division of this run belongs to — these fakes mint
   *  exactly one. Posts carry it because the runner filters on it: the list
   *  route has no competition filter at all (`org-posts.ts:163-167`). */
  readonly competitionOfDivision: (divisionId: string) => string | undefined;
}

export interface NewsRoutesOptions {
  /** The org holds `news.auto`. False makes `PATCH /divisions/{id}` refuse
   *  `auto_posts: true` with a 402, exactly as the product does. */
  readonly newsAutoGranted?: boolean;
  /** A republish that MOVES `published_at` — the mutant the fire-once proxy
   *  exists to catch, made reachable so a wiring test can prove the run reds. */
  readonly republishBumpsTimestamp?: boolean;
  /** Draft nothing at all, however many fixtures decide: the legitimate-zero
   *  case the five preconditions make reachable. */
  readonly draftNothing?: boolean;
}

export interface NewsRoutesWorld {
  /** Watches the fold calls the fake already answers and drafts against them.
   *  Returns nothing — it never claims a route. */
  observe(method: string, path: string, body: unknown): void;
  /** The three news routes. */
  handle(method: string, path: string, body: unknown): RawResult | undefined;
  posts(): readonly FakeNewsPost[];
  autoPostsOn(divisionId: string): boolean;
}

export function makeNewsRoutesWorld(opts: NewsRoutesInput): NewsRoutesWorld {
  const autoPosts = new Set<string>();
  const rows = new Map<string, FakeNewsPost>();
  const draftedFixtures = new Set<string>();
  let counter = 0;
  let clock = 0;

  const draft = (fixtureId: string): void => {
    if (opts.draftNothing === true) return;
    const divisionId = opts.divisionOfFixture(fixtureId);
    if (divisionId === undefined || !autoPosts.has(divisionId)) return;
    // `org_posts_auto_once` — a repeat decide absorbs the insert rather than
    // minting a second post for the same fixture.
    if (draftedFixtures.has(fixtureId)) return;
    draftedFixtures.add(fixtureId);
    const id = `post-${++counter}`;
    rows.set(id, {
      id,
      org_id: "org-fixed",
      competition_id: opts.competitionOfDivision(divisionId) ?? null,
      division_id: divisionId,
      kind: "result",
      status: "draft",
      published_at: null,
      auto_source: { trigger: "result", fixture_id: fixtureId },
    });
  };

  return {
    observe(method, path, body) {
      if (method !== "POST") return;
      const single = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path.split("?")[0]);
      if (single !== null) {
        draft(single[1]);
        return;
      }
      const bulk = /^\/api\/v1\/divisions\/[^/]+\/events\/import$/.exec(path.split("?")[0]);
      if (bulk !== null) {
        const streams = (body as { streams?: readonly { fixture?: { id?: string } }[] }).streams ?? [];
        for (const st of streams) {
          if (st.fixture?.id !== undefined) draft(st.fixture.id);
        }
      }
    },

    handle(method, path, body) {
      const routePath = path.split("?")[0];
      const division = /^\/api\/v1\/divisions\/([^/]+)$/.exec(routePath);
      if (method === "PATCH" && division !== null && (body as { auto_posts?: unknown })?.auto_posts !== undefined) {
        const divisionId = division[1];
        const wants = (body as { auto_posts?: boolean }).auto_posts === true;
        if (wants && opts.newsAutoGranted === false) {
          return {
            status: 402,
            json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "news.auto", feature_key: "news.auto" } } as never,
          };
        }
        if (wants) autoPosts.add(divisionId);
        else autoPosts.delete(divisionId);
        return { status: 200, json: { ok: true, data: { id: divisionId, auto_posts: wants } } };
      }

      const list = /^\/api\/v1\/orgs\/([^/]+)\/posts$/.exec(routePath);
      if (method === "GET" && list !== null) {
        const q = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
        const status = q.get("status");
        const known = status === "draft" || status === "published" || status === "archived";
        const all = [...rows.values()];
        return {
          status: 200,
          json: { ok: true, data: known ? all.filter((p) => p.status === status) : all },
        };
      }

      const patch = /^\/api\/v1\/posts\/([^/]+)$/.exec(routePath);
      if (method === "PATCH" && patch !== null) {
        const row = rows.get(patch[1]);
        if (row === undefined) return { status: 404, json: { ok: false, error: "no such post" } };
        if ((body as { action?: string }).action !== "publish") {
          return { status: 400, json: { ok: false, error: "unsupported action" } };
        }
        const neverPublished = row.published_at === null;
        const next: FakeNewsPost = {
          ...row,
          status: "published",
          published_at:
            neverPublished || opts.republishBumpsTimestamp === true
              ? `2026-09-10T00:00:${String(++clock).padStart(2, "0")}Z`
              : row.published_at,
        };
        rows.set(next.id, next);
        return { status: 200, json: { ok: true, data: next } };
      }
      return undefined;
    },

    posts: () => [...rows.values()],
    autoPostsOn: (divisionId) => autoPosts.has(divisionId),
  };
}
