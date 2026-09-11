import { test, expect } from "@playwright/test";
import zlib from "node:zlib";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, loginUi, type OrgInfo } from "./helpers";

// Group D (owner ruling, 2026-08-24): the public poster PDF gets the draw as
// page 2 onward — a round-by-round list, grouped by stage/round, using the
// same slot labels the board shows for an unresolved (day-one) fixture. No
// UI to check at any width, so (like calendar-ics.spec.ts and
// knockout.spec.ts) this file must NOT join the seven-width viewport
// matrix: playwright.config.ts's "parallel" project testIgnore is
// [SERIAL_SPECS, /mobile\.spec\.ts/], and this filename keeps it out of
// every mobile-*/tablet-* project's testMatch. The first two tests are
// request-only, reusing the shared authenticated session the way
// calendar-ics.spec.ts does; the locale test needs its own isolated login
// (see that describe block) because it mutates the org's default_locale,
// which would otherwise leak French copy into every other test sharing the
// default session's org in the same parallel shard.
//
// Fixture: the SAME 4-entrant knockout shape calendar-ics.spec.ts already
// established — generate() writes the final's home/away as
// `{key: "slot.winner_match", …}` labels (no entrant, no scheduled_at)
// before either semi is played (stages.ts:1117-1155).
//
// A pdfkit PDF's content stream is FlateDecode-compressed by default, so
// this reuses the SAME two decode techniques the route's own unit test
// (poster.pdf/__tests__/route.test.ts) validates and documents in full —
// the PDF's own /Count field for page count, and hex-bracketed Tj/TJ
// operand decoding (valid only for this route's standard, unembedded
// Helvetica/Helvetica-Bold text) for the actual rendered characters. Doing
// this against a REAL server response, not a hand-built mock, is the
// point: it proves the real Postgres row shapes this route fetches reach
// pdfkit correctly, not just the fixtures the unit test hand-builds.

function decodePdfPageCount(pdf: Buffer): number {
  const raw = pdf.toString("latin1");
  const m =
    /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(raw) ||
    /\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/.exec(raw);
  if (!m) throw new Error("no /Count found in PDF object table");
  return Number(m[1]);
}

function decodePdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const decoder = new TextDecoder("windows-1252");
  const decodeHexRun = (segment: string): string => {
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    let out = "";
    let hm: RegExpExecArray | null;
    while ((hm = hexRe.exec(segment))) out += decoder.decode(Buffer.from(hm[1]!, "hex"));
    return out;
  };
  const lines: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    let inflated: Buffer;
    try {
      inflated = zlib.inflateSync(Buffer.from(m[1]!, "latin1"));
    } catch {
      continue; // not a FlateDecode text stream (e.g. the QR image XObject)
    }
    const content = inflated.toString("latin1");
    const tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
    let am: RegExpExecArray | null;
    while ((am = tjArrayRe.exec(content))) {
      const line = decodeHexRun(am[1]!);
      if (line) lines.push(line);
    }
    const tjRe = /<([0-9A-Fa-f]+)>\s*Tj/g;
    let tm: RegExpExecArray | null;
    while ((tm = tjRe.exec(content))) lines.push(decoder.decode(Buffer.from(tm[1]!, "hex")));
  }
  return lines.join(" ");
}

async function posterUrl(
  request: import("@playwright/test").APIRequestContext,
  compId: string,
): Promise<string> {
  const compData = await apiJson<{ org_id: string; slug: string }>(
    request,
    `/api/v1/competitions/${compId}`,
  );
  const orgs = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const orgSlug = orgs.data!.find((o) => o.id === compData.data!.org_id)?.slug;
  expect(orgSlug, "the current session must be a member of the org that owns this competition").toBeTruthy();
  return `/shared/${orgSlug}/${compData.data!.slug}/poster.pdf`;
}

