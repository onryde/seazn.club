// Directory → Streaming (spec 2026-09-30 §4, owner rulings D1 D2 D6).
//
// `apps/web` vitest is `environment: "node"` — NO DOM. Three layers, each proven where it CAN be (AGENTS.md classes 1
// and 2):
//   * the whole panel as MARKUP (`renderToStaticMarkup` inside the page's DictProvider) — which controls exist for whom,
//     what each row says, which class each twin carries;
//   * the islands DRIVEN (`renderIsland`, the repo's hook harness) — `AddForm`, `DestinationRow` and the panel's own
//     `run` — with the v1 transport, the confirm dialog and the router doubled, so the path each action calls, the body
//     it sends and what a refusal leaves on screen are pinned rather than guessed;
//   * the error map off the REAL wire: each refusal is the server's own error (its class or its code constant), sent
//     through the real v1 envelope (`v1()`) and the real client transport (`apiV1`), exactly as the tab receives it.
// What none of this can see — layout, the cascade, real tap area, a real server — is the walkthrough
// `e2e/walkthrough/directory-stream-destinations.spec.ts`.
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): a destination reads no sport. The "another platform" axis is swept
// instead — every create platform (STREAM_PLATFORMS) and every stored legacy kind (StreamTargetKind minus them).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ZodError } from "zod";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ApiV1Error } from "@/lib/client-v1";
import { HttpError } from "@/lib/errors";
import { messages, type MessageKey } from "@/lib/messages";
import type { Dict } from "@/lib/i18n-constants";
import {
  DESTINATION_LABEL_EMPTY, STREAM_KEY_EMPTY, STREAM_PLATFORMS, isStreamPlatform,
} from "@/lib/stream-destinations";
import { v1, parseBody } from "@/server/api-v1/http";
import { CreateStreamTarget, StreamTargetKind, StreamTargetSaveOutcome, type StreamTarget, type StreamTargetSaved } from "@/server/api-v1/schemas";
import { DestinationNotAllowedError, TargetUnreadableError, targetHeld } from "@/server/usecases/stream-targets";
import type { TargetHolder } from "@/server/usecases/stream-target-holders";
import { STREAM_KIND_BRAND, STREAM_MARK_KINDS, platformName } from "../stream-platform-mark";
import {
  AddForm, DestinationRow, StreamDestinationsPanel, destinationErrorText, destinationMutationOutcome, rowLock,
} from "../stream-destinations-panel";

// ─── doubles ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// The REAL `ApiV1Error` class (the one `apiV1` throws); only the transport is doubled. `realApiV1` is kept for `wire`.
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
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/directory",
  useSearchParams: () => new URLSearchParams("tab=streaming"),
}));
const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));

beforeEach(() => {
  apiCalls.length = 0;
  refresh.mockReset();
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => true);
  transport.impl = async (url, opts) => {
    apiCalls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
    return {};
  };
});
afterEach(() => vi.restoreAllMocks());

// ─── builders ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const target = (over: Partial<StreamTarget> = {}): StreamTarget => ({
  id: "t1", kind: "youtube", label: "Club YouTube", watchUrl: null, createdAt: "2026-09-12T10:00:00.000Z",
  keyHint: "8hd", inUse: null, ...over,
});
const live = { sessionId: "s", fixtureId: "f", href: "/o/a/c/b/d/c/f/5", matchNo: 5, courtName: "Court 1", state: "live" as const };

/** A sentence as the English catalog renders it, `{var}` filled — the copy a customer reads. */
const m = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), messages[k] as string);
const matchOf = (no: number) => m("breadcrumb.match", { no });

/** React's HTML escaping, so a sentence can be looked for inside markup. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function panelHtml({ targets, canEdit = true, addOpen = false }: { targets: StreamTarget[]; canEdit?: boolean; addOpen?: boolean }): string {
  return renderToStaticMarkup(
    <DictProvider dict={messages as unknown as Dict} locale="en">
      <StreamDestinationsPanel orgId="o" canEdit={canEdit} targets={targets} locale="en" initialAddOpen={addOpen} />
    </DictProvider>,
  );
}

const attr = (el: ReactElement, name: string): unknown => propsOf(el)[name];
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined => tree.find((el) => attr(el, "data-testid") === id);
const allByTestId = (tree: ReactElement[], id: string): ReactElement[] => tree.filter((el) => attr(el, "data-testid") === id);
const textAt = (tree: ReactElement[], id: string): string => {
  const el = byTestId(tree, id);
  if (!el) throw new Error(`no ${id} in the tree`);
  return textOf(el).replace(/\s+/g, " ").trim();
};
const click = async (el: ReactElement | undefined): Promise<void> => {
  const onClick = el && (propsOf(el).onClick as ((e?: unknown) => unknown) | undefined);
  if (!onClick) throw new Error("no onClick on that element — the test is asserting nothing");
  await onClick({ preventDefault: () => {}, stopPropagation: () => {} });
  await settle();
};
const type = (tree: ReactElement[], id: string, value: string): void => {
  const el = byTestId(tree, id);
  if (!el) throw new Error(`no ${id} to type into`);
  (propsOf(el).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A refusal exactly as the tab receives it: the server's own error through the real v1 envelope and the real client
 *  transport (the stream-session-view.test.ts `wire` pattern). */
