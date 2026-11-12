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
// - Every control is a 44px target (min-h-11), at 320 as at 1280; long names wrap, never push the page sideways.
//
// Copy comes from the page's `ui` dictionary (the /me page's DictProvider): the viewer's language, never the match's.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { usePlural, useT } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { QUICK_MATCH_NAME_MAX, QUICK_MATCH_NON_BLANK_PATTERN } from "@/lib/quick-match-constants";
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

export function QuickMatchMyList({ items }: { items: readonly MyQuickMatchItem[] }) {
  const t = useT();
  const router = useRouter();
  // What this browser has already done, laid over the page's read until the refresh brings the same news.
  const [renamed, setRenamed] = useState<Readonly<Record<string, string>>>({});
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = items.filter((i) => !deleted.has(i.id)).map((i) => ({ ...i, name: renamed[i.id] ?? i.name }));
  if (shown.length === 0) return null;
  return (
    <section data-testid="me-quick-matches" aria-labelledby={TITLE_ID} className="mb-8 min-w-0">
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
          <MyRow
            key={item.id}
            item={item}
            onRenamed={(name) => {
              setRenamed((r) => ({ ...r, [item.id]: name }));
              router.refresh();
            }}
            onDeleted={() => {
              setDeleted((d) => new Set([...d, item.id]));
              heading.current?.focus();
              router.refresh();
            }}
          />
        ))}
      </ul>
    </section>
  );
}

type Mode = "idle" | "rename" | "delete";

function MyRow({
  item,
  onRenamed,
  onDeleted,
}: {
  item: MyQuickMatchItem;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
}) {
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
    if (!answer.ok) return setError(answer.key);
    setMode("idle");
    onRenamed(answer.name ?? (input.current?.value ?? item.name).trim());
  }
  async function remove() {
    if (pending) return;
    setPending(true);
    setError(null);
    const answer = await deleteMyQuickMatch(item.id);
    setPending(false);
    if (!answer.ok) return setError(answer.key);
    onDeleted();
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
