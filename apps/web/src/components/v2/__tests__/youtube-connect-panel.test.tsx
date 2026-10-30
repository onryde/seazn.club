// YouTube Connect's UI on the Streaming page (T9; spec 2026-10-27 §6.1; owner D3 D7 D13 D14).
//
// `apps/web` vitest is `environment: "node"` — no DOM. So, as in stream-destinations-panel.test.tsx, three layers, each proven where it
// can be (AGENTS.md classes 1 and 2):
//   * markup (`renderToStaticMarkup`) — which controls exist, which field names a form posts, which sentence each state reads as;
//   * the islands DRIVEN (`renderIsland`, the repo's hook harness) — the consent box, the picker, a connection row's editors — with the
//     v1 transport and the router doubled, so the path each action calls, the body it sends and what a refusal leaves on screen are
//     pinned. Every body is run through the route's REAL zod schema (`PickYoutubeChannel`, `YoutubeConnectionSettings`) and every
//     path through the REAL OpenAPI route table, so the producer is checked against the consumer, not against itself;
//   * the error map off the REAL wire: each refusal is the server's own error through the real v1 envelope and the real client transport.
// What none of this can see — layout, real tap area, the round trip to the fake Google — is the shots spec
// (`e2e/youtube-streaming.shots.spec.ts`) and the DB-backed seam test beside this file (`youtube-connect-seam.test.tsx`).
//
// Expected values are literals typed from the spec / brief / T8's contract (field names, paths, bodies, the ten landing codes) or read
// from the dictionaries by key — never read back from the code under test. Every sweep reports how many it checked, and zero fails.
//
// Sport: not applicable — connecting a YouTube channel is sport-agnostic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ApiV1Error } from "@/lib/client-v1";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import { messages, type MessageKey } from "@/lib/messages";
import { GOOGLE_THIRD_PARTY_ACCESS_URL, YOUTUBE_CONSENT_VERSION, YOUTUBE_DEAD_GRANT_PURGE_DAYS, YOUTUBE_DISCONNECTED_LABEL, YOUTUBE_LANDING_CODES, YOUTUBE_PRIVACIES } from "@/lib/youtube";
import { ROUTES } from "@/server/api-v1/openapi";
import { v1 } from "@/server/api-v1/http";
import { PickYoutubeChannel, StreamTargetKind, YOUTUBE_REVOKE_OUTCOMES, YoutubeConnectionSaved, YoutubeConnectionSettings, type StreamTarget } from "@/server/api-v1/schemas";
import {
  ConsentBox, KidsChoice, PrivacyChoice, YoutubeChannelPicker, YoutubeChannelRow, YoutubeConnectCard, YoutubeDisconnectedNotice, YoutubeLandingNotice,
  channelStatus, youtubeErrorText, youtubeTargetLabel,
} from "../youtube-connect-panel";
import { YoutubeDisconnectOnlyPanel } from "../youtube-disconnect-only-panel";
import { REFUSAL_FOCUS_RING } from "../refusal-focus";
import { AddForm, DestinationRow, StreamDestinationsPanel } from "../stream-destinations-panel";

// ─── doubles ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const transport = vi.hoisted(() => ({ impl: null as null | ((url: string, opts?: { method?: string; json?: unknown }) => Promise<unknown>) }));
const apiCalls: { url: string; method: string; json: unknown }[] = [];
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, opts?: { method?: string; json?: unknown }) =>
      transport.impl ? transport.impl(url, opts) : actual.apiV1(url, opts as RequestInit & { json?: unknown }),
  };
});
const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/streaming",
  useSearchParams: () => new URLSearchParams(""),
}));
// The confirm dialog, answerable: `answer` is what the person clicked, `asked` is every dialog the page opened.
const confirmState = vi.hoisted(() => ({ answer: true, asked: [] as Record<string, unknown>[], hold: null as null | Promise<void> }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async (opts: Record<string, unknown>) => {
    confirmState.asked.push(opts);
    if (confirmState.hold) await confirmState.hold;
    return confirmState.answer;
  },
}));

/** Records every call and answers `answer(url, method)`; the default is an empty object. */
function answerWith(answer: (url: string, method: string) => unknown | Promise<unknown> = () => ({})) {
  transport.impl = async (url, opts) => {
    const method = opts?.method ?? "GET";
    apiCalls.push({ url, method, json: opts?.json });
    return answer(url, method);
  };
}
beforeEach(() => {
  apiCalls.length = 0;
  confirmState.answer = true;
  confirmState.asked.length = 0;
  confirmState.hold = null;
  nav.refresh.mockReset();
  nav.replace.mockReset();
  answerWith();
});
afterEach(() => vi.restoreAllMocks());

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A sentence as the English catalog renders it, `{var}` filled — the copy a customer reads. */
const m = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), messages[k] as string);
/** React's HTML escaping, so a sentence can be looked for inside markup. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const attr = (el: ReactElement, name: string): unknown => propsOf(el)[name];
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined => tree.find((el) => attr(el, "data-testid") === id);
const allByTestId = (tree: ReactElement[], id: string): ReactElement[] => tree.filter((el) => attr(el, "data-testid") === id);
const textAt = (tree: ReactElement[], id: string): string => {
  const el = byTestId(tree, id);
  if (!el) throw new Error(`no ${id} in the tree`);
  return textOf(el).replace(/\s+/g, " ").trim();
};
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const click = async (el: ReactElement | undefined): Promise<void> => {
  const onClick = el && (propsOf(el).onClick as ((e?: unknown) => unknown) | undefined);
  if (!onClick) throw new Error("no onClick on that element — the test is asserting nothing");
  await onClick({ preventDefault: () => {}, stopPropagation: () => {} });
  await settle();
};
/** Fire a form's submit handler, returning whether it called preventDefault (a browser would otherwise navigate). */
const submit = async (form: ReactElement | undefined): Promise<{ prevented: boolean }> => {
  const onSubmit = form && (propsOf(form).onSubmit as ((e: { preventDefault: () => void }) => unknown) | undefined);
  if (!onSubmit) throw new Error("no onSubmit on that element — the test is asserting nothing");
  let prevented = false;
  await onSubmit({ preventDefault: () => { prevented = true; } });
  await settle();
  return { prevented };
};
const ofType = (tree: ReactElement[], type: unknown): ReactElement | undefined => tree.find((el) => el.type === type);

