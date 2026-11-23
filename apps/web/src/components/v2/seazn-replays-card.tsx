"use client";
// Seazn-hosted video (Task 25): the fixture stream panel's list of the fixture's Seazn replays, in its ended card. Each part the replay
// move made (the session view's `seaznReplays`, server/video/organiser-replays.ts), in part order, with its state in words: getting
// ready, ready (on the public match page, or not when the public cannot see the match: Task 25 review m3), or failed — and a failed
// part says that the original recording still plays meanwhile, where it plays, and until when (m3). A part is labelled "Part {n}" only
// when there are two or more, as the panel's YouTube replay row labels its parts. Nothing at all when there is none.
//
// Task 26: every part has Delete (the house confirm first, danger tone, touch size), and a playable part has Download — a link to the
// download route, which streams the file as an attachment (no token, no address of the host: the route is the only thing the browser
// talks to). The delete's flow (`deleteSeaznReplayFlow`) is a plain async function so the node-only tests drive it; the hook is glue.
//
// The panel's own row style (a slate-bordered box, the slate chip): one quiet line per part, the state's colour on a small dot, the
// failure in red words, the actions under the state at every width (44 px targets). The card is a pure function of its props, as the
// panel's body is.
import { useCallback, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-provider";
import { apiV1 } from "@/lib/client-v1";
import { DELETE_RECORDING_AFTER_DAYS } from "@/server/relay/config";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";

type Replay = StreamSessionCurrent["seaznReplays"][number];

/** The download route of a part: the only address the panel gives the browser for the file. */
export const replayDownloadHref = (fixtureId: string, replayId: string): string =>
  `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/replays/${encodeURIComponent(replayId)}/download`;

/** What the panel holds for the card's Delete: which part is being deleted, which one failed to, the parts deleted here (hidden at
 *  once, before the next read of the session view drops them), and the action. */
export interface SeaznReplayActions {
  deleting: string | null;
  failed: string | null;
  gone: ReadonlySet<string>;
  onDelete: (replay: Replay, multi: boolean) => void;
}

/** The delete, step by step: the confirm (nothing happens unless the organiser confirms), the route, then a fresh read of the view.
 *  A refusal of the route is the row's failure; a failed re-read is not (the part is already deleted, and hidden). */
export async function deleteSeaznReplayFlow(d: {
  fixtureId: string;
  replay: Replay;
  confirm: () => Promise<boolean>;
  del: (url: string) => Promise<unknown>;
  reread: () => Promise<unknown>;
}): Promise<"cancelled" | "deleted" | "failed"> {
  if (!(await d.confirm())) return "cancelled";
  try {
    await d.del(`/api/v1/fixtures/${encodeURIComponent(d.fixtureId)}/replays/${encodeURIComponent(d.replay.id)}`);
  } catch {
    return "failed";
  }
  await d.reread().catch(() => undefined);
  return "deleted";
}

/** The panel's hook: the flow over the house confirm and the v1 client, and the state the card shows. `reread` is the session view's
 *  own read (`usePhoneSession().read`). */
export function useSeaznReplayActions(fixtureId: string, reread: () => Promise<unknown>): SeaznReplayActions {
  const msg = useMsg();
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const onDelete = useCallback(
    (replay: Replay, multi: boolean) => {
      if (deleting !== null) return;
      const options: ConfirmOptions = {
        title: multi ? msg("stream.replay.deletePartTitle", { n: replay.partNo }) : msg("stream.replay.delete"),
        body: msg("stream.replay.deleteConfirm"),
        confirmLabel: msg("stream.replay.delete"),
        cancelLabel: msg("stream.replay.deleteKeep"),
        tone: "danger",
        size: "touch",
      };
      void deleteSeaznReplayFlow({
        fixtureId,
        replay,
        confirm: async () => {
          const ok = await confirm(options);
          if (ok) {
            setFailed(null);
            setDeleting(replay.id);
          }
          return ok;
        },
        del: (url) => apiV1(url, { method: "DELETE" }),
        reread,
      }).then((outcome) => {
        if (outcome === "deleted") setGone((g) => new Set(g).add(replay.id));
        if (outcome === "failed") setFailed(replay.id);
        if (outcome !== "cancelled") setDeleting(null);
      });
    },
    [confirm, deleting, fixtureId, msg, reread],
  );
  return { deleting, failed, gone, onDelete };
}
/** The state's words. A playable part names where it plays (m3): the public match page, or not when the public cannot see it. */
const stateKey = (p: Replay) =>
  p.state === "processing"
    ? "stream.replay.seazn.processing"
    : p.state === "failed"
      ? "stream.replay.seazn.failed"
      : p.onMatchPage
        ? "stream.replay.seazn.ready"
        : "stream.replay.seazn.readyPrivate";
const DOT = { processing: "bg-amber-500", playable: "bg-emerald-500", failed: "bg-red-500" } as const;
const WORDS = { processing: "text-slate-700", playable: "text-slate-700", failed: "text-red-700" } as const;

/** A replay's length as a clock (`m:ss`, `h:mm:ss` from an hour); null for a length that is not a whole number of seconds. */
export function replayLength(seconds: number | null): string | null {
  if (seconds === null || !Number.isInteger(seconds) || seconds < 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** `replays` absent: a view from a server older than the field (a deploy in flight), which has none to show. */
export function SeaznReplaysCard({ fixtureId, replays, actions }: { fixtureId: string; replays: readonly Replay[] | undefined; actions: SeaznReplayActions }) {
  const msg = useMsg();
  if (replays === undefined) return null;
  const parts = replays.filter((p) => !actions.gone.has(p.id)).sort((a, b) => a.partNo - b.partNo);
  if (parts.length === 0) return null;
  const multi = parts.length > 1;
  return (
    <section data-testid="stream-seazn-replays" className="min-w-0 space-y-2 rounded-lg border border-slate-200 p-3">
      <p className="text-sm font-semibold text-slate-900">{msg("stream.replay.seazn.title")}</p>
      <ul className="space-y-3">
        {parts.map((p) => {
          const length = p.state === "playable" ? replayLength(p.lengthSeconds) : null;
          const deleting = actions.deleting === p.id;
          // Two or more parts: each action's name says WHICH part (read by a screen reader after the visible words, so the name starts
          // with what is on the button).
          const which = multi ? <span className="sr-only"> {msg("stream.replay.seazn.part", { n: p.partNo })}</span> : null;
          return (
            <li
              key={p.id}
              data-testid="stream-seazn-replay"
              data-state={p.state}
              className={`min-w-0 text-sm ${multi ? "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3" : ""}`}
            >
              {/* The label column and the state column stay aligned row to row; a long state wraps under itself, never under the label.
                  The actions sit under the state from md; on a phone they take the card's whole width (each button growing to fill its line), so
                  a long label (nl, fr) never wraps inside a button squeezed into the state column. */}
              {multi && <span className="font-medium tabular-nums text-slate-900">{msg("stream.replay.seazn.part", { n: p.partNo })}</span>}
              <div className="min-w-0 space-y-2">
                <span className={`flex min-w-0 items-start gap-2 ${WORDS[p.state]}`}>
                  <span aria-hidden className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${DOT[p.state]}`} />
                  <span className="min-w-0">
                    {msg(stateKey(p))}
                    {length !== null && <span className="ml-2 inline-block rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-700">{length}</span>}
                  </span>
                </span>
                {p.state === "failed" && (
                  <p data-testid="stream-seazn-replay-interim" className="pl-4 text-xs text-slate-600">
                    {msg(p.onMatchPage ? "stream.replay.seazn.failedStillPlays" : "stream.replay.seazn.failedStillPlaysPrivate", { days: DELETE_RECORDING_AFTER_DAYS })}
                  </p>
                )}
              </div>
              <div data-testid="stream-seazn-replay-actions" className={`mt-2 flex flex-wrap gap-2 md:pl-4 ${multi ? "col-span-full md:col-start-2" : ""}`}>
                {p.state === "playable" && (
                  <a
                    data-testid="stream-seazn-replay-download"
                    href={replayDownloadHref(fixtureId, p.id)}
                    download
                    className="btn btn-ghost min-h-11 max-md:grow"
                  >
                    <Download aria-hidden className="h-4 w-4" />
                    {msg("stream.replay.download")}
                    {which}
                  </a>
                )}
                <button
                  type="button"
                  data-testid="stream-seazn-replay-delete"
                  disabled={actions.deleting !== null}
                  aria-busy={deleting || undefined}
                  onClick={() => actions.onDelete(p, multi)}
                  className="btn btn-danger min-h-11 max-md:grow"
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                  {deleting ? msg("stream.replay.deleting") : msg("stream.replay.delete")}
                  {which}
                </button>
              </div>
              {actions.failed === p.id && (
                <p role="alert" data-testid="stream-seazn-replay-delete-failed" className={`mt-2 text-xs text-red-700 md:pl-4 ${multi ? "col-span-full md:col-start-2" : ""}`}>
                  {msg("stream.replay.deleteFailed")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
