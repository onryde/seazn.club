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
