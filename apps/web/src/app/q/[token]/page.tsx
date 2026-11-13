// Quick match plan 2, Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.5, C19): the
// guest's home at `/q/<token>`. The token is a scoring credential (O3): it is read from the route's `params` only, trimmed
// (Review Focus 3: a trailing slash or a `?utm` never reaches it; case is part of it), and resolved by plan 1's
// `resolveQuickMatchToken`, which answers null for an unknown, malformed, expired or deleted one. Every null is the same
// dead screen, so the page never says which.
//
// Never cached (`force-dynamic`, Review Focus 2): the home after a score must be the new table. Never indexed. No-store does
// not keep a phone's browser from restoring the page from its back-forward cache on Back, so the live home also mounts
// `QuickMatchRefreshOnRestore`, which reads it again on a restore (Task 10 review I-1).
// The viewer's locale (D10): `resolveLocale()` with no org default, exactly as the pad resolves it, never the row's.
//
// The read's `row` carries the creator's email and the sealed token (A14). It goes to `QuickMatchHomeView`, a SERVER
// component, and no further. The client components here take strings only: `HtmlLang` the locale, and Task 6's
// `QuickMatchScoreForm` its action (`/q/<token>/score/<fixtureId>`, the home's own path plus a fixture id) and its words.
//
// Task 6: the Score slot (each playable match's form post into the pad) and the flash: a refused action lands back here
// as `?e=<code>` (D3), printed as the viewer's `quickMatch.flash.*` line. The dead screen ignores `?e=`: a crafted one
// must not give a dead link a reason (D16).
//
// Task 7: the Share slot (the link, Copy and the share sheet on first paint; the QR behind "Show QR"). `QuickMatchShare` takes the home's PATH (`routes.quickMatch(token)`), never an absolute URL built
// here: the island puts it on the page's own origin, so no forwarded host is trusted (B7). Its two shared children
// (`ShareButton`, `SeaznQrImage`) read their own words through `useMsg`, so the island sits in a `DictProvider` holding
// just those keys (`share.*`, `qr.*`) in the viewer's language: never the whole ui dictionary in the flight payload.
//
// Task 8: the Add-a-match slot (a league's decider, C5): `QuickMatchAddMatch` takes its action
// (`routes.quickMatchAddMatch(token)`), the sides as ids and names, the two the view picked, and its words; nothing of the read.
// A refused add lands here with its flash AND the guest's two picks (`?e=<code>&home=<id>&away=<id>`, review m4): the
// disclosure then opens on first paint at those picks, each kept only if it is one of this match's sides (else the view's
// own pick), so the fix is one tap away with no script. Picks without a flash are ignored (a reload, a crafted link), and
// the picks are spent with `e` (`ClearFlashParam`).
//
// Plan 3 Task 5: the Save slot (`QuickMatchSaveForm`, a plain post to `routes.quickMatchSaveConfirm(token)`), drawn by the
// view only while nobody has saved the match; its saver reads "Saved". The session is read ONLY for a saved match (the one
// case where who is looking changes the page), so an unsaved home stays a page anyone's request renders the same.
//
// Plan 4 Task 4: the row menu slot (`QuickMatchRowMenu`, one ⋯ per row, owner 2026-11-13). The list says what a row offers;
// this page turns each item into its post (`routes.quickMatchScore` for Score and Edit result, `routes.quickMatchSkip`,
// `routes.quickMatchPutBack`, each the home's own path plus a fixture id) and its words, and hands the island strings only.
//
// Plan 5 Task 7 (League + Knockout): the cut slot (`QuickMatchCutPrompt`, asked only while a tie at the cut is open: the
// Pick panel posting `routes.quickMatchCutPick(token)` and, when a lot ordered the tie, the Toss form posting
// `routes.quickMatchCutToss(token)`, with Back to the home's own path) and "Setting up the knockout"'s Refresh (the home's
// own path). No advance runs here: the read itself retries the knockout's fill on every load (`readQuickMatchHome` step 0),
// so a second phone whose answer was ALREADY_DECIDED lands on a home that shows the knockout filled.
import type { Metadata } from "next";
import { DictProvider } from "@/components/i18n/dict-provider";
import { HtmlLang } from "@/components/i18n/html-lang";
import {
  homeFlash,
  QuickMatchDead,
  QuickMatchHomeView,
  QuickMatchRefreshLink,
  type QuickMatchCopy,
  type QuickMatchSlots,
} from "@/components/quick-match/home";
import { QuickMatchAddMatch } from "@/components/quick-match/add-match";
import { QuickMatchCutPrompt } from "@/components/quick-match/cut-prompt";
import { QuickMatchRowMenu } from "@/components/quick-match/row-menu";
import { ClearFlashParam } from "@/components/quick-match/clear-flash-param";
import { matchSidesId, type RowMenuItem } from "@/components/quick-match/match-list";
import { QuickMatchRefreshOnRestore } from "@/components/quick-match/refresh-on-restore";
import { QuickMatchSaveForm } from "@/components/quick-match/save-form";
import { QuickMatchScoreForm } from "@/components/quick-match/score-form";
import { QuickMatchShare } from "@/components/quick-match/share";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n";
import { plural, t } from "@/lib/i18n-runtime";
import { pickDictPrefixes } from "@/lib/i18n-subset";
import { resolveLocale } from "@/lib/resolve-locale";
import { routes } from "@/lib/routes";
import { levelWords } from "@/lib/score/levels";
import { ADD_PICK_PARAMS } from "@/server/usecases/quick-match-add";
import { readQuickMatchHome, resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { quickMatchFullTable } from "./full-table";

export const dynamic = "force-dynamic";

/** The words the Share island's shared children read for themselves: ShareButton's (`share.*`), the QR's (`qr.*`). */
const SHARE_DICT_PREFIXES = ["share.", "qr."] as const;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return { title: t(ui, "quickMatch.home.title"), robots: { index: false, follow: false } };
}

