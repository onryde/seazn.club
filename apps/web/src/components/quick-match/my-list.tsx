"use client";
// The account's "Quick matches" (quick match plan 3, Task 6; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7,
// C9, C13, C19; plan 3 Amend T6 [B25, B26, B29]): the matches this person saved, on /me, each linking to its home, with the two
// things only the saver may do to it: Rename and Delete (for everyone with the link).
//
// - The empty case first (B26): with no row, from the page's read or once the last row is deleted here, it renders nothing,
//   so the account page never carries an empty box or a heading over nothing. The page mounts it unconditionally: this is
//   the one guard.
// - Each name links to `routes.quickMatch(token)`, built HERE from the token the page read (quick-match-home.ts
//   `listMyQuickMatches`), so the link's painter is this file. The href holds the home token, the match's credential (O3), so the
//   link carries `ph-no-capture` (B25, scrub-secret-painters.test.ts). A plain <a>: the home is dynamic and per token. A row whose
//   token could not be opened (B29) shows its name without a link, and says so.
// - Rename opens a small form in the row (the name, bounded as the create bounds it: required, not all spaces, at most
//   QUICK_MATCH_NAME_MAX); Delete opens a confirmation in the row, whose own button deletes. Both send their request with `fetch`
//   (my-list-requests.ts, `PATCH`/`DELETE /api/quick-match/<id>`), so they need the script; the server checks everything again.
//   A refusal is printed in the row as its own line (role=alert); success updates the row at once and refreshes the page's read.
// - What this browser knows past the page's read is one pure step (`remember`, `onRead`, `shownOf`; T6 review m1, m2):
//   a rename lays its name over the row until the page's next read, which then wins; a delete drops the row; a refusal that
//   the match is no longer in the account (another tab deleted it, or it expired) drops the row too. A delete and a "gone"
//   are said in the list's polite live region, which stays mounted while it has something to say, and focus moves to a
//   stable target: the heading while rows remain, else the list's own root (never lost to the page's body).
// - The section's id is the anchor the saved home's "In your account" link lands on (`/me#quick-matches`, home.tsx).
// - Every control is a 44px target (min-h-11), at 320 as at 1280; long names wrap, never push the page sideways.
//
// Copy comes from the page's `ui` dictionary (the /me page's DictProvider): the viewer's language, never the match's.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { usePlural, useT } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { QUICK_MATCH_ACCOUNT_SECTION_ID, QUICK_MATCH_NAME_MAX, QUICK_MATCH_NON_BLANK_PATTERN } from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import { deleteMyQuickMatch, renameMyQuickMatch } from "./my-list-requests";

/** One saved quick match, as the page read it (quick-match-home.ts `MyQuickMatch`, restated here: this island imports nothing
 *  from the server). */
export interface MyQuickMatchItem {
  id: string;
  name: string;
  /** null: the row's link could not be rebuilt (B29). */
  token: string | null;
  format: "league" | "knockout";
  played: number;
  total: number;
}

const TITLE_ID = "me-quick-matches-title";
const TARGET = "min-h-11";

const FORMAT_KEY = {
  league: "quickMatch.format.league",
  knockout: "quickMatch.format.knockout",
} as const satisfies Record<MyQuickMatchItem["format"], MessageKey>;

/** What this browser knows past the page's read `read`: the rows it deleted or found gone, the names it set, and the last
 *  thing the list said in its live region. */
export interface ListMemory {
  read: readonly MyQuickMatchItem[];
  gone: ReadonlySet<string>;
  renamed: Readonly<Record<string, string>>;
  notice: { key: MessageKey; name: string } | null;
}
/** An answer the list heard for one row: renamed, deleted, or refused as no longer in the account (NOT_IN_ACCOUNT). */
export type ListEvent =
  | { kind: "renamed"; id: string; name: string }
  | { kind: "deleted"; id: string; name: string }
  | { kind: "gone"; id: string; name: string };

