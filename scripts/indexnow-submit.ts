// Tells IndexNow (indexnow.org: Bing and the engines that share its list) which pages of the production site to fetch
// again: the help, blog and marketing URLs of https://seazn.club/sitemap.xml, posted to the shared endpoint. prod.yml
// runs it after the deploy, as a step that cannot fail the job:
//
//     INDEXNOW_ORIGIN=https://seazn.club node --experimental-strip-types scripts/indexnow-submit.ts
//
// It submits only from a production deploy (`refusal` below): staging, a laptop, a test and a pull request run are
// refused before any request is made. No dependencies. scripts/__tests__/indexnow-submit.test.ts.
import { isMainModule } from "./lib/main-module.ts";

/**
 * The IndexNow key. PUBLIC by the protocol's design: the site serves it at /<key>.txt (apps/web/public/), which is how a
 * search engine knows the sender of a submission controls the host. It is not a credential and is used for nothing else.
 * To rotate it, change it here and rename and rewrite that file.
 */
export const INDEXNOW_KEY = "bd16c17c8b369e759475dd324e520b07";

/** The one origin this may submit for, compared character for character. */
export const PRODUCTION_ORIGIN = "https://seazn.club";
const ENDPOINT = "https://api.indexnow.org/indexnow";
/** The protocol's limit on one POST's urlList. */
const BATCH_SIZE = 10_000;
/** Each request gives up on its own, well inside the workflow step's timeout. */
const REQUEST_TIMEOUT_MS = 20_000;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Why this environment may not submit, or null when it is the production deploy. Two things must hold: the origin the
 * caller names is exactly production's (there is no default), and the process is prod.yml's own trigger, a GitHub Actions
 * push of a release tag. So a laptop, a test or a pull request run cannot submit even with the origin set by hand.
 */
export function refusal(env: Env): string | null {
  const origin = env.INDEXNOW_ORIGIN;
  if (origin !== PRODUCTION_ORIGIN) {
    return `INDEXNOW_ORIGIN is ${origin === undefined ? "not set" : `'${origin}'`}, not exactly '${PRODUCTION_ORIGIN}'`;
  }
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "push" || !env.GITHUB_REF?.startsWith("refs/tags/v")) {
    return "this is not the production deploy (a GitHub Actions push of a release tag, refs/tags/v*)";
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Every <loc> of a sitemap, XML-unescaped. An hreflang alternate is not a <loc>. */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]));
}

const onProduction = (url: string): boolean => {
  try {
    return new URL(url).origin === PRODUCTION_ORIGIN;
  } catch {
    return false;
  }
};

/**
 * The pages a release changes: help, the blog and the marketing tree (/{lang}; the sitemap lists its /en URLs). An allow
 * list on the path's first segment, so everything else the sitemap holds is left to the crawlers' own schedule, above all
 * the public competition pages under /live, which change with every match and not with a deploy.
 */
const RELEASE_PAGE = /^\/(?:en|help|blog)(?:\/|$)/;

export interface SubmitResult {
  submitted: number;
  batches: number;
  /** <loc> entries left out because they name another host, which the protocol refuses. */
  otherHost: number;
  /** Production pages left out because they are not help, blog or marketing pages (RELEASE_PAGE). */
  leftOut: number;
}

/**
 * Reads the production sitemap and posts its help, blog and marketing URLs. `fetch` has no default, so nothing reaches
 * the network unless its caller hands it the network. Throws on a refused environment (before any request), on a sitemap
 * that does not answer or lists none of those pages, and on the first batch IndexNow does not accept.
 */
export async function submitIndexNow(io: { env: Env; fetch: typeof globalThis.fetch }): Promise<SubmitResult> {
  const refused = refusal(io.env);
  if (refused !== null) throw new Error(`refusing to submit: ${refused}`);

  const sitemap = await io.fetch(`${PRODUCTION_ORIGIN}/sitemap.xml`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!sitemap.ok) throw new Error(`the sitemap answered ${sitemap.status}; nothing submitted`);
  const found = sitemapUrls(await sitemap.text());
  const ours = found.filter(onProduction);
  const unique = [...new Set(ours)];
  const urls = unique.filter((url) => RELEASE_PAGE.test(new URL(url).pathname));
  if (urls.length === 0) {
    throw new Error(`the sitemap lists no ${PRODUCTION_ORIGIN} help, blog or marketing URL (${found.length} <loc> read); nothing submitted`);
  }

  let batches = 0;
  for (let at = 0; at < urls.length; at += BATCH_SIZE) {
    const urlList = urls.slice(at, at + BATCH_SIZE);
    const res = await io.fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: new URL(PRODUCTION_ORIGIN).host,
        key: INDEXNOW_KEY,
        keyLocation: `${PRODUCTION_ORIGIN}/${INDEXNOW_KEY}.txt`,
        urlList,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 200: received. 202: received, the key still to be checked.
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(`IndexNow answered ${res.status} to batch ${batches + 1} (${urlList.length} URLs); ${at} URLs were accepted before it`);
    }
    batches++;
  }
  return { submitted: urls.length, batches, otherHost: found.length - ours.length, leftOut: unique.length - urls.length };
}

if (isMainModule(import.meta.url)) {
  try {
    const r = await submitIndexNow({ env: process.env, fetch: globalThis.fetch });
    console.log(`IndexNow accepted ${r.submitted} URLs in ${r.batches} batch(es); left out: ${r.leftOut} pages that are not help, blog or marketing, and ${r.otherHost} entries naming another host.`);
  } catch (e) {
    // The workflow step is continue-on-error, so the warning annotation is what makes a failure visible.
    console.log(`::warning::IndexNow submission did not happen: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
