// The sitemap check waits out the SAME window the server parses; the module is
// import-free, so it loads under `--experimental-strip-types`.
import { sitemapWindowOverride } from "../../../apps/web/src/lib/sitemap-window.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/** sitemap.xml lists a public, PUBLISHED competition and its division. The
 *  route used to be prerendered at `next build`, which has no database, so the
 *  deployed copy carried no competition at all (fix 2026-09-27). It now renders
 *  per request and caches its competition read for SITEMAP_REVALIDATE_SECONDS
 *  (an hour shipped). On a fresh server — CI's — the first read after this
 *  publish sees it. On a long-lived one the list may have been read earlier in
 *  the hour; start the server AND this script with a short
 *  SITEMAP_REVALIDATE_SECONDS and the check waits that window out. Published,
 *  not draft: a draft is unlisted by owner decision 2026-09-27. */
export async function sitemapSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+sitemap_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
  const comp = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Sitemap Cup ${tag}`,
    visibility: "public",
  });
  const compRow = v1data<{ id: string; slug: string; visibility: string }>(comp);
  const div = await v1(owner, `/api/v1/competitions/${compRow.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divSlug = v1data<{ slug?: string } | undefined>(div)?.slug ?? "";
  const published = await v1(owner, `/api/v1/competitions/${compRow.id}`, "PATCH", { status: "published" });
  check(
    "sitemap: a PUBLIC competition with a division is created and published",
    comp.status === 201 &&
      compRow.visibility === "public" &&
      div.status === 201 &&
      published.status === 200 &&
      v1data<{ status: string }>(published).status === "published" &&
      orgSlug !== "",
  );

  // Paths closed by `</loc>`: the XML carries the server's configured origin,
  // and the hub's entry must not be satisfied by its division's.
  const hub = `/shared/${orgSlug}/${compRow.slug}`;
  const listed = (xml: string) => xml.includes(`${hub}</loc>`) && xml.includes(`${hub}/${divSlug}</loc>`);
  const windowS = sitemapWindowOverride(process.env.SITEMAP_REVALIDATE_SECONDS);
  const deadline = Date.now() + (windowS === undefined ? 0 : (2 * windowS + 10) * 1000);
  let sm = await html(newSession(), "/sitemap.xml");
  while (!listed(sm.body) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    sm = await html(newSession(), "/sitemap.xml");
  }
  check(
    `sitemap: an anonymous GET /sitemap.xml lists the published competition and its division (status ${sm.status})`,
    sm.status === 200 && divSlug !== "" && listed(sm.body),
  );
}
