// Quick match plan 1, Task 9 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §4 step 4, C12; pre-flight
// A6, A13, B9, C8, C18): the pad's way back. A guest scoring a quick match's fixture on `/score/[token]` gets a link to
// that quick match's home, `/q/<home token>`, labeled `quickMatch.backToMatch`. Every other pad gets none.
//
// The real producers on both ends, no fixture on either (AGENTS.md class 1, the inert seam): the quick match is made by
// `createQuickMatch`, the pad's link is minted through the guest's own door (`ensureGuestDeviceLink`, Task 8), and the page under test is the REAL async server component, rendered to
// HTML. Assertions on that HTML anchor on `="` (AGENTS.md: React serializes an omitted prop as "$undefined").
//
// Expected values come from the producer or the spec, never from the page: the href is `/q/` + the token
// `createQuickMatch` handed its creator; the English copy is the spec's (C12, plan 1 Task 9 "Back to the quick match").
//
// Sport: one (badminton, the spec's own example). The link's condition reads the link's org and the `quick_matches` row,
// never the sport, so a sport sweep would repeat the same branch.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import { QuickMatchBackLink } from "@/components/v2/quick-match-back-link";
import { ScanWaiting } from "@/components/v2/scan-waiting";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { deviceLinkOrgId, ensureDeviceLink, ensureGuestDeviceLink, resolveDeviceLinkToken } from "@/server/usecases/device-links";
import { createQuickMatch, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { findQuickMatchByCompetition } from "@/server/usecases/quick-match-home";
import { readScanFixture } from "@/server/usecases/scan-fixture";
import { hashVisitorKey, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { fixturesOf, seedStage } from "@/server/usecases/__tests__/_sheets-rig";
import { log } from "@/server/logger";
import fr from "@/dictionaries/fr/ui.json";
import en from "@/dictionaries/en/ui.json";
import ScorePadPage from "../page";

/** A throwaway key of this file's own (pre-flight A15): every create seals a home token and every mint seals its
 *  secret, and CI's unit job has no DEVICE_LINK_KEK. Never printed; restored in afterAll. */
const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);

// The page resolves the viewer's locale from the request; there is none here. Hoisted so one case can switch it.
const locale = vi.hoisted(() => ({ value: "en" as "en" | "fr" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => locale.value }));
// The create's one analytics event reaches a mock, never PostHog.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The real lookup, recorded: an ordinary pad must not pay for it (the org guard), a quick match's pad pays once.
vi.mock("@/server/usecases/quick-match-home", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/quick-match-home")>();
  return { ...real, findQuickMatchByCompetition: vi.fn(real.findQuickMatchByCompetition) };
});
// The resolver and the dead link's org lookup: the real ones, switchable, for a refusal that carries no code (the
// database failing, not the link).
vi.mock("@/server/usecases/device-links", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/device-links")>();
  return {
    ...real,
    resolveDeviceLinkToken: vi.fn(real.resolveDeviceLinkToken),
    deviceLinkOrgId: vi.fn(real.deviceLinkOrgId),
  };
});
// The page's own "match gone" screen: a link that resolves to a fixture the read cannot find. The real read, switchable.
vi.mock("@/server/usecases/scan-fixture", async (orig) => {
  const real = await orig<typeof import("@/server/usecases/scan-fixture")>();
  return { ...real, readScanFixture: vi.fn(real.readScanFixture) };
});

const HAS_DB = !!process.env.DATABASE_URL;
/** The spec's English copy (C12; plan 1 Task 9). Typed, so the test does not read it back from the page. */
const EN_LABEL = "Back to the quick match";
const KEY = "quickMatch.backToMatch";

/** Read from the catalog in beforeAll, never typed (as Tasks 5 and 7 do). */
let BADMINTON_V: string;

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** Two badminton pairs, one league match. Each call is its own quick match, keyed on its own name (pre-flight A16). */
const twoSides = (): CreateQuickMatch => ({
  name: `QM pad ${randomUUID().slice(0, 8)}`,
  sport_key: "badminton",
  variant_key: BADMINTON_V,
  kind: "pair",
  format: "league",
  sides: ["Ravi & Sam", "Priya & Tom"],
  plays: 1,
  email: null,
  locale: "en",
});

