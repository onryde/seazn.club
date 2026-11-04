// FMT5 (owner-approved mock, 2026-11-03): the division's format is changed from the Fixtures tab's Division rules card,
// freely until the first result exists. `replaceStages` (server/usecases/stages.ts) is the one writer; this file is the
// wire it speaks, client-safe so the Format dialog reads the same codes and the same preview shape the server writes.
//
//  - No fixture in the division: the PUT replaces the stages, as it always has.
//  - Fixtures, none with a result: the PUT clears them and replaces the stages in ONE transaction, but only with the
//    token of a preview (`?clear=<token>`). The preview (`?dry_run=1`) runs the whole change — every refusal it can
//    raise, the body's included — and rolls it back, answering what the change would clear. Its counts are read from
//    the rows the delete takes, never computed by the client.
//  - A result anywhere in the division: 409 FORMAT_LOCKED (`fixtureHasResultSql`, the one "a result exists" set that
//    rebuild and history read).
//
// No runtime import: `import type` only, like `swiss-refusals.ts`.
import type { MessageKey } from "@/lib/messages";

export type FormatChangeCode =
  | "FORMAT_LOCKED"
  | "FORMAT_CHANGE_CONFIRM"
  | "FORMAT_CHANGE_STALE"
  | "FORMAT_STREAM_LIVE";

/** Each refusal's status, the server's English and the key the dialog says it with. The English equals `en/ui.json`
 *  for the key (`lib/__tests__/format-change-copy.test.ts`), with `{match}` filled by the server from the fixture number. */
export const FORMAT_CHANGE_REFUSALS: Readonly<Record<FormatChangeCode, { status: 409; message: string; key: MessageKey }>> = {
  FORMAT_LOCKED: {
    status: 409,
    message: "Format is locked once scoring starts.",
    key: "formatChange.err.FORMAT_LOCKED",
  },
  FORMAT_CHANGE_CONFIRM: {
    status: 409,
    message: "Changing the format clears this division's fixtures. Check what will be cleared, then confirm.",
    key: "formatChange.err.FORMAT_CHANGE_CONFIRM",
  },
  FORMAT_CHANGE_STALE: {
    status: 409,
    message: "The fixtures changed since you opened this. Check what will be cleared again.",
    key: "formatChange.err.FORMAT_CHANGE_STALE",
  },
  FORMAT_STREAM_LIVE: {
    status: 409,
    message: "{match} is streaming. End the stream before you change the format.",
    key: "formatChange.err.FORMAT_STREAM_LIVE",
  },
};

export function isFormatChangeCode(code: unknown): code is FormatChangeCode {
  return typeof code === "string" && Object.hasOwn(FORMAT_CHANGE_REFUSALS, code);
}

/** What a format change would clear: the answer of `PUT /divisions/{id}/stages?dry_run=1`, and the `preview` member
 *  of a FORMAT_CHANGE_CONFIRM / FORMAT_CHANGE_STALE refusal's error body. Every count is read from the rows the change deletes. */
export interface FormatChangePreview {
  dry_run: true;
  /** The stages the change replaces, in board order. */
  stages: { id: string; name: string }[];
  /** The division's fixtures, every one unplayed (a played one refuses FORMAT_LOCKED). */
  fixtures: number;
  /** Of those, the ones with a time on the schedule. */
  slots: number;
  /** The distinct courts those fixtures sit on. */
  courts: number;
  /** Organiser setup that goes with the fixtures (`ON DELETE CASCADE`). */
  officials: number;
  lineups: number;
  device_links: number;
  /** Match Day calls on those fixtures. */
  calls: number;
  /** The token the change must send back as `?clear=` — null when no fixture exists and there is nothing to confirm. */
  token: string | null;
}

/** The preview a refusal's error body (`{code, message, preview}`) carries, when it carries one. */
export function previewOf(details: unknown): FormatChangePreview | null {
  if (typeof details !== "object" || details === null) return null;
  const p = (details as { preview?: unknown }).preview;
  if (typeof p !== "object" || p === null || (p as { dry_run?: unknown }).dry_run !== true) return null;
  return p as FormatChangePreview;
}