test.describe("public poster.pdf — the draw", () => {
  test("a competition with no fixtures still renders a plain one-page poster (regression)", async ({
    request,
  }) => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Poster Plain ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
      visibility: "public",
    });
    expect(comp.status, "create competition").toBeLessThan(300);

    const url = await posterUrl(request, comp.data!.id);
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const buf = Buffer.from(await res.body());
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(decodePdfPageCount(buf)).toBe(1);
  });

  test("a 4-entrant knockout's day-one final adds the draw, with its slot labels reaching the rendered page", async ({
    request,
  }) => {
    const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Poster Draw ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
      visibility: "public",
    });
    expect(comp.status, "create competition").toBeLessThan(300);
    const compId = comp.data!.id;

    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name: "Cup",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    expect(div.status, "create division").toBeLessThan(300);
    const divisionId = div.data!.id;

    await addEntrantsViaApi(request, divisionId, ["Seed1", "Seed2", "Seed3", "Seed4"]);
    const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
      kind: "knockout",
      name: "Cup",
    });
    expect(fixtureIds.length, "4-entrant knockout: 2 semis + 1 final").toBe(3);

    const url = await posterUrl(request, compId);
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    const buf = Buffer.from(await res.body());
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(decodePdfPageCount(buf), "the draw adds at least a second page").toBeGreaterThan(1);

    const text = decodePdfText(buf);
    // The final's slots are unresolved before either semi is played (same
    // shape calendar-ics.spec.ts proves) — the draw prints "Winner of R1·…"
    // labels, never a bare "TBD" or a blank line, for both semis' winners.
    expect(text).toMatch(/Winner of R1/);
    expect(text).toContain("Seed1");
  });
});

// Isolated login (own empty storageState — the credits-tab-shots/
// f5-export-locale-spec idiom) because this test mutates the org's own
// default_locale; doing that on the shared default session's org would leak
// French copy into every other test running against it in the same
// parallel shard.
test.describe("public poster.pdf — locale", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a French-locale org's day-one poster renders the localized copy, not English", async ({
    page,
  }) => {
    await loginUi(page, `delivered+poster-fr-${Date.now()}@resend.dev`, "/");
    const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
      name: `Poster FR ${Date.now()}`,
    });
    expect(created.status, "create org").toBeLessThan(300);
    const orgId = created.data!.id;
    await apiJson(page.request, "/api/orgs/active", "POST", { org_id: orgId });
    const locale = await apiJson(page.request, `/api/orgs/${orgId}`, "PATCH", { default_locale: "fr" });
    expect(locale.status, JSON.stringify(locale.error)).toBe(200);

    const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Poster FR Comp ${TAG}`,
      visibility: "public",
    });
    expect(comp.status, "create competition").toBeLessThan(300);
    const compId = comp.data!.id;

    const div = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name: "Coupe",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    expect(div.status, "create division").toBeLessThan(300);
    await addEntrantsViaApi(page.request, div.data!.id, ["Un", "Deux", "Trois", "Quatre"]);
    await createStageAndGenerate(page.request, div.data!.id, { kind: "knockout", name: "Coupe" });

    const orgs = await apiJson<OrgInfo[]>(page.request, "/api/orgs");
    const orgSlug = orgs.data!.find((o) => o.id === orgId)?.slug;
    const res = await page.request.get(`/shared/${orgSlug}/${comp.data!.slug}/poster.pdf`);
    expect(res.status()).toBe(200);
    const buf = Buffer.from(await res.body());
    const text = decodePdfText(buf);
    expect(text).toContain("Scannez pour suivre en direct");
    expect(text).not.toContain("Scan to follow live");

    // Review gap: the draw's own "vs" separator between the two fixture
    // sides also needs to resolve through the org's locale, not just the
    // page-1 copy above — the two semis ("Un"/"Deux", "Trois"/"Quatre")
    // this test already created are real, filled fixtures, so their rows
    // print the separator. `" vs "` (padded) rather than the bare
    // substring: TAG is a base-36 Date.now() token with no spaces of its
    // own, so a space-padded match can never collide with it by chance.
    expect(text).toContain("contre");
    expect(text).not.toContain(" vs ");
  });
});
