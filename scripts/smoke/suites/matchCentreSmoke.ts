// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, newSession, cookieHeader, call, check, signIn, tag, ledger, timedFixture, html, v1, v1data,
} from "../harness.ts";

/**
 * Width/height straight off a PNG's own `IHDR` chunk (spec §W3-poster
 * acceptance: "decode the poster.png and check dimensions"). No image
 * library needed for two big-endian uint32s: the 8-byte PNG signature is
 * followed by a 4-byte chunk length, the 4-byte ASCII type "IHDR", then
 * IHDR's own first two fields are width then height — offsets 16 and 20.
 * Throws on anything that is not a PNG at all, which is itself a useful
 * failure mode here (a 404 or an HTML error page never has these bytes).
 */
function pngSize(buf: Uint8Array): { width: number; height: number } {
  const sig = Buffer.from(buf.subarray(0, 8));
  if (sig.toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  const view = Buffer.from(buf.subarray(0, 24));
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

/**
 * Task 15 (spectator W1) — the public match-centre page and the
 * `match_centre` field on `GET /api/v1/public/fixtures/{id}` are real
 * against a live server, not merely unit-tested. A bare `core.start` (no
 * balls at all) is enough for the second check: `buildMatchCentre`
 * (apps/web/src/server/public-site/match-centre.ts) always emits
 * `tabs: ["summary", ...extraTabs, "info"]`, and `extraTabs` only grows once
 * real ball/line data exists — so `tabs.length` is exactly 2 here, which is
 * the floor the check pins. The court card renders regardless: `MatchCentre`
 * only falls back to its placeholder when `doc.tabs.length === 0`. Own
 * fresh org — never touches the shared org this file's other suites depend
 * on.
 */
export async function matchCentreSmoke(): Promise<void> {
  const owner = newSession();
  await signIn(owner, `delivered+matchcentre_${tag}@resend.dev`);
  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Match Centre Smoke ${tag}`,
      visibility: "public",
    }),
  );
  const fx = await timedFixture(owner, comp.id, {
    name: "Smoke XI",
    sport_key: "cricket",
    variant_key: "t20",
    entrants: [
      { kind: "team", display_name: `Smoke Home ${tag}`, seed: 1 },
      { kind: "team", display_name: `Smoke Away ${tag}`, seed: 2 },
    ],
  });
  const fxLedger = ledger(owner, fx.fixtureId);
  // cricket.toss BEFORE core.start — the engine's own guard 422s the other
  // way round ("toss must precede core.start", cricket.ts:3372).
  const toss = await fxLedger.send("cricket.toss", { wonBy: fx.entrantIds[0], elected: "bat" });
  check("match centre smoke: cricket.toss is accepted before core.start", toss.status < 300);
  const start = await fxLedger.send("core.start", {});
  check("match centre smoke: core.start is accepted", start.status < 300);

  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs[0]?.slug ?? "";
  const divSlug = v1data<{ slug: string }>(await v1(owner, `/api/v1/divisions/${fx.divisionId}`)).slug;
  const path = `/shared/${orgSlug}/${comp.slug}/${divSlug}/fixtures/${fx.fixtureId}`;
  // Fix round 1 (task-15-review.md I3): the whole point of this check is
  // that an ANONYMOUS spectator can read the page -- `owner`'s session
  // cookies would still pass if `/shared` silently started requiring auth,
  // exactly the regression this check exists to catch. `newSession()` here
  // (moved up from below, now shared with the JSON check too) carries none.
  const anon = newSession();
  const page = await html(anon, path);
  check(
    "match centre smoke: GET /shared/.../fixtures/{id} renders the match centre (mc-court-card), read ANONYMOUSLY",
    page.status === 200 && page.body.includes('data-testid="mc-court-card"'),
  );

  const pub = await v1(anon, `/api/v1/public/fixtures/${fx.fixtureId}`);
  const tabs = v1data<{ match_centre?: { tabs?: unknown[] } }>(pub).match_centre?.tabs;
  check(
    "match centre smoke: GET /api/v1/public/fixtures/{id} carries match_centre.tabs.length >= 2",
    Array.isArray(tabs) && tabs.length >= 2,
  );

  // W3 poster (spec §Acceptance "Smoke: poster.png 200, image/png,
  // non-trivial size, for one fixture") — decoded, not just status-checked,
  // per the same section's "decode the poster.png and check dimensions".
  const posterRes = await fetch(`${BASE}${path}/poster.png`, {
    headers: cookieHeader(anon) ? { cookie: cookieHeader(anon) } : {},
  });
  const posterBuf = new Uint8Array(await posterRes.arrayBuffer());
  check(
    "match centre smoke: GET .../poster.png is 200 image/png, ANONYMOUSLY",
    posterRes.status === 200 && (posterRes.headers.get("content-type") ?? "").includes("image/png"),
  );
  check("match centre smoke: poster.png is a non-trivial size", posterBuf.byteLength > 5_000);
  const posterDims = pngSize(posterBuf);
  check(
    "match centre smoke: poster.png decodes to 1080×1350 (POSTER_SIZE)",
    posterDims.width === 1080 && posterDims.height === 1350,
  );

  // The OG re-render (ruling 16) shares the same model at a third aspect —
  // pinned separately per the spec's regression list: "the route still
  // answers 200 image/png at exactly 1200×630".
  const ogUrl = /<meta property="og:image" content="([^"]+)"/.exec(page.body)?.[1];
  const ogPath = ogUrl?.replace(/^https?:\/\/[^/]+/, "");
  const ogRes = ogPath ? await fetch(`${BASE}${ogPath}`) : null;
  const ogBuf = ogRes ? new Uint8Array(await ogRes.arrayBuffer()) : new Uint8Array();
  check(
    "match centre smoke: fixture OG card is 200 image/png",
    !!ogRes && ogRes.status === 200 && (ogRes.headers.get("content-type") ?? "").includes("image/png"),
  );
  const ogDims = ogBuf.byteLength > 0 ? pngSize(ogBuf) : { width: 0, height: 0 };
  check(
    "match centre smoke: fixture OG card decodes to 1200×630 (OG_SIZE)",
    ogDims.width === 1200 && ogDims.height === 630,
  );
}
