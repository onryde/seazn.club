// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, call, check, signIn, tag, html, v1, v1data,
} from "../harness.ts";

// =====================================================================
// v3 content + API wave (PROMPT-35/37/39): markdown descriptions render
// through the one prose pipeline, /help + /developers are live, API keys
// carry scopes + pins + rate headers, OG/poster/embed/sponsors work on the
// pro path and gate/degrade honestly on the free path.
// =====================================================================
export async function v3ContentApiSuite(
  admin: Session,
  proOrgId: string,
  proOrgSlug: string,
): Promise<void> {
  const bin = async (path: string, s?: Session) => {
    const res = await fetch(BASE + path, {
      headers: s && Object.keys(s.cookies).length ? { cookie: cookieHeader(s) } : {},
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      buf,
    };
  };

  // ---- PRO PATH -------------------------------------------------------
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Content Wave ${tag}`,
    visibility: "public",
    description:
      `## Welcome\n\nA **great** day out.\n\n**[Register now](https://example.com/r)**\n\n` +
      `<script>alert(1)</script>`,
  });
  check("v3: markdown competition created", comp.status === 201);
  const compData = v1data<{ id: string; slug: string }>(comp);

  // Full config on purpose — the seeded variant preset can be sparse in a
  // shared/dev DB (the CONFIG_INVALID variant-poisoning gotcha, PR #63).
  const div = await v1(admin, `/api/v1/competitions/${compData.id}/divisions`, "POST", {
    name: "Open Singles",
    sport_key: "generic",
    variant_key: "score",
    config: {
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    },
  });
  check("v3: division created", div.status === 201);
  const divData = v1data<{ id: string; slug: string }>(div);
  const patchedDiv = await v1(admin, `/api/v1/divisions/${divData.id}`, "PATCH", {
    description: "### House rules\n\nBe kind.",
  });
  check("v3: division description via PATCH", patchedDiv.status === 200);

  const publicComp = await html(newSession(), `/shared/${proOrgSlug}/${compData.slug}`);
  check("v3: public page renders markdown h2", publicComp.body.includes("<h2>Welcome</h2>"));
  check("v3: CTA button rendered", publicComp.body.includes("prose-cta"));
  check("v3: XSS neutralised on public page", !publicComp.body.includes("<script>alert"));

  // Help centre + format gallery + developer docs are live.
  const helpHome = await html(newSession(), "/help");
  check("v3: /help renders", helpHome.status === 200 && helpHome.body.includes("Getting started"));
  const helpFormats = await html(newSession(), "/help/formats/league");
  check(
    "v3: format explainer renders",
    helpFormats.status === 200 && helpFormats.body.includes("Round robin"),
  );
  const helpIndex = (await (await fetch(BASE + "/api/help-index")).json()) as {
    slug: string;
  }[];
  check(
    "v3: help search index has waitlist",
    helpIndex.some((d) => d.slug === "registration/waitlist"),
  );
  const dev = await html(newSession(), "/developers");
  check("v3: /developers renders", dev.status === 200 && dev.body.includes("scope"));
  const pubSpec = (await (await fetch(BASE + "/api/v1/openapi.json?published=1")).json()) as {
    paths: Record<string, unknown>;
  };
  check(
    "v3: published spec excludes key management",
    !Object.keys(pubSpec.paths).some((p) => p.includes("api-keys")),
  );

  // Scoped API keys (PROMPT-37): read key reads with rate headers, 403s on
  // writes; pinned key stays inside its competition.
  const mkKey = await v1(admin, `/api/v1/orgs/${proOrgId}/api-keys`, "POST", {
    name: "smoke read",
    scopes: ["read"],
  });
  check("v3: read key minted", mkKey.status === 201);
  const keySecret = v1data<{ secret: string }>(mkKey).secret;
  const keyAuth = { Authorization: `Bearer ${keySecret}` };
  const keyRead = await v1(newSession(), "/api/v1/competitions", "GET", undefined, keyAuth);
  check("v3: read key GETs competitions", keyRead.status === 200);
  check("v3: rate-limit headers present", !!keyRead.headers.get("X-RateLimit-Limit"));
  const keyWrite = await v1(
    newSession(),
    "/api/v1/competitions",
    "POST",
    { ends_on: "2030-12-31", name: "Nope" },
    keyAuth,
  );
  check("v3: read key 403 on manage route", keyWrite.status === 403);

  const otherComp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Pin Other ${tag}`,
  });
  const otherId = v1data<{ id: string }>(otherComp).id;
  const mkPinned = await v1(admin, `/api/v1/orgs/${proOrgId}/api-keys`, "POST", {
    name: "smoke pinned",
    scopes: ["read"],
    competition_id: compData.id,
  });
  const pinnedAuth = {
    Authorization: `Bearer ${v1data<{ secret: string }>(mkPinned).secret}`,
  };
  const pinnedOk = await v1(
    newSession(),
    `/api/v1/competitions/${compData.id}`,
    "GET",
    undefined,
    pinnedAuth,
  );
  check("v3: pinned key reads its competition", pinnedOk.status === 200);
  const pinnedOut = await v1(
    newSession(),
    `/api/v1/competitions/${otherId}`,
    "GET",
    undefined,
    pinnedAuth,
  );
  check("v3: pinned key 403 outside its competition", pinnedOut.status === 403);

  // OG share card + QR poster (PROMPT-39 #1/#3). Next serves dynamic
  // metadata images on hash-suffixed URLs — read og:image off the page.
  const ogUrl = (body: string) =>
    /<meta property="og:image" content="([^"]+)"/.exec(body)?.[1]?.replace(/^https?:\/\/[^/]+/, "");
  const ogPath = ogUrl(publicComp.body);
  check("v3: page exposes og:image", !!ogPath);
  const og = await bin(ogPath ?? "/missing");
  check("v3: competition OG card is a PNG", og.status === 200 && og.type.includes("image/png"));
  const poster = await bin(`/shared/${proOrgSlug}/${compData.slug}/poster.pdf`);
  check(
    "v3: QR poster is a PDF",
    poster.status === 200 &&
      poster.buf[0] === 0x25 &&
      poster.buf[1] === 0x50 &&
      poster.buf[2] === 0x44 &&
      poster.buf[3] === 0x46,
  );

  // Embeds (PROMPT-39 #4): pro renders, and sponsors (#5) reach the dashboard.
  const embed = await html(newSession(), `/embed/divisions/${divData.id}/standings`);
  check("v3: embed renders on pro", embed.status === 200 && embed.body.includes("seazn.club"));
  const sponsorPatch = (await call(admin, `/api/orgs/${proOrgId}`, "PATCH", {
    sponsors: [{ name: `Acme ${tag}`, url: "https://acme.example" }],
  })) as { id?: string };
  check("v3: sponsors saved", !!sponsorPatch.id);
  // v10: the blob is a read shim only — once the org has sponsors table rows
  // (sponsorsSuite created them), public pages render rows, not the blob.
  const stripRow = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Strip ${tag}`,
    url: "https://strip.example",
  });
  check("v3: sponsor row created for strip", stripRow.status === 201);
  const compPage2 = await html(newSession(), `/shared/${proOrgSlug}/${compData.slug}`);
  check("v3: sponsor strip on pro dashboard", compPage2.body.includes(`Strip ${tag}`));
  check(
    "v3: blob sponsor stays shim-only once rows exist",
    !compPage2.body.includes(`Acme ${tag}`),
  );

  // ---- FREE PATH ------------------------------------------------------
  const free = newSession();
  const freeVer = await signIn(free, `delivered+content_free_${tag}@resend.dev`);
  const freeOrgId = freeVer.org_id;
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeSlug = freeOrgs.find((o) => o.id === freeOrgId)?.slug ?? "";

  const freeComp = await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Free Content ${tag}`,
    visibility: "public",
    description: "## Free words\n\nStill **rendered**.",
  });
  check("v3: free org markdown competition", freeComp.status === 201);
  const freeCompData = v1data<{ id: string; slug: string }>(freeComp);
  const freeDiv = await v1(free, `/api/v1/competitions/${freeCompData.id}/divisions`, "POST", {
    name: "Free Div",
    sport_key: "generic",
    variant_key: "score",
    config: {
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    },
  });
  const freeDivId = v1data<{ id: string }>(freeDiv).id;

  const freePage = await html(newSession(), `/shared/${freeSlug}/${freeCompData.slug}`);
  check("v3: free public page renders markdown", freePage.body.includes("<h2>Free words</h2>"));
  const freeOg = await bin(ogUrl(freePage.body) ?? "/missing");
  check(
    "v3: free OG card renders (violet)",
    freeOg.status === 200 && freeOg.type.includes("image/png"),
  );

  const freeKey = await v1(free, `/api/v1/orgs/${freeOrgId}/api-keys`, "POST", {
    name: "nope",
    scopes: ["read"],
  });
  check("v3: key creation 402 on free", freeKey.status === 402);
  const freeEmbed = await html(newSession(), `/embed/divisions/${freeDivId}/standings`);
  check("v3: embed 404 on free", freeEmbed.status === 404);

  await call(free, `/api/orgs/${freeOrgId}`, "PATCH", {
    sponsors: [{ name: `Acme Free ${tag}` }],
  });
  // v10 policy change: the un-tiered partner strip is free — a community
  // org's sponsors (here via the blob shim: no table rows yet) render
  // publicly, flat, with no tier labels.
  const freePage2 = await html(newSession(), `/shared/${freeSlug}/${freeCompData.slug}`);
  check(
    "v3→v10: free sponsor strip renders publicly, un-tiered",
    freePage2.body.includes(`Acme Free ${tag}`) && !freePage2.body.includes("Presented by"),
  );
}
