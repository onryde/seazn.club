// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/** PLG growth loops (design/plg): the "Powered by Seazn Club" footer is an
 *  acquisition CTA (attribution-link.tsx) and every public competition page
 *  carries a fan-facing share bar (share-bar.tsx). The footer used to be the
 *  free tier's alone; V396 (entitlements v18 W2 T15, owner ruling 2026-09-03)
 *  made badge removal ENTERPRISE-only, so a Pro org now carries BOTH — the
 *  `org.branded` gate is unchanged, the row behind it moved. That is the
 *  acquisition loop the same ruling took off profiles, embeds and auto posts;
 *  it runs through public dashboards instead. /me carries the player→organiser
 *  nudge
 *  (run-your-own-cta.tsx) and /discover always offers the /start CTA. */
export async function plgGrowthSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;

  // --- Pro path: share bar present, "Powered by" attribution footer gone.
  const proComp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `PLG Pro Cup ${tag}`,
      visibility: "public",
    }),
  );
  const proShared = await html(newSession(), `/shared/${proOrgSlug}/${proComp.slug}`);
  check(
    "plg pro page keeps the fan ShareBar",
    // The ARIA name, not the visible label. The button shows the brand alone
    // ("WhatsApp") since the sponsor-placement change — a full sentence on the
    // button wrapped the phone hero onto two rows — and a bare "WhatsApp"
    // substring is too weak to isolate this row from anything else on the page.
    proShared.status === 200 &&
      proShared.body.includes("Share this competition on WhatsApp") &&
      proShared.body.includes("Copy link"),
  );
  check(
    // Key off the attribution CTA's own text, not a bare "Powered by" — the
    // community attribution line itself reads "Powered by Seazn Club", so that
    // substring never isolated the footer that org.branded drops.
    //
    // INVERTED by V396, not deleted. This asserted that a Pro page DROPS the
    // footer, which was true for as long as `dashboard.branding` was true on
    // Pro (V112 → V395). The owner moved badge removal to enterprise on
    // 2026-09-03: every self-serve plan carries the badge now, Pro included,
    // and the assertion has to say so rather than be quietly retired. The
    // enterprise case has no persona in this script; `entitlements-v18-badge.test.ts`
    // covers all five plans through `org_has_feature` itself.
    "plg pro page KEEPS the Seazn attribution footer (V396: badge removal is enterprise-only)",
    proShared.body.includes("Run your own free"),
  );
  // Spectator W2 (Task 17, SM4) — the competition page IS the hub now. The
  // markers are the hub's own testids (anchored on `="`), and the old landing's
  // "Divisions" section must be gone rather than rendered beside it.
  check(
    "hub: the public competition page renders the matches hub with its Overview tab",
    proShared.body.includes(`data-testid="mh-root"`) && proShared.body.includes(`data-testid="mh-tab-overview"`),
  );
  check("hub: the old landing's Divisions section is gone", !/<h2[^>]*>Divisions<\/h2>/.test(proShared.body));
  const emptyHub = v1data<{ tabs?: string[]; matches?: unknown[] } | undefined>(
    await v1(newSession(), `/api/v1/public/orgs/${proOrgSlug}/competitions/${proComp.slug}/hub`),
  );
  check(
    "hub: a competition with no divisions offers only Overview and Info, with no matches",
    JSON.stringify(emptyHub?.tabs) === JSON.stringify(["overview", "info"]) && emptyHub?.matches?.length === 0,
  );

  // --- RS007: the `/shared/[orgSlug]` segment must MISS with a 404, never a
  // 500. `not-found.tsx` there once called `resolveLocale()`, which reads
  // cookies/headers; every page in that segment is statically generated
  // (`revalidate = 30`), and a static page whose not-found boundary reads
  // headers makes Next throw "Page changed from static to dynamic at runtime"
  // — so the whole public surface 500'd, real org pages included, while the
  // branded 404 it was supposed to render never appeared at all.
  //
  // This lives in SMOKE rather than e2e on purpose: `e2e.yml` triggers on push
  // to `main` only, so an e2e test gives no pre-merge signal, and smoke is the
  // PR-only gate. It also cannot be a unit test — the failure needs a real
  // request against a production build, which is exactly what smoke does and
  // what `tsc`, vitest and `next build` all missed.
  const orgRoot = await html(newSession(), `/shared/${proOrgSlug}`);
  check("public org page renders (not a 500)", orgRoot.status === 200);
  const missingOrg = await html(newSession(), `/shared/no-such-org-${tag}`);
  check(
    `nonexistent org 404s rather than 500ing (got ${missingOrg.status})`,
    missingOrg.status === 404,
  );
  const missingComp = await html(newSession(), `/shared/${proOrgSlug}/no-such-comp-${tag}`);
  check(
    `nonexistent competition under a real org 404s rather than 500ing (got ${missingComp.status})`,
    missingComp.status === 404,
  );

  // --- Free path: a fresh community owner's public page carries both the
  // attribution CTA and the fan ShareBar.
  const free = newSession();
  const freeVer = await signIn(free, `delivered+plg_free_${tag}@resend.dev`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `PLG Free Cup ${tag}`,
      visibility: "public",
    }),
  );
  const freeShared = await html(newSession(), `/shared/${freeOrg.slug}/${freeComp.slug}`);
  check(
    "plg free page carries the Seazn attribution CTA",
    freeShared.status === 200 && freeShared.body.includes("Run your own free"),
  );
  check(
    "plg free page also renders the fan ShareBar",
    freeShared.body.includes("Share this competition on WhatsApp") &&
      freeShared.body.includes("Copy link"),
  );

  // --- /me: the player→organiser "run your own" CTA is gated to users with
  // NO org (organisers must never see their own acquisition pitch). `free`
  // owns an org → hidden; a fresh org-less session → shown.
  const meRun = await html(free, "/me");
  check(
    "plg /me hides run-your-own from a user who has an org",
    meRun.status === 200 && !meRun.body.includes("utm_source=me"),
  );
  // An org-less session needs consume-with-next: a bare signIn auto-creates
  // "My organization" (ensureActiveOrg), but a `next` target skips the org
  // bootstrap (postAuthLanding) — exactly how claim/invite emails land.
  const playerOnly = newSession();
  const plgReq = (await call(playerOnly, "/api/auth/magic-link", "POST", {
    email: `delivered+plg_player_${tag}@resend.dev`,
  })) as { login_url?: string };
  const plgTok = new URL(plgReq.login_url ?? "").searchParams.get("token");
  await call(playerOnly, "/api/auth/magic-link/consume", "POST", {
    token: plgTok,
    next: "/me",
  });
  const meRunPlayer = await html(playerOnly, "/me");
  check(
    "plg /me renders run-your-own for an org-less player",
    meRunPlayer.status === 200 &&
      meRunPlayer.body.includes("Run your own tournament") &&
      meRunPlayer.body.includes("utm_source=me"),
  );

  // --- /discover: the acquisition CTA back to /start (unconditional —
  // renders whether or not any club happens to be live right now).
  const discover = await html(newSession(), "/en/discover");
  check(
    "plg /discover offers the /start acquisition CTA",
    discover.status === 200 &&
      discover.body.includes("utm_source=discover") &&
      discover.body.includes("Start free"),
  );
}
