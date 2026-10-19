// Which deployment a browser Sentry event came from (owner ruling 2026-10-19: report the real environment, stg vs prod).
//
// NODE_ENV cannot say: the image sets it to "production" for staging and production alike, so every event would carry
// "production". The browser has no runtime env, only what the build baked in; the one baked value that differs per deployment
// is the site's own origin, NEXT_PUBLIC_BASE_URL (fly.toml -> https://seazn.club, fly.stg.toml -> https://stg.seazn.club, both
// passed as build args). The host is matched EXACTLY, so a lookalike (`seazn.club.evil.test`) or a subdomain is not mistaken
// for a deployment, and anything unmapped (local, CI, a preview) keeps the old answer, NODE_ENV.
//
// The server and edge configs still report NODE_ENV; this is the browser's only (sentry.server.config.ts is out of scope).
const ENVIRONMENT_BY_HOST: Readonly<Record<string, string>> = {
  "seazn.club": "production",
  "stg.seazn.club": "staging",
};

/**
 * @param baseUrl the baked `process.env.NEXT_PUBLIC_BASE_URL` (written out literally at the call site, which is what lets
 *                Next inline it into the client bundle)
 * @param nodeEnv `process.env.NODE_ENV`, the answer for any origin that is not a known deployment
 */
export function sentryEnvironment(baseUrl: string | undefined, nodeEnv: string | undefined): string {
  let host = "";
  try {
    if (baseUrl) host = new URL(baseUrl).hostname;
  } catch {
    // Not a URL: unmapped, so NODE_ENV answers.
  }
  return Object.hasOwn(ENVIRONMENT_BY_HOST, host) ? ENVIRONMENT_BY_HOST[host]! : nodeEnv || "development";
}