export default async function QuickMatchHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ e?: string | string[]; home?: string | string[]; away?: string | string[] }>;
}) {
  const token = (await params).token.trim();
  const locale = await resolveLocale();
  const [ui, pub, search] = await Promise.all([getDictionary(locale, "ui"), getDictionary(locale, "public"), searchParams]);
  const copy: QuickMatchCopy = {
    locale,
    t: (key, vars) => t(ui, key, vars),
    plural: (key, count, vars) => plural(ui, key, count, locale, vars),
    levels: levelWords(pub),
    pub: (key, vars) => t(pub, key, vars),
  };

  const row = await resolveQuickMatchToken(token);
  const home = row ? await readQuickMatchHome(row) : null;
  if (!home) {
    return (
      <>
        <HtmlLang lang={locale} />
        <QuickMatchDead locale={locale} t={copy.t} />
      </>
    );
  }

  const flash = homeFlash(search?.e);
  // A refused add's picks (review m4): only beside a flash, and only when the add's route put at least one there.
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const handedBack = flash ? { home: first(search?.home), away: first(search?.away) } : null;
  const reopen = handedBack !== null && (handedBack.home !== undefined || handedBack.away !== undefined);
  const menuWords = {
    score: copy.t("quickMatch.home.scoreShort"),
    editResult: copy.t("quickMatch.home.editResult"),
    notPlayed: copy.t("quickMatch.home.notPlayed"),
    notPlayedHint: copy.t("quickMatch.home.notPlayedHint"),
    putBack: copy.t("quickMatch.home.putBack"),
  };
  const slots: QuickMatchSlots = {
    // Offered by the view on a live or ready match (C11, C18), the hero's and each such row's.
    score: (fixture, place) => (
      <QuickMatchScoreForm
        action={routes.quickMatchScore(token, fixture.id)}
        place={place}
        label={copy.t(
          place === "row" ? "quickMatch.home.scoreShort" : fixture.live ? "quickMatch.home.continue" : "quickMatch.home.score",
        )}
        describedBy={place === "hero" ? undefined : matchSidesId(fixture.id)}
      />
    ),
    // One ⋯ menu per row (plan 4 Task 4): Score and Not played on a match still to play, Edit result on a settled one the pad
    // will still reopen (A-M6: the same Score route), Put back on a Not played one until the league finishes.
    rowMenu: (row) => {
      const offers = (kind: RowMenuItem["kind"]) => row.items.some((i) => i.kind === kind);
      const skip = row.items.find((i): i is Extract<RowMenuItem, { kind: "skip" }> => i.kind === "skip");
      return (
        <QuickMatchRowMenu
          label={copy.t("quickMatch.home.moreActions", { home: row.home, away: row.away })}
          scoreAction={offers("score") ? routes.quickMatchScore(token, row.fixtureId) : undefined}
          editAction={offers("edit") ? routes.quickMatchScore(token, row.fixtureId) : undefined}
          skipAction={skip ? routes.quickMatchSkip(token, row.fixtureId) : undefined}
          putBackAction={offers("putBack") ? routes.quickMatchPutBack(token, row.fixtureId) : undefined}
          words={menuWords}
          sheet={
            skip
              ? { ...skip.copy, confirm: copy.t("quickMatch.skip.confirm"), keep: copy.t("quickMatch.skip.keep") }
              : undefined
          }
        />
      );
    },
    share: (
      <DictProvider dict={pickDictPrefixes(ui, SHARE_DICT_PREFIXES)} locale={locale}>
        <QuickMatchShare
          path={routes.quickMatch(token)}
          title={home.row.name}
          labels={{
            share: copy.t("quickMatch.home.share"),
            copy: copy.t("quickMatch.home.copy"),
            copied: copy.t("quickMatch.home.copied"),
            qrAlt: copy.t("quickMatch.home.qrAlt"),
            // The device link panel's "Show QR", in all four locales: the same words for the same control.
            showQr: copy.t("dlink.showQr"),
            shareNative: copy.t("quickMatch.home.shareNative", { name: home.row.name }),
          }}
        />
      </DictProvider>
    ),
    save: (
      <QuickMatchSaveForm action={routes.quickMatchSaveConfirm(token)} label={copy.t("quickMatch.home.save")} look="ghost" />
    ),
    // League only (the view asks for it only there, C5): the two selects open at the view's pick, the table's top two.
    addMatch: (view) => {
      const ours = new Set(view.sides.map((s) => s.id));
      const kept = (id: string | undefined, fallback: string) => (reopen && id !== undefined && ours.has(id) ? id : fallback);
      return (
        <QuickMatchAddMatch
          action={routes.quickMatchAddMatch(token)}
          sides={view.sides}
          home={kept(handedBack?.home, view.home)}
          away={kept(handedBack?.away, view.away)}
          open={reopen}
          labels={{
            open: copy.t("quickMatch.home.addMatch"),
            home: copy.t("quickMatch.addMatch.home"),
            away: copy.t("quickMatch.addMatch.away"),
            submit: copy.t("quickMatch.addMatch.submit"),
          }}
        />
      );
    },
    // A League + Knockout's tie at the cut (asked by the view only while it is open): the guests' two answers.
    cut: (view) => (
      <QuickMatchCutPrompt
        pickAction={routes.quickMatchCutPick(token)}
        tossAction={view.toss ? routes.quickMatchCutToss(token) : null}
        backHref={routes.quickMatch(token)}
        members={view.members}
        seats={view.seats}
        locale={locale}
        words={{
          pick: copy.t("quickMatch.cut.pick"),
          toss: copy.t("quickMatch.cut.toss"),
          back: copy.t("quickMatch.cut.back"),
          question: copy.plural("quickMatch.cut.pickQuestion", view.seats),
          // As written ("Send {names} through"): the island names the sides chosen.
          send: copy.t("quickMatch.cut.send"),
        }}
      />
    ),
    refresh: <QuickMatchRefreshLink href={routes.quickMatch(token)} label={copy.t("quickMatch.home.refresh")} />,
  };
  const viewerId = home.row.savedByUserId === null ? null : ((await getCurrentUser())?.id ?? null);
  return (
    <>
      <HtmlLang lang={locale} />
      {/* The flash is printed: `?e=` is spent, so a reload or a shared link does not print it again (T6 review m2). */}
      <ClearFlashParam alsoSpent={ADD_PICK_PARAMS} />
      {/* Back from the pad on a phone restores this page from the back-forward cache: read it again (T10 review I-1). */}
      <QuickMatchRefreshOnRestore />
      <QuickMatchHomeView
        home={home}
        copy={copy}
        slots={slots}
        flash={flash ? { text: copy.t(flash.key, flash.vars), tone: flash.tone } : null}
        viewerId={viewerId}
        fullTable={quickMatchFullTable(home, copy.pub)}
      />
    </>
  );
}
