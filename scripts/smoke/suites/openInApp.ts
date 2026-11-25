// Open in app (spec 2026-11-25 §5.2, §5.3): `assetlinks.json` and the `/app/*` fallback pages as the BUILT server serves
// them. Anonymous, keyless, no org. The session cookie sent here is made up: the proxy reads only its presence, and a
// fallback page must set no cookie even then.
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, check } from "../harness.ts";

/** Typed here, never read from apps/web/src/lib/app-store.ts. */
const PLAY = "https://play.google.com/store/apps/details?id=com.seazn.capture";

export async function openInAppSuite(): Promise<void> {
  const links = await fetch(`${BASE}/.well-known/assetlinks.json`, { redirect: "manual" });
  const list: unknown = links.status === 200 ? await links.json() : null;
  check(`open in app: assetlinks.json is a 200 with no redirect (status ${links.status})`, links.status === 200);
  check(
    "open in app: assetlinks.json is a JSON array served as application/json",
    (links.headers.get("content-type") ?? "").startsWith("application/json") && Array.isArray(list),
  );

  for (const kind of ["stream", "score", "day"]) {
    const res = await fetch(`${BASE}/app/${kind}`, { redirect: "manual", headers: { cookie: "seazn_session=smoke-presence-only" } });
    const body = await res.text();
    const header = (name: string) => res.headers.get(name) ?? "";
    check(`open in app: /app/${kind} is 200 HTML`, res.status === 200 && header("content-type").startsWith("text/html"));
    check(
      `open in app: /app/${kind} sends no referrer, is never stored or indexed, and sets no cookie`,
      header("referrer-policy") === "no-referrer" &&
        header("cache-control") === "no-store" &&
        header("x-robots-tag").includes("noindex") &&
        res.headers.getSetCookie().length === 0,
    );
    const policy = header("content-security-policy") || header("content-security-policy-report-only");
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    // The logo and the condensed face are inline `data:` URIs, which ask for nothing; any other src or url() is a request.
    const loaded = [...body.matchAll(/(?:\ssrc\s*=|\burl\()\s*["']?([^"'\s>)]*)/gi)].map((m) => m[1]);
    check(
      `open in app: /app/${kind} has one script under the served nonce, loads only data: URIs, and the Play link`,
      nonce !== undefined &&
        body.split("<script").length === 2 &&
        body.includes(`<script nonce="${nonce}">`) &&
        loaded.length > 0 &&
        loaded.every((target) => target.startsWith("data:")) &&
        body.includes(`href="${PLAY}"`),
    );
    check(
      `open in app: only /app/score offers the way back to scoring in the browser (/app/${kind})`,
      body.includes('data-testid="score-in-browser"') === (kind === "score"),
    );
  }
}