export function freshMemory(read: readonly MyQuickMatchItem[]): ListMemory {
  return { read, gone: new Set(), renamed: {}, notice: null };
}
export function remember(m: ListMemory, e: ListEvent): ListMemory {
  if (e.kind === "renamed") return { ...m, renamed: { ...m.renamed, [e.id]: e.name } };
  const key: MessageKey = e.kind === "deleted" ? "quickMatch.me.deleted" : "quickMatch.me.notInAccount";
  return { ...m, gone: new Set([...m.gone, e.id]), notice: { key, name: e.name } };
}
/** The page read again (a refresh): its names win over this browser's renames; what is gone stays gone; what was said stays. */
export function onRead(m: ListMemory, read: readonly MyQuickMatchItem[]): ListMemory {
  return { ...m, read, renamed: {} };
}
export function shownOf(items: readonly MyQuickMatchItem[], m: ListMemory): MyQuickMatchItem[] {
  return items.filter((i) => !m.gone.has(i.id)).map((i) => ({ ...i, name: m.renamed[i.id] ?? i.name }));
}

export function QuickMatchMyList({ items }: { items: readonly MyQuickMatchItem[] }) {
  const t = useT();
  const router = useRouter();
  const [memory, setMemory] = useState(() => freshMemory(items));
  // A new read from the page (router.refresh, or a navigation back): adjust during render, React's sanctioned way.
  if (memory.read !== items) setMemory(onRead(memory, items));
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const shown = shownOf(items, memory);
  // The empty case first (B26): nothing read and nothing said, nothing at all.
  if (shown.length === 0 && memory.notice === null) return null;

  const settle = (event: ListEvent) => {
    const left = shown.filter((i) => i.id !== event.id).length;
    setMemory((m) => remember(m, event));
    if (event.kind !== "renamed") (left > 0 ? heading : root).current?.focus();
    router.refresh();
  };
  return (
    <div ref={root} tabIndex={-1} data-testid="me-qm-root" className="min-w-0 outline-none">
      <p role="status" aria-live="polite" aria-atomic="true" data-testid="me-qm-status" className="sr-only">
        {memory.notice ? t(memory.notice.key, { name: memory.notice.name }) : ""}
      </p>
      {shown.length > 0 && (
        <section
          id={QUICK_MATCH_ACCOUNT_SECTION_ID}
          data-testid="me-quick-matches"
          aria-labelledby={TITLE_ID}
          className="mb-8 min-w-0 scroll-mt-4"
        >
          <h2
            id={TITLE_ID}
            ref={heading}
            tabIndex={-1}
            className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400 outline-none"
          >
            {t("quickMatch.me.title")}
          </h2>
          <ul className="min-w-0 space-y-2">
            {shown.map((item) => (
              <MyRow key={item.id} item={item} onSettled={settle} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

type Mode = "idle" | "rename" | "delete";

function MyRow({ item, onSettled }: { item: MyQuickMatchItem; onSettled: (event: ListEvent) => void }) {
  const t = useT();
  const plural = usePlural();
  const ids = useId();
  const nameId = `${ids}-name`;
  const [mode, setMode] = useState<Mode>("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "rename") input.current?.focus();
  }, [mode]);

  const open = (next: Mode) => {
    setError(null);
    setMode(next);
  };
  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const answer = await renameMyQuickMatch(item.id, input.current?.value ?? "");
    setPending(false);
    if (!answer.ok) return refused(answer.key);
    setMode("idle");
    onSettled({ kind: "renamed", id: item.id, name: answer.name ?? (input.current?.value ?? item.name).trim() });
  }
  async function remove() {
    if (pending) return;
    setPending(true);
    setError(null);
    const answer = await deleteMyQuickMatch(item.id);
    setPending(false);
    if (!answer.ok) return refused(answer.key);
    onSettled({ kind: "deleted", id: item.id, name: item.name });
  }
  // No longer in the account (another tab deleted it, or it expired): every control here would answer the same, so the row
  // goes and the list says why (m1). Any other refusal stays on the row, its own line.
  function refused(key: MessageKey) {
    if (key === "quickMatch.me.notInAccount") return onSettled({ kind: "gone", id: item.id, name: item.name });
    setError(key);
  }

  const href = item.token === null ? null : routes.quickMatch(item.token);
  const line = `${t(FORMAT_KEY[item.format])} · ${plural("quickMatch.home.playedSaved", item.total, { played: item.played })}`;
  return (
    <li data-testid="me-qm-row" data-qm-id={item.id} className="card min-w-0 space-y-3 p-4">
      <div className="min-w-0">
        {href !== null ? (
          <a
            id={nameId}
            href={href}
            data-testid="me-qm-name"
            className={`ph-no-capture inline-flex ${TARGET} max-w-full items-center text-sm font-medium text-purple-700 underline decoration-purple-200 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-purple-700`}
          >
            {item.name}
          </a>
        ) : (
          <span id={nameId} data-testid="me-qm-name" className="block text-sm font-medium text-slate-800 [overflow-wrap:anywhere]">
            {item.name}
          </span>
        )}
        <p data-testid="me-qm-meta" className="text-xs text-slate-500">
          {line}
        </p>
        {href === null && (
          <p data-testid="me-qm-nolink" className="mt-1 text-xs text-slate-500">
            {t("quickMatch.me.noLink")}
          </p>
        )}
      </div>

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="me-qm-rename"
            aria-describedby={nameId}
            onClick={() => open("rename")}
            className={`btn btn-ghost ${TARGET}`}
          >
            {t("quickMatch.me.rename")}
          </button>
          <button
            type="button"
            data-testid="me-qm-delete"
            aria-describedby={nameId}
            onClick={() => open("delete")}
            className={`btn btn-danger ${TARGET}`}
          >
            {t("quickMatch.me.delete")}
          </button>
        </div>
      )}

      {mode === "rename" && (
        <form data-testid="me-qm-rename-form" onSubmit={rename} className="min-w-0 space-y-2">
          <label htmlFor={`${ids}-input`} className="label">
            {t("quickMatch.me.renameLabel")}
          </label>
          <input
            ref={input}
            id={`${ids}-input`}
            data-testid="me-qm-rename-input"
            name="name"
            defaultValue={item.name}
            required
            maxLength={QUICK_MATCH_NAME_MAX}
            pattern={QUICK_MATCH_NON_BLANK_PATTERN}
            autoComplete="off"
            className={`input ${TARGET} min-w-0`}
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" data-testid="me-qm-rename-save" disabled={pending} className={`btn btn-primary ${TARGET}`}>
              {t("quickMatch.me.renameSave")}
            </button>
            <button
              type="button"
              data-testid="me-qm-rename-cancel"
              disabled={pending}
              onClick={() => open("idle")}
              className={`btn btn-ghost ${TARGET}`}
            >
              {t("quickMatch.me.cancel")}
            </button>
          </div>
        </form>
      )}

      {mode === "delete" && (
        <div
          data-testid="me-qm-delete-confirm"
          role="group"
          aria-labelledby={`${ids}-question`}
          className="min-w-0 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3"
        >
          <p id={`${ids}-question`} data-testid="me-qm-delete-question" className="text-sm text-red-800">
            {t("quickMatch.me.deleteConfirm")}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="me-qm-delete-yes"
              disabled={pending}
              onClick={remove}
              className={`btn ${TARGET} bg-red-600 text-white shadow-sm hover:bg-red-700`}
            >
              {t("quickMatch.me.deleteYes")}
            </button>
            <button
              type="button"
              data-testid="me-qm-delete-cancel"
              disabled={pending}
              onClick={() => open("idle")}
              className={`btn btn-ghost ${TARGET}`}
            >
              {t("quickMatch.me.cancel")}
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" data-testid="me-qm-error" className="text-sm text-red-700">
          {t(error, { max: QUICK_MATCH_NAME_MAX })}
        </p>
      )}
    </li>
  );
}