/** A fresh quick match, its one fixture, and that fixture's pad link minted through the guest's door (Task 8). */
async function quickMatchPad(): Promise<{ out: CreatedQuickMatch; fixtureId: string; secret: string }> {
  const out = await createQuickMatch(twoSides(), { visitorHash: hashVisitorKey(mintVisitorKey()), mailAllowed: async () => true });
  const [fx] = await sql<{ id: string }[]>`
    select id from fixtures
    where division_id = ${out.divisionId} and home_entrant_id is not null and away_entrant_id is not null
    order by round_no, seq_in_round limit 1`;
  if (!fx) throw new Error(`precondition: quick match ${out.id} has a fixture with both sides`);
  const row = await findQuickMatchByCompetition(out.competitionId);
  if (!row) throw new Error(`precondition: quick match ${out.id} has its row`);
  const { secret } = await ensureGuestDeviceLink(row, fx.id);
  return { out, fixtureId: fx.id, secret };
}

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

/** The element whose direct children include an element of `type`: the wrapper a screen puts it in. */
function parentOf(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = parentOf(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const children = (node.props as { children?: ReactNode }).children;
  const direct = Array.isArray(children) ? children : [children];
  if (direct.some((c) => isValidElement(c) && c.type === type)) return node;
  return parentOf(children, type);
}
const classNameOf = (el: ReactElement | null) => ((el?.props as { className?: string } | undefined)?.className ?? "");

async function render(secret: string): Promise<{ tree: ReactElement; html: string }> {
  const tree = (await ScorePadPage({ params: Promise.resolve({ token: secret }) })) as ReactElement;
  return { tree, html: renderToStaticMarkup(tree) };
}

/** The anchor the page painted for the back link, by its test id: its open tag and its text. */
function backAnchor(html: string): { tag: string; text: string } | null {
  const m = /(<a [^>]*data-testid="quick-match-back-link"[^>]*>)([\s\S]*?)<\/a>/.exec(html);
  return m ? { tag: m[1]!, text: m[2]!.replace(/<[^>]+>/g, "") } : null;
}
const classesOf = (tag: string) => (/ class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
/** The class attribute of the element that DIRECTLY wraps the back link, read whole from its `class="` to its closing
 *  quote, so a token is matched exactly (never `/\bmd:…/`, which also matches inside `max-md:…`). */
const linkParentClasses = (html: string) =>
  (/<div class="([^"]*)"><a [^>]*data-testid="quick-match-back-link"/.exec(html)?.[1] ?? "").split(/\s+/).filter(Boolean);
/** The class attribute of the block directly inside `<main>`: the wrapper every scan screen puts its content in. */
const mainWrapperClass = (html: string) => /<main [^>]*><div class="([^"]*)">/.exec(html)?.[1];
const lookup = () => vi.mocked(findQuickMatchByCompetition);

/** Controller ruling 2026-11-08: the back link is an extra and never breaks scoring. A key that cannot open the home
 *  token hides the link, renders the pad and logs ONE server warning with its own reason code, carrying neither the
 *  token nor the envelope. The codes are the ruling's three cases, typed here, never read back from the page. */
const REASON = {
  kekMissing: "quick_match_back_link_kek_missing",
  malformed: "quick_match_back_link_malformed",
  rejected: "quick_match_back_link_rejected",
} as const;
// The repo's logger (pino, and through Sentry's pino integration, Sentry Logs): recorded, and kept off stdout.
const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
/** The page's back-link warnings among everything logged at warn since the last `warn.mockClear()`. */
const backLinkWarnings = () =>
  warn.mock.calls.filter(([fields]) => {
    const reason = (fields as { reason?: unknown } | undefined)?.reason;
    return typeof reason === "string" && reason.startsWith("quick_match_back_link_");
  });
const reasonOf = (call: unknown[]) => (call[0] as { reason: string }).reason;

