"use client";
// Directory → Streaming (spec 2026-09-30 §4, owner rulings D1 D2 D6). Destinations are managed HERE only; the fixture
// panel picks one. Remove is an archive (D2) and is refused while a match is live OR waiting on it — the row says which.
// Follows venues-panel.tsx: inline forms and cards, no modals, `useConfirm` for Remove, `router.refresh()` after each
// mutation, `apiV1` for every call.
//
// Copy: every refusal is mapped from its machine CODE to this page's own dictionary (`destinationErrorText`). The
// server's `message` is English API prose and is never rendered — venues-panel's "show err.message" fallback is exactly
// what this file does not copy (B2 review).
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis, MonitorPlay, Plus } from "lucide-react";
import Link from "@/components/ui/console-link";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { UTC, fmtPublicDate } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import {
  DESTINATION_LABEL_EMPTY, DESTINATION_NOT_ALLOWED, STREAM_KEY_EMPTY, STREAM_PLATFORMS, TARGET_UNREADABLE, isStreamPlatform,
  type StreamPlatform,
} from "@/lib/stream-destinations";
import { keyShapeWarning } from "@/lib/stream-key-shape";
import type { StreamTarget, StreamTargetKind } from "@/server/api-v1/schemas";
import { PlatformMark, platformName } from "./stream-platform-mark";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
type RowOp = "rename" | "replace" | "remove";
type Op = "add" | RowOp;

/** Review Focus 3: a 404 on Rename, Replace or Remove means the row is already gone (a double tap, a second tab) — the
 *  list is refreshed and nothing is shown as an error. Only for a row that existed: an ADD answered 404 is an error. */
// The op is the contract's (brief T7 Step 5): every row op answers a 404 the same way, so the body does not read it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function destinationMutationOutcome(status: number, _op: RowOp): "refresh" | "error" {
  return status === 404 ? "refresh" : "error";
}

/** D2: Replace key and Remove are locked while a match is live OR waiting on the destination. */
export function rowLock(t: Pick<StreamTarget, "inUse">): { locked: boolean; matchNo: number | null } {
  return t.inUse ? { locked: true, matchNo: t.inUse.matchNo } : { locked: false, matchNo: null };
}

/** The `status` / `code` / `extra` of an `ApiV1Error` (lib/client-v1.ts), read structurally — `null` for anything that
 *  never reached the server (a network TypeError, an abort, a non-object). */
function wireOf(err: unknown): { status: number; code: string; extra: Record<string, unknown> } | null {
  if (typeof err !== "object" || err === null) return null;
  const { status, code, extra } = err as { status?: unknown; code?: unknown; extra?: unknown };
  if (typeof status !== "number" || typeof code !== "string") return null;
  return { status, code, extra: typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>) : {} };
}

/**
 * A refusal as this page's own sentence, by the route's machine code (openapi.ts documents each one). `kind` is the
 * destination the action was about: the wire carries no remedy for an unreadable key, so the ROW decides it — a
 * YouTube or Twitch row is repaired by Replace key; a legacy kind cannot be, and cannot be added again either (D6), so
 * it is told to remove it (the server's own `TargetUnreadableError.forKind` rule). Anything unmapped is the generic
 * retry sentence — never the server's English.
 */
export function destinationErrorText(msg: Msg, err: unknown, kind: StreamTargetKind): string {
  const w = wireOf(err);
  if (!w) return msg("streamDest.error.generic");
  switch (w.code) {
    case "TARGET_IN_USE": {
      const h = w.extra.holder as { matchNo?: unknown } | null | undefined;
      return typeof h?.matchNo === "number"
        ? msg("streamDest.stopFirst", { match: msg("breadcrumb.match", { no: h.matchNo }) })
        : msg("streamDest.error.inUse");
    }
    case "DESTINATION_DUPLICATE": {
      const other = w.extra.other as { label?: unknown } | undefined;
      return typeof other?.label === "string" && other.label !== ""
        ? msg("streamDest.error.duplicate", { label: other.label })
        : msg("streamDest.error.duplicateUnnamed");
    }
    case TARGET_UNREADABLE:
      return msg(isStreamPlatform(kind) ? "streamDest.error.unreadable" : "streamDest.error.unreadableLegacy");
    case DESTINATION_NOT_ALLOWED:
      return msg("streamDest.error.notAllowed");
    case STREAM_KEY_EMPTY:
      return msg("streamDest.error.keyEmpty");
    case DESTINATION_LABEL_EMPTY:
      return msg("streamDest.error.nameEmpty");
    case "VALIDATION": {
      // The schema's 400 (zod issues on the envelope). The watch link is the one field a person can get wrong that the
      // form does not already hold back (a blank name or key never enables Save).
      const issues = w.extra.issues;
      const watch = Array.isArray(issues) && issues.some((i) => Array.isArray((i as { path?: unknown })?.path) && (i as { path: unknown[] }).path[0] === "watchUrl");
      return msg(watch ? "streamDest.error.watch" : "streamDest.error.generic");
    }
    case "FORBIDDEN":
      return msg("streamDest.error.forbidden");
    default:
      return msg("streamDest.error.generic");
  }
}