async function wire(err: unknown): Promise<ApiV1Error> {
  const res = await v1(async () => { throw err; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
  const saved = transport.impl;
  transport.impl = null; // the REAL apiV1 for this one call
  try {
    const { apiV1 } = await import("@/lib/client-v1");
    await apiV1("/api/v1/orgs/o/stream-targets/t1", { method: "PATCH", json: {} });
  } catch (caught) {
    expect(caught).toBeInstanceOf(ApiV1Error);
    return caught as ApiV1Error;
  } finally {
    transport.impl = saved;
    fetchSpy.mockRestore();
  }
  throw new Error("apiV1 resolved on an error response");
}

const holder = (over: Partial<TargetHolder> = {}): TargetHolder => ({
  sessionId: "s", targetId: "t1", fixtureId: "f", href: "/o/a/c/b/d/c/f/5", matchNo: 5, courtName: "Court 1",
  label: "Club YouTube", state: "live", ...over,
});
/** The route's own 400: a body its schema refuses, through the real `parseBody`. */
async function schemaRefusal(body: unknown): Promise<unknown> {
  try {
    await parseBody(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), CreateStreamTarget);
  } catch (e) {
    expect(e).toBeInstanceOf(ZodError);
    return e;
  }
  throw new Error("the schema accepted the body");
}

const LEGACY_KINDS = StreamTargetKind.options.filter((k) => !isStreamPlatform(k));

// ─── the whole panel as markup ────────────────────────────────────────────────────────────────────────────────────────
describe("the Directory Streaming tab (spec §4)", () => {
  it("a row: platform mark, name, and the subline '{Platform} · key ends …{hint} · added {date}'", () => {
    const html = panelHtml({ targets: [target()] });
    expect(html).toMatch(/data-testid="stream-dest-subline"[^>]*>YouTube · key ends …8hd · added 12 Sept?</);
    expect(html).toMatch(/data-platform-mark="youtube"/);
    expect(html).toMatch(/data-testid="stream-dest-row"[^>]*data-target-id="t1"/);
  });

  it("no key hint from the server (a short key, or one that will not open): the subline says nothing about the key (never '…null')", () => {
    const html = panelHtml({ targets: [target({ keyHint: null })] });
    expect(html).not.toMatch(/key ends/);
    expect(html).not.toMatch(/null|undefined/);
    expect(html).toMatch(/data-testid="stream-dest-subline"[^>]*>YouTube · added /);
  });

  it("in use: a badge per state that LINKS to the holding match; Replace key and Remove locked with 'Stop Match {n} first'; Rename stays enabled", () => {
    let checked = 0;
    for (const state of ["live", "waiting"] as const) {
      const html = panelHtml({ canEdit: true, targets: [target({ inUse: { ...live, state } })] });
      const badges = html.match(/<a [^>]*data-testid="stream-dest-badge"[^>]*>/g) ?? [];
      expect(badges.length, `${state}: the phone and the desktop badge`).toBe(2);
      for (const b of badges) {
        expect(b, state).toContain(`data-state="${state}"`);
        expect(b, state).toContain('href="/o/a/c/b/d/c/f/5"');
      }
      const badgeText = m(state === "live" ? "streamDest.badge.live" : "streamDest.badge.waiting", { match: matchOf(5) });
      expect(html, state).toContain(esc(badgeText));
      expect(html, state).toMatch(/data-testid="stream-dest-replace"[^>]*aria-disabled="true"/);
      expect(html, state).toMatch(/data-testid="stream-dest-remove"[^>]*aria-disabled="true"/);
      expect(html, state).not.toMatch(/data-testid="stream-dest-rename"[^>]*aria-disabled="true"/);
      expect(html, state).toContain(esc(m("streamDest.stopFirst", { match: matchOf(5) })));
      expect(html, state).toMatch(/data-testid="stream-dest-remove"[^>]*title="Stop Match 5 first"/);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the positive pair: a destination nothing holds has no badge and no lock", () => {
    const html = panelHtml({ canEdit: true, targets: [target()] });
    expect(html).not.toMatch(/data-testid="stream-dest-badge"/);
    expect(html).not.toMatch(/aria-disabled="true"/);
    expect(html).not.toContain(esc(m("streamDest.stopFirst", { match: matchOf(5) })));
  });

  it("a holder whose fixture was deleted (matchNo and href null): a badge that is NOT a link, 'another match', and a lock that names no match", () => {
    const html = panelHtml({ targets: [target({ inUse: { ...live, matchNo: null, href: null, fixtureId: null } })] });
    expect(html).not.toMatch(/<a [^>]*data-testid="stream-dest-badge"/);
    expect(html).toMatch(/<span [^>]*data-testid="stream-dest-badge"[^>]*data-state="live"/);
    expect(html).toContain(esc(m("streamDest.badge.live", { match: m("streamDest.anotherMatch") })));
    expect(html).toContain(esc(m("streamDest.stopFirstUnnamed")));
    expect(html).toMatch(/data-testid="stream-dest-remove"[^>]*aria-disabled="true"/);
    expect(html).not.toMatch(/Match null|null/);
  });

  it("a viewer who cannot edit sees the list and NO action and no Add", () => {
    const html = panelHtml({ canEdit: false, targets: [target()] });
    expect(html).toMatch(/data-testid="stream-dest-row"/);
    for (const id of ["stream-dest-add", "stream-dest-rename", "stream-dest-replace", "stream-dest-remove", "stream-dest-menu"]) {
      expect(html, id).not.toMatch(new RegExp(`data-testid="${id}"`));
    }
    // The positive twin: an editor sees every one of them.
    const editor = panelHtml({ canEdit: true, targets: [target()] });
    for (const id of ["stream-dest-add", "stream-dest-rename", "stream-dest-replace", "stream-dest-remove", "stream-dest-menu"]) {
      expect(editor, id).toMatch(new RegExp(`data-testid="${id}"`));
    }
  });

  it("empty: the empty state with Add for an editor; the positive twin renders no empty state", () => {
    expect(panelHtml({ canEdit: true, targets: [] })).toMatch(/data-testid="stream-dest-empty"[\s\S]*data-testid="stream-dest-empty-add"/);
    expect(panelHtml({ canEdit: true, targets: [] })).toContain(esc(m("streamDest.empty")));
    expect(panelHtml({ canEdit: false, targets: [] })).toMatch(/data-testid="stream-dest-empty"/);
    expect(panelHtml({ canEdit: false, targets: [] })).not.toMatch(/data-testid="stream-dest-empty-add"/);
    expect(panelHtml({ canEdit: true, targets: [target()] })).not.toMatch(/data-testid="stream-dest-empty"/);
  });

  it("the phone ⋯ menu is a 44px md:hidden button; the desktop actions are max-md:hidden", () => {
    const html = panelHtml({ canEdit: true, targets: [target()] });
    expect(html).toMatch(/data-testid="stream-dest-menu"[^>]*class="[^"]*\sh-11 w-11\s[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-role="stream-dest-actions"[^>]*class="[^"]*\smax-md:hidden"/);
    expect(html).toMatch(new RegExp(`data-testid="stream-dest-menu"[^>]*aria-label="${esc(m("streamDest.more", { label: "Club YouTube" }))}"`));
  });

  it("every stored LEGACY kind lists with its own name and mark, keeps Remove, and never says to add it again; the add form offers ONLY the create platforms", () => {
    let checked = 0;
    for (const kind of LEGACY_KINDS) {
      const html = panelHtml({ canEdit: true, targets: [target({ kind, label: `Old ${kind}` })], addOpen: true });
      expect(html, kind).toContain(`${esc(platformName(m, kind))} · key ends …8hd`);
      expect(html, kind).toMatch(new RegExp(`data-platform-mark="${kind}"`));
      expect(html, kind).toMatch(/data-testid="stream-dest-remove"/);
      expect(html.match(/data-testid="stream-dest-platform-[a-z_]+"/g), kind).toEqual(STREAM_PLATFORMS.map((p) => `data-testid="stream-dest-platform-${p}"`));
      expect(html, kind).not.toMatch(/again/i);
      checked++;
    }
    expect(checked).toBe(LEGACY_KINDS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every kind the DB can hold has a mark and a name (every stored kind lists, spec §5.4)", () => {
    expect([...STREAM_MARK_KINDS].sort()).toEqual([...StreamTargetKind.options].sort());
    let named = 0;
    for (const kind of StreamTargetKind.options) {
      expect(platformName(m, kind), kind).toBe(kind === "custom_rtmp" ? m("stream.target.kind.other") : STREAM_KIND_BRAND[kind]);
      named++;
    }
    expect(named).toBe(StreamTargetKind.options.length);
  });

  it("the add form: a segmented platform choice opening at the first platform, name ≤ 80, a password key with Show, an optional watch link — and NO server field (spec §4, D6)", () => {
    const html = panelHtml({ canEdit: true, targets: [], addOpen: true });
    expect(html).toMatch(/data-testid="stream-dest-form"/);
    expect(html).toMatch(new RegExp(`data-testid="stream-dest-platform-${STREAM_PLATFORMS[0]}"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="stream-dest-platform-${STREAM_PLATFORMS[0]}"`));
    expect(html).toMatch(/data-testid="stream-dest-name"[^>]*maxLength="80"|maxLength="80"[^>]*data-testid="stream-dest-name"/i);
    expect(html).toMatch(/data-testid="stream-dest-key"[^>]*type="password"|type="password"[^>]*data-testid="stream-dest-key"/);
    expect(html).toMatch(/data-testid="stream-dest-key-show"/);
    expect(html).toMatch(/data-testid="stream-dest-watch"/);
    expect(html).not.toMatch(/rtmp|Server URL|stream-dest-server/i);
    // The empty state's own Add does not repeat while the form is open.
    expect(html).not.toMatch(/data-testid="stream-dest-empty-add"/);
  });
});

// ─── the pure decisions ───────────────────────────────────────────────────────────────────────────────────────────────
describe("destinationMutationOutcome (Review Focus 3)", () => {
  it("a 404 on a repeated Remove, Replace or Rename means it already happened: refresh, no error; a 409, 422 or 5xx is an error", () => {
    expect(destinationMutationOutcome(404, "remove")).toBe("refresh");
    expect(destinationMutationOutcome(404, "replace")).toBe("refresh");
    expect(destinationMutationOutcome(404, "rename")).toBe("refresh");
    for (const s of [400, 403, 409, 422, 500, 503]) expect(destinationMutationOutcome(s, "remove"), String(s)).toBe("error");
  });
});

describe("rowLock", () => {
  it("locked exactly while inUse is set — live or waiting — carrying its match number", () => {
    expect(rowLock(target())).toEqual({ locked: false, matchNo: null });
    expect(rowLock(target({ inUse: live }))).toEqual({ locked: true, matchNo: 5 });
    expect(rowLock(target({ inUse: { ...live, state: "waiting" } }))).toEqual({ locked: true, matchNo: 5 });
    expect(rowLock(target({ inUse: { ...live, matchNo: null } }))).toEqual({ locked: true, matchNo: null });
  });
});

// ─── the error map, off the real wire ─────────────────────────────────────────────────────────────────────────────────
describe("destinationErrorText — every refusal the routes answer reads as the page's own copy, never the server's English", () => {
  type Row = [name: string, err: () => Promise<unknown> | unknown, kind: StreamTargetKind, expected: string];
  const ROWS: Row[] = [
    ["TARGET_IN_USE 409, live on a numbered match", () => targetHeld(holder()), "youtube", m("streamDest.stopFirst", { match: matchOf(5) })],
    ["TARGET_IN_USE 409, waiting on a numbered match", () => targetHeld(holder({ state: "waiting", matchNo: 7 })), "twitch", m("streamDest.stopFirst", { match: matchOf(7) })],
    ["TARGET_IN_USE 409, the holder's fixture deleted (matchNo null)", () => targetHeld(holder({ matchNo: null, href: null, fixtureId: null })), "youtube", m("streamDest.error.inUse")],
    ["DESTINATION_DUPLICATE 409", () => new HttpError(409, 'that stream key is already saved as "Main cam"', "DESTINATION_DUPLICATE", { other: { id: "t2", label: "Main cam" } }), "youtube", m("streamDest.error.duplicate", { label: "Main cam" })],
    ["DESTINATION_DUPLICATE 409 without a label", () => new HttpError(409, "dup", "DESTINATION_DUPLICATE", {}), "youtube", m("streamDest.error.duplicateUnnamed")],
    ["TARGET_UNREADABLE 422, a legacy kind (remove only)", () => new TargetUnreadableError("remove"), "facebook", m("streamDest.error.unreadableLegacy")],
    ["TARGET_UNREADABLE 422, a platform row (replace the key)", () => new TargetUnreadableError("replace_key"), "youtube", m("streamDest.error.unreadable")],
    // The wire carries no remedy field (only the server's English names it), so the ROW's kind decides — the same rule the
    // server's own `TargetUnreadableError.forKind` applies, swept over every stored kind below.
    ["DESTINATION_NOT_ALLOWED 422", () => new DestinationNotAllowedError("host"), "kick", m("streamDest.error.notAllowed")],
    ["STREAM_KEY_EMPTY 422", () => new HttpError(422, "The stream key is empty", STREAM_KEY_EMPTY), "youtube", m("streamDest.error.keyEmpty")],
    ["DESTINATION_LABEL_EMPTY 422", () => new HttpError(422, "The destination name is empty", DESTINATION_LABEL_EMPTY), "youtube", m("streamDest.error.nameEmpty")],
    ["VALIDATION 400 on the watch link (the schema's own refusal)", () => schemaRefusal({ kind: "youtube", label: "A", streamKey: "k", watchUrl: "https://example.com/x" }), "youtube", m("streamDest.error.watch")],
    ["VALIDATION 400 on anything else (a kind the create allowlist refuses)", () => schemaRefusal({ kind: "facebook", label: "A", streamKey: "k" }), "youtube", m("streamDest.error.generic")],
    ["FORBIDDEN 403 (a viewer's stale tab)", () => new HttpError(403, "Insufficient permissions"), "youtube", m("streamDest.error.forbidden")],
    ["CONFLICT 409, the row changed while saving", () => new HttpError(409, "the destination changed while it was being saved; try again"), "youtube", m("streamDest.error.generic")],
    ["INTERNAL 500", () => new Error("boom"), "youtube", m("streamDest.error.generic")],
  ];

  it("each row's copy is the dictionary's, and the server's own message never reaches the screen", async () => {
    let checked = 0;
    for (const [name, make, kind, expected] of ROWS) {
      const raw = await make();
      const e = await wire(raw);
      const text = destinationErrorText(m, e, kind);
      expect(text, name).toBe(expected);
      expect(text, `${name}: not the server's sentence`).not.toBe(e.message);
      if (e.message.length > 12) expect(text, `${name}: no server English inside`).not.toContain(e.message);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("TARGET_UNREADABLE's remedy follows the row's kind exactly as the server's forKind decides it — every stored kind", async () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      const e = await wire(TargetUnreadableError.forKind(kind));
      const serverRemedy = TargetUnreadableError.forKind(kind).remedy;
      expect(destinationErrorText(m, e, kind), kind).toBe(m(serverRemedy === "replace_key" ? "streamDest.error.unreadable" : "streamDest.error.unreadableLegacy"));
      checked++;
    }
    expect(checked).toBe(StreamTargetKind.options.length);
    expect(m("streamDest.error.unreadableLegacy"), "a legacy kind cannot be added again (D6)").not.toMatch(/again/i);
  });

  it("errors that never reached the server (a network TypeError, an abort, null) are the generic retry copy", () => {
    let checked = 0;
    for (const err of [new TypeError("Failed to fetch"), new DOMException("aborted", "AbortError"), null, "x"]) {
      expect(destinationErrorText(m, err, "youtube"), String(err)).toBe(m("streamDest.error.generic"));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("every streamDest.* key this file reads exists in all four locales (no English fallback leaking into es/fr/nl)", async () => {
    const { LOCALES } = await import("@/lib/i18n-constants");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const keys = Object.keys(messages).filter((k) => k.startsWith("streamDest.") || k === "directory.tab.streaming" || k === "directory.streaming.desc");
    expect(keys.length).toBeGreaterThan(30);
    let checked = 0;
    for (const l of LOCALES) {
      const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
      for (const k of keys) {
        expect(typeof dict[k], `${l} ${k}`).toBe("string");
        expect(dict[k]!.length, `${l} ${k}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * keys.length);
  });
});

// ─── the islands, driven ──────────────────────────────────────────────────────────────────────────────────────────────
describe("DestinationRow — driven", () => {
  /** The panel's REAL `run` (its 404 rule, its refresh, its error line), taken off the panel island's own row element. */
  function panelWith(t: StreamTarget, canEdit = true) {
    const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit, targets: [t], locale: "en" });
    const rowEl = panel.tree().find((el) => el.type === DestinationRow);
    if (!rowEl) throw new Error("the panel rendered no DestinationRow");
    const row = renderIsland(DestinationRow, propsOf(rowEl) as Parameters<typeof DestinationRow>[0]);
    return { panel, row };
  }

  it("Remove on a free destination: the confirm names it, then DELETE to its own path, then a refresh", async () => {
    const { panel, row } = panelWith(target());
    await click(byTestId(row.tree(), "stream-dest-remove"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const opts = confirmMock.mock.calls[0]![0] as { title: string; tone: string; confirmLabel: string; cancelLabel: string };
    expect(opts.title).toBe(m("streamDest.confirmRemove.title", { label: "Club YouTube" }));
    expect(opts.tone).toBe("danger");
    expect(opts.cancelLabel).toBe(m("streamDest.cancel"));
    expect(apiCalls).toEqual([{ url: "/api/v1/orgs/o/stream-targets/t1", method: "DELETE", json: undefined }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(byTestId(panel.tree(), "stream-dest-error")).toBeUndefined();
  });

  it("the Remove dialog's body: a platform row says re-adding the key restores it (D2); a LEGACY row never says 'again' — it cannot be added (D6)", async () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      confirmMock.mockClear();
      const { row } = panelWith(target({ kind }));
      await click(byTestId(row.tree(), "stream-dest-remove"));
      const body = String((confirmMock.mock.calls[0]![0] as { body: unknown }).body);
      if (isStreamPlatform(kind)) expect(body, kind).toBe(m("streamDest.confirmRemove.body"));
      else {
        expect(body, kind).toBe(m("streamDest.confirmRemove.bodyLegacy"));
        expect(body, kind).not.toMatch(/again/i);
      }
      checked++;
    }
    expect(checked).toBe(StreamTargetKind.options.length);
  });

  it("Remove answered 'cancel' in the dialog sends nothing", async () => {
    confirmMock.mockImplementation(async () => false);
    const { row } = panelWith(target());
    await click(byTestId(row.tree(), "stream-dest-remove"));
    expect(apiCalls).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a LOCKED Remove and Replace key are no-ops — no dialog, no request, no editor — while Rename still opens (live and waiting)", async () => {
    let checked = 0;
    for (const state of ["live", "waiting"] as const) {
      confirmMock.mockClear();
      apiCalls.length = 0;
      const { row } = panelWith(target({ inUse: { ...live, state } }));
      await click(byTestId(row.tree(), "stream-dest-remove"));
      await click(byTestId(row.tree(), "stream-dest-replace"));
      expect(confirmMock, state).not.toHaveBeenCalled();
      expect(apiCalls, state).toEqual([]);
      expect(byTestId(row.tree(), "stream-dest-replace-input"), state).toBeUndefined();
      await click(byTestId(row.tree(), "stream-dest-rename"));
      expect(byTestId(row.tree(), "stream-dest-rename-input"), state).toBeDefined();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("Review Focus 3: a Remove the server answers 404 (a double tap, a second tab) refreshes and shows NO error", async () => {
    transport.impl = async (url, opts) => {
      apiCalls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      throw new ApiV1Error("stream target not found", 404, "NOT_FOUND");
    };
    const { panel, row } = panelWith(target());
    await click(byTestId(row.tree(), "stream-dest-remove"));
    expect(apiCalls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(byTestId(panel.tree(), "stream-dest-error")).toBeUndefined();
  });

  it("a double tap on Remove sends ONE request: the second tap lands while the first is in flight", async () => {
    let release: () => void = () => {};
    transport.impl = (url, opts) => {
      apiCalls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      return new Promise((r) => { release = () => r({ removed: true }); });
    };
    const { row } = panelWith(target());
    const remove = byTestId(row.tree(), "stream-dest-remove")!;
    const first = (propsOf(remove).onClick as () => Promise<void>)();
    await settle();
    await (propsOf(byTestId(row.tree(), "stream-dest-remove")!).onClick as () => Promise<void>)();
    release();
    await first;
    await settle();
    expect(apiCalls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("a Remove refused 409 TARGET_IN_USE (the page was stale) says 'Stop Match {n} first' AND refreshes, so the row locks", async () => {
    const refusal = await wire(targetHeld(holder({ matchNo: 3, state: "waiting" })));
    transport.impl = async (url, opts) => {
      apiCalls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      throw refusal;
    };
    const { panel, row } = panelWith(target());
    await click(byTestId(row.tree(), "stream-dest-remove"));
    expect(textAt(panel.tree(), "stream-dest-error")).toBe(m("streamDest.stopFirst", { match: matchOf(3) }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("Rename: an inline editor seeded with the current name, PATCH {label} trimmed, then a refresh; a blank name cannot be saved", async () => {
    const { row } = panelWith(target({ inUse: live })); // allowed while in use (spec §5.2)
    await click(byTestId(row.tree(), "stream-dest-rename"));
    expect(attr(byTestId(row.tree(), "stream-dest-rename-input")!, "value")).toBe("Club YouTube");
    type(row.tree(), "stream-dest-rename-input", "   ");
    expect(attr(byTestId(row.tree(), "stream-dest-rename-save")!, "disabled")).toBe(true);
    type(row.tree(), "stream-dest-rename-input", "  Court 1 camera ");
    expect(attr(byTestId(row.tree(), "stream-dest-rename-save")!, "disabled")).toBe(false);
    const form = byTestId(row.tree(), "stream-dest-rename-form")!;
    await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
    await settle();
    expect(apiCalls).toEqual([{ url: "/api/v1/orgs/o/stream-targets/t1", method: "PATCH", json: { label: "Court 1 camera" } }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(byTestId(row.tree(), "stream-dest-rename-input"), "the editor closes on success").toBeUndefined();
  });

  it("Replace key: a password field with Show and the ROW's platform shape warning (never blocking), PATCH {streamKey}; a legacy kind warns nothing", async () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      apiCalls.length = 0;
      refresh.mockClear();
      const { row } = panelWith(target({ kind }));
      await click(byTestId(row.tree(), "stream-dest-replace"));
      const input = byTestId(row.tree(), "stream-dest-replace-input")!;
      expect(attr(input, "type"), kind).toBe("password");
      expect(attr(input, "autoComplete"), kind).toBe("new-password");
      type(row.tree(), "stream-dest-replace-input", "TestKeyName");
      const warning = byTestId(row.tree(), "stream-dest-replace-warning");
      if (isStreamPlatform(kind)) expect(textOf(warning!), kind).toBe(m(`streamDest.shape.${kind}`));
      else expect(warning, `${kind}: a legacy kind has no shape to warn about`).toBeUndefined();
      expect(attr(byTestId(row.tree(), "stream-dest-replace-save")!, "disabled"), `${kind}: warns, never blocks`).toBe(false);
      await click(byTestId(row.tree(), "stream-dest-replace-show"));
      expect(attr(byTestId(row.tree(), "stream-dest-replace-input")!, "type"), kind).toBe("text");
      const form = byTestId(row.tree(), "stream-dest-replace-form")!;
      await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
      await settle();
      expect(apiCalls, kind).toEqual([{ url: "/api/v1/orgs/o/stream-targets/t1", method: "PATCH", json: { streamKey: "TestKeyName" } }]);
      checked++;
    }
    expect(checked).toBe(StreamTargetKind.options.length);
  });

  it("the phone ⋯ menu opens the same three actions as 44px menu items; a held row's locked items say 'Stop Match {n} first' inside the menu", async () => {
    const { row } = panelWith(target({ inUse: live }));
    const menu = byTestId(row.tree(), "stream-dest-menu")!;
    expect(attr(menu, "aria-expanded")).toBe(false);
    expect(row.tree().some((el) => attr(el, "role") === "menu")).toBe(false);
    await click(menu);
    expect(attr(byTestId(row.tree(), "stream-dest-menu")!, "aria-expanded")).toBe(true);
    const items = row.tree().filter((el) => attr(el, "role") === "menuitem");
    expect(items.map((el) => attr(el, "data-action"))).toEqual(["rename", "replace", "remove"]);
    for (const it of items) expect(String(attr(it, "className")).split(/\s+/), String(attr(it, "data-action"))).toContain("min-h-11");
    const locked = allByTestId(row.tree(), "stream-dest-locked");
    expect(locked).toHaveLength(2);
    for (const l of locked) expect(textOf(l)).toBe(m("streamDest.stopFirst", { match: matchOf(5) }));
    expect(items.map((el) => attr(el, "aria-disabled"))).toEqual([undefined, true, true]);
    // A locked menu item is a no-op too.
    await click(items[2]);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("the positive twin: a free row's menu items carry no lock and Remove from the menu asks, then deletes", async () => {
    const { row } = panelWith(target());
    await click(byTestId(row.tree(), "stream-dest-menu"));
    expect(allByTestId(row.tree(), "stream-dest-locked")).toHaveLength(0);
    const remove = row.tree().find((el) => attr(el, "role") === "menuitem" && attr(el, "data-action") === "remove");
    await click(remove);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(apiCalls.map((c) => c.method)).toEqual(["DELETE"]);
  });
});

describe("AddForm — driven", () => {
  const form = (onSave = vi.fn<(b: unknown) => Promise<void>>(async () => {})) => ({ island: renderIsland(AddForm, { onSave, onCancel: () => {} }), onSave });
  const submit = async (island: ReturnType<typeof form>["island"]) => {
    await (propsOf(byTestId(island.tree(), "stream-dest-form")!).onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
    await settle();
  };

  it("opens at the first platform; the staging key NAME warns with that platform's copy and Save stays ENABLED (warns, never blocks)", async () => {
    const { island, onSave } = form();
    expect(attr(byTestId(island.tree(), `stream-dest-platform-${STREAM_PLATFORMS[0]}`)!, "aria-checked")).toBe(true);
    type(island.tree(), "stream-dest-name", "Main court");
    type(island.tree(), "stream-dest-key", "TestYouTube");
    expect(textAt(island.tree(), "stream-dest-key-warning")).toBe(m("streamDest.shape.youtube"));
    expect(attr(byTestId(island.tree(), "stream-dest-save")!, "disabled")).toBe(false);
    await submit(island);
    expect(onSave).toHaveBeenCalledWith({ kind: "youtube", label: "Main court", streamKey: "TestYouTube" });
  });

  it("each platform sends ITS kind and judges the key by ITS shape — swept over STREAM_PLATFORMS", async () => {
    let checked = 0;
    for (const p of STREAM_PLATFORMS) {
      const { island, onSave } = form();
      await click(byTestId(island.tree(), `stream-dest-platform-${p}`));
      expect(attr(byTestId(island.tree(), `stream-dest-platform-${p}`)!, "aria-checked"), p).toBe(true);
      type(island.tree(), "stream-dest-name", `N ${p}`);
      type(island.tree(), "stream-dest-key", "TestKeyName");
      expect(textAt(island.tree(), "stream-dest-key-warning"), p).toBe(m(`streamDest.shape.${p}`));
      type(island.tree(), "stream-dest-watch", " https://www.twitch.tv/club ");
      await submit(island);
      expect(onSave, p).toHaveBeenCalledWith({ kind: p, label: `N ${p}`, streamKey: "TestKeyName", watchUrl: "https://www.twitch.tv/club" });
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length);
  });

  it("a well-shaped key shows no warning (the positive pair); a blank name or key keeps Save disabled", () => {
    const { island } = form();
    type(island.tree(), "stream-dest-key", "abcd-1234-efgh-5678-ijkl");
    expect(byTestId(island.tree(), "stream-dest-key-warning")).toBeUndefined();
    expect(attr(byTestId(island.tree(), "stream-dest-save")!, "disabled"), "no name yet").toBe(true);
    type(island.tree(), "stream-dest-name", "   ");
    expect(attr(byTestId(island.tree(), "stream-dest-save")!, "disabled"), "a blank name").toBe(true);
    type(island.tree(), "stream-dest-name", "Main");
    type(island.tree(), "stream-dest-key", "   ");
    expect(attr(byTestId(island.tree(), "stream-dest-save")!, "disabled"), "a blank key").toBe(true);
    type(island.tree(), "stream-dest-key", "k");
    expect(attr(byTestId(island.tree(), "stream-dest-save")!, "disabled")).toBe(false);
  });

  it("m8: the key field keeps password managers out, and Show flips it to text", async () => {
    const { island } = form();
    const key = byTestId(island.tree(), "stream-dest-key")!;
    expect(attr(key, "type")).toBe("password");
    expect(attr(key, "autoComplete")).toBe("new-password");
    expect(attr(key, "data-1p-ignore")).toBe(true);
    expect(attr(key, "data-lpignore")).toBe("true");
    await click(byTestId(island.tree(), "stream-dest-key-show"));
    expect(attr(byTestId(island.tree(), "stream-dest-key")!, "type")).toBe("text");
  });
});

describe("StreamDestinationsPanel — the add path, driven", () => {
  it("Save POSTs the body to the org's collection, closes the form and refreshes; a refusal keeps the form open with the page's copy", async () => {
    const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [], locale: "en", initialAddOpen: true });
    const addEl = panel.tree().find((el) => el.type === AddForm)!;
    await (propsOf(addEl).onSave as (b: unknown) => Promise<void>)({ kind: "twitch", label: "T", streamKey: "k" });
    await settle();
    expect(apiCalls).toEqual([{ url: "/api/v1/orgs/o/stream-targets", method: "POST", json: { kind: "twitch", label: "T", streamKey: "k" } }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(panel.tree().find((el) => el.type === AddForm), "closed on success").toBeUndefined();

    const refused = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [], locale: "en", initialAddOpen: true });
    const dup = await wire(new HttpError(409, "dup", "DESTINATION_DUPLICATE", { other: { id: "t9", label: "Old cam" } }));
    transport.impl = async () => { throw dup; };
    await (propsOf(refused.tree().find((el) => el.type === AddForm)!).onSave as (b: unknown) => Promise<void>)({ kind: "youtube", label: "A", streamKey: "k" });
    await settle();
    expect(textAt(refused.tree(), "stream-dest-error")).toBe(m("streamDest.error.duplicate", { label: "Old cam" }));
    expect(refused.tree().find((el) => el.type === AddForm), "open after a refusal").toBeDefined();
  });

  it("A19 (owner decision a): a key already saved answers `existing` — the form stays OPEN and says 'already saved as {the STORED name}', the list refreshes; `restored` and `inserted` close it", async () => {
    const save = async (outcome: StreamTargetSaved["outcome"], stored: Partial<StreamTarget> = {}) => {
      refresh.mockReset();
      const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [], locale: "en", initialAddOpen: true });
      transport.impl = async (url, opts) => {
        apiCalls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
        return { ...target(stored), outcome } satisfies StreamTargetSaved;
      };
      await (propsOf(panel.tree().find((el) => el.type === AddForm)!).onSave as (b: unknown) => Promise<void>)({ kind: "youtube", label: "Typed name", streamKey: "k" });
      await settle();
      return panel;
    };
    // The stored name differs from the typed one — the copy must name the SAVED destination, never echo the form.
    const existing = await save("existing", { label: "Court 1 camera" });
    expect(existing.tree().find((el) => el.type === AddForm), "open: nothing was added").toBeDefined();
    expect(textAt(existing.tree(), "stream-dest-error")).toBe(m("streamDest.error.duplicate", { label: "Court 1 camera" }));
    expect(textAt(existing.tree(), "stream-dest-error")).not.toContain("Typed name");
    expect(refresh, "the list is re-read, so the saved row is on screen").toHaveBeenCalledTimes(1);

    let checked = 0;
    for (const outcome of ["restored", "inserted"] as const) {
      const panel = await save(outcome);
      expect(panel.tree().find((el) => el.type === AddForm), `${outcome}: closed`).toBeUndefined();
      expect(byTestId(panel.tree(), "stream-dest-error"), `${outcome}: no message`).toBeUndefined();
      expect(refresh, outcome).toHaveBeenCalledTimes(1);
      checked++;
    }
    expect(checked).toBe(StreamTargetSaveOutcome.options.length - 1);
  });

  it("an add refused 404 is an ERROR, not 'already done' — the 404 rule is for rows that exist", async () => {
    const panel = renderIsland(StreamDestinationsPanel, { orgId: "o", canEdit: true, targets: [], locale: "en", initialAddOpen: true });
    transport.impl = async () => { throw new ApiV1Error("organization not found", 404, "NOT_FOUND"); };
    await (propsOf(panel.tree().find((el) => el.type === AddForm)!).onSave as (b: unknown) => Promise<void>)({ kind: "youtube", label: "A", streamKey: "k" });
    await settle();
    expect(textAt(panel.tree(), "stream-dest-error")).toBe(m("streamDest.error.generic"));
    expect(refresh).not.toHaveBeenCalled();
  });
});