describe.skipIf(!HAS_DB)("the pad's way back to the quick match (C12)", () => {
  it("a quick match's pad links to its home: /q/ + the creator's token, ph-no-capture, the spec's English copy", async () => {
    const { out, secret } = await quickMatchPad();
    lookup().mockClear();
    warn.mockClear();
    const { tree, html } = await render(secret);

    expect(backLinkWarnings(), "an opened home token is not a warning").toHaveLength(0);
    expect(find(tree, DeviceScorePad), "precondition: the pad itself renders").not.toBeNull();
    // Review Q1/Q2: the pad is told it is a quick match's, so its decided and locked lines name no organiser.
    expect((find(tree, DeviceScorePad)!.props as { quickMatch?: boolean }).quickMatch, "the copy seam: a guest's pad").toBe(true);
    expect(out.token.startsWith("qm_"), "precondition: the creator was handed a home token").toBe(true);
    const a = backAnchor(html);
    expect(a, "the back link is painted").not.toBeNull();
    expect(a!.tag).toContain(`href="/q/${out.token}"`);
    expect(classesOf(a!.tag), "the href holds the home token, a capability (B9)").toContain("ph-no-capture");
    // Placement, pinned as whole tokens of the class attribute: under the pad below md, a flex column to order it in.
    expect(classesOf(a!.tag), "under the pad on a phone").toContain("max-md:order-last");
    expect(a!.tag, "anchored: the token ends the class attribute").toMatch(/\smax-md:order-last"/);
    expect(linkParentClasses(html), "the link's parent is the flex column that orders it").toEqual(
      expect.arrayContaining(["flex", "flex-col"]),
    );
    expect(a!.text).toContain(EN_LABEL);
    // Exactly one painting of the token: nothing else on the pad carries it.
    expect(html.split(out.token).length - 1).toBe(1);
    expect(lookup(), "one lookup, by the fixture's own competition").toHaveBeenCalledTimes(1);
    expect(lookup()).toHaveBeenCalledWith(out.competitionId);
  });

  it("the link's accessible name is the label alone: the arrow is hidden from assistive tech", async () => {
    const { secret } = await quickMatchPad();
    const { html } = await render(secret);
    const inner = /<a [^>]*data-testid="quick-match-back-link"[^>]*>([\s\S]*?)<\/a>/.exec(html)![1]!;
    const spoken = inner.replace(/<span aria-hidden="true">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "").trim();
    expect(spoken).toBe(EN_LABEL);
  });

  it("an ordinary org's pad renders no back link, and pays no quick-match lookup (the negative pair)", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B"]);
    const [fixture] = await fixturesOf(stage.id);
    const { secret } = await ensureDeviceLink(auth, fixture!.id);
    expect(auth.orgId).not.toBe(QUICK_MATCH_SYSTEM_ORG_ID);
    lookup().mockClear();
    warn.mockClear();
    const { tree, html } = await render(secret);
    expect(backLinkWarnings(), "an ordinary pad has nothing to warn about").toHaveLength(0);

    expect(find(tree, DeviceScorePad), "precondition: the pad renders").not.toBeNull();
    expect((find(tree, DeviceScorePad)!.props as { quickMatch?: boolean }).quickMatch, "an ordinary pad keeps the organiser's copy").toBe(false);
    expect(find(tree, QuickMatchBackLink)).toBeNull();
    expect(html).not.toContain('href="/q/');
    expect(html).not.toContain(EN_LABEL);
    expect(lookup(), "the org guard: an ordinary pad never asks").not.toHaveBeenCalled();
    expect(mainWrapperClass(html), "an ordinary pad keeps the plain block it always had").toBe("mx-auto max-w-2xl");
  });

  it("two quick matches in the one system org: each pad links to its OWN home, never the other's", async () => {
    const a = await quickMatchPad();
    const b = await quickMatchPad();
    const pa = backAnchor((await render(a.secret)).html);
    const pb = backAnchor((await render(b.secret)).html);
    expect(pa!.tag).toContain(`href="/q/${a.out.token}"`);
    expect(pb!.tag).toContain(`href="/q/${b.out.token}"`);
    expect(pa!.tag).not.toContain(b.out.token);
    expect(pb!.tag).not.toContain(a.out.token);
  });

  it("a second render links to the same home: reading the envelope never spends or re-mints the token", async () => {
    const { out, secret } = await quickMatchPad();
    const first = backAnchor((await render(secret)).html);
    const second = backAnchor((await render(secret)).html);
    expect(first!.tag).toContain(`href="/q/${out.token}"`);
    expect(second!.tag).toBe(first!.tag);
  });

  it("an expired quick match still shows the link (the home answers honestly; a score revives the row, D5)", async () => {
    const { out, secret } = await quickMatchPad();
    await sql`update quick_matches set expires_at = now() - interval '1 day' where id = ${out.id}`;
    expect(backAnchor((await render(secret)).html)!.tag).toContain(`href="/q/${out.token}"`);
  });

  it("a system-org competition with no quick_matches row (an orphan, D1): the pad, no link, no throw", async () => {
    const { out, secret } = await quickMatchPad();
    await sql`delete from quick_matches where id = ${out.id}`;
    try {
      lookup().mockClear();
      const { tree, html } = await render(secret);
      expect(find(tree, DeviceScorePad), "the pad still renders").not.toBeNull();
      // The system org is what makes a pad a guest's: an orphan has no organiser either.
      expect((find(tree, DeviceScorePad)!.props as { quickMatch?: boolean }).quickMatch).toBe(true);
      expect(lookup(), "precondition: the system org's pad did ask").toHaveBeenCalledTimes(1);
      expect(html).not.toContain('href="/q/');
      expect(html).not.toContain(out.token);
    } finally {
      await hardDeleteQuickMatchCompetition(out.competitionId);
    }
  });

  it("DEVICE_LINK_KEK missing: the pad still renders, with no back link, no throw and one warning (A6, C8)", async () => {
    const { out, secret } = await quickMatchPad();
    vi.stubEnv("DEVICE_LINK_KEK", "");
    try {
      lookup().mockClear();
      warn.mockClear();
      const { tree, html } = await render(secret);
      expect(find(tree, DeviceScorePad), "a missing KEK never takes the pad down").not.toBeNull();
      expect(lookup(), "precondition: the row was found, so the open was attempted").toHaveBeenCalledTimes(1);
      expect(find(tree, QuickMatchBackLink)).toBeNull();
      expect(html).not.toContain('href="/q/');
      expect(html).not.toContain(out.token);
      const warned = backLinkWarnings();
      expect(warned.map(reasonOf)).toEqual([REASON.kekMissing]);
      expect(JSON.stringify(warned)).not.toContain(out.token);
    } finally {
      vi.stubEnv("DEVICE_LINK_KEK", KEK);
    }
  });

  it("a damaged envelope: the pad still renders, with no back link, no throw and one warning of its own reason", async () => {
    const { out, secret } = await quickMatchPad();
    await sql`update quick_matches set token_enc = ${Buffer.from([1, 2, 3])} where id = ${out.id}`;
    try {
      warn.mockClear();
      const { tree, html } = await render(secret);
      expect(find(tree, DeviceScorePad), "a damaged row never takes the pad down").not.toBeNull();
      expect(find(tree, QuickMatchBackLink)).toBeNull();
      expect(html).not.toContain('href="/q/');
      const warned = backLinkWarnings();
      expect(warned.map(reasonOf)).toEqual([REASON.malformed]);
      expect(JSON.stringify(warned)).not.toContain(out.token);
    } finally {
      await hardDeleteQuickMatchCompetition(out.competitionId);
    }
  });

  it("a key rotated without re-sealing (the wrong KEK): the pad still renders, no back link, one warning of its own reason", async () => {
    const { out, secret } = await quickMatchPad();
    const [row] = await sql<{ token_enc: Uint8Array }[]>`select token_enc from quick_matches where id = ${out.id}`;
    const envelope = Buffer.from(row!.token_enc);
    let other = kekBytes(32).toString("hex");
    while (other === KEK) other = kekBytes(32).toString("hex");
    vi.stubEnv("DEVICE_LINK_KEK", other);
    try {
      lookup().mockClear();
      warn.mockClear();
      const { tree, html } = await render(secret);
      expect(find(tree, DeviceScorePad), "a wrong key never takes the pad down").not.toBeNull();
      expect(lookup(), "precondition: the row was found, so the open was attempted").toHaveBeenCalledTimes(1);
      expect(find(tree, QuickMatchBackLink)).toBeNull();
      expect(html).not.toContain('href="/q/');
      expect(html).not.toContain(out.token);
      const warned = backLinkWarnings();
      expect(warned.map(reasonOf)).toEqual([REASON.rejected]);
      const logged = JSON.stringify(warned);
      expect(logged).not.toContain(out.token);
      expect(logged, "the envelope is never logged, in either encoding").not.toContain(envelope.toString("hex"));
      expect(logged).not.toContain(envelope.toString("base64"));
    } finally {
      vi.stubEnv("DEVICE_LINK_KEK", KEK);
    }
  });

  // Review Q3 (controller ruling 2026-11-08): a later round's pad can drop back to the waiting screen when a feeder's
  // result is voided, and the guest there still needs the way home. The waiting screen's client component reads the
  // app router, so these cases read the page's element tree (as page.test.tsx does for it) and render only the link.
  it("the waiting screen keeps the way back: a seat emptied after the link was made, as a voided feeder leaves it", async () => {
    const { out, fixtureId, secret } = await quickMatchPad();
    // The guest door refuses an unknown side (C18), so the link exists first, exactly as it would before the void.
    await sql`update fixtures set away_entrant_id = null where id = ${fixtureId}`;
    lookup().mockClear();
    warn.mockClear();
    const tree = (await ScorePadPage({ params: Promise.resolve({ token: secret }) })) as ReactElement;
    expect(find(tree, ScanWaiting), "precondition: the waiting screen").not.toBeNull();
    expect(find(tree, DeviceScorePad), "precondition: no pad while a side is unknown").toBeNull();
    const link = find(tree, QuickMatchBackLink);
    expect(link, "the way back is on the waiting screen too").not.toBeNull();
    const a = backAnchor(renderToStaticMarkup(link!));
    expect(a!.tag).toContain(`href="/q/${out.token}"`);
    expect(classesOf(a!.tag)).toEqual(expect.arrayContaining(["ph-no-capture", "max-md:order-last"]));
    expect(a!.text).toContain(EN_LABEL);
    const wrapper = parentOf(tree, QuickMatchBackLink);
    expect(wrapper, "the link and the waiting screen share one wrapper").toBe(parentOf(tree, ScanWaiting));
    expect(classNameOf(wrapper).split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-col"]));
    expect(lookup()).toHaveBeenCalledTimes(1);
    expect(backLinkWarnings()).toHaveLength(0);
  });

  it("a broken key on a waiting screen that polls: ONE warning for the competition, not one per refresh", async () => {
    // The waiting screen re-renders this page every POLL_MS (router.refresh). Ruling 2026-11-08: a broken key logs at
    // most once, not once per poll. Three renders stand in for three polls.
    const { out, fixtureId, secret } = await quickMatchPad();
    await sql`update fixtures set away_entrant_id = null where id = ${fixtureId}`;
    vi.stubEnv("DEVICE_LINK_KEK", "");
    try {
      warn.mockClear();
      let renders = 0;
      for (let i = 0; i < 3; i++) {
        const tree = (await ScorePadPage({ params: Promise.resolve({ token: secret }) })) as ReactElement;
        expect(find(tree, ScanWaiting), "precondition: the waiting screen").not.toBeNull();
        expect(find(tree, QuickMatchBackLink), "no link under a missing key, every time").toBeNull();
        renders++;
      }
      expect(renders).toBe(3);
      expect(backLinkWarnings().map(reasonOf)).toEqual([REASON.kekMissing]);
      expect(JSON.stringify(backLinkWarnings())).not.toContain(out.token);
    } finally {
      vi.stubEnv("DEVICE_LINK_KEK", KEK);
    }
  });

  it("an ordinary org's waiting screen: no link, no lookup, the plain block it always had (the negative pair)", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const final = (await fixturesOf(stage.id)).find((f) => f.round_no === 2);
    expect(final, "precondition: a knockout of four has a final").toBeTruthy();
    const { secret } = await ensureDeviceLink(auth, final!.id);
    lookup().mockClear();
    const tree = (await ScorePadPage({ params: Promise.resolve({ token: secret }) })) as ReactElement;
    expect(find(tree, ScanWaiting), "precondition: a final with no sides waits").not.toBeNull();
    expect(find(tree, QuickMatchBackLink)).toBeNull();
    expect(lookup(), "the org guard holds on the waiting screen too").not.toHaveBeenCalled();
    expect(classNameOf(parentOf(tree, ScanWaiting))).toBe("mx-auto max-w-2xl");
  });

  it("a French viewer gets the French label, from the French dictionary", async () => {
    const { out, secret } = await quickMatchPad();
    const frLabel = (fr as Record<string, string>)[KEY];
    expect(frLabel, "precondition: the key is translated").toBeTruthy();
    expect(frLabel).not.toBe((en as Record<string, string>)[KEY]);
    locale.value = "fr";
    try {
      const a = backAnchor((await render(secret)).html);
      expect(a!.tag).toContain(`href="/q/${out.token}"`);
      expect(a!.text).toContain(frLabel!);
      expect(a!.text).not.toContain(EN_LABEL);
    } finally {
      locale.value = "en";
    }
  });
});

