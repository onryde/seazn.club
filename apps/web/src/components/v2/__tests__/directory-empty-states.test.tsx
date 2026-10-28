// The Directory's four empty states are text on a white card, so their colour has to clear WCAG AA (4.5:1). `text-slate-400` on white is
// ~2.6:1: the venues one was that, and axe (mobile.spec.ts "key surfaces", which scans /directory?tab=venues) reddened at every width. The
// Players and Clubs empty states carried the same class; Officials already used `text-slate-500`. Rendered through the REAL panels with
// nothing in them, so a panel that stops rendering its empty state fails here instead of passing on an absent string.
//
// The expected words come from the dictionary (never typed here); the colour is read off the element that carries them, by class TOKEN
// (a substring scan would call `text-slate-500` a `text-slate-50` and miss a `hover:`-prefixed twin). Sport: not applicable.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import { ClubsTeamsList } from "@/components/v2/clubs-teams-list";
import { OfficialsDirectoryPanel } from "@/components/v2/officials-directory-panel";
import { PersonsPanel } from "@/components/v2/persons-panel";
import { VenuesPanel } from "@/components/v2/venues-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/directory",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const html = (node: ReactElement): string =>
  renderToStaticMarkup(<DictProvider dict={en as never} locale="en">{node}</DictProvider>);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The class tokens of the element whose text is exactly `text` (null when there is not exactly one such element). */
function tokensOfElementSaying(markup: string, text: string): string[] | null {
  const found = [...markup.matchAll(new RegExp(`<[a-z0-9]+[^>]*\\sclass="([^"]*)"[^>]*>${escapeRe(text)}<`, "g"))];
  return found.length === 1 ? found[0]![1]!.split(/\s+/).filter(Boolean) : null;
}

const dict = en as Record<string, string>;
const EMPTY_STATES: [string, string, () => string][] = [
  ["Players", dict["persons.empty"]!, () => html(<PersonsPanel persons={[]} storageBase="" canEdit />)],
  ["Clubs and teams", dict["clubs.list.invite"]!, () => html(<ClubsTeamsList clubs={[]} teams={[]} storageBase="" canEdit viewerPlan="community" />)],
  ["Officials", dict["officials.empty"]!, () => html(<OfficialsDirectoryPanel officials={[]} canEdit rolesMultiAllowed viewerPlan="community" />)],
  ["Venues", dict["venues.empty"]!, () => html(<VenuesPanel venues={[]} orgId="00000000-0000-4000-8000-000000000000" canEdit />)],
];

describe("the Directory's empty states clear AA contrast on their white card", () => {
  it("every one of the four renders its sentence in text-slate-500 and none carries text-slate-400", () => {
    let checked = 0;
    for (const [name, sentence, render] of EMPTY_STATES) {
      expect(sentence, `${name}: the dictionary has the sentence`).toBeTruthy();
      const tokens = tokensOfElementSaying(render(), sentence);
      expect(tokens, `${name}: exactly one element says "${sentence.slice(0, 40)}..."`).not.toBeNull();
      expect(tokens, `${name}: text-slate-400 on white is ~2.6:1`).not.toContain("text-slate-400");
      expect(tokens, `${name}: the AA-passing muted token`).toContain("text-slate-500");
      checked++;
    }
    expect(checked, "anti-vacuity: four empty states").toBe(4);
  });
});

// CI e2e, second pass (B3): once the scan met a POPULATED venues list it reddened on the venue's Delete link (`text-red-500` on white,
// ~3.8:1). The panel's other sub-AA tokens went with it: `text-slate-400` text and the archived badge's `text-slate-500` on
// `bg-slate-200` (~3.7:1). Rendered through the REAL panel with a venue, an active court (with hours) and an archived court, so the
// Delete/Archive links, the courts list and a badge are all in the markup — anti-vacuity counts each before the token check.
describe("a populated venues list clears AA contrast", () => {
  it("no element carries a sub-AA text token, and the controls that carried them are present", () => {
    const venue = {
      id: "v1", name: "Riverside Sports Hall", address: null, sort: 0, archived_at: null, created_at: "2026-01-01T00:00:00Z",
      courts: [
        { id: "c1", venue_id: "v1", name: "Court 1", sort: 0, tags: [], archived_at: null, created_at: "2026-01-01T00:00:00Z",
          hours: [{ weekday: 1, open_min: 540, close_min: 1260 }], exceptions: [] },
        { id: "c2", venue_id: "v1", name: "Court 2", sort: 1, tags: [], archived_at: "2026-02-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
          hours: [], exceptions: [] },
      ],
    };
    const markup = html(<VenuesPanel venues={[venue]} orgId="00000000-0000-4000-8000-000000000000" canEdit />);
    const classLists = [...markup.matchAll(/\sclass="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/).filter(Boolean));
    expect(classLists.length, "anti-vacuity: the panel rendered elements").toBeGreaterThan(10);
    const deletes = classLists.filter((c) => c.includes("underline") && c.some((t) => t.startsWith("text-red-")));
    expect(deletes.length, "anti-vacuity: at least one Delete link rendered").toBeGreaterThan(0);
    let checked = 0;
    for (const tokens of classLists) {
      expect(tokens, "text-red-500 on white is ~3.8:1").not.toContain("text-red-500");
      expect(tokens, "text-slate-400 on white is ~2.6:1").not.toContain("text-slate-400");
      if (tokens.includes("bg-slate-200")) expect(tokens, "slate-500 on slate-200 is ~3.7:1").not.toContain("text-slate-500");
      checked++;
    }
    expect(checked).toBe(classLists.length);
  });
});