type Input = { name?: string; value?: string; type?: string; checked: boolean; disabled: boolean; testid?: string };
/** Every <input> in some markup, as a browser would read it. React serialises a true boolean attribute as `x=""`. */
function inputsOf(html: string): Input[] {
  return [...html.matchAll(/<input\b([^>]*)>/g)].map(([, a = ""]) => ({
    name: /\bname="([^"]*)"/.exec(a)?.[1],
    value: /\bvalue="([^"]*)"/.exec(a)?.[1],
    type: /\btype="([^"]*)"/.exec(a)?.[1],
    testid: /\bdata-testid="([^"]*)"/.exec(a)?.[1],
    checked: /\bchecked(=""|\s|$)/.test(a),
    disabled: /\bdisabled(=""|\s|$)/.test(a),
  }));
}
const localeDict = (l: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
const inLocale = (l: string, node: ReactNode): string =>
  renderToStaticMarkup(<DictProvider dict={localeDict(l) as unknown as Dict} locale={l as never}>{node}</DictProvider>);
/** Markup as the text a person reads: tags gone, React's HTML escaping undone, whitespace collapsed. */
const plain = (html: string) =>
  html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** A refusal exactly as the page receives it: the server's own error through the real v1 envelope and the real client transport. */
async function wire(err: unknown): Promise<ApiV1Error> {
  const res = await v1(async () => { throw err; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
  const saved = transport.impl;
  transport.impl = null; // the REAL apiV1 for this one call
  try {
    const { apiV1 } = await import("@/lib/client-v1");
    await apiV1("/api/v1/orgs/o/youtube-connections", { method: "POST", json: {} });
  } catch (caught) {
    expect(caught).toBeInstanceOf(ApiV1Error);
    return caught as ApiV1Error;
  } finally {
    transport.impl = saved;
    fetchSpy.mockRestore();
  }
  throw new Error("apiV1 resolved on an error response");
}

/** Is `method url` a route the API really serves? `{id}`-style segments in the route table match any one path segment. */
function isRealRoute(method: string, url: string): boolean {
  const path = url.replace(/^\/api\/v1/, "").split("?")[0]!;
  return ROUTES.some((r) => r.method === method.toLowerCase() && new RegExp(`^${r.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path));
}

// ─── builders ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type View = NonNullable<StreamTarget["youtube"]>;
const CHANNEL_ID = "UC7xK2mQ9rVbN4tLpA1sZ0wE";
const view = (over: Partial<View> = {}): View => ({
  connectionId: "c-1", channelId: CHANNEL_ID, channelTitle: "Riverside FC", privacy: "unlisted", madeForKids: false, status: "connected", liveState: "enabled",
  termsOutdated: false, openBroadcasts: 0, ...over,
});
const channel = (y: Partial<View> = {}, over: Partial<StreamTarget> = {}): StreamTarget => ({
  id: "t-yt", kind: "youtube", label: "Riverside FC", watchUrl: null, createdAt: "2026-10-20T10:00:00.000Z", keyHint: null, inUse: null, youtube: view(y), ...over,
});
const pasted = (over: Partial<StreamTarget> = {}): StreamTarget => ({
  id: "t-key", kind: "youtube", label: "Club YouTube", watchUrl: null, createdAt: "2026-09-12T10:00:00.000Z", keyHint: "8hd", inUse: null, youtube: null, ...over,
});
const PENDING = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const rowHtml = (t: StreamTarget, canEdit = true): string =>
  renderToStaticMarkup(
    <DictProvider dict={messages as unknown as Dict} locale="en">
      <ul><YoutubeChannelRow t={t} canEdit={canEdit} orgId="o" badge={null} /></ul>
    </DictProvider>,
  );
const panelHtml = (p: Partial<Parameters<typeof StreamDestinationsPanel>[0]> & { targets: StreamTarget[] }): string =>
  renderToStaticMarkup(
    <DictProvider dict={messages as unknown as Dict} locale="en">
      <StreamDestinationsPanel orgId="o" canEdit locale="en" {...p} />
    </DictProvider>,
  );

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the consent step", () => {
  const mount = () => renderIsland(YoutubeConnectCard, { orgId: "org-1", onCancel: vi.fn() });
  const tick = (island: ReturnType<typeof mount>, on: boolean) => {
    const box = ofType(island.tree(), ConsentBox);
    if (!box) throw new Error("the card rendered no ConsentBox");
    (propsOf(box).onChange as (v: boolean) => void)(on);
  };

  it("Continue to Google is DISABLED until the box is ticked, enabled once it is, disabled again when it is unticked — and the hint goes and comes with it", () => {
    const card = mount();
    const state = () => ({
      disabled: attr(byTestId(card.tree(), "youtube-connect-submit")!, "disabled"),
      hint: byTestId(card.tree(), "youtube-consent-required"),
      checked: attr(ofType(card.tree(), ConsentBox)!, "checked"),
    });
    expect(state().disabled, "unticked: disabled").toBe(true);
    expect(state().checked).toBe(false);
    expect(textAt(card.tree(), "youtube-consent-required")).toBe(m("streaming.youtube.consent.required"));
    expect(textAt(card.tree(), "youtube-connect-submit")).toBe(m("streaming.youtube.consent.continue"));

    tick(card, true);
    expect(state().disabled, "ticked: enabled").toBe(false);
    expect(state().checked).toBe(true);
    expect(state().hint, "the hint is gone once ticked").toBeUndefined();

    tick(card, false);
    expect(state().disabled, "unticked again: disabled again").toBe(true);
    expect(state().hint, "the hint is back").toBeDefined();
  });

  it("Enter inside a field cannot submit past an unticked box: the form refuses it (preventDefault), and lets a ticked one through", async () => {
    const card = mount();
    expect((await submit(byTestId(card.tree(), "youtube-connect-form"))).prevented, "unticked: stopped on the page").toBe(true);
    tick(card, true);
    expect((await submit(byTestId(card.tree(), "youtube-connect-form"))).prevented, "ticked: the browser posts it").toBe(false);
  });

  it("the markup: a real <form method=post> to the connect route, unticked and with Continue disabled in the HTML itself, carrying the org", () => {
    const html = inLocale("en", <YoutubeConnectCard orgId="org-1" onCancel={() => {}} />);
    expect(html).toMatch(/<form[^>]*\bmethod="post"/);
    expect(html).toMatch(/<form[^>]*\baction="\/api\/youtube\/connect"/);
    const hidden = inputsOf(html).filter((i) => i.type === "hidden");
    expect(hidden).toEqual([expect.objectContaining({ name: "orgId", value: "org-1" })]);
    const consent = inputsOf(html).find((i) => i.name === "consent");
    expect(consent, "the consent checkbox").toMatchObject({ type: "checkbox", value: "1", checked: false });
    expect(html, "the submit button is disabled in the server HTML too").toMatch(/<button[^>]*data-testid="youtube-connect-submit"[^>]*\bdisabled=""|<button[^>]*\bdisabled=""[^>]*data-testid="youtube-connect-submit"/);
  });

  it("Unlisted and Made-for-kids No are PRESELECTED (D2) and the three visibilities are exactly the spec's: every one selectable, one at a time", () => {
    const html = inLocale("en", <YoutubeConnectCard orgId="org-1" onCancel={() => {}} />);
    const privacy = inputsOf(html).filter((i) => i.name === "privacy");
    expect(privacy.map((i) => i.value)).toEqual(["unlisted", "public", "private"]);   // spec §6.1.2 / D2 — typed, not read back
    expect(privacy.filter((i) => i.checked).map((i) => i.value)).toEqual(["unlisted"]);
    const kids = inputsOf(html).filter((i) => i.name === "madeForKids");
    expect(kids.map((i) => i.value)).toEqual(["0", "1"]);
    expect(kids.filter((i) => i.checked).map((i) => i.value)).toEqual(["0"]);

    // The vocabulary is lib/youtube.ts's: no visibility the route would refuse, none left out.
    expect(privacy.map((i) => i.value).sort()).toEqual([...YOUTUBE_PRIVACIES].sort());
    let checked = 0;
    for (const chosen of ["unlisted", "public", "private"] as const) {
      const one = inputsOf(renderToStaticMarkup(<PrivacyChoice value={chosen} onChange={() => {}} />));
      expect(one.filter((i) => i.checked).map((i) => i.value), chosen).toEqual([chosen]);
      checked++;
    }
    for (const chosen of ["0", "1"] as const) {
      const one = inputsOf(renderToStaticMarkup(<KidsChoice value={chosen} onChange={() => {}} />));
      expect(one.filter((i) => i.checked).map((i) => i.value), chosen).toEqual([chosen]);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("choosing a visibility or made-for-kids moves the choice the form posts (driven through the card's own state)", () => {
    const card = mount();
    const privacyOf = () => attr(ofType(card.tree(), PrivacyChoice)!, "value");
    const kidsOf = () => attr(ofType(card.tree(), KidsChoice)!, "value");
    expect([privacyOf(), kidsOf()]).toEqual(["unlisted", "0"]);
    let checked = 0;
    for (const p of ["public", "private", "unlisted"] as const) {
      (attr(ofType(card.tree(), PrivacyChoice)!, "onChange") as (v: string) => void)(p);
      expect(privacyOf(), p).toBe(p);
      checked++;
    }
    (attr(ofType(card.tree(), KidsChoice)!, "onChange") as (v: string) => void)("1");
    expect(kidsOf()).toBe("1");
    expect(checked).toBe(3);
  });

  it("M5: the card EXPLAINS that the choices apply to a channel connected for the first time (a channel already connected keeps its settings)", () => {
    const html = inLocale("en", <YoutubeConnectCard orgId="org-1" onCancel={() => {}} />);
    expect(plain(html)).toContain(m("streaming.youtube.settingsNote"));
    expect(m("streaming.youtube.settingsNote")).toMatch(/already connected/i);
  });

  // PO 2026-10-30, owner-requested (after stg's test stream was flagged under YouTube's child-safety policy): the under-16 rule is part of
  // what the organiser TICKS, not a separate note beside the box. The clause per locale: English typed from the ruling, the other three the
  // translations shipped with it. Each is checked against its dictionary AND against the label the checkbox sits in.
  const MINORS_CLAUSE: Record<string, string> = {
    en: "makes sure an adult is visibly present whenever players under 16 are on camera",
    es: "se asegura de que un adulto esté visiblemente presente siempre que aparezcan en cámara jugadores menores de 16 años",
    fr: "veille à ce qu’un adulte soit visiblement présent chaque fois que des joueurs de moins de 16 ans sont filmés",
    nl: "ervoor zorgt dat er zichtbaar een volwassene aanwezig is wanneer spelers onder de 16 in beeld zijn",
  };

  it("PO 2026-10-30: YouTube's under-16 rule is a clause of the consent the organiser TICKS — inside the checkbox's label, after the rights clause, before Continue — in EVERY locale", () => {
    expect(Object.keys(MINORS_CLAUSE).sort(), "a clause for every locale, and no other").toEqual([...LOCALES].sort());
    let checked = 0;
    for (const l of LOCALES) {
      const clause = MINORS_CLAUSE[l]!;
      const dict = localeDict(l);
      const body = dict["streaming.youtube.consent.body"]!;
      // Where the ruling puts it: after the rights clause (the sentence's one parenthesis, "(venue, players, music)") and before what
      // Seazn will do (the sentence's one "Seazn").
      expect(body, `${l}: the consent sentence carries the clause`).toContain(clause);
      expect(body.indexOf(")"), `${l}: after the rights clause`).toBeLessThan(body.indexOf(clause));
      expect(body.indexOf(clause), `${l}: before what Seazn will do`).toBeLessThan(body.indexOf("Seazn"));
      const html = inLocale(l, <YoutubeConnectCard orgId="org-1" onCancel={() => {}} />);
      // The <label> the consent checkbox sits in: the words a tap ticks, and what a screen reader reads as the box's name.
      const box = html.indexOf('data-testid="youtube-consent"');
      const button = html.indexOf('data-testid="youtube-connect-submit"');
      expect(box, `${l}: the checkbox is in the markup`).toBeGreaterThan(-1);
      expect(button, `${l}: the go-to-Google button is in the markup`).toBeGreaterThan(-1);
      const open = html.lastIndexOf("<label", box);
      const close = html.indexOf("</label>", box);
      expect(open, `${l}: the checkbox is inside a label`).toBeGreaterThan(-1);
      const label = html.slice(open, close);
      const filled = body.replace("{tos}", dict["streaming.youtube.consent.tos"]!).replace("{guidelines}", dict["streaming.youtube.consent.guidelines"]!);
      expect(plain(label), `${l}: the label reads the dictionary's sentence, slots filled`).toBe(filled);
      expect(label, `${l}: the clause is in the label`).toContain(esc(clause));
      expect(close, `${l}: and that label closes before Continue to Google`).toBeLessThan(button);
      checked++;
    }
    expect(checked).toBe(4);
    // English: the ruling's own words, in their place in the sentence.
    expect(m("streaming.youtube.consent.body")).toContain(
      "has the rights to stream this content (venue, players, music), makes sure an adult is visibly present whenever players under 16 are on camera, and agrees that Seazn will",
    );
  });

  it("the separate under-16 note #1089 added is GONE: no key in any dictionary, nothing rendered beside the box — the rule is said once, in the consent", () => {
    const OLD_KEY = "streaming.youtube.connect.minors";
    // The #1089 sentence's opening, typed: a note that came back under another key is caught too.
    const OLD_EN = "Streaming junior matches? YouTube doesn't allow live streams showing children under 16";
    let checked = 0;
    for (const l of LOCALES) {
      expect(localeDict(l)[OLD_KEY], `${l}: the key is deleted`).toBeUndefined();
      const html = inLocale(l, <YoutubeConnectCard orgId="org-1" onCancel={() => {}} />);
      expect(html, `${l}: no note element`).not.toContain('data-testid="youtube-minors-note"');
      // The positive pair: the rule is still on the card, exactly once (in the consent), in this locale.
      expect(plain(html).split(MINORS_CLAUSE[l]!).length - 1, `${l}: the clause, once`).toBe(1);
      checked++;
    }
    expect(checked).toBe(4);
    expect(plain(inLocale("en", <YoutubeConnectCard orgId="org-1" onCancel={() => {}} />))).not.toContain(OLD_EN);
  });

  it("the consent wording and its version move TOGETHER: this is the English text YOUTUBE_CONSENT_VERSION 2 names (1 -> 2 when the under-16 clause joined, PO 2026-10-30)", () => {
    // If this fails you changed the words a person ticks. Update the pin AND bump YOUTUBE_CONSENT_VERSION (lib/youtube.ts) in the SAME
    // change: that is what makes every new connection record the text it ticked, and every older one read "Review updated terms" (spec
    // §6.1.5 — Go live is never blocked by it). Never the pin alone.
    expect(YOUTUBE_CONSENT_VERSION).toBe(2);
    expect(m("streaming.youtube.consent.body")).toBe(
      "I confirm this organisation will follow YouTube's {tos} and {guidelines}, has the rights to stream this content (venue, players, music), makes sure an adult is visibly present whenever players under 16 are on camera, and agrees that Seazn will create, title, start and end a YouTube live broadcast on this channel for each match we stream here.",
    );
    expect(m("streaming.youtube.consent.disclaimer")).toBe(
      "YouTube alone decides whether this channel can stream; Seazn is not responsible if YouTube restricts or disables live streaming, removes a stream, issues a strike, or does not save a replay.",
    );
    expect(m("streaming.youtube.consent.bound")).toBe("By connecting you agree to be bound by the {tos}. See our {privacy}.");
  });

  it("the consent text: the spec's words, the ToS / Community Guidelines / Privacy Policy links (external ones noopener), and no unfilled {slot} in ANY locale", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const html = inLocale(l, <ConsentBox checked={false} onChange={() => {}} withName />);
      const text = plain(html);
      expect(text, `${l}: no unfilled slot`).not.toMatch(/\{\w+\}/);
      const links = [...html.matchAll(/<a\b([^>]*)>/g)].map(([, a = ""]) => ({ href: /\bhref="([^"]*)"/.exec(a)?.[1], rel: /\brel="([^"]*)"/.exec(a)?.[1], target: /\btarget="([^"]*)"/.exec(a)?.[1] }));
      // Four links: ToS and Guidelines in the sentence, the ToS again in the "bound by" line, and our Privacy Policy.
      expect(links.map((x) => x.href), l).toEqual([
        "https://www.youtube.com/t/terms", "https://www.youtube.com/t/community_guidelines", "https://www.youtube.com/t/terms", "/legal/privacy",
      ]);
      for (const x of links) {
        expect(x.target, `${l} ${x.href}`).toBe("_blank");
        expect(x.rel, `${l} ${x.href}`).toBe("noopener noreferrer");
      }
      const dict = localeDict(l);
      expect(text, l).toContain(dict["streaming.youtube.consent.disclaimer"]);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    // English: the sentence the owner approved in the spec, link labels in place.
    const en = plain(inLocale("en", <ConsentBox checked={false} onChange={() => {}} withName />));
    expect(en).toContain("I confirm this organisation will follow YouTube's Terms of Service and Community Guidelines");
    expect(en).toContain("create, title, start and end a YouTube live broadcast on this channel for each match we stream here");
    expect(en).toContain("By connecting you agree to be bound by the YouTube Terms of Service. See our Privacy Policy.");
  });

  it("the review-terms variant of the box posts no field (it is a PATCH, not a form POST); the connect one posts consent=1", () => {
    const named = inputsOf(renderToStaticMarkup(<ConsentBox checked={false} onChange={() => {}} withName />))[0]!;
    const bare = inputsOf(renderToStaticMarkup(<ConsentBox checked={false} onChange={() => {}} withName={false} />))[0]!;
    expect(named).toMatchObject({ type: "checkbox", name: "consent", value: "1" });
    expect(bare.name).toBeUndefined();
    expect(bare.value).toBeUndefined();
  });

  it("Cancel hands control back", async () => {
    const onCancel = vi.fn();
    const card = renderIsland(YoutubeConnectCard, { orgId: "org-1", onCancel });
    await click(byTestId(card.tree(), "youtube-connect-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the landing banner — the connect round trip's outcome as this page's sentence", () => {
  // Derived from the exported source (the override: "derive the test's list from that exported source, not a typed table").
  const BANNER_CODES = YOUTUBE_LANDING_CODES.filter((c) => c !== "pick");
  /** The dictionary key a banner reads: `streaming.youtube.landing.<code>`, except the one T9's review added, which the brief named. */
  const KEY_OF = (code: string): string => (code === "already_connected" ? "streaming.youtube.alreadyConnected" : `streaming.youtube.landing.${code}`);
  /** The two success outcomes (a status, not an alert); every other code is a failure the person must act on. */
  const SUCCESS = ["connected", "already_connected"];

  it("the source has the codes the brief names: twelve, eleven of them banners (T7 added `unavailable`, T9 review added `already_connected`, which only the picker lands); `pick` is the picker's", () => {
    expect(YOUTUBE_LANDING_CODES).toHaveLength(12);
    expect(BANNER_CODES).toHaveLength(11);
    expect(YOUTUBE_LANDING_CODES).toContain("unavailable");
    expect(YOUTUBE_LANDING_CODES).toContain("already_connected");
    expect(BANNER_CODES).not.toContain("pick");
  });

  it("EVERY banner code renders its own sentence — ELEVEN checked, eleven distinct — success as a status, every failure as an alert", () => {
    const seen = new Set<string>();
    let checked = 0;
    for (const code of BANNER_CODES) {
      const html = renderToStaticMarkup(<YoutubeLandingNotice code={code} />);
      const sentence = (messages as Record<string, string>)[KEY_OF(code)];
      expect(sentence, `${code}: the dictionary has it`).toBeTypeOf("string");
      expect(html, code).toContain(esc(sentence!));
      expect(html, code).toContain(`data-code="${code}"`);
      expect(html, `${code}: role`).toContain(SUCCESS.includes(code) ? 'role="status"' : 'role="alert"');
      seen.add(sentence!);
      checked++;
    }
    expect(checked, "all eleven banner codes").toBe(11);
    expect(seen.size, "no two codes share a sentence").toBe(11);
  });

  it("already_connected reads, word for word, as the controller's ruling (M5): the channel was already connected, its visibility and audience settings are unchanged, change them in Settings", () => {
    // The copy is the ruling's own sentence typed here, not read back from the dictionary under test.
    expect(messages["streaming.youtube.alreadyConnected" as MessageKey]).toBe(
      "This channel was already connected. Its visibility and audience settings are unchanged — change them in Settings.",
    );
    const html = renderToStaticMarkup(<YoutubeLandingNotice code="already_connected" />);
    expect(plain(html)).toContain("This channel was already connected.");
    expect(plain(html)).not.toContain(m("streaming.youtube.landing.connected"));
  });

  it("every banner sentence is translated: es, fr and nl each have all eleven, none of them the English", () => {
    let checked = 0;
    for (const l of ["es", "fr", "nl"]) {
      const dict = localeDict(l);
      for (const code of BANNER_CODES) {
        const key = KEY_OF(code);
        expect(dict[key], `${l} ${key}`).toBeTypeOf("string");
        expect(dict[key], `${l} ${key} is not the English`).not.toBe((messages as Record<string, string>)[key]);
        expect(inLocale(l, <YoutubeLandingNotice code={code} />), `${l} ${code}`).toContain(esc(dict[key]!));
        checked++;
      }
    }
    expect(checked).toBe(33);
  });

  it("Dismiss clears the query: the page is replaced with /streaming (no outcome left to re-show on a reload)", async () => {
    const banner = renderIsland(YoutubeLandingNotice, { code: "denied" as const });
    await click(byTestId(banner.tree(), "youtube-landing-dismiss"));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith("/streaming");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the channel picker", () => {
  const CHANNELS = [{ id: "UC-one", title: "Riverside FC" }, { id: "UC-two", title: "Riverside Juniors" }];
  // The POST answer is parsed by the route's own response schema, so the field the picker reads is the field the wire carries
  // (youtube-connections-routes.test.ts pins the real route's body to the same shape): a rename on one side fails here.
  const answerPicker = (existing = false) =>
    answerWith((_url, method) => (method === "POST" ? YoutubeConnectionSaved.parse({ connectionId: "c-9", targetId: "t-9", existing }) : { channels: CHANNELS }));
  const mount = async () => {
    const picker = renderIsland(YoutubeChannelPicker, { orgId: "org-1", pendingId: PENDING });
    await settle();
    return picker;
  };

  it("loads the grant's channels on mount (GET the pending lookup of THIS grant), says how many, and lists each by title", async () => {
    answerPicker();
    const picker = await mount();
    expect(apiCalls).toEqual([{ url: `/api/v1/orgs/org-1/youtube-connections/pending/${PENDING}`, method: "GET", json: undefined }]);
    expect(isRealRoute("GET", apiCalls[0]!.url), "a route the API really serves").toBe(true);
    expect(allByTestId(picker.tree(), "youtube-picker-channel")).toHaveLength(2);
    const body = textOf(byTestId(picker.tree(), "youtube-picker")!).replace(/\s+/g, " ");
    expect(body).toContain("Riverside FC");
    expect(body).toContain("Riverside Juniors");
    expect(body).toContain(m("streaming.youtube.picker.body", { count: 2 }));
    expect(byTestId(picker.tree(), "youtube-picker-loading"), "no loading line once loaded").toBeUndefined();
  });

  it("while it loads: a loading line, and no Connect button to press (nothing chosen can exist yet)", async () => {
    let release: (v: unknown) => void = () => {};
    answerWith(() => new Promise((r) => { release = r; }));
    const picker = renderIsland(YoutubeChannelPicker, { orgId: "org-1", pendingId: PENDING });
    expect(textAt(picker.tree(), "youtube-picker-loading")).toBe(m("streaming.youtube.picker.loading"));
    expect(byTestId(picker.tree(), "youtube-picker-connect")).toBeUndefined();
    release({ channels: CHANNELS });
    await settle();
    expect(byTestId(picker.tree(), "youtube-picker-loading")).toBeUndefined();
    expect(byTestId(picker.tree(), "youtube-picker-connect")).toBeDefined();
  });

  it("Connect channel is disabled until a channel is CHOSEN (nothing is preselected: connecting the wrong channel is the worse mistake); choosing posts {pendingId, channelId} and lands on connected", async () => {
    answerPicker();
    const picker = await mount();
    expect(attr(byTestId(picker.tree(), "youtube-picker-connect")!, "disabled")).toBe(true);
    expect(allByTestId(picker.tree(), "youtube-picker-channel").map((r) => attr(r, "checked"))).toEqual([false, false]);
    await click(byTestId(picker.tree(), "youtube-picker-connect"));
    expect(apiCalls.filter((c) => c.method === "POST"), "a click with nothing chosen sends nothing").toEqual([]);

    (attr(allByTestId(picker.tree(), "youtube-picker-channel")[1]!, "onChange") as () => void)();
    expect(attr(byTestId(picker.tree(), "youtube-picker-connect")!, "disabled")).toBe(false);
    expect(allByTestId(picker.tree(), "youtube-picker-channel").map((r) => attr(r, "checked"))).toEqual([false, true]);
    await click(byTestId(picker.tree(), "youtube-picker-connect"));

    const posts = apiCalls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/v1/orgs/org-1/youtube-connections");
    expect(isRealRoute("POST", posts[0]!.url)).toBe(true);
    expect(posts[0]!.json, "the body the route's own schema accepts, naming the SECOND channel").toEqual({ pendingId: PENDING, channelId: "UC-two" });
    expect(() => PickYoutubeChannel.parse(posts[0]!.json)).not.toThrow();
    expect(nav.replace).toHaveBeenCalledWith("/streaming?youtube=connected");
  });

  it("a double tap sends ONE pick", async () => {
    answerPicker();
    const picker = await mount();
    (attr(allByTestId(picker.tree(), "youtube-picker-channel")[0]!, "onChange") as () => void)();
    const connect = byTestId(picker.tree(), "youtube-picker-connect");
    const onClick = propsOf(connect!).onClick as () => Promise<void>;
    await Promise.all([onClick(), onClick()]);
    await settle();
    expect(apiCalls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a refusal stays on the picker with the page's own sentence and the buttons usable again; a retry then succeeds (the sequence, not one call)", async () => {
    let attempt = 0;
    answerWith(async (_url, method) => {
      if (method === "GET") return { channels: CHANNELS };
      attempt += 1;
      if (attempt === 1) throw await wire(new HttpError(409, "This channel is connected to another organisation on Seazn", "YOUTUBE_OTHER_ORG"));
      return { connectionId: "c", targetId: "t", existing: false };
    });
    const picker = await mount();
    (attr(allByTestId(picker.tree(), "youtube-picker-channel")[0]!, "onChange") as () => void)();
    await click(byTestId(picker.tree(), "youtube-picker-connect"));
    expect(textAt(picker.tree(), "youtube-error")).toBe(m("streaming.youtube.landing.other_org"));
    expect(nav.replace, "not connected").not.toHaveBeenCalled();
    expect(attr(byTestId(picker.tree(), "youtube-picker-connect")!, "disabled"), "usable again").toBe(false);
    await click(byTestId(picker.tree(), "youtube-picker-connect"));
    expect(nav.replace).toHaveBeenCalledWith("/streaming?youtube=connected");
    expect(byTestId(picker.tree(), "youtube-error"), "the error is cleared by the retry").toBeUndefined();
  });

  it("a grant that is gone (404 / 410 on the lookup) reads as an expired request, with Cancel only — never a Connect button with nothing to connect", async () => {
    let checked = 0;
    for (const err of [new HttpError(404, "Not found"), new HttpError(410, "This connect request has expired", "YOUTUBE_PENDING_EXPIRED")]) {
      answerWith(async () => { throw await wire(err); });
      const picker = await mount();
      expect(textAt(picker.tree(), "youtube-error"), String(err.status)).toBe(m("streaming.youtube.landing.expired"));
      expect(byTestId(picker.tree(), "youtube-picker-connect"), String(err.status)).toBeUndefined();
      expect(byTestId(picker.tree(), "youtube-picker-loading"), String(err.status)).toBeUndefined();
      expect(byTestId(picker.tree(), "youtube-picker-cancel")).toBeDefined();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("M5: picking a channel the org ALREADY had lands on the already-connected banner (its settings were kept); a new channel lands on plain connected — the positive pair, and an answer without the flag (older server) reads as plain connected", async () => {
    const pickFirst = async () => {
      const picker = await mount();
      (attr(allByTestId(picker.tree(), "youtube-picker-channel")[0]!, "onChange") as () => void)();
      await click(byTestId(picker.tree(), "youtube-picker-connect"));
    };
    answerPicker(true);
    await pickFirst();
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenLastCalledWith("/streaming?youtube=already_connected");

    nav.replace.mockReset();
    answerPicker(false);
    await pickFirst();
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenLastCalledWith("/streaming?youtube=connected");

    nav.replace.mockReset();
    answerWith((_url, method) => (method === "POST" ? { connectionId: "c-9", targetId: "t-9" } : { channels: CHANNELS }));
    await pickFirst();
    expect(nav.replace, "no flag is not 'already connected'").toHaveBeenLastCalledWith("/streaming?youtube=connected");
  });

  it("a pick whose grant is gone (404 / 410 on the POST) mirrors the lookup: the expired sentence, the channel list and Connect gone, Cancel the only way on — and a refusal that leaves the grant alive does NOT clear it", async () => {
    let checked = 0;
    for (const err of [new HttpError(404, "Not found"), new HttpError(410, "This connect request has expired", "YOUTUBE_PENDING_EXPIRED")]) {
      answerWith(async (_url, method) => {
        if (method === "GET") return { channels: CHANNELS };
        throw await wire(err);
      });
      const picker = await mount();
      (attr(allByTestId(picker.tree(), "youtube-picker-channel")[0]!, "onChange") as () => void)();
      await click(byTestId(picker.tree(), "youtube-picker-connect"));
      expect(textAt(picker.tree(), "youtube-error"), String(err.status)).toBe(m("streaming.youtube.landing.expired"));
      expect(byTestId(picker.tree(), "youtube-picker-connect"), `${err.status}: no Connect with nothing to connect`).toBeUndefined();
      expect(allByTestId(picker.tree(), "youtube-picker-channel"), `${err.status}: the list is gone`).toHaveLength(0);
      expect(byTestId(picker.tree(), "youtube-picker-cancel"), `${err.status}: Cancel stays`).toBeDefined();
      expect(nav.replace, `${err.status}: not connected`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);

    // The other side: a refusal that leaves the grant usable (another org's channel, 409) keeps the list and Connect.
    answerWith(async (_url, method) => {
      if (method === "GET") return { channels: CHANNELS };
      throw await wire(new HttpError(409, "This channel is connected to another organisation on Seazn", "YOUTUBE_OTHER_ORG"));
    });
    const picker = await mount();
    (attr(allByTestId(picker.tree(), "youtube-picker-channel")[0]!, "onChange") as () => void)();
    await click(byTestId(picker.tree(), "youtube-picker-connect"));
    expect(allByTestId(picker.tree(), "youtube-picker-channel")).toHaveLength(2);
    expect(byTestId(picker.tree(), "youtube-picker-connect")).toBeDefined();
  });

  it("a grant that lists no channels says so (no_channel) and offers no Connect", async () => {
    answerWith(() => ({ channels: [] }));
    const picker = await mount();
    expect(textAt(picker.tree(), "youtube-error")).toBe(m("streaming.youtube.landing.no_channel"));
    expect(byTestId(picker.tree(), "youtube-picker-connect")).toBeUndefined();
  });

  it("Cancel returns to the Streaming page, nothing sent", async () => {
    answerPicker();
    const picker = await mount();
    await click(byTestId(picker.tree(), "youtube-picker-cancel"));
    expect(nav.replace).toHaveBeenCalledWith("/streaming");
    expect(apiCalls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("I1 — a long channel title cannot push a form past its card (a <fieldset>'s UA min-inline-size is min-content)", () => {
  /** The class TOKENS of every <fieldset> in some markup — tokens, so `max-md:min-w-0` cannot satisfy a `min-w-0` check. */
  const fieldsetTokens = (html: string): string[][] =>
    [...html.matchAll(/<fieldset\b([^>]*)>/g)].map(([, a = ""]) => (/\bclass="([^"]*)"/.exec(a)?.[1] ?? "").split(/\s+/).filter(Boolean));
  const html = (node: ReactNode): string => renderToStaticMarkup(<DictProvider dict={messages as unknown as Dict} locale="en">{node}</DictProvider>);

  it("every fieldset this feature renders carries min-w-0 AND min-inline-size:0 — the choices, the connect card, and the picker (five checked)", async () => {
    answerWith(() => ({ channels: [{ id: "UC-long", title: "Riverside Community Football Club Juniors U12 Girls" }] }));
    const picker = renderIsland(YoutubeChannelPicker, { orgId: "org-1", pendingId: PENDING });
    await settle();
    const pickerFieldsets = picker.tree().filter((el) => el.type === "fieldset");
    const surfaces: [string, string[][]][] = [
      ["PrivacyChoice", fieldsetTokens(html(<PrivacyChoice value="unlisted" onChange={() => {}} />))],
      ["KidsChoice", fieldsetTokens(html(<KidsChoice value="0" onChange={() => {}} />))],
      ["YoutubeConnectCard", fieldsetTokens(html(<YoutubeConnectCard orgId="o" onCancel={() => {}} />))],
      ["YoutubeChannelPicker", pickerFieldsets.map((el) => String(attr(el, "className") ?? "").split(/\s+/).filter(Boolean))],
    ];
    expect(surfaces.map(([, f]) => f.length), "one, one, two (privacy + kids), one").toEqual([1, 1, 2, 1]);
    let checked = 0;
    for (const [name, sets] of surfaces) {
      for (const tokens of sets) {
        expect(tokens, `${name}: min-w-0 as a class token`).toContain("min-w-0");
        expect(tokens, `${name}: min-inline-size reset`).toContain("[min-inline-size:0]");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: five fieldsets looked at").toBe(5);
  });

  it("the picker's title is the part that gives way: it truncates inside a min-w-0 label (the whole chain, not just the span)", async () => {
    answerWith(() => ({ channels: [{ id: "UC-long", title: "Riverside Community Football Club Juniors U12 Girls" }] }));
    const picker = renderIsland(YoutubeChannelPicker, { orgId: "org-1", pendingId: PENDING });
    await settle();
    const tokens = (el: ReactElement) => String(attr(el, "className") ?? "").split(/\s+/);
    const label = picker.tree().find((el) => el.type === "label")!;
    const title = picker.tree().find((el) => el.type === "span" && textOf(el).includes("Riverside Community"))!;
    expect(tokens(label)).toContain("min-w-0");
    expect(tokens(title)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("youtubeErrorText — every refusal the connection routes answer reads as the page's own copy, never the server's English", () => {
  type Row = [name: string, err: () => unknown, expected: string];
  const GENERIC = m("streamDest.error.generic");
  const ROWS: Row[] = [
    ["409 YOUTUBE_OTHER_ORG", () => new HttpError(409, "That channel is connected to another organisation on Seazn", "YOUTUBE_OTHER_ORG"), m("streaming.youtube.landing.other_org")],
    ["410 YOUTUBE_PENDING_EXPIRED", () => new HttpError(410, "This connect request has expired; connect the channel again", "YOUTUBE_PENDING_EXPIRED"), m("streaming.youtube.landing.expired")],
    ["422 YOUTUBE_CHANNEL_NOT_OFFERED", () => new HttpError(422, "That channel is not one of the channels this Google account offered", "YOUTUBE_CHANNEL_NOT_OFFERED"), m("streaming.youtube.error.notOffered")],
    ["422 YOUTUBE_DIFFERENT_CHANNEL", () => new HttpError(422, "That grant is for a different channel than this connection", "YOUTUBE_DIFFERENT_CHANNEL"), m("streaming.youtube.landing.different_channel")],
    ["409 YOUTUBE_IN_USE (a match is using the channel)", () => new HttpError(409, "A match is using this channel", "YOUTUBE_IN_USE"), m("streaming.youtube.error.inUse")],
    ["404 (a connection that is gone)", () => new HttpError(404, "Not found"), m("streaming.youtube.error.gone")],
    ["403 FORBIDDEN (a viewer's stale tab)", () => new HttpError(403, "Insufficient permissions"), m("streamDest.error.forbidden")],
    ["401 UNAUTHENTICATED", () => new AuthError("Not signed in"), m("streamDest.error.signedOut")],
    ["402 PAYMENT_REQUIRED, a frozen admin seat (members.max)", () => new PaymentRequiredError("members.max"), m("streamDest.error.seatFrozen")],
    ["402 PAYMENT_REQUIRED for any other feature", () => new PaymentRequiredError("formats.double_elim"), GENERIC],
    ["422 YOUTUBE_PRIVACY_INVALID", () => new HttpError(422, "privacy must be unlisted, public or private", "YOUTUBE_PRIVACY_INVALID"), GENERIC],
    ["500", () => new Error("boom"), GENERIC],
  ];

  it("each refusal maps to its own sentence through the real envelope, and the server's message never reaches the screen", async () => {
    let checked = 0;
    for (const [name, make, expected] of ROWS) {
      const err = await wire(make());
      const text = youtubeErrorText((k, v) => m(k, v), err);
      expect(text, name).toBe(expected);
      expect(text, `${name}: not the server's English`).not.toContain(err.message);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("an error that never reached the server (a dropped connection) is the generic retry line", () => {
    expect(youtubeErrorText((k, v) => m(k, v), new TypeError("Failed to fetch"))).toBe(GENERIC);
    expect(youtubeErrorText((k, v) => m(k, v), null)).toBe(GENERIC);
  });

  it("every sentence it can answer exists in all four locales (no English fallback in es/fr/nl)", () => {
    const keys: MessageKey[] = [
      "streaming.youtube.landing.other_org", "streaming.youtube.landing.expired", "streaming.youtube.landing.different_channel",
      "streaming.youtube.error.notOffered", "streaming.youtube.error.gone", "streaming.youtube.error.inUse", "streamDest.error.forbidden", "streamDest.error.signedOut",
      "streamDest.error.seatFrozen", "streamDest.error.generic",
    ];
    let checked = 0;
    for (const l of LOCALES) {
      for (const k of keys) {
        expect(localeDict(l)[k], `${l} ${k}`).toBeTypeOf("string");
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * keys.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("a connected channel's row", () => {
  /** What the row says about itself, per live state — the dictionary keys typed from the spec's states, not read from channelStatus. */
  const MATRIX: [status: View["status"], liveState: string, pill: MessageKey, tone: string][] = [
    ["connected", "enabled", "streaming.youtube.status.connected", "ok"],
    ["connected", "not_enabled", "streaming.youtube.status.notEnabled", "warn"],
    ["connected", "blocked", "streaming.youtube.status.blocked", "bad"],
    ["connected", "unknown", "streaming.youtube.status.unknown", "neutral"],
    ["connected", "a_state_this_build_has_never_heard_of", "streaming.youtube.status.unknown", "neutral"],
    ["reconnect_needed", "enabled", "streaming.youtube.status.reconnectNeeded", "bad"],
    ["reconnect_needed", "not_enabled", "streaming.youtube.status.reconnectNeeded", "bad"],
    ["reconnect_needed", "blocked", "streaming.youtube.status.reconnectNeeded", "bad"],
    ["reconnect_needed", "unknown", "streaming.youtube.status.reconnectNeeded", "bad"],
  ];

  it("each (status, liveState) reads as its own pill and tone; an unknown or unrecognised live state is NEUTRAL and never says connected, enabled or ready", () => {
    let checked = 0;
    const neutralLines: string[] = [];
    for (const [status, liveState, pill, tone] of MATRIX) {
      const t = channel({ status, liveState: liveState as View["liveState"] });
      const html = rowHtml(t);
      expect(html, `${status}/${liveState}`).toContain(`data-tone="${tone}"`);
      expect(textAt(renderIsland(YoutubeChannelRow, { t, canEdit: true, orgId: "o", badge: null }).tree(), "youtube-channel-status"), `${status}/${liveState}`).toBe(m(pill));
      if (tone === "neutral") {
        neutralLines.push(plain(html));
        expect(plain(html), `${liveState}: no "connected" pill`).not.toContain(m("streaming.youtube.status.connected"));
        expect(plain(html), `${liveState}: no "can go live" sentence`).not.toContain(m("streaming.youtube.statusLine.connected"));
        expect(plain(html), `${liveState}: says it has not been confirmed`).toContain(m("streaming.youtube.statusLine.unknown"));
      }
      checked++;
    }
    expect(checked, "every cell of the matrix").toBe(MATRIX.length);
    expect(neutralLines, "both neutral cases ran").toHaveLength(2);
    // stg run 2026-10-29: "Seazn hasn't confirmed …" read as a fault on a channel that had just connected. The line says WHEN the check
    // happens (the next Go live), not that something is missing.
    expect(m("streaming.youtube.statusLine.unknown"), "names the moment of the check").toMatch(/next time you go live/i);
    expect(m("streaming.youtube.statusLine.unknown"), "does not read as a fault").not.toMatch(/hasn't|not been|cannot|can't/i);
    // The positive pair: an ENABLED channel does say it can go live (a neutral that said nothing of the kind would pass the above).
    expect(plain(rowHtml(channel()))).toContain(m("streaming.youtube.statusLine.connected"));
  });

  it("channelStatus is total over what the wire may send: a made-up liveState and a made-up status both fail CLOSED", () => {
    expect(channelStatus({ status: "connected", liveState: "surprise" as View["liveState"] }).tone).toBe("neutral");
    expect(channelStatus({ status: "revoked" as View["status"], liveState: "enabled" }).tone).toBe("bad");
  });

  // U1 (PO ruling, T19 fix round 2): the reconnect-needed row warns that the channel's stored data is deleted a fixed time after it
  // stopped working. The number is the daily pass's own declaration (lib/youtube's YOUTUBE_DEAD_GRANT_PURGE_DAYS, which daily.ts purges
  // by), never a figure typed here - so a change to the purge moves the sentence with it.
  describe("the reconnect-needed warning (the dead-grant purge, in the customer's words)", () => {
    const WARNING = "youtube-channel-purge";
    const KEY = "streaming.youtube.statusLine.reconnectPurge" as MessageKey;
    const rowIn = (l: string, t: StreamTarget, opts: { disconnectOnly?: boolean } = {}) =>
      inLocale(l, <ul><YoutubeChannelRow t={t} canEdit orgId="o" badge={null} {...opts} /></ul>);
    const warningOf = (html: string): string | null => {
      const hit = new RegExp(`<p[^>]*data-testid="${WARNING}"[^>]*>(.*?)</p>`).exec(html);
      return hit ? plain(hit[1]!) : null;
    };

    it("in every locale the warning carries the purge window, the number comes from the declaration, and no `{days}` slot is left unfilled", () => {
      let checked = 0;
      for (const l of LOCALES) {
        const raw = localeDict(l)[KEY];
        expect(raw, `${l}: the sentence exists`).toBeTypeOf("string");
        expect(raw, `${l}: the number is a slot, not typed into the translation`).toContain("{days}");
        const said = warningOf(rowIn(l, channel({ status: "reconnect_needed" })));
        expect(said, `${l}: the warning is on the reconnect-needed row`).not.toBeNull();
        expect(said, `${l}: says the window`).toContain(String(YOUTUBE_DEAD_GRANT_PURGE_DAYS));
        expect(said, `${l}: no slot left`).not.toMatch(/[{}]/);
        expect(said, `${l}: it is THIS locale's sentence`).toBe(plain(raw!.replaceAll("{days}", String(YOUTUBE_DEAD_GRANT_PURGE_DAYS))));
        if (l !== "en") expect(raw, `${l}: translated, not the English fallback`).not.toBe(localeDict("en")[KEY]);
        checked++;
      }
      expect(checked, "every locale").toBe(LOCALES.length);
      expect(LOCALES.length).toBeGreaterThan(1);
    });

    it("it sits with the reconnect-needed state only: no other cell of the matrix, and not the restricted (disconnect-only) page", () => {
      let on = 0;
      let off = 0;
      for (const [status, liveState] of MATRIX) {
        const html = rowIn("en", channel({ status, liveState: liveState as View["liveState"] }));
        if (status === "reconnect_needed") {
          expect(warningOf(html), `${status}/${liveState}`).not.toBeNull();
          on++;
        } else {
          expect(warningOf(html), `${status}/${liveState}`).toBeNull();
          expect(plain(html), `${status}/${liveState}`).not.toContain(m(KEY, { days: YOUTUBE_DEAD_GRANT_PURGE_DAYS }));
          off++;
        }
      }
      expect([on, off], "both sides of the matrix ran").toEqual([4, 5]);
      // The restricted page cannot reconnect, so a "reconnect to keep it" sentence there would point at a button that is not there.
      expect(warningOf(rowIn("en", channel({ status: "reconnect_needed" }), { disconnectOnly: true }))).toBeNull();
    });

    it("it is a separate sentence from the status line, which keeps saying what stopped and what that blocks", () => {
      const html = rowIn("en", channel({ status: "reconnect_needed" }));
      expect(plain(html)).toContain(m("streaming.youtube.statusLine.reconnectNeeded"));
      expect(plain(html)).toContain(m(KEY, { days: YOUTUBE_DEAD_GRANT_PURGE_DAYS }));
      // A reconnect with the terms to review first still warns: the clock runs whatever the agreement text says.
      expect(warningOf(rowIn("en", channel({ status: "reconnect_needed", termsOutdated: true })))).not.toBeNull();
    });
  });

  it("not-enabled carries YouTube's up-to-24-hours hint; no other state does", () => {
    let withHint = 0;
    let without = 0;
    for (const [status, liveState] of MATRIX) {
      const has = plain(rowHtml(channel({ status, liveState: liveState as View["liveState"] }))).includes(m("streaming.youtube.notEnabledHint"));
      if (status === "connected" && liveState === "not_enabled") {
        expect(has).toBe(true);
        withHint++;
      } else {
        expect(has, `${status}/${liveState}`).toBe(false);
        without++;
      }
    }
    expect([withHint, without]).toEqual([1, MATRIX.length - 1]);
    expect(m("streaming.youtube.notEnabledHint")).toMatch(/24 hours/);
  });

  it("the title, privacy and made-for-kids are the connection's, and a long 43-character name truncates inside a min-w-0 chain", () => {
    const name = "Riverside Community Football Club Juniors U12";
    const html = rowHtml(channel({ channelTitle: name, privacy: "public", madeForKids: true }));
    expect(plain(html)).toContain(name);
    expect(plain(html)).toContain(`${m("streaming.youtube.privacy.public")} · ${m("streaming.youtube.row.kidsYes")}`);
    expect(html).toMatch(/class="[^"]*\bmin-w-0\b[^"]*"[^>]*><p[^>]*class="[^"]*\btruncate\b/);
    expect(plain(rowHtml(channel({ privacy: "private", madeForKids: false })))).toContain(`${m("streaming.youtube.privacy.private")} · ${m("streaming.youtube.row.kidsNo")}`);
  });

  it("the row's YouTube logo is a link to the channel on YouTube (owner 2026-10-28), and a held channel shows its holder badge", () => {
    const row = rowHtml(channel());
    const a = /<a\b[^>]*data-testid="youtube-logo-link"[^>]*>/.exec(row)?.[0];
    expect(a, "the logo is wrapped in an anchor").toBeDefined();
    expect(a).toContain(`href="https://www.youtube.com/channel/${CHANNEL_ID}"`);
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
    expect(a, "named '<channel> on YouTube'").toContain(`aria-label="${m("streaming.youtube.channelLink", { name: "Riverside FC" })}"`);
    expect(m("streaming.youtube.channelLink", { name: "Riverside FC" })).toBe("Riverside FC on YouTube");
    expect(row, "the neutral platform tile is NOT also drawn: one mark per row").not.toContain('data-platform-mark="youtube"');
    const html = renderToStaticMarkup(
      <DictProvider dict={messages as unknown as Dict} locale="en"><ul><YoutubeChannelRow t={channel()} canEdit orgId="o" badge={<span data-testid="stream-dest-badge">Live on Match 5</span>} /></ul></DictProvider>,
    );
    expect(html).toContain('data-testid="stream-dest-badge"');
  });

  it("NO Rename, Replace key or Remove, for anyone, in any state (the server answers each with 422 YOUTUBE_USE_DISCONNECT: a channel leaves by Disconnect, T18)", () => {
    const forbiddenTestIds = ["stream-dest-rename", "stream-dest-replace", "stream-dest-remove", "stream-dest-menu", "stream-dest-menu-remove"];
    const forbiddenWords = [m("streamDest.rename"), m("streamDest.replaceKey"), m("streamDest.remove")];
    let checked = 0;
    for (const canEdit of [true, false]) {
      for (const [status, liveState] of MATRIX) {
        for (const termsOutdated of [false, true]) {
          const html = rowHtml(channel({ status, liveState: liveState as View["liveState"], termsOutdated }), canEdit);
          for (const id of forbiddenTestIds) expect(html, `${canEdit}/${status}/${liveState}/${termsOutdated} ${id}`).not.toContain(`data-testid="${id}"`);
          const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(([, b = ""]) => plain(b));
          for (const w of forbiddenWords) expect(buttons, `${canEdit}/${status}/${liveState}/${termsOutdated} ${w}`).not.toContain(w);
          checked++;
        }
      }
    }
    expect(checked).toBe(2 * MATRIX.length * 2);
  });

  it("who sees which action: Reconnect only on a dead grant with CURRENT terms; Review terms whenever the terms moved on; Settings and Disconnect for every editor; a viewer sees none", () => {
    const actions = (html: string) => ({
      reconnect: html.includes('data-testid="youtube-reconnect"'),
      review: html.includes('data-testid="youtube-review-terms"'),
      settings: html.includes('data-testid="youtube-settings"'),
      disconnect: html.includes('data-testid="youtube-disconnect"'),
    });
    expect(actions(rowHtml(channel()))).toEqual({ reconnect: false, review: false, settings: true, disconnect: true });
    expect(actions(rowHtml(channel({ status: "reconnect_needed" })))).toEqual({ reconnect: true, review: false, settings: true, disconnect: true });
    expect(actions(rowHtml(channel({ termsOutdated: true })))).toEqual({ reconnect: false, review: true, settings: true, disconnect: true });
    expect(actions(rowHtml(channel({ status: "reconnect_needed", termsOutdated: true })))).toEqual({ reconnect: false, review: true, settings: true, disconnect: true });
    let checked = 0;
    for (const y of [{}, { status: "reconnect_needed" as const }, { termsOutdated: true }]) {
      expect(actions(rowHtml(channel(y), false)), JSON.stringify(y)).toEqual({ reconnect: false, review: false, settings: false, disconnect: false });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("terms moved on: a connected channel says matches keep streaming; a dead one says review FIRST, then reconnect — and no other row says either", () => {
    expect(plain(rowHtml(channel({ termsOutdated: true })))).toContain(m("streaming.youtube.statusLine.reviewTerms"));
    expect(plain(rowHtml(channel({ status: "reconnect_needed", termsOutdated: true })))).toContain(m("streaming.youtube.statusLine.reviewFirst"));
    expect(plain(rowHtml(channel({ status: "reconnect_needed", termsOutdated: true })))).not.toContain(m("streaming.youtube.statusLine.reviewTerms"));
    expect(plain(rowHtml(channel()))).not.toContain(m("streaming.youtube.statusLine.reviewTerms"));
    expect(plain(rowHtml(channel()))).not.toContain(m("streaming.youtube.statusLine.reviewFirst"));
    expect(rowHtml(channel({ termsOutdated: true }))).toContain('data-testid="youtube-channel-terms"');
    expect(rowHtml(channel())).not.toContain('data-testid="youtube-channel-terms"');
  });

  it("Reconnect is a form POST to the connect route carrying the connection and its CURRENT settings — and NO consent field (the consent on file stands: T7-R2)", () => {
    const html = rowHtml(channel({ status: "reconnect_needed", privacy: "public", madeForKids: true, connectionId: "11111111-2222-4333-8444-555555555555" }));
    const form = /<form[^>]*data-testid="youtube-reconnect-form"[^>]*>([\s\S]*?)<\/form>/.exec(html);
    expect(form, "the reconnect form").not.toBeNull();
    expect(form![0]).toMatch(/\bmethod="post"/);
    expect(form![0]).toMatch(/\baction="\/api\/youtube\/connect"/);
    const fields = Object.fromEntries(inputsOf(form![1]!).map((i) => [i.name, i.value]));
    expect(fields).toEqual({ orgId: "o", connectionId: "11111111-2222-4333-8444-555555555555", privacy: "public", madeForKids: "1" });
    expect(inputsOf(form![1]!).some((i) => i.name === "consent")).toBe(false);
  });

  describe("Settings", () => {
    const mount = (y: Partial<View> = {}) => renderIsland(YoutubeChannelRow, { t: channel({ connectionId: "c-7", ...y }), canEdit: true, orgId: "org-1", badge: null });
    const open = async (row: ReturnType<typeof mount>) => click(byTestId(row.tree(), "youtube-settings"));
    const choose = (row: ReturnType<typeof mount>, privacy?: string, kids?: "0" | "1") => {
      if (privacy) (attr(ofType(row.tree(), PrivacyChoice)!, "onChange") as (v: string) => void)(privacy);
      if (kids) (attr(ofType(row.tree(), KidsChoice)!, "onChange") as (v: string) => void)(kids);
    };

    it("opens on the connection's CURRENT values; Save is disabled until something changed; a change PATCHes THIS connection with the route's body, refreshes, and closes", async () => {
      const row = mount({ privacy: "private", madeForKids: true });
      expect(byTestId(row.tree(), "youtube-settings-form")).toBeUndefined();
      await open(row);
      expect(attr(ofType(row.tree(), PrivacyChoice)!, "value")).toBe("private");
      expect(attr(ofType(row.tree(), KidsChoice)!, "value")).toBe("1");
      expect(attr(byTestId(row.tree(), "youtube-settings-save")!, "disabled"), "nothing changed").toBe(true);
      await submit(byTestId(row.tree(), "youtube-settings-form"));
      expect(apiCalls, "an unchanged form sends nothing").toEqual([]);

      choose(row, "public", "0");
      expect(attr(byTestId(row.tree(), "youtube-settings-save")!, "disabled")).toBe(false);
      await submit(byTestId(row.tree(), "youtube-settings-form"));
      expect(apiCalls).toEqual([{ url: "/api/v1/orgs/org-1/youtube-connections/c-7", method: "PATCH", json: { privacy: "public", madeForKids: false } }]);
      expect(isRealRoute("PATCH", apiCalls[0]!.url)).toBe(true);
      expect(() => YoutubeConnectionSettings.parse(apiCalls[0]!.json)).not.toThrow();
      expect(nav.refresh).toHaveBeenCalledTimes(1);
      expect(byTestId(row.tree(), "youtube-settings-form"), "closed after saving").toBeUndefined();
    });

    it("every visibility is saveable from every other (the table, not one lucky pair)", async () => {
      let checked = 0;
      for (const from of ["unlisted", "public", "private"] as const) {
        for (const to of ["unlisted", "public", "private"] as const) {
          if (from === to) continue;
          apiCalls.length = 0;
          const row = mount({ privacy: from });
          await open(row);
          choose(row, to);
          await submit(byTestId(row.tree(), "youtube-settings-form"));
          expect(apiCalls, `${from} -> ${to}`).toEqual([{ url: "/api/v1/orgs/org-1/youtube-connections/c-7", method: "PATCH", json: { privacy: to, madeForKids: false } }]);
          checked++;
        }
      }
      expect(checked).toBe(6);
    });

    it("made-for-kids alone is a change too", async () => {
      const row = mount({ madeForKids: false });
      await open(row);
      choose(row, undefined, "1");
      await submit(byTestId(row.tree(), "youtube-settings-form"));
      expect(apiCalls[0]!.json).toEqual({ privacy: "unlisted", madeForKids: true });
    });

    it("Cancel closes without a call, and reopening shows the connection's values again, not the abandoned edit (the sequence)", async () => {
      const row = mount({ privacy: "unlisted" });
      await open(row);
      choose(row, "public");
      await click(byTestId(row.tree(), "youtube-settings-cancel"));
      expect(byTestId(row.tree(), "youtube-settings-form")).toBeUndefined();
      expect(apiCalls).toEqual([]);
      await open(row);
      expect(attr(ofType(row.tree(), PrivacyChoice)!, "value"), "the abandoned edit is gone").toBe("unlisted");
    });

    it("a refusal shows IN the row as the page's sentence and keeps the form open; the connection already gone (404) also re-reads the list", async () => {
      answerWith(async () => { throw await wire(new HttpError(404, "Not found")); });
      const row = mount();
      await open(row);
      choose(row, "public");
      await submit(byTestId(row.tree(), "youtube-settings-form"));
      expect(textAt(row.tree(), "youtube-error")).toBe(m("streaming.youtube.error.gone"));
      expect(nav.refresh, "the list is re-read: the row it names is gone").toHaveBeenCalledTimes(1);
      expect(byTestId(row.tree(), "youtube-settings-form"), "still open").toBeDefined();

      answerWith(async () => { throw await wire(new HttpError(403, "Insufficient permissions")); });
      nav.refresh.mockReset();
      await submit(byTestId(row.tree(), "youtube-settings-form"));
      expect(textAt(row.tree(), "youtube-error")).toBe(m("streamDest.error.forbidden"));
      expect(nav.refresh, "a 403 does not refresh").not.toHaveBeenCalled();
    });
  });

  describe("Review updated terms", () => {
    const mount = (y: Partial<View> = {}) => renderIsland(YoutubeChannelRow, { t: channel({ connectionId: "c-7", termsOutdated: true, ...y }), canEdit: true, orgId: "org-1", badge: null });
    const tickTerms = (row: ReturnType<typeof mount>, on: boolean) => (attr(ofType(row.tree(), ConsentBox)!, "onChange") as (v: boolean) => void)(on);

    it("shows the consent text with an untouched box; Accept is disabled until ticked; ticking and accepting PATCHes {consent: true} (the route's own schema), refreshes, closes", async () => {
      const row = mount();
      await click(byTestId(row.tree(), "youtube-review-terms"));
      expect(ofType(row.tree(), ConsentBox), "the wording is on screen to be read").toBeDefined();
      expect(attr(ofType(row.tree(), ConsentBox)!, "withName"), "a PATCH, not a form field").toBe(false);
      expect(attr(byTestId(row.tree(), "youtube-terms-accept")!, "disabled")).toBe(true);
      await submit(byTestId(row.tree(), "youtube-terms-form"));
      expect(apiCalls, "unticked: Enter sends nothing").toEqual([]);

      tickTerms(row, true);
      expect(attr(byTestId(row.tree(), "youtube-terms-accept")!, "disabled")).toBe(false);
      await submit(byTestId(row.tree(), "youtube-terms-form"));
      expect(apiCalls).toEqual([{ url: "/api/v1/orgs/org-1/youtube-connections/c-7", method: "PATCH", json: { consent: true } }]);
      expect(isRealRoute("PATCH", apiCalls[0]!.url)).toBe(true);
      expect(() => YoutubeConnectionSettings.parse(apiCalls[0]!.json)).not.toThrow();
      expect(nav.refresh).toHaveBeenCalledTimes(1);
      expect(byTestId(row.tree(), "youtube-terms-form")).toBeUndefined();
    });

    it("the tick does not survive a close: reopening starts unticked (consent is given each time it is read)", async () => {
      const row = mount();
      await click(byTestId(row.tree(), "youtube-review-terms"));
      tickTerms(row, true);
      await click(byTestId(row.tree(), "youtube-terms-cancel"));
      await click(byTestId(row.tree(), "youtube-review-terms"));
      expect(attr(ofType(row.tree(), ConsentBox)!, "checked")).toBe(false);
      expect(apiCalls).toEqual([]);
    });

    it("Settings and Review terms are one-at-a-time: opening one closes the other", async () => {
      const row = mount();
      await click(byTestId(row.tree(), "youtube-review-terms"));
      await click(byTestId(row.tree(), "youtube-settings"));
      expect(byTestId(row.tree(), "youtube-terms-form")).toBeUndefined();
      expect(byTestId(row.tree(), "youtube-settings-form")).toBeDefined();
      await click(byTestId(row.tree(), "youtube-review-terms"));
      expect(byTestId(row.tree(), "youtube-settings-form")).toBeUndefined();
      expect(byTestId(row.tree(), "youtube-terms-form")).toBeDefined();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("Disconnect (T18) — the one way a channel leaves", () => {
  const STATES: [status: View["status"], liveState: View["liveState"]][] = [
    ["connected", "enabled"], ["connected", "not_enabled"], ["connected", "blocked"], ["connected", "unknown"],
    ["reconnect_needed", "enabled"], ["reconnect_needed", "blocked"],
  ];
  const DELETE_URL = "/api/v1/orgs/org-1/youtube-connections/c-9";
  const mount = (y: Partial<View> = {}, extra: Record<string, unknown> = {}) =>
    renderIsland(YoutubeChannelRow, { t: channel({ connectionId: "c-9", ...y }), canEdit: true, orgId: "org-1", badge: null, ...extra });
  const disconnectBtn = (row: ReturnType<typeof mount>) => byTestId(row.tree(), "youtube-disconnect");
  const inUse = () => new HttpError(409, "A match is using this channel", "YOUTUBE_IN_USE");

  it("an editor sees Disconnect on EVERY state - a dead grant, a blocked channel, outdated terms included (the policy's door is never behind a health check); a viewer sees none", () => {
    let seen = 0;
    for (const [status, liveState] of STATES) {
      for (const termsOutdated of [false, true]) {
        const html = rowHtml(channel({ status, liveState, termsOutdated }), true);
        const btn = new RegExp('<button\\b[^>]*data-testid="youtube-disconnect"[^>]*>([\\s\\S]*?)</button>').exec(html);
        expect(btn, `${status}/${liveState}/${termsOutdated}`).not.toBeNull();
        expect(plain(btn![1]!)).toBe("Disconnect");
        expect(btn![0], "a danger button").toMatch(/\bbtn-danger\b/);
        expect(btn![0], "44px floor").toMatch(/\bmin-h-11\b/);
        expect(btn![0], "full width on a phone").toMatch(/\bmax-md:w-full\b/);
        expect(btn![0], "never disabled by the channel's health").not.toMatch(/\bdisabled\b/);
        expect(rowHtml(channel({ status, liveState, termsOutdated }), false), `viewer ${status}/${liveState}/${termsOutdated}`).not.toContain('data-testid="youtube-disconnect"');
        seen++;
      }
    }
    expect(seen).toBe(STATES.length * 2);
  });

  it("and it WORKS on every one of those states: a dead grant, a blocked channel, a not-enabled one - one DELETE of THAT connection each (anti-vacuity: 6 states)", async () => {
    let sent = 0;
    for (const [status, liveState] of STATES) {
      apiCalls.length = 0;
      const row = mount({ status, liveState, termsOutdated: status === "reconnect_needed" });
      await click(disconnectBtn(row));
      expect(apiCalls, `${status}/${liveState}`).toEqual([{ url: DELETE_URL, method: "DELETE", json: undefined }]);
      sent++;
    }
    expect(sent).toBe(STATES.length);
  });

  it("the confirm dialog names the channel and says what goes (revoke, stream keys, replay links) and what stays (the videos); it is the danger dialog with touch buttons, never window.confirm", async () => {
    const row = mount({ channelTitle: "Riverside FC" });
    await click(disconnectBtn(row));
    expect(confirmState.asked).toHaveLength(1);
    const asked = confirmState.asked[0]!;
    expect(asked).toMatchObject({ tone: "danger", size: "touch", cancelLabel: m("streamDest.cancel") });
    expect(asked.title).toBe("Disconnect Riverside FC?");
    expect(asked.confirmLabel).toBe("Disconnect channel");
    expect(asked.body, "the dictionary's own sentence").toBe(m("streaming.youtube.disconnect.body"));
    expect(String(asked.body)).toMatch(/stream keys/);
    expect(String(asked.body)).toMatch(/replay links/);
    expect(String(asked.body)).toMatch(/Videos already on YouTube stay there/);
    // F1: the body is true in all three outcomes - it ASKS Google, and says when it will not (a shared account); it never promises a revoke
    expect(String(asked.body)).toMatch(/asks Google to revoke its access, unless another connected channel uses the same Google account/);
    expect(String(asked.body), "no unconditional revoke promise").not.toMatch(/will revoke its access/);
  });

  it("confirmed: DELETEs THIS connection on a route the API serves, tells the page which channel, and re-reads the list - once", async () => {
    const onDisconnected = vi.fn();
    const row = mount({ channelTitle: "Riverside FC" }, { onDisconnected });
    await click(disconnectBtn(row));
    expect(apiCalls).toEqual([{ url: DELETE_URL, method: "DELETE", json: undefined }]);
    expect(isRealRoute("DELETE", DELETE_URL), "the route table serves this path and method").toBe(true);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    // the stand-in transport answers `{}`: no outcome on the wire is told as the cautious one, never as a confirmed revoke - and no
    // keysLeft is "not confirmed" too (null), never a 0 that would read as "every key went"
    expect(onDisconnected).toHaveBeenCalledWith({ name: "Riverside FC", outcome: "not_confirmed", keysLeft: null });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(byTestId(row.tree(), "youtube-error"), "no error line").toBeUndefined();
  });

  it("cancelled: nothing is sent, nothing is re-read, nobody is told - and the next confirmed tap works (the sequence)", async () => {
    const onDisconnected = vi.fn();
    const row = mount({}, { onDisconnected });
    confirmState.answer = false;
    await click(disconnectBtn(row));
    expect(confirmState.asked, "the dialog opened").toHaveLength(1);
    expect(apiCalls).toEqual([]);
    expect(nav.refresh).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(byTestId(row.tree(), "youtube-error")).toBeUndefined();

    confirmState.answer = true;
    await click(disconnectBtn(row));
    expect(confirmState.asked).toHaveLength(2);
    expect(apiCalls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it("a match is using the channel (409 YOUTUBE_IN_USE): the reason in plain words, IN the row, nothing re-read and nobody told; Disconnect stays available and works once the match is over (the sequence)", async () => {
    const onDisconnected = vi.fn();
    answerWith(async () => { throw await wire(inUse()); });
    const row = mount({}, { onDisconnected });
    await click(disconnectBtn(row));
    expect(textAt(row.tree(), "youtube-error")).toBe("A match is live on this channel or about to be, or its stream only just stopped and the channel is held for a few minutes. Disconnect it once the match has ended and that time has passed.");
    expect(textAt(row.tree(), "youtube-error")).toBe(m("streaming.youtube.error.inUse"));
    expect(nav.refresh).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(attr(disconnectBtn(row)!, "disabled"), "still available").toBe(false);

    answerWith();
    await click(disconnectBtn(row));
    expect(byTestId(row.tree(), "youtube-error"), "the refusal is cleared by the next attempt").toBeUndefined();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("F2: 409 YOUTUBE_END_UNKNOWN (the end rule could not say whether a match is using the channel) is its OWN sentence in the row - not the 'a match is live' one, not the generic retry - and re-reads nothing", async () => {
    const onDisconnected = vi.fn();
    answerWith(async () => { throw await wire(new HttpError(409, "Seazn could not tell whether a match is using this channel", "YOUTUBE_END_UNKNOWN")); });
    const row = mount({}, { onDisconnected });
    await click(disconnectBtn(row));
    expect(textAt(row.tree(), "youtube-error")).toBe(m("streaming.youtube.error.endUnknown"));
    expect(textAt(row.tree(), "youtube-error")).not.toBe(m("streaming.youtube.error.inUse"));
    expect(textAt(row.tree(), "youtube-error")).not.toBe(m("streamDest.error.generic"));
    expect(textAt(row.tree(), "youtube-error"), "plain words, not the server's English").not.toContain("could not tell");
    expect(nav.refresh).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("other refusals: a channel already gone (404) re-reads the list and says so; a viewer's stale tab (403) says so and re-reads nothing; a dropped connection is the generic retry line", async () => {
    const cases: [name: string, err: () => Promise<unknown>, sentence: string, refreshes: number][] = [
      ["404", () => wire(new HttpError(404, "Not found")), m("streaming.youtube.error.gone"), 1],
      ["403", () => wire(new HttpError(403, "Insufficient permissions")), m("streamDest.error.forbidden"), 0],
      ["network", async () => new TypeError("Failed to fetch"), m("streamDest.error.generic"), 0],
    ];
    let checked = 0;
    for (const [name, err, sentence, refreshes] of cases) {
      nav.refresh.mockReset();
      answerWith(async () => { throw await err(); });
      const row = mount();
      await click(disconnectBtn(row));
      expect(textAt(row.tree(), "youtube-error"), name).toBe(sentence);
      expect(nav.refresh, name).toHaveBeenCalledTimes(refreshes);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a second tap while the dialog is open asks nothing more and sends one DELETE (the double-submit guard)", async () => {
    let release!: () => void;
    confirmState.hold = new Promise<void>((r) => { release = r; });
    const row = mount();
    const tap = attr(disconnectBtn(row)!, "onClick") as () => Promise<void>;
    const first = tap();
    const second = tap();
    release();
    await Promise.all([first, second]);
    await settle();
    expect(confirmState.asked).toHaveLength(1);
    expect(apiCalls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("refreshAfter={false} (the restricted page) tells the page but never re-reads - on success or on a 404", async () => {
    const onDisconnected = vi.fn();
    const ok = mount({}, { onDisconnected, refreshAfter: false });
    await click(disconnectBtn(ok));
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(nav.refresh).not.toHaveBeenCalled();

    answerWith(async () => { throw await wire(new HttpError(404, "Not found")); });
    const gone = mount({}, { refreshAfter: false });
    await click(disconnectBtn(gone));
    expect(textAt(gone.tree(), "youtube-error")).toBe(m("streaming.youtube.error.gone"));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("disconnectOnly: Disconnect and nothing else - no Reconnect, Settings, Review terms, no go-live sentence, no terms badge - in every state (the pill still says what the channel is)", () => {
    const statusLines: MessageKey[] = [
      "streaming.youtube.statusLine.connected", "streaming.youtube.statusLine.reconnectNeeded", "streaming.youtube.statusLine.notEnabled",
      "streaming.youtube.statusLine.blocked", "streaming.youtube.statusLine.unknown", "streaming.youtube.statusLine.reviewTerms", "streaming.youtube.statusLine.reviewFirst",
    ];
    const only = (t: StreamTarget) =>
      renderToStaticMarkup(<DictProvider dict={messages as unknown as Dict} locale="en"><ul><YoutubeChannelRow t={t} canEdit orgId="o" badge={null} disconnectOnly /></ul></DictProvider>);
    let checked = 0;
    for (const [status, liveState] of STATES) {
      for (const termsOutdated of [false, true]) {
        const t = channel({ status, liveState, termsOutdated });
        const html = only(t);
        const where = `${status}/${liveState}/${termsOutdated}`;
        expect(html, where).toContain('data-testid="youtube-disconnect"');
        expect(html, where).toContain('data-testid="youtube-channel-status"');
        for (const id of ["youtube-reconnect", "youtube-reconnect-form", "youtube-settings", "youtube-review-terms", "youtube-channel-line", "youtube-channel-purge", "youtube-channel-terms", "youtube-channel-terms-line", "youtube-channel-hint"]) {
          expect(html, `${where} ${id}`).not.toContain(`data-testid="${id}"`);
        }
        for (const k of statusLines) expect(plain(html), `${where} ${k}`).not.toContain(m(k));
        // the positive pair: the SAME channel in the full page does say its line
        expect(rowHtml(t), where).toContain('data-testid="youtube-channel-line"');
        checked++;
      }
    }
    expect(checked).toBe(STATES.length * 2);
  });

  it("the panel keeps the news of a disconnect after the row has left the list, and Dismiss clears it", async () => {
    const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [channel()], locale: "en" });
    expect(ofType(panel.tree(), YoutubeDisconnectedNotice), "no notice before").toBeUndefined();
    (attr(ofType(panel.tree(), YoutubeChannelRow)!, "onDisconnected") as (news: { name: string; outcome: string; keysLeft: number | null }) => void)({ name: "Riverside FC", outcome: "revoked", keysLeft: 0 });
    const notice = ofType(panel.tree(), YoutubeDisconnectedNotice);
    expect(notice, "the notice").toBeDefined();
    expect(attr(notice!, "name")).toBe("Riverside FC");
    expect(attr(notice!, "outcome")).toBe("revoked");
    expect(attr(notice!, "keysLeft")).toBe(0);
    const html = renderToStaticMarkup(<DictProvider dict={messages as unknown as Dict} locale="en"><YoutubeDisconnectedNotice name="Riverside FC" outcome="revoked" keysLeft={0} onDismiss={() => {}} /></DictProvider>);
    expect(plain(html)).toContain("Riverside FC is disconnected. Seazn deleted what it stored from YouTube for this channel.");
    expect(html).toMatch(/data-testid="youtube-disconnected"[^>]*\brole="status"|\brole="status"[^>]*data-testid="youtube-disconnected"/);
    (attr(notice!, "onDismiss") as () => void)();
    expect(ofType(panel.tree(), YoutubeDisconnectedNotice), "dismissed").toBeUndefined();
  });

  it("m6: the news of a disconnect TAKES FOCUS as it appears (the button that asked left with the row, and focus would fall to the top of the page): the notice is a focusable block that hands itself the focus on attach, with the house ring; each new piece of news is a new element, so it focuses again - on the full page and on the restricted one", () => {
    // The notice itself
    const notice = renderIsland(YoutubeDisconnectedNotice, { name: "Riverside FC", outcome: "revoked", keysLeft: 0, onDismiss: () => {} });
    const box = byTestId(notice.tree(), "youtube-disconnected")!;
    expect(box, "the notice box").toBeDefined();
    expect(attr(box, "tabIndex"), "focusable, but not in the tab order").toBe(-1);
    expect(attr(box, "role"), "and still announced").toBe("status");
    for (const token of REFUSAL_FOCUS_RING.split(/\s+/)) expect(String(attr(box, "className")), `the house ring: ${token}`).toContain(token);
    const attach = attr(box, "ref") as ((el: { focus: () => void } | null) => void) | undefined;
    expect(attach, "a ref that runs when the box attaches").toBeTypeOf("function");
    const el = { focus: vi.fn() };
    attach!(el);
    expect(el.focus, "focused on attach").toHaveBeenCalledTimes(1);
    expect(() => attach!(null), "and the detach does nothing").not.toThrow();
    expect(el.focus).toHaveBeenCalledTimes(1);
    // an alert (a revoke Seazn could not confirm) is focusable the same way
    const alert = byTestId(renderIsland(YoutubeDisconnectedNotice, { name: "Riverside FC", outcome: "not_confirmed", keysLeft: 0, onDismiss: () => {} }).tree(), "youtube-disconnected")!;
    expect(attr(alert, "role")).toBe("alert");
    expect(attr(alert, "tabIndex")).toBe(-1);

    // The mount sites: a different piece of news is a different element (a key), so a second disconnect focuses again.
    type Done = (n: { name: string; outcome: string; keysLeft?: number | null }) => void;
    const pair = (): StreamTarget[] => [
      channel({ connectionId: "c-1", channelTitle: "Riverside FC" }, { id: "t-1" }),
      channel({ connectionId: "c-2", channelTitle: "Riverside Juniors" }, { id: "t-2" }),
    ];
    const rowsIn = (panel: { tree: () => ReactElement[] }) => panel.tree().filter((x) => x.type === YoutubeChannelRow);
    let sites = 0;
    for (const [where, panel] of [
      ["the full page", renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: pair(), locale: "en" })],
      ["the restricted page", renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: pair() })],
    ] as const) {
      const [a, b] = rowsIn(panel).map((r) => attr(r, "onDisconnected") as Done);   // both taken from the same render
      a!({ name: "Riverside FC", outcome: "revoked" });
      const first = ofType(panel.tree(), YoutubeDisconnectedNotice)!.key;
      b!({ name: "Riverside Juniors", outcome: "revoked" });
      const second = ofType(panel.tree(), YoutubeDisconnectedNotice)!.key;
      expect(first, `${where}: the notice is keyed`).toBeTypeOf("string");
      expect(second, `${where}: the next news is another element`).not.toBe(first);
      sites++;
    }
    expect(sites, "anti-vacuity: both mount sites judged").toBe(2);
  });

  it("keys left reach the notice from BOTH mount sites - the full page and the restricted one - as the row handed them: a count, and null (anti-vacuity: 2 sites x 2 values)", () => {
    type Done = (n: { name: string; outcome: string; keysLeft: number | null }) => void;
    let checked = 0;
    for (const [where, make] of [
      ["the full page", () => renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [channel()], locale: "en" })],
      ["the restricted page", () => renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: [channel()] })],
    ] as const) {
      for (const keysLeft of [3, null]) {
        const panel = make();
        (attr(ofType(panel.tree(), YoutubeChannelRow)!, "onDisconnected") as Done)({ name: "Riverside FC", outcome: "revoked", keysLeft });
        const notice = ofType(panel.tree(), YoutubeDisconnectedNotice);
        expect(notice, `${where}/${keysLeft}: the notice`).toBeDefined();
        expect(attr(notice!, "keysLeft"), `${where}/${keysLeft}: handed on`).toBe(keysLeft);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("F5: after a disconnect the connect round trip's landing banner ('YouTube channel connected.') does not sit above 'X is disconnected' - every non-picker landing goes, and its ?youtube= query with it; the picker, other landings' absence and a no-landing page are unaffected (anti-vacuity: every banner code)", () => {
    const SPEC_BANNER_CODES = YOUTUBE_LANDING_CODES.filter((c) => c !== "pick");
    expect(SPEC_BANNER_CODES.length, "premise: the banner codes the connect flow can land with").toBeGreaterThan(5);
    let checked = 0;
    for (const code of SPEC_BANNER_CODES) {
      nav.replace.mockReset();
      const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [channel()], locale: "en", landing: { code, pendingId: null } });
      expect(ofType(panel.tree(), YoutubeLandingNotice), `${code}: premise - the banner is there`).toBeDefined();
      (attr(ofType(panel.tree(), YoutubeChannelRow)!, "onDisconnected") as (n: { name: string; outcome: string }) => void)({ name: "Riverside FC", outcome: "revoked" });
      expect(ofType(panel.tree(), YoutubeLandingNotice), `${code}: the stale banner is gone`).toBeUndefined();
      expect(ofType(panel.tree(), YoutubeDisconnectedNotice), `${code}: the disconnect's news is there`).toBeDefined();
      expect(nav.replace, `${code}: and the query that raised it is cleared, so a reload does not bring it back`).toHaveBeenCalledWith("/streaming");
      checked++;
    }
    expect(checked).toBe(SPEC_BANNER_CODES.length);

    // the picker is a step of a flow in progress, not news: a disconnect leaves it open (and leaves the URL alone)
    nav.replace.mockReset();
    const picking = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [channel()], locale: "en", landing: { code: "pick", pendingId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" } });
    (attr(ofType(picking.tree(), YoutubeChannelRow)!, "onDisconnected") as (n: { name: string; outcome: string }) => void)({ name: "Riverside FC", outcome: "revoked" });
    expect(ofType(picking.tree(), YoutubeChannelPicker), "the picker stays").toBeDefined();
    expect(nav.replace).not.toHaveBeenCalled();

    // no landing (the plain page): nothing to clear and no navigation
    const plain = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [channel()], locale: "en" });
    (attr(ofType(plain.tree(), YoutubeChannelRow)!, "onDisconnected") as (n: { name: string; outcome: string }) => void)({ name: "Riverside FC", outcome: "revoked" });
    expect(ofType(plain.tree(), YoutubeDisconnectedNotice)).toBeDefined();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  const OUTCOME_COPY = {
    revoked: { key: "streaming.youtube.disconnect.done", link: false, role: "status" },
    skipped_shared_account: { key: "streaming.youtube.disconnect.doneShared", link: false, role: "status" },
    not_confirmed: { key: "streaming.youtube.disconnect.doneUnconfirmed", link: true, role: "alert" },
  } as const satisfies Record<(typeof YOUTUBE_REVOKE_OUTCOMES)[number], { key: MessageKey; link: boolean; role: string }>;

  it("F1: the row hands the page the outcome the wire carried, unchanged, for each of the three the API declares (anti-vacuity: every declared outcome)", async () => {
    expect(Object.keys(OUTCOME_COPY).sort(), "a declared outcome without copy would be told as another").toEqual([...YOUTUBE_REVOKE_OUTCOMES].sort());
    let checked = 0;
    for (const outcome of YOUTUBE_REVOKE_OUTCOMES) {
      answerWith(async () => ({ revokeOutcome: outcome, keysDeleted: 0, keysLeft: 0, purged: { broadcasts: 0, streamUrlsCleared: 0 } }));
      const onDisconnected = vi.fn();
      await click(disconnectBtn(mount({ channelTitle: "Riverside FC" }, { onDisconnected })));
      expect(onDisconnected, outcome).toHaveBeenCalledWith({ name: "Riverside FC", outcome, keysLeft: 0 });
      checked++;
    }
    expect(checked).toBe(YOUTUBE_REVOKE_OUTCOMES.length);
  });

  it("keys left: the row hands the page the `keysLeft` the wire carried - a count, null (the channel could not be read) - and an answer without one is told as null, the cautious one (anti-vacuity: 4 answers)", async () => {
    const answers: [wire: unknown, want: number | null][] = [[2, 2], [1, 1], [null, null], [undefined, null]];
    let checked = 0;
    for (const [wire, want] of answers) {
      answerWith(async () => ({ revokeOutcome: "revoked", keysDeleted: 0, ...(wire === undefined ? {} : { keysLeft: wire }), purged: { broadcasts: 0, streamUrlsCleared: 0 } }));
      const onDisconnected = vi.fn();
      await click(disconnectBtn(mount({ channelTitle: "Riverside FC" }, { onDisconnected })));
      expect(onDisconnected, String(wire)).toHaveBeenCalledWith({ name: "Riverside FC", outcome: "revoked", keysLeft: want });
      checked++;
    }
    expect(checked).toBe(answers.length);
  });

  it("F1: the notice tells the three outcomes apart in all four locales, from the dictionaries - revoked and 'kept on purpose' are calm statuses; 'not confirmed' is an alert that carries the plain Google link, and ONLY that one does (anti-vacuity: 3 outcomes x 4 locales)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const dict = localeDict(l);
      const sentences = new Set<string>();
      for (const outcome of YOUTUBE_REVOKE_OUTCOMES) {
        const want = OUTCOME_COPY[outcome];
        const html = inLocale(l, <YoutubeDisconnectedNotice name="Riverside FC" outcome={outcome} keysLeft={0} onDismiss={() => {}} />);
        const expected = dict[want.key]!.replaceAll("{name}", "Riverside FC").replaceAll("{link}", dict["streaming.youtube.disconnect.googleLink"]!);
        expect(plain(html), `${l}/${outcome}: the dictionary's sentence`).toContain(expected);
        expect(html, `${l}/${outcome}: no placeholder left in the page`).not.toMatch(/\{(name|link)\}/);
        expect(html, `${l}/${outcome}: role`).toMatch(new RegExp(`role="${want.role}"`));
        expect(html, `${l}/${outcome}: outcome marker`).toContain(`data-outcome="${outcome}"`);
        expect(html, `${l}/${outcome}: nothing left`).toContain('data-keys-left="0"');
        expect(html, `${l}/${outcome}: no logo in the notice`).not.toMatch(/<svg|<img/);
        if (want.link) {
          // The href is the ONE constant (lib/youtube.ts); the literal it must equal - the page the Developer Policies name - is pinned in
          // lib/__tests__/youtube-google-urls.test.ts.
          expect(html, `${l}/${outcome}: the plain link`).toContain(`href="${GOOGLE_THIRD_PARTY_ACCESS_URL}"`);
          expect(html, `${l}/${outcome}: opens safely in a new tab`).toMatch(/<a\b[^>]*target="_blank"[^>]*rel="noopener noreferrer"|<a\b[^>]*rel="noopener noreferrer"[^>]*target="_blank"/);
          expect(plain(html.match(/<a\b[^>]*>([\s\S]*?)<\/a>/)![1]!), `${l}: the link text`).toBe(dict["streaming.youtube.disconnect.googleLink"]);
        } else {
          expect(html, `${l}/${outcome}: no Google link where there is nothing to do there`).not.toContain(new URL(GOOGLE_THIRD_PARTY_ACCESS_URL).hostname);
        }
        sentences.add(plain(html));
        checked++;
      }
      expect(sentences.size, `${l}: three different sentences`).toBe(YOUTUBE_REVOKE_OUTCOMES.length);
    }
    expect(checked).toBe(LOCALES.length * YOUTUBE_REVOKE_OUTCOMES.length);
  });

  // Keys left on the channel (stg 2026-10-30, PO ruling): "deleted" must never be said while a Seazn key is still in the club's Studio. The
  // sentence LEADS with what is left and where to delete it - a count (Intl.PluralRules picks `.one` / `.other`, the repo's plural keys) or,
  // when the channel could not be read, "couldn't check" - and the grant's own outcome follows as a sentence of its own. Expected text is the
  // dictionaries' in every locale, the plural form chosen by the platform's CLDR rules - never read back from the component.
  const pluralOf = (dict: Record<string, string>, l: string, key: string, count: number) =>
    dict[`${key}.${new Intl.PluralRules(l).select(count)}`] ?? dict[`${key}.other`]!;
  const KEYS_STATES = [
    { keysLeft: 1, outcome: "revoked", tail: null },
    { keysLeft: 2, outcome: "revoked", tail: null },
    { keysLeft: null, outcome: "revoked", tail: null },
    { keysLeft: 1, outcome: "skipped_shared_account", tail: "streaming.youtube.disconnect.keysTail.shared" },
    { keysLeft: null, outcome: "not_confirmed", tail: "streaming.youtube.disconnect.keysTail.unconfirmed" },
  ] as const;

  it("keys left, in all four locales: the sentence says how many keys are still on the channel (or that Seazn couldn't check) and where to delete them - never the 'deleted' sentence - and the shared and not-confirmed outcomes still say theirs after it; an alert with its own marker (anti-vacuity: 5 states x 4 locales)", () => {
    let checked = 0;
    const perLocale = new Map<string, number>();
    for (const l of LOCALES) {
      const dict = localeDict(l);
      const sentences = new Set<string>();
      for (const st of KEYS_STATES) {
        const html = inLocale(l, <YoutubeDisconnectedNotice name="Riverside FC" outcome={st.outcome} keysLeft={st.keysLeft} onDismiss={() => {}} />);
        const where = `${l}/${st.outcome}/${st.keysLeft}`;
        const lead = (st.keysLeft === null ? dict["streaming.youtube.disconnect.keysUnchecked"]! : pluralOf(dict, l, "streaming.youtube.disconnect.keysLeft", st.keysLeft))
          .replaceAll("{name}", "Riverside FC").replaceAll("{count}", String(st.keysLeft));
        const tail = st.tail === null ? "" : ` ${dict[st.tail]!.replaceAll("{link}", dict["streaming.youtube.disconnect.googleLink"]!)}`;
        expect(plain(html), `${where}: the dictionary's sentence(s)`).toContain(`${lead}${tail}`);
        if (st.keysLeft !== null) expect(plain(html), `${where}: the count is in it`).toContain(String(st.keysLeft));
        for (const told of ["streaming.youtube.disconnect.done", "streaming.youtube.disconnect.doneShared", "streaming.youtube.disconnect.doneUnconfirmed"]) {
          expect(plain(html), `${where}: never "${told}"`).not.toContain(dict[told]!.replaceAll("{name}", "Riverside FC").split("{link}")[0]!.trim());
        }
        expect(html, `${where}: no placeholder left`).not.toMatch(/\{(name|count|link)\}/);
        expect(html, `${where}: an alert - there is something for the organiser to do`).toMatch(/role="alert"/);
        expect(html, `${where}: the outcome marker stands`).toContain(`data-outcome="${st.outcome}"`);
        expect(html, `${where}: the keys marker`).toContain(`data-keys-left="${st.keysLeft === null ? "unknown" : st.keysLeft}"`);
        const linked = html.includes(`href="${GOOGLE_THIRD_PARTY_ACCESS_URL}"`);
        expect(linked, `${where}: the Google link only where the revoke was not confirmed`).toBe(st.outcome === "not_confirmed");
        sentences.add(plain(html));
        checked++;
      }
      expect(sentences.size, `${l}: five different notices`).toBe(KEYS_STATES.length);
      perLocale.set(l, sentences.size);
    }
    expect(perLocale.size, "the new sentence rendered in every locale").toBe(4);
    expect(checked).toBe(LOCALES.length * KEYS_STATES.length);
  });

  it("keys left: the new sentences exist in every locale, are not the English in es/fr/nl, keep their slots, and the plural pair differs (one key vs several) - and nothing is left (0) is the plain 'deleted' sentence, the positive pair", () => {
    const slots: Record<string, string[]> = {
      "streaming.youtube.disconnect.keysLeft.one": ["{name}", "{count}"],
      "streaming.youtube.disconnect.keysLeft.other": ["{name}", "{count}"],
      "streaming.youtube.disconnect.keysUnchecked": ["{name}"],
      "streaming.youtube.disconnect.keysTail.shared": [],
      "streaming.youtube.disconnect.keysTail.unconfirmed": ["{link}"],
    };
    let checked = 0;
    for (const l of LOCALES) {
      const d = localeDict(l);
      for (const [k, want] of Object.entries(slots)) {
        const v = d[k];
        expect(v, `${l} ${k}`).toBeTypeOf("string");
        if (l !== "en") expect(v, `${l} ${k} is not the English`).not.toBe(localeDict("en")[k]);
        expect((v!.match(/\{\w+\}/g) ?? []).sort(), `${l} ${k}: its slots`).toEqual([...want].sort());
        checked++;
      }
      expect(d["streaming.youtube.disconnect.keysLeft.one"], `${l}: one key reads differently from several`).not.toBe(d["streaming.youtube.disconnect.keysLeft.other"]);
      const none = plain(inLocale(l, <YoutubeDisconnectedNotice name="Riverside FC" outcome="revoked" keysLeft={0} onDismiss={() => {}} />));
      expect(none, `${l}: nothing left is the plain sentence`).toContain(d["streaming.youtube.disconnect.done"]!.replaceAll("{name}", "Riverside FC"));
    }
    expect(checked).toBe(LOCALES.length * Object.keys(slots).length);
    // the English, typed from the PO ruling
    expect(m("streaming.youtube.disconnect.keysLeft.other", { name: "X", count: 2 })).toBe(
      "X is disconnected, but Seazn couldn't delete 2 stream keys from YouTube. Delete them in YouTube Studio → Go live → Stream → Manage stream keys.",
    );
  });

  it("F1: only the unconfirmed sentence says Google may still hold access, and only the shared one says why it stays (the English wording, typed from the ruling)", () => {
    expect(m("streaming.youtube.disconnect.doneShared", { name: "X" })).toMatch(/another channel on the same Google account is still connected/);
    expect(m("streaming.youtube.disconnect.doneUnconfirmed", { name: "X" })).toMatch(/couldn't confirm that Google removed Seazn's access/);
    expect(m("streaming.youtube.disconnect.done", { name: "X" })).not.toMatch(/Google/);
  });

  it("B6 batch review m5 / N5 + round 2 C5, in every locale: the in-use sentence says the channel is held by a match that is live OR ABOUT TO BE, and a few minutes after a stream stops; the shared-account sentence names the account that connected THIS channel, never 'your' account; the end-unknown sentence is a persistent fault - reported, contact support, no 'try again'", () => {
    // The wording each locale must carry (typed from the ruling), and the wording it must NOT: the old sentences' tell-tales.
    const want: Record<string, { inUse: RegExp; inUseAbout: RegExp; sharedNot: RegExp; unknownYes: RegExp; unknownNot: RegExp }> = {
      en: { inUse: /held for a few minutes/, inUseAbout: /live on this channel or about to be/, sharedNot: /your Google account/, unknownYes: /has been reported.*contact support/, unknownNot: /try again/i },
      es: { inUse: /unos minutos/, inUseAbout: /a punto de estarlo/, sharedNot: /tu cuenta de Google/, unknownYes: /comunicado.*soporte/, unknownNot: /Inténtalo/ },
      fr: { inUse: /quelques minutes/, inUseAbout: /sur le point de l’être/, sharedNot: /votre compte Google/, unknownYes: /signalé.*support/, unknownNot: /Réessayez/ },
      nl: { inUse: /enkele minuten/, inUseAbout: /op het punt te beginnen/, sharedNot: /je Google-account/, unknownYes: /gemeld.*support/, unknownNot: /Probeer het/ },
    };
    expect(m("streaming.youtube.disconnect.doneShared", { name: "X" })).toMatch(/the Google account that connected this channel/);
    let checked = 0;
    for (const l of LOCALES) {
      const w = want[l]!;
      const d = localeDict(l);
      expect(d["streaming.youtube.error.inUse"], `${l} inUse`).toMatch(w.inUse);
      expect(d["streaming.youtube.error.inUse"], `${l} inUse covers the match that is about to be live`).toMatch(w.inUseAbout);
      expect(d["streaming.youtube.disconnect.doneShared"], `${l} doneShared`).not.toMatch(w.sharedNot);
      expect(d["streaming.youtube.disconnect.doneShared"], `${l} doneShared keeps its slot`).toContain("{name}");
      expect(d["streaming.youtube.error.endUnknown"], `${l} endUnknown`).toMatch(w.unknownYes);
      expect(d["streaming.youtube.error.endUnknown"], `${l} endUnknown is not a retry`).not.toMatch(w.unknownNot);
      checked++;
    }
    expect(checked, "anti-vacuity: every locale judged").toBe(LOCALES.length);
    expect(Object.keys(want).sort(), "and the table covers exactly the locales there are").toEqual([...LOCALES].sort());
  });

  it("the new sentences exist in all four locales, keep their {name} slot where they have one, and are not the English in es/fr/nl", () => {
    const slotted: MessageKey[] = [
      "streaming.youtube.disconnect.title", "streaming.youtube.disconnect.done", "streaming.youtube.disconnect.doneShared", "streaming.youtube.disconnect.doneUnconfirmed",
    ];
    const plainKeys: MessageKey[] = [
      "streaming.youtube.action.disconnect", "streaming.youtube.disconnect.body", "streaming.youtube.disconnect.confirm", "streaming.youtube.error.inUse",
      "streaming.youtube.disconnectOnly.note", "streaming.youtube.disconnectOnly.none", "streaming.youtube.disconnect.googleLink", "streaming.youtube.error.endUnknown",
    ];
    let checked = 0;
    for (const l of LOCALES) {
      for (const k of [...slotted, ...plainKeys]) {
        const v = localeDict(l)[k];
        expect(v, `${l} ${k}`).toBeTypeOf("string");
        expect(v!.length, `${l} ${k} is not empty`).toBeGreaterThan(0);
        if (l !== "en") expect(v, `${l} ${k} is not the English`).not.toBe(localeDict("en")[k]);
        if (slotted.includes(k)) expect(v, `${l} ${k} keeps {name}`).toContain("{name}");
        else expect(v, `${l} ${k} has no stray slot`).not.toMatch(/[{}]/);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * (slotted.length + plainKeys.length));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the disconnect-only Streaming page (T18) - an org that can no longer go live can still disconnect", () => {
  const inUse409 = () => new HttpError(409, "A match is using this channel", "YOUTUBE_IN_USE");
  const two = (): StreamTarget[] => [
    channel({ connectionId: "c-1", channelTitle: "Riverside FC" }, { id: "t-1" }),
    channel({ connectionId: "c-2", channelTitle: "Riverside Juniors" }, { id: "t-2" }),
  ];
  const onlyHtml = (targets: StreamTarget[], locale = "en") =>
    inLocale(locale, <YoutubeDisconnectOnlyPanel orgId="o" targets={targets} />);
  const rowsOf = (panel: { tree: () => ReactElement[] }) => panel.tree().filter((el) => el.type === YoutubeChannelRow);

  it("renders the note and ONE disconnect-only row per channel - no Connect, Add, Settings, Reconnect, and no pasted key at all (even if one is handed in)", () => {
    const html = onlyHtml([...two(), pasted()]);
    expect(html.match(/data-testid="youtube-channel-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="youtube-disconnect"/g)).toHaveLength(2);
    expect(plain(html)).toContain("Matches can't go live from this organisation right now. You can still disconnect the YouTube channels below.");
    expect(plain(html)).toContain("Riverside FC");
    expect(plain(html)).toContain("Riverside Juniors");
    expect(plain(html), "a pasted destination is not this page's business").not.toContain("Club YouTube");
    for (const id of ["youtube-connect", "youtube-connect-empty", "stream-dest-add", "stream-dest-empty-add", "youtube-settings", "youtube-reconnect", "stream-dest-row", "stream-dest-empty"]) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
  });

  it("its note is the locale's own sentence in all four locales", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const html = onlyHtml(two(), l);
      expect(html, l).toContain(esc(localeDict(l)["streaming.youtube.disconnectOnly.note"]!));
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("each row is handed the restricted props (disconnectOnly, no re-read) - and driven through the REAL row, a disconnect removes just that channel, shows the news, and never re-reads the page", async () => {
    const panel = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: two() });
    expect(rowsOf(panel)).toHaveLength(2);
    for (const r of rowsOf(panel)) {
      expect(attr(r, "disconnectOnly")).toBe(true);
      expect(attr(r, "refreshAfter")).toBe(false);
      expect(attr(r, "canEdit")).toBe(true);
    }
    // the real row, mounted with exactly the props the panel gave the first channel
    const real = renderIsland(YoutubeChannelRow, propsOf(rowsOf(panel)[0]!) as never);
    await click(byTestId(real.tree(), "youtube-disconnect"));
    expect(apiCalls).toEqual([{ url: "/api/v1/orgs/o/youtube-connections/c-1", method: "DELETE", json: undefined }]);
    expect(rowsOf(panel).map((r) => attr(r, "t") as StreamTarget).map((t) => t.id), "only the other channel is left").toEqual(["t-2"]);
    expect(attr(ofType(panel.tree(), YoutubeDisconnectedNotice)!, "name")).toBe("Riverside FC");
    expect(nav.refresh, "the page is not re-read: the server would 404 an org with nothing left").not.toHaveBeenCalled();
  });

  it("F3: a channel that was already disconnected elsewhere (the DELETE answers 404) leaves the restricted page's list like a success - no dead row with an error, no re-read, no false 'disconnected' notice - and the LAST one leaves the empty line (anti-vacuity: both rows)", async () => {
    answerWith(async () => { throw await wire(new HttpError(404, "Not found")); });
    const panel = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: two() });
    expect(rowsOf(panel), "premise: two rows").toHaveLength(2);
    expect(attr(rowsOf(panel)[0]!, "onGone"), "the panel gives each row a way to drop itself").toBeTypeOf("function");

    const first = renderIsland(YoutubeChannelRow, propsOf(rowsOf(panel)[0]!) as never);
    await click(byTestId(first.tree(), "youtube-disconnect"));
    expect(apiCalls.map((c) => c.url), "the DELETE was tried").toEqual(["/api/v1/orgs/o/youtube-connections/c-1"]);
    expect(rowsOf(panel).map((r) => (attr(r, "t") as StreamTarget).id), "only the other channel is left").toEqual(["t-2"]);
    expect(byTestId(first.tree(), "youtube-error"), "no dead row with an error").toBeUndefined();
    expect(ofType(panel.tree(), YoutubeDisconnectedNotice), "this tab disconnected nothing: no notice").toBeUndefined();
    expect(nav.refresh, "a re-read of the last-channel page would 404").not.toHaveBeenCalled();

    const second = renderIsland(YoutubeChannelRow, propsOf(rowsOf(panel)[0]!) as never);
    await click(byTestId(second.tree(), "youtube-disconnect"));
    expect(rowsOf(panel)).toHaveLength(0);
    expect(byTestId(panel.tree(), "stream-disconnect-only-empty"), "the empty line").toBeDefined();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("F3: only a 404 drops the row - a 409 (a match is using it) and a dropped connection keep it and say why", async () => {
    let kept = 0;
    for (const [name, err] of [["409", () => wire(inUse409())], ["network", async () => new TypeError("Failed to fetch")]] as const) {
      answerWith(async () => { throw await err(); });
      const panel = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: two() });
      const real = renderIsland(YoutubeChannelRow, propsOf(rowsOf(panel)[0]!) as never);
      await click(byTestId(real.tree(), "youtube-disconnect"));
      expect(rowsOf(panel), name).toHaveLength(2);
      expect(byTestId(real.tree(), "youtube-error"), name).toBeDefined();
      kept++;
    }
    expect(kept).toBe(2);
  });

  it("F7: when the LAST channel has left, the page asks to re-render itself at the emptied URL (so its own nav stops offering a link that would 404, and the notice stays) - once, and not before; by a success and by a 404 alike", async () => {
    // a success on each of two rows: the first is not the last, the second is
    const panel = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: two() });
    (attr(rowsOf(panel)[0]!, "onDisconnected") as (n: { name: string; outcome: string }) => void)({ name: "Riverside FC", outcome: "revoked" });
    expect(nav.replace, "one channel is still there: stay where we are").not.toHaveBeenCalled();
    (attr(rowsOf(panel)[0]!, "onDisconnected") as (n: { name: string; outcome: string }) => void)({ name: "Riverside Juniors", outcome: "revoked" });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace, "the one href, from the constants").toHaveBeenCalledWith("/streaming?disconnected=1");
    expect(nav.refresh, "a re-read of the bare page would be the 404").not.toHaveBeenCalled();

    // the other tab already disconnected the last one: the same exit
    nav.replace.mockReset();
    const one = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: [two()[0]!] });
    (attr(rowsOf(one)[0]!, "onGone") as () => void)();
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith("/streaming?disconnected=1");

    // an empty list handed in from the server (we are ALREADY at the emptied URL, or the org never had one) navigates nowhere
    nav.replace.mockReset();
    renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: [] });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("N1: two disconnects in flight at once (each row's callback taken from the SAME render, as a click that began before the other finished holds it): whichever lands LAST empties the list, and the page asks to re-render itself exactly once - in either order, and for a success beside a 404", () => {
    type Done = (n: { name: string; outcome: string }) => void;
    let orders = 0;
    for (const order of [[0, 1], [1, 0]] as const) {
      nav.replace.mockReset();
      const panel = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: two() });
      const rows = rowsOf(panel);
      expect(rows, "premise: two rows").toHaveLength(2);
      const done = rows.map((r) => attr(r, "onDisconnected") as Done);   // both taken BEFORE either lands
      done[order[0]]!({ name: "A", outcome: "revoked" });
      expect(nav.replace, `${order}: one channel is still there`).not.toHaveBeenCalled();
      done[order[1]]!({ name: "B", outcome: "revoked" });
      expect(rowsOf(panel), `${order}: the list is empty`).toHaveLength(0);
      expect(nav.replace, `${order}: the last one to leave asked for the emptied page`).toHaveBeenCalledTimes(1);
      expect(nav.replace).toHaveBeenCalledWith("/streaming?disconnected=1");
      orders++;
    }
    // a success beside a 404 (the other tab disconnected one): the same exit
    nav.replace.mockReset();
    const panel = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: two() });
    const [first, second] = rowsOf(panel);
    const gone = attr(first!, "onGone") as () => void;
    const done = attr(second!, "onDisconnected") as (n: { name: string; outcome: string }) => void;
    gone();
    expect(nav.replace, "one left").not.toHaveBeenCalled();
    done({ name: "B", outcome: "revoked" });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(orders, "anti-vacuity: both orders ran").toBe(2);
  });

  it("the LAST channel leaves: an empty line instead of a list, the news stays, still no re-read (the empty case, then the sequence)", async () => {
    const panel = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: two() });
    (attr(rowsOf(panel)[0]!, "onDisconnected") as (n: { name: string; outcome: string }) => void)({ name: "Riverside FC", outcome: "revoked" });
    (attr(rowsOf(panel)[0]!, "onDisconnected") as (n: { name: string; outcome: string }) => void)({ name: "Riverside Juniors", outcome: "not_confirmed" });
    expect(rowsOf(panel)).toHaveLength(0);
    expect(textAt(panel.tree(), "stream-disconnect-only-empty")).toBe("No YouTube channels are connected.");
    expect(attr(ofType(panel.tree(), YoutubeDisconnectedNotice)!, "name"), "the latest news").toBe("Riverside Juniors");
    expect(attr(ofType(panel.tree(), YoutubeDisconnectedNotice)!, "outcome"), "and its outcome travels with it").toBe("not_confirmed");
    expect(byTestId(panel.tree(), "stream-disconnect-only-note"), "the note stays").toBeDefined();
    expect(nav.refresh).not.toHaveBeenCalled();
    // a list that holds only a pasted destination (the server never sends one) is an EMPTY list, not a list of one
    const pastedOnly = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: [pasted()] });
    expect(rowsOf(pastedOnly), "no row for a pasted destination").toHaveLength(0);
    expect(byTestId(pastedOnly.tree(), "stream-disconnect-only-empty"), "so the page says there is nothing to disconnect").toBeDefined();
    // and an empty list handed in from the server says the same, with no news
    const empty = renderIsland(YoutubeDisconnectOnlyPanel, { orgId: "o", targets: [] });
    expect(textAt(empty.tree(), "stream-disconnect-only-empty")).toBe(m("streaming.youtube.disconnectOnly.none"));
    expect(ofType(empty.tree(), YoutubeDisconnectedNotice)).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("T18: the archived label in a LIST that contains an archived row", () => {
  it("in every locale the list shows the locale's wording for the archived literal, never the English literal outside en; the customer's own label passes through (anti-vacuity: 4 locales)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const html = inLocale(
        l,
        <StreamDestinationsPanel
          orgId="o" canEdit locale={l}
          targets={[channel(), pasted({ id: "t-a", label: YOUTUBE_DISCONNECTED_LABEL }), pasted({ id: "t-b", label: "Club YouTube" })]}
        />,
      );
      expect(html.match(/data-testid="stream-dest-row"/g), `${l}: both pasted rows listed`).toHaveLength(2);
      expect(html, l).toContain(esc(localeDict(l)["streaming.youtube.disconnectedLabel"]!));
      if (l !== "en") expect(html, `${l}: no English literal`).not.toContain(YOUTUBE_DISCONNECTED_LABEL);
      expect(html, `${l}: the customer's own words`).toContain("Club YouTube");
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the archived 'disconnected' label is localized", () => {
  it("the database literal is the one the token store writes, and every locale has its own wording for it", () => {
    expect(YOUTUBE_DISCONNECTED_LABEL).toBe("YouTube channel (disconnected)");   // typed from the brief, not read back
    let checked = 0;
    for (const l of LOCALES) {
      const dict = localeDict(l);
      expect(dict["streaming.youtube.disconnectedLabel"], l).toBeTypeOf("string");
      expect(youtubeTargetLabel((k) => dict[k]!, YOUTUBE_DISCONNECTED_LABEL), l).toBe(dict["streaming.youtube.disconnectedLabel"]);
      if (l !== "en") expect(dict["streaming.youtube.disconnectedLabel"], `${l} is not the English`).not.toBe(YOUTUBE_DISCONNECTED_LABEL);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("any other label is the customer's own words and passes through untouched — including one that merely contains the literal", () => {
    const id = (k: MessageKey) => m(k);
    for (const label of ["Club YouTube", "", "YouTube channel (disconnected) 2", "my YouTube channel (disconnected)"]) {
      expect(youtubeTargetLabel(id, label), label).toBe(label);
    }
  });

  it("a destination row that carries the archived literal SHOWS the locale's wording (es), not the English", () => {
    const html = inLocale(
      "es",
      <ul><DestinationRow t={pasted({ label: YOUTUBE_DISCONNECTED_LABEL })} canEdit={false} locale="es" orgId="o" run={async () => ({ ok: true, value: null })} /></ul>,
    );
    expect(html).toContain(esc(localeDict("es")["streaming.youtube.disconnectedLabel"]!));
    expect(html).not.toContain(YOUTUBE_DISCONNECTED_LABEL);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the panel with YouTube Connect", () => {
  it("an editor with NO destinations: the empty card offers both ways in — Connect YouTube first, then Add streaming key (no YouTube mark on either)", () => {
    const html = panelHtml({ targets: [] });
    expect(html).toMatch(/data-testid="stream-dest-empty"[\s\S]*data-testid="youtube-connect-empty"[\s\S]*data-testid="stream-dest-empty-add"/);
    expect(plain(html)).toContain(m("streamDest.add"));
    expect(plain(html)).toContain(m("streamDest.empty"));
    expect(plain(html)).toContain(m("streaming.youtube.connect"));
    expect(html.match(/data-platform-mark="youtube"/g), "the Connect button wears no mark").toBeNull();
    expect(html.match(/data-youtube-icon="/g), "the Connect button draws no logo (a logo must be a link; a button is not one)").toBeNull();
    expect(m("streamDest.empty"), "the empty copy names the connect path too").toMatch(/Connect your YouTube channel/);
  });

  it("a viewer sees no way in at all (read-only), but the empty card still renders", () => {
    const html = panelHtml({ targets: [], canEdit: false });
    expect(html).toContain('data-testid="stream-dest-empty"');
    for (const id of ["stream-dest-empty-add", "youtube-connect-empty", "youtube-connect", "stream-dest-add"]) expect(html, id).not.toContain(`data-testid="${id}"`);
  });

  // Owner 2026-10-30: Connect YouTube is the primary way in and comes FIRST; adding a pasted key is the secondary one. Both places that offer
  // the pair (the header row over a list, the empty card) — so a fix to one cannot leave the other behind.
  it("Connect YouTube is the primary button and comes first; Add streaming key is the secondary one after it — in the header row AND the empty card", () => {
    const classesOf = (html: string, testid: string): string[] => {
      const tag = new RegExp(`<button\\b[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0];
      expect(tag, `${testid} renders`).toBeDefined();
      return (/\bclass="([^"]*)"/.exec(tag!)?.[1] ?? "").split(/\s+/).filter(Boolean);
    };
    const places = [
      { where: "header row", targets: [pasted()], connect: "youtube-connect", add: "stream-dest-add", absent: "youtube-connect-empty" },
      { where: "empty card", targets: [], connect: "youtube-connect-empty", add: "stream-dest-empty-add", absent: "youtube-connect" },
    ];
    let checked = 0;
    for (const p of places) {
      const html = panelHtml({ targets: p.targets });
      const connect = classesOf(html, p.connect);
      const add = classesOf(html, p.add);
      expect(connect, `${p.where}: Connect YouTube is primary`).toContain("btn-primary");
      expect(connect, `${p.where}: Connect YouTube is not the ghost`).not.toContain("btn-ghost");
      expect(add, `${p.where}: Add streaming key is the ghost`).toContain("btn-ghost");
      expect(add, `${p.where}: Add streaming key is not primary`).not.toContain("btn-primary");
      expect(html.indexOf(`data-testid="${p.connect}"`), `${p.where}: Connect YouTube comes before Add streaming key`).toBeLessThan(html.indexOf(`data-testid="${p.add}"`));
      expect(html, `${p.where}: only this place's pair renders`).not.toContain(`data-testid="${p.absent}"`);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the Add button's label names a streaming key in every locale, in the same noun the YouTube stream-key title already uses (es/fr/nl)", () => {
    // English is the owner's own wording (2026-10-30), "streaming key"; the shipped English title says "stream key", so en is pinned to the
    // ruling and the other three to their title's noun (the title is "Seazn Club · <noun> {n}").
    expect(m("streamDest.add")).toMatch(/\bstreaming key\b/i);
    let checked = 0;
    for (const l of ["es", "fr", "nl"] as const) {
      const d = localeDict(l);
      const noun = /·\s*(.+?)\s*\{n\}/.exec(d["streaming.youtube.streamKeyTitle"]!)?.[1];
      expect(noun, `${l}: the stream-key title carries a noun`).toBeTruthy();
      expect(d["streamDest.add"]!.toLowerCase(), l).toContain(noun!.toLowerCase());
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("connected channels and pasted keys list in two groups, channels first, each under a heading ONLY when both kinds are present", () => {
    const both = panelHtml({ targets: [pasted(), channel()] });
    const channelsHeading = `<h2 class="mb-2 text-sm font-semibold text-slate-700">${m("streaming.youtube.channels")}</h2>`;
    const keysHeading = `<h2 class="mb-2 text-sm font-semibold text-slate-700">${m("streaming.keys.heading")}</h2>`;
    expect(both).toContain(channelsHeading);
    expect(both).toContain(keysHeading);
    expect(both.indexOf(channelsHeading)).toBeLessThan(both.indexOf('data-testid="youtube-channel-row"'));
    expect(both.indexOf('data-testid="youtube-channel-row"')).toBeLessThan(both.indexOf(keysHeading));
    expect(both.indexOf(keysHeading)).toBeLessThan(both.indexOf('data-testid="stream-dest-row"'));
    for (const only of [[channel()], [pasted()]]) {
      const html = panelHtml({ targets: only });
      expect(html).not.toContain(channelsHeading);
      expect(html).not.toContain(keysHeading);
    }
  });

  it("a row is a channel row or a pasted row by what it CARRIES (`youtube`), never by its kind — swept over every stored kind", () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      const asKey = panelHtml({ targets: [pasted({ kind })] });
      expect(asKey, `${kind} without a connection`).toContain('data-testid="stream-dest-row"');
      expect(asKey, `${kind} without a connection`).not.toContain('data-testid="youtube-channel-row"');
      const asChannel = panelHtml({ targets: [channel({}, { kind })] });
      expect(asChannel, `${kind} with a connection`).toContain('data-testid="youtube-channel-row"');
      expect(asChannel, `${kind} with a connection`).not.toContain('data-testid="stream-dest-row"');
      checked++;
    }
    expect(checked).toBe(StreamTargetKind.options.length);
  });

  it("Add streaming key and Connect YouTube are one form at a time: opening either closes the other (driven)", async () => {
    const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [pasted()], locale: "en" });
    const has = () => ({ add: !!ofType(panel.tree(), AddForm), connect: !!ofType(panel.tree(), YoutubeConnectCard) });
    expect(has()).toEqual({ add: false, connect: false });
    await click(byTestId(panel.tree(), "youtube-connect"));
    expect(has()).toEqual({ add: false, connect: true });
    await click(byTestId(panel.tree(), "stream-dest-add"));
    expect(has()).toEqual({ add: true, connect: false });
    await click(byTestId(panel.tree(), "youtube-connect"));
    expect(has()).toEqual({ add: false, connect: true });
    await click(byTestId(panel.tree(), "youtube-connect"));
    expect(has(), "the same button closes it again").toEqual({ add: false, connect: false });
  });

  it("the empty card's own buttons behave the same: opening one removes THAT button and keeps the other", async () => {
    const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [], locale: "en" });
    await click(byTestId(panel.tree(), "youtube-connect-empty"));
    expect(ofType(panel.tree(), YoutubeConnectCard)).toBeDefined();
    expect(byTestId(panel.tree(), "youtube-connect-empty")).toBeUndefined();
    expect(byTestId(panel.tree(), "stream-dest-empty-add")).toBeDefined();
    await click(byTestId(panel.tree(), "stream-dest-empty-add"));
    expect(ofType(panel.tree(), YoutubeConnectCard)).toBeUndefined();
    expect(byTestId(panel.tree(), "stream-dest-empty-add")).toBeUndefined();
    expect(byTestId(panel.tree(), "youtube-connect-empty")).toBeDefined();
  });

  describe("what the connect round trip landed with", () => {
    const tree = (p: { landing: Parameters<typeof StreamDestinationsPanel>[0]["landing"]; canEdit?: boolean; targets?: StreamTarget[] }) =>
      renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: p.canEdit ?? true, targets: p.targets ?? [], locale: "en", landing: p.landing }).tree();

    it("a banner code shows its banner — to editors AND viewers (everyone who can see the page is told what happened)", () => {
      let checked = 0;
      for (const canEdit of [true, false]) {
        for (const code of YOUTUBE_LANDING_CODES.filter((c) => c !== "pick")) {
          const banner = tree({ landing: { code, pendingId: null }, canEdit }).find((el) => el.type === YoutubeLandingNotice);
          expect(banner, `${code}/${canEdit}`).toBeDefined();
          expect(attr(banner!, "code")).toBe(code);
          checked++;
        }
      }
      expect(checked, "eleven banner codes x editor and viewer").toBe(22);
    });

    it("a pick opens the picker for THIS pending grant — for an editor only; a viewer gets neither picker nor banner", () => {
      const pick = { code: "pick" as const, pendingId: PENDING };
      const editor = tree({ landing: pick });
      expect(attr(editor.find((el) => el.type === YoutubeChannelPicker)!, "pendingId")).toBe(PENDING);
      expect(attr(editor.find((el) => el.type === YoutubeChannelPicker)!, "orgId")).toBe("o");
      expect(editor.find((el) => el.type === YoutubeLandingNotice), "a pick is not a banner").toBeUndefined();
      const viewer = tree({ landing: pick, canEdit: false });
      expect(viewer.find((el) => el.type === YoutubeChannelPicker)).toBeUndefined();
      expect(viewer.find((el) => el.type === YoutubeLandingNotice)).toBeUndefined();
    });

    it("a pick with no pending grant opens nothing; no landing shows neither banner nor picker (the empty case)", () => {
      for (const landing of [{ code: "pick" as const, pendingId: null }, null, undefined]) {
        const t = tree({ landing });
        expect(t.find((el) => el.type === YoutubeChannelPicker), String(landing?.code)).toBeUndefined();
        expect(t.find((el) => el.type === YoutubeLandingNotice), String(landing?.code)).toBeUndefined();
      }
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the copy", () => {
  const SOURCE = readFileSync(join(__dirname, "..", "youtube-connect-panel.tsx"), "utf8");
  const PANEL_SOURCE = readFileSync(join(__dirname, "..", "stream-destinations-panel.tsx"), "utf8");
  const NEW_KEYS = Object.keys(messages).filter((k) => k.startsWith("streaming.youtube.") || k === "streaming.keys.heading");
  const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();

  it("every new key exists in all four locales, non-empty, with the SAME {slots} as the English (a translation that dropped {count} or {tos} fails here)", () => {
    expect(NEW_KEYS.length, "the sweep has something to sweep").toBeGreaterThan(55);
    let checked = 0;
    for (const l of LOCALES) {
      const dict = localeDict(l);
      for (const k of NEW_KEYS) {
        expect(dict[k], `${l} ${k}`).toBeTypeOf("string");
        expect(dict[k]!.trim().length, `${l} ${k}`).toBeGreaterThan(0);
        expect(slots(dict[k]!), `${l} ${k} slots`).toEqual(slots((messages as Record<string, string>)[k]!));
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * NEW_KEYS.length);
  });

  it("every dictionary key the YouTube UI reads exists (a key typed here and not added would render as the raw key)", () => {
    const used = new Set([...(SOURCE + PANEL_SOURCE).matchAll(/"((?:streaming\.youtube|streaming\.keys)\.[A-Za-z_.]+)"/g)].map((x) => x[1]!));
    expect(used.size, "the scan found keys").toBeGreaterThan(40);
    let checked = 0;
    let plurals = 0;
    for (const k of used) {
      const dict = messages as Record<string, string>;
      // A key read through the plural helper (`useMsgPlural`) is a BASE: it resolves to `<base>.<CLDR category>`, falling back to
      // `<base>.other`, which must therefore exist (lib/i18n-runtime.ts `plural`).
      if (dict[k] === undefined && typeof dict[`${k}.other`] === "string") {
        expect(dict[`${k}.one`], `${k}: a plural base has its singular`).toBeTypeOf("string");
        plurals++;
      } else expect(dict[k], k).toBeTypeOf("string");
      checked++;
    }
    expect(checked).toBe(used.size);
    expect(plurals, "the one plural base the notice reads (keys left)").toBe(1);
  });

  it("the user-visible strings in the new component are all dictionary keys: no English sentence is hardcoded in its JSX", () => {
    // A JSX text node or a string prop that reads as a sentence: letters and spaces, a capital first, 3+ words.
    const sentences = [...SOURCE.matchAll(/>\s*([A-Z][A-Za-z']+(?: [A-Za-z']+){2,}[.!?]?)\s*</g)].map((x) => x[1]);
    expect(sentences, "hardcoded English in JSX").toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// T12 polish (owner-approved 2026-10-28, from the B3 sign-off): four things the owner saw on the Streaming page.
describe("T12 polish: the Streaming page", () => {
  const tokens = (html: string, testid: string): string[] => {
    const tag = new RegExp(`<[a-z]+\\b[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? "";
    return (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
  };

  it("1. every secondary action on a channel row reads as a BUTTON at rest (house `btn-ghost`: border and fill), never bare text — across every state", () => {
    // The rows that carry a secondary action: Settings always; Review terms when the terms moved on (primary only when it must be first).
    const states: [string, Partial<View>][] = [
      ["connected", {}],
      ["reconnect needed", { status: "reconnect_needed" }],
      ["terms moved on", { termsOutdated: true }],
      ["dead grant AND terms moved on", { status: "reconnect_needed", termsOutdated: true }],
    ];
    let checked = 0;
    for (const [name, y] of states) {
      const html = rowHtml(channel(y));
      for (const id of ["youtube-settings", "youtube-review-terms", "youtube-reconnect"]) {
        if (!html.includes(`data-testid="${id}"`)) continue;
        const t = tokens(html, id);
        // Primary or ghost — either way a filled or bordered control. A bare `btn` is the plain text the owner rejected.
        expect(t.includes("btn-ghost") || t.includes("btn-primary"), `${name}: ${id} is a button at rest (${t.join(" ")})`).toBe(true);
        checked++;
      }
      expect(tokens(html, "youtube-settings"), `${name}: Settings is the quiet one, not the loud one`).not.toContain("btn-primary");
    }
    expect(checked, "anti-vacuity: the actions that exist across the four states (Settings; Reconnect + Settings; Review + Settings; Review + Settings)").toBe(1 + 2 + 2 + 2);
    // Review terms is the loud one ONLY while the dead grant needs it first.
    expect(tokens(rowHtml(channel({ termsOutdated: true })), "youtube-review-terms")).toContain("btn-ghost");
    expect(tokens(rowHtml(channel({ status: "reconnect_needed", termsOutdated: true })), "youtube-review-terms")).toContain("btn-primary");
  });

  it("2. the empty card hides its Connect YouTube while the channel picker is open (one way in), and shows it everywhere else", () => {
    const picking = panelHtml({ targets: [], landing: { code: "pick", pendingId: PENDING } });
    expect(picking, "the picker is the way in").toContain('data-testid="youtube-picker"');
    expect(picking, "no second Connect YouTube beside it").not.toContain('data-testid="youtube-connect-empty"');
    expect(picking, "Add streaming key is untouched").toContain('data-testid="stream-dest-empty-add"');
    // The positive pairs: no landing, and a landing that is not a pick, both still offer it.
    expect(panelHtml({ targets: [] })).toContain('data-testid="youtube-connect-empty"');
    expect(panelHtml({ targets: [], landing: { code: "connected", pendingId: null } })).toContain('data-testid="youtube-connect-empty"');
    // A viewer cannot pick, so nothing opens and nothing is hidden.
    expect(panelHtml({ targets: [], canEdit: false, landing: { code: "pick", pendingId: PENDING } })).not.toContain('data-testid="youtube-picker"');
  });

  it("3. the landing banner centres its sentence against Dismiss from 768 up (md:items-center) and stays a stacked column on a phone, for EVERY code", () => {
    // Every landing the banner has a sentence for: all but `pick`, which opens the picker instead.
    const bannerCodes = YOUTUBE_LANDING_CODES.filter((c) => c !== "pick");
    let checked = 0;
    for (const code of bannerCodes) {
      const t = tokens(renderToStaticMarkup(<YoutubeLandingNotice code={code} />), "youtube-landing");
      expect(t, `${code}: centred beside the button from md`).toContain("md:items-center");
      expect(t, `${code}: phone stacks`).toContain("max-md:flex-col");
      expect(t, `${code}: the phone's alignment is untouched`).toContain("items-start");
      checked++;
    }
    expect(checked, "every banner code").toBe(bannerCodes.length);
    expect(checked).toBe(11);
  });

  it("4. the logo appears ONLY as the channel row's link: the pasted-key row wears the neutral tile, the Connect buttons wear nothing", () => {
    const html = panelHtml({ targets: [channel(), pasted()] });
    // One logo on the page: the channel row's. It is inside an anchor to the channel.
    expect(html.match(/data-youtube-icon="/g), "the channel row's logo, and no other").toHaveLength(1);
    expect(html).toMatch(new RegExp(`<a\\b[^>]*href="https://www\\.youtube\\.com/channel/${CHANNEL_ID}"[^>]*><svg[^>]*data-youtube-icon="md"`));
    // The pasted row keeps its alignment with a neutral tile (one platform mark on the page: the pasted row's).
    expect(html.match(/data-platform-mark="youtube"/g), "the pasted-key row's neutral tile").toHaveLength(1);
    const pastedRow = /<li data-testid="stream-dest-row"[\s\S]*?<\/li>/.exec(html)![0];
    expect(pastedRow).toContain('data-platform-mark="youtube"');
    expect(pastedRow, "the pasted row draws no logo").not.toContain("data-youtube-icon");
    // The toolbar's Connect YouTube: words only.
    const connect = /<button[^>]*data-testid="youtube-connect"[^>]*>[\s\S]*?<\/button>/.exec(html)![0];
    expect(connect).toContain(m("streaming.youtube.connect"));
    expect(connect, "no mark in the Connect button").not.toMatch(/data-platform-mark|data-youtube-icon|<svg/);
    // The empty card's Connect: the same.
    const empty = panelHtml({ targets: [] });
    expect(empty.match(/data-youtube-icon="/g)).toBeNull();
    expect(/<button[^>]*data-testid="youtube-connect-empty"[^>]*>[\s\S]*?<\/button>/.exec(empty)![0]).not.toMatch(/data-platform-mark|data-youtube-icon|<svg/);
  });

  it("4b. every channel row is its own link, to its own channel (two channels: two links, two ids)", () => {
    const other = "UCq8Zp3nW2yHcB6vTdR4eXjA";
    const html = panelHtml({
      targets: [channel({}, { id: "t-a" }), channel({ connectionId: "c-2", channelId: other, channelTitle: "Riverside Juniors" }, { id: "t-b", label: "Riverside Juniors" })],
    });
    const hrefs = [...html.matchAll(/<a\b[^>]*href="(https:\/\/www\.youtube\.com\/[^"]+)"[^>]*><svg/g)].map((x) => x[1]);
    expect(hrefs, "one logo link per channel row, each to that row's channel").toEqual([
      `https://www.youtube.com/channel/${CHANNEL_ID}`,
      `https://www.youtube.com/channel/${other}`,
    ]);
    const labels = [...html.matchAll(/<a\b[^>]*aria-label="([^"]+)"[^>]*><svg/g)].map((x) => x[1]);
    expect(labels).toEqual(["Riverside FC on YouTube", "Riverside Juniors on YouTube"]);
  });

  it("4c. the link's accessible name is in the viewer's language (es/fr/nl carry the channel's name too)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const html = renderToStaticMarkup(
        <DictProvider dict={localeDict(l) as unknown as Dict} locale={l}><ul><YoutubeChannelRow t={channel()} canEdit orgId="o" badge={null} /></ul></DictProvider>,
      );
      const label = /<a\b[^>]*aria-label="([^"]+)"[^>]*><svg/.exec(html)?.[1];
      expect(label, l).toBe(esc(localeDict(l)["streaming.youtube.channelLink"]!.replace("{name}", "Riverside FC")));
      expect(label, `${l}: names the channel and YouTube`).toMatch(/Riverside FC/);
      expect(label, `${l}: names YouTube`).toMatch(/YouTube/);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(LOCALES.length).toBe(4);
  });
});