// Controller ruling 2026-11-12: a quick match has no organiser, so on every dead screen the page draws (a link the
// resolver refuses as revoked or expired, a match the page cannot read) the hint tells the guest what they can do: go
// back to the quick match and tap Score, which mints them a fresh link. An ordinary org keeps the organiser's hint.
describe.skipIf(!HAS_DB)("the dead link's hint names no organiser on a quick match (controller ruling 2026-11-12)", () => {
  const QM_HINT = en["device.quickMatch.askFreshLink"];
  const ORGANISER_HINT = en["device.askFreshLink"];
  const ORGANISER = /organi[sz]er/i;
  const revoke = (fixtureId: string) =>
    sql`update device_links set revoked_at = now() where fixture_id = ${fixtureId} and revoked_at is null`;
  const expire = (fixtureId: string) =>
    sql`update device_links set expires_at = now() - interval '1 hour' where fixture_id = ${fixtureId} and revoked_at is null`;
  /** An ordinary org's league match and its pad link (the negative pair's side). */
  async function ordinaryPad(): Promise<{ fixtureId: string; secret: string }> {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B"]);
    const [fixture] = await fixturesOf(stage.id);
    expect(auth.orgId, "premise: not the system org").not.toBe(QUICK_MATCH_SYSTEM_ORG_ID);
    return { fixtureId: fixture!.id, secret: (await ensureDeviceLink(auth, fixture!.id)).secret };
  }

  it.each([
    { how: "revoked", kill: revoke, headline: "device.dead.revoked" },
    { how: "expired", kill: expire, headline: "device.dead.expired" },
  ] as const)("a quick match's $how link: sent back to the quick match, never to an organiser", async ({ kill, headline }) => {
    const { fixtureId, secret } = await quickMatchPad();
    expect(find((await render(secret)).tree, DeviceScorePad), "precondition: the link scores before it dies").not.toBeNull();
    await kill(fixtureId);
    const { html } = await render(secret);
    expect(html, "precondition: the dead screen, for this code").toContain(en[headline]);
    expect(html).toContain(QM_HINT);
    expect(html).not.toMatch(ORGANISER);
  });

  it("an ordinary org's revoked link keeps the organiser's hint (the negative pair)", async () => {
    const { fixtureId, secret } = await ordinaryPad();
    await revoke(fixtureId);
    const { html } = await render(secret);
    expect(html, "precondition: the dead screen").toContain(en["device.dead.revoked"]);
    expect(html).toContain(ORGANISER_HINT);
    expect(html).not.toContain(QM_HINT);
  });

  it("a token no link holds names no org: the not-valid screen keeps the ordinary hint", async () => {
    const { html } = await render(`dl_${randomUUID()}`);
    expect(html, "precondition: the not-valid screen").toContain(en["device.dead.invalid"]);
    expect(html).toContain(ORGANISER_HINT);
    expect(html).not.toContain(QM_HINT);
  });

  it("a resolver failure with no code (the database, not the link): the not-valid screen it always had, no second query", async () => {
    const { secret } = await quickMatchPad();
    const down = new Error("connection terminated");
    const realOrgId = vi.mocked(deviceLinkOrgId).getMockImplementation()!;
    vi.mocked(resolveDeviceLinkToken).mockRejectedValueOnce(down);
    vi.mocked(deviceLinkOrgId).mockClear();
    // Were it asked, it would fail as the database does, and the page would throw instead of drawing a screen.
    vi.mocked(deviceLinkOrgId).mockRejectedValueOnce(down);
    try {
      const { html } = await render(secret);
      expect(html, "the screen a failed resolve always drew").toContain(en["device.dead.invalid"]);
      expect(html).toContain(ORGANISER_HINT);
      expect(vi.mocked(deviceLinkOrgId), "no org lookup for a refusal the resolver did not code").not.toHaveBeenCalled();
    } finally {
      // An unspent rejection must not reach the next case.
      vi.mocked(deviceLinkOrgId).mockReset().mockImplementation(realOrgId);
    }
  });

  it.each([
    { who: "a quick match", pad: quickMatchPad, hint: QM_HINT, not: ORGANISER_HINT },
    { who: "an ordinary org", pad: ordinaryPad, hint: ORGANISER_HINT, not: QM_HINT },
  ])("a live link whose match the page cannot read ($who): the gone screen, with its own hint", async ({ pad, hint, not }) => {
    const { secret } = await pad();
    vi.mocked(readScanFixture).mockResolvedValueOnce(null);
    const { html } = await render(secret);
    expect(vi.mocked(readScanFixture), "precondition: the page asked the read").toHaveBeenCalled();
    expect(html, "precondition: the gone screen").toContain(en["device.dead.gone"]);
    expect(html).toContain(hint);
    expect(html).not.toContain(not);
  });
});