type Run = (op: Op, kind: StreamTargetKind, call: () => Promise<unknown>) => Promise<boolean>;
type AddBody = { kind: StreamPlatform; label: string; streamKey: string; watchUrl?: string };

export function StreamDestinationsPanel({
  orgId, canEdit, targets, locale, initialAddOpen = false,
}: {
  orgId: string;
  /** Owner or admin (the page's `canEdit`, the API's write gate). Every member sees the list; only these see actions. */
  canEdit: boolean;
  targets: StreamTarget[];
  /** For the "added {date}" subline — the page's locale, formatted the same on server and client. */
  locale: string;
  /** Test seam: opens the add form on first render. The page never passes it. */
  initialAddOpen?: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(initialAddOpen);
  const [error, setError] = useState<string | null>(null);

  const run: Run = async (op, kind, call) => {
    setError(null);
    try {
      await call();
      router.refresh();
      return true;
    } catch (err) {
      const w = wireOf(err);
      if (op !== "add" && w && destinationMutationOutcome(w.status, op) === "refresh") {
        router.refresh();
        return true;
      }
      setError(destinationErrorText(msg, err, kind));
      // A refusal naming a holder means this page was stale: the destination is held NOW, so the list is re-read and the
      // row locks with its badge (the error line stays until the next action).
      if (w?.code === "TARGET_IN_USE") router.refresh();
      return false;
    }
  };

  const openAdd = () => setAddOpen(true);

  return (
    <div data-testid="stream-destinations" className="space-y-4">
      {canEdit && targets.length > 0 && (
        <div>
          <button
            type="button"
            data-testid="stream-dest-add"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((v) => !v)}
            className="btn btn-primary min-h-11"
          >
            <Plus aria-hidden className="h-4 w-4" strokeWidth={2} />
            {msg("streamDest.add")}
          </button>
        </div>
      )}
      {canEdit && addOpen && (
        <AddForm
          onCancel={() => setAddOpen(false)}
          onSave={async (body) => {
            const ok = await run("add", body.kind, () => apiV1(`/api/v1/orgs/${orgId}/stream-targets`, { method: "POST", json: body }));
            if (ok) setAddOpen(false);
          }}
        />
      )}
      {error && (
        <p data-testid="stream-dest-error" role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {targets.length === 0 ? (
        <div data-testid="stream-dest-empty" className="card flex flex-col items-center gap-3 p-8 text-center max-md:p-5">
          <span aria-hidden className="grid h-11 w-11 place-items-center rounded-full bg-purple-50 text-purple-700">
            <MonitorPlay className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <p className="max-w-md text-sm text-slate-600">{msg("streamDest.empty")}</p>
          {canEdit && !addOpen && (
            <button type="button" data-testid="stream-dest-empty-add" onClick={openAdd} className="btn btn-primary min-h-11">
              <Plus aria-hidden className="h-4 w-4" strokeWidth={2} />
              {msg("streamDest.add")}
            </button>
          )}
        </div>
      ) : (
        <div className="card overflow-visible">
          <ul className="divide-y divide-slate-100" aria-label={msg("streamDest.listLabel")}>
            {targets.map((t) => (
              <DestinationRow key={t.id} t={t} canEdit={canEdit} locale={locale} orgId={orgId} run={run} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The key field shared by Add and Replace key: password-style, a Show toggle, the platform's shape warning (which
 *  never blocks). A render helper, not a component — its state lives in the form that owns it. m8: a stream key is not
 *  a login, so the browser and password managers are kept out of it. */
function keyField(p: {
  id: string; testids: { input: string; show: string; warning: string }; label: string; value: string; show: boolean; warning: MessageKey | null; msg: Msg;
  onChange: (v: string) => void; onToggle: () => void;
}): ReactNode {
  const warningId = `${p.id}-warning`;
  return (
    <div>
      <label htmlFor={p.id} className="text-sm font-medium text-slate-800">{p.label}</label>
      <div className="relative mt-1">
        <input
          id={p.id}
          data-testid={p.testids.input}
          type={p.show ? "text" : "password"}
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          maxLength={200}
          className={`input min-h-11 pr-20 font-mono${p.warning ? " border-amber-400 ring-1 ring-amber-200" : ""}`}
          aria-describedby={p.warning ? warningId : undefined}
          value={p.value}
          onChange={(e) => p.onChange(e.target.value)}
        />
        <button
          type="button"
          data-testid={p.testids.show}
          aria-pressed={p.show}
          onClick={p.onToggle}
          className="absolute right-1 top-1/2 flex min-h-11 -translate-y-1/2 items-center rounded-md px-3 text-sm font-medium text-purple-700 hover:bg-purple-50"
        >
          {p.msg(p.show ? "streamDest.keyHide" : "streamDest.keyShow")}
        </button>
      </div>
      {p.warning && (
        <p
          id={warningId}
          data-testid={p.testids.warning}
          className="mt-2 text-sm text-amber-800"
        >
          {p.msg(p.warning)}
        </p>
      )}
    </div>
  );
}

export function AddForm({ onSave, onCancel }: { onSave: (b: AddBody) => Promise<void>; onCancel: () => void }) {
  const msg = useMsg();
  const [kind, setKind] = useState<StreamPlatform>(STREAM_PLATFORMS[0]);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [watch, setWatch] = useState("");
  const [busy, setBusy] = useState(false);
  const warning = keyShapeWarning(kind, key);
  const ready = label.trim() !== "" && key.trim() !== "";

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onSave({ kind, label: label.trim(), streamKey: key.trim(), ...(watch.trim() ? { watchUrl: watch.trim() } : {}) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form data-testid="stream-dest-form" className="card p-5 max-md:p-4" aria-label={msg("streamDest.add")} onSubmit={submit}>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">{msg("streamDest.platform")}</legend>
        <div role="radiogroup" aria-label={msg("streamDest.platform")} className="mt-1.5 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {STREAM_PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={kind === p}
              data-testid={`stream-dest-platform-${p}`}
              onClick={() => setKind(p)}
              className={`flex min-h-11 flex-1 basis-[5.5rem] items-center justify-center gap-2 rounded-md px-3 text-sm font-medium ${
                kind === p ? "bg-white text-purple-700 shadow-sm ring-1 ring-purple-200" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <PlatformMark kind={p} size="sm" />
              {platformName(msg, p)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="stream-dest-name" className="text-sm font-medium text-slate-800">{msg("streamDest.name")}</label>
          <input
            id="stream-dest-name"
            data-testid="stream-dest-name"
            className="input mt-1 min-h-11"
            maxLength={80}
            autoComplete="off"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        {keyField({
          id: "stream-dest-key", testids: { input: "stream-dest-key", show: "stream-dest-key-show", warning: "stream-dest-key-warning" }, label: msg("streamDest.key"), value: key, show, warning, msg,
          onChange: setKey, onToggle: () => setShow((v) => !v),
        })}
      </div>
      <div className="mt-4">
        <label htmlFor="stream-dest-watch" className="text-sm font-medium text-slate-800">{msg("streamDest.watch")}</label>
        <input
          id="stream-dest-watch"
          data-testid="stream-dest-watch"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className="input mt-1 min-h-11"
          value={watch}
          onChange={(e) => setWatch(e.target.value)}
        />
      </div>
      <div className="mt-5 flex gap-2 max-md:flex-col">
        <button type="submit" data-testid="stream-dest-save" disabled={!ready || busy} className="btn btn-primary min-h-11">
          {msg("streamDest.save")}
        </button>
        <button type="button" data-testid="stream-dest-cancel" onClick={onCancel} className="btn btn-ghost min-h-11">
          {msg("streamDest.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The holder badge — a link to the holding fixture's page, or plain text when that fixture is gone. The anchor is the
 *  44-px tap box; the pill inside it is the visual. */
function badgeOf(t: StreamTarget, msg: Msg): ReactNode {
  const h = t.inUse;
  if (!h) return null;
  const match = h.matchNo === null ? msg("streamDest.anotherMatch") : msg("breadcrumb.match", { no: h.matchNo });
  const isLive = h.state === "live";
  const pill = (
    <span
      className={`badge inline-flex items-center gap-1.5 normal-case ring-1 ${
        isLive ? "bg-red-50 text-red-700 ring-red-200" : "bg-amber-50 text-amber-800 ring-amber-200"
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${isLive ? "bg-red-500" : "bg-amber-500"}`} />
      {msg(isLive ? "streamDest.badge.live" : "streamDest.badge.waiting", { match })}
    </span>
  );
  return h.href ? (
    <Link data-testid="stream-dest-badge" data-state={h.state} href={h.href} className="inline-flex min-h-11 max-w-full items-center">
      {pill}
    </Link>
  ) : (
    <span data-testid="stream-dest-badge" data-state={h.state} className="inline-flex min-h-11 max-w-full items-center">
      {pill}
    </span>
  );
}

const ACTION = "btn min-h-11 px-2.5";

export function DestinationRow({
  t, canEdit, locale, orgId, run,
}: {
  t: StreamTarget;
  canEdit: boolean;
  locale: string;
  orgId: string;
  run: Run;
}) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [mode, setMode] = useState<"rename" | "replace" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState(t.label);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  // A second tap (or a tap during the confirm) while an action is in flight is refused here, before any request.
  const busy = useRef(false);

  const { locked, matchNo } = rowLock(t);
  const stopFirst = matchNo === null ? msg("streamDest.stopFirstUnnamed") : msg("streamDest.stopFirst", { match: msg("breadcrumb.match", { no: matchNo }) });
  const platform = platformName(msg, t.kind);
  const date = fmtPublicDate(locale, UTC, t.createdAt, { day: "numeric", month: "short" });
  const subline = t.keyHint
    ? msg("streamDest.subline", { platform, hint: t.keyHint, date })
    : msg("streamDest.sublineNoHint", { platform, date });
  const badge = badgeOf(t, msg);
  const path = `/api/v1/orgs/${orgId}/stream-targets/${t.id}`;
  const warning = mode === "replace" && isStreamPlatform(t.kind) ? keyShapeWarning(t.kind, key) : null;

  const openRename = () => {
    setMenuOpen(false);
    setName(t.label);
    setMode("rename");
  };
  const openReplace = () => {
    setMenuOpen(false);
    if (locked) return;
    setKey("");
    setShow(false);
    setMode("replace");
  };
  const onRemove = async () => {
    setMenuOpen(false);
    if (locked || busy.current) return;
    busy.current = true;
    try {
      const ok = await confirm({
        title: msg("streamDest.confirmRemove.title", { label: t.label }),
        // D2 vs D6: re-adding the key restores a YouTube / Twitch row; a legacy kind cannot be added at all.
        body: msg(isStreamPlatform(t.kind) ? "streamDest.confirmRemove.body" : "streamDest.confirmRemove.bodyLegacy"),
        confirmLabel: msg("streamDest.remove"),
        cancelLabel: msg("streamDest.cancel"),
        tone: "danger",
        size: "touch",
      });
      if (ok) await run("remove", t.kind, () => apiV1(path, { method: "DELETE" }));
    } finally {
      busy.current = false;
    }
  };
  const onRemoveTap = () => void onRemove();
  const save = async (op: "rename" | "replace", body: { label: string } | { streamKey: string }) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const ok = await run(op, t.kind, () => apiV1(path, { method: "PATCH", json: body }));
      if (ok) setMode(null);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  if (mode === "rename") {
    return (
      <li data-testid="stream-dest-row" data-target-id={t.id} className="px-4 py-3">
        <form
          data-testid="stream-dest-rename-form"
          className="flex flex-wrap items-center gap-3 md:flex-nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() === "") return;
            void save("rename", { label: name.trim() });
          }}
        >
          <PlatformMark kind={t.kind} size="md" />
          <label className="sr-only" htmlFor={`stream-dest-rename-${t.id}`}>{msg("streamDest.name")}</label>
          <input
            id={`stream-dest-rename-${t.id}`}
            data-testid="stream-dest-rename-input"
            className="input min-h-11 min-w-0 flex-1 max-md:basis-[calc(100%-2.75rem)]"
            maxLength={80}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex gap-2 max-md:w-full max-md:pl-11">
            <button type="submit" data-testid="stream-dest-rename-save" disabled={name.trim() === "" || saving} className="btn btn-primary min-h-11">
              {msg("streamDest.renameSave")}
            </button>
            <button type="button" data-testid="stream-dest-rename-cancel" onClick={() => setMode(null)} className="btn btn-ghost min-h-11">
              {msg("streamDest.cancel")}
            </button>
          </div>
        </form>
      </li>
    );
  }

  /** One action as a desktop button or a phone menu item. A locked one is aria-disabled, never `disabled`, so its
   *  reason stays reachable and focusable; a tap on it does nothing. */
  const lockable = (which: "replace" | "remove", asItem: boolean) => {
    const danger = which === "remove";
    const label = msg(danger ? "streamDest.remove" : "streamDest.replaceKey");
    const onClick = danger ? onRemoveTap : openReplace;
    if (asItem) {
      return (
        <button
          type="button"
          role="menuitem"
          data-action={which}
          data-testid={`stream-dest-menu-${which}`}
          aria-disabled={locked || undefined}
          onClick={onClick}
          className={`flex min-h-11 w-full flex-col items-start justify-center rounded-lg px-3 text-left text-sm ${
            locked ? "cursor-not-allowed " + (danger ? "text-red-300" : "text-slate-400") : danger ? "text-red-600 hover:bg-red-50" : "text-slate-800 hover:bg-purple-50"
          }`}
        >
          {label}
          {locked && (
            <span data-testid="stream-dest-locked" className="text-xs text-slate-500">
              {stopFirst}
            </span>
          )}
        </button>
      );
    }
    return (
      <button
        type="button"
        data-testid={`stream-dest-${which}`}
        title={locked ? stopFirst : undefined}
        aria-disabled={locked || undefined}
        onClick={onClick}
        className={`${ACTION} ${danger ? "text-red-600" : "text-slate-700"} ${locked ? "cursor-not-allowed opacity-50" : danger ? "hover:bg-red-50" : "hover:bg-purple-50"}`}
      >
        {label}
        {locked && <span className="sr-only">{` — ${stopFirst}`}</span>}
      </button>
    );
  };

  return (
    <li data-testid="stream-dest-row" data-target-id={t.id} className="px-4 py-3">
      <div className="flex items-start gap-3 md:items-center">
        <PlatformMark kind={t.kind} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{t.label}</p>
          <p data-testid="stream-dest-subline" className="truncate text-xs text-slate-500">{subline}</p>
          {badge && <div className="min-w-0 md:hidden">{badge}</div>}
        </div>
        {badge && <div className="shrink-0 max-md:hidden">{badge}</div>}
        {canEdit && (
          <div data-role="stream-dest-actions" className="flex shrink-0 gap-1 max-md:hidden">
            <button type="button" data-testid="stream-dest-rename" onClick={openRename} className={`${ACTION} text-slate-700 hover:bg-purple-50`}>
              {msg("streamDest.rename")}
            </button>
            {lockable("replace", false)}
            {lockable("remove", false)}
          </div>
        )}
        {canEdit && (
          <button
            type="button"
            data-testid="stream-dest-menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={msg("streamDest.more", { label: t.label })}
            onClick={() => setMenuOpen((v) => !v)}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 md:hidden"
          >
            <Ellipsis aria-hidden className="h-5 w-5" strokeWidth={2} />
          </button>
        )}
      </div>
      {canEdit && menuOpen && (
        <div
          role="menu"
          aria-label={msg("streamDest.more", { label: t.label })}
          className="ml-11 mt-2 rounded-xl border border-slate-200 bg-white p-1 shadow-lg md:hidden"
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenuOpen(false);
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-action="rename"
            data-testid="stream-dest-menu-rename"
            onClick={openRename}
            className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-slate-800 hover:bg-purple-50"
          >
            {msg("streamDest.rename")}
          </button>
          {lockable("replace", true)}
          {lockable("remove", true)}
        </div>
      )}
      {canEdit && mode === "replace" && (
        <form
          data-testid="stream-dest-replace-form"
          className="mt-3 space-y-3 md:pl-11"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim() === "") return;
            void save("replace", { streamKey: key.trim() });
          }}
        >
          {keyField({
            id: `stream-dest-replace-${t.id}`,
            testids: { input: "stream-dest-replace-input", show: "stream-dest-replace-show", warning: "stream-dest-replace-warning" }, label: msg("streamDest.newKey"), value: key, show,
            warning, msg, onChange: setKey, onToggle: () => setShow((v) => !v),
          })}
          <div className="flex gap-2 max-md:flex-col">
            <button type="submit" data-testid="stream-dest-replace-save" disabled={key.trim() === "" || saving} className="btn btn-primary min-h-11">
              {msg("streamDest.replaceSave")}
            </button>
            <button type="button" data-testid="stream-dest-replace-cancel" onClick={() => setMode(null)} className="btn btn-ghost min-h-11">
              {msg("streamDest.cancel")}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
