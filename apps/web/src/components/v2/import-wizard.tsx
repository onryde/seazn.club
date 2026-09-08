"use client";

// Import wizard (Jul3/01 §8): upload → column mapper (remembered per org) →
// preview grouped by club with per-row op badges + issue list → Commit.
// The preview IS the ImportPlan rendered — no surprise writes.
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
// RS011 review round 3, finding 2: `commitImport` (server/usecases/
// imports.ts) runs the SAME eligibility gate `putLineup`/roster-write
// endpoints do and can 422 ELIGIBILITY_VIOLATION, but `commit()` had no
// recovery path for it — same gap as `lineup-editor.tsx`'s finding 1, same
// dialog, same retry-wiring pattern.
import type { EligibilityIssue } from "@/lib/registration-rules";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";

const FIELDS: [string, MessageKey][] = [
  ["", "import.field.ignore"],
  ["clubName", "import.field.club"],
  ["clubShortName", "import.field.clubShort"],
  ["clubExternalRef", "import.field.clubRef"],
  ["teamName", "import.field.team"],
  ["teamShortName", "import.field.teamShort"],
  ["playerFullName", "import.field.player"],
  ["dob", "import.field.dob"],
  ["gender", "import.field.gender"],
  ["squadNumber", "import.field.squad"],
  ["position", "import.field.position"],
  ["isCaptain", "import.field.captain"],
  ["divisionSlug", "import.field.division"],
  ["entrantDisplayName", "import.field.entrant"],
];

interface ImportIssue {
  rowNo: number;
  column?: string;
  severity: "error" | "warn";
  code: string;
  message: string;
  messageArgs?: Record<string, string>;
}

// code -> localized (message key, badge key). Codes not listed here fall back
// to the server's English message + raw code badge (Jul3/01 §4 issue codes).
const ISSUE_I18N: Record<string, { messageKey: MessageKey; badgeKey: MessageKey }> = {
  DIVISION_NOT_FOUND: {
    messageKey: "import.error.divisionNotFound",
    badgeKey: "import.issueCode.divisionNotFound",
  },
};
/** A plan target: either an existing row's id or a forward reference to
 *  another op in this same plan (`packages/engine/src/import/types.ts`). */
interface OpTarget {
  id?: string;
  ref?: string;
}
interface ImportOp {
  kind: string;
  ref?: string;
  sourceRows: number[];
  after?: Record<string, unknown>;
  /** `squad.add` names its person by target rather than carrying a name —
   *  the preview resolves it back through the plan's own `person.create`. */
  person?: OpTarget;
  team?: OpTarget;
}
interface ImportPlan {
  ops: ImportOp[];
  stats: { clubs: number; teams: number; persons: number; entrants: number; rosters: number; squads: number };
  issues: ImportIssue[];
}
interface Preview {
  importId: string;
  filename: string;
  rowCount: number;
  mapping?: Record<string, string>;
  plan: ImportPlan;
}
interface CommitResult {
  importId: string;
  stats: ImportPlan["stats"];
  divisionIds: string[];
}

/** Exported for `import-wizard-op-badges.test.ts`, which derives the kinds
 *  from the engine's own `ImportOp` union and fails when a new one arrives
 *  unmapped — the fallback prints the raw kind, which is silent. */
export const OP_BADGE: Record<string, { labelKey: MessageKey; cls: string }> = {
  "club.create": { labelKey: "import.op.clubCreate", cls: "bg-emerald-50 text-emerald-700" },
  "club.update": { labelKey: "import.op.clubUpdate", cls: "bg-sky-50 text-sky-700" },
  "team.create": { labelKey: "import.op.teamCreate", cls: "bg-emerald-50 text-emerald-700" },
  "team.link": { labelKey: "import.op.teamLink", cls: "bg-sky-50 text-sky-700" },
  "person.create": { labelKey: "import.op.personCreate", cls: "bg-emerald-50 text-emerald-700" },
  "entrant.create": { labelKey: "import.op.entrantCreate", cls: "bg-violet-50 text-violet-700" },
  "roster.add": { labelKey: "import.op.rosterAdd", cls: "bg-slate-100 text-slate-600" },
  // W4. Missing this row did not fail anything — an unmapped kind falls back
  // to `op.kind`, so the preview printed a literal "squad.add" chip beside
  // the friendly ones. Found by looking at the screen, not by a test.
  "squad.add": { labelKey: "import.op.squadAdd", cls: "bg-slate-100 text-slate-600" },
};

async function postForm<T>(url: string, form: FormData, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, { method: "POST", body: form, headers });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; [k: string]: unknown };
  };
  if (!res.ok || payload.ok === false) {
    const { code = "UNKNOWN", message, ...extra } = payload.error ?? {};
    throw new ApiV1Error(message ?? `Request failed (${res.status})`, res.status, code, extra);
  }
  return payload.data as T;
}

export function ImportWizard({ viewerPlan }: { viewerPlan: ViewerPlan }) {
  const msg = useMsg();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CommitResult | null>(null);
  const [warnsAcknowledged, setWarnsAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // RS011 review round 3, finding 2: pending override-dialog state, set only
  // while a commit is blocked on ELIGIBILITY_VIOLATION and waiting on the
  // organiser — same shape as `entrants-panel.tsx`'s `eligibilityGate`.
  const [eligibilityGate, setEligibilityGate] = useState<{
    violations: EligibilityIssue[];
  } | null>(null);

  const errors = preview?.plan.issues.filter((i) => i.severity === "error") ?? [];
  const warns = preview?.plan.issues.filter((i) => i.severity === "warn") ?? [];

  function fail(err: unknown) {
    if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
      setPaywallFeature(String(err.extra.feature_key ?? ""));
    } else {
      setError(err instanceof Error ? err.message : msg("import.failed"));
    }
  }

  async function upload(selected: File, withMapping?: Record<string, string>) {
    setError(null);
    setPaywallFeature(null);
    setResult(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", selected);
      const remembered =
        withMapping ??
        (JSON.parse(localStorage.getItem("import-mapping") ?? "null") as Record<string, string> | null) ??
        undefined;
      if (remembered && Object.keys(remembered).length > 0) {
        form.append("mapping", JSON.stringify(remembered));
      }
      const data = await postForm<Preview>("/api/v1/imports", form);
      setPreview(data);
      setMapping(data.mapping ?? {});
      setWarnsAcknowledged(false);
    } catch (err) {
      // A refused NEW FILE must take the previous file's plan with it.
      // Otherwise the last good preview stays mounted under the paywall with
      // its "Commit import" button live, and pressing it imports a file the
      // organiser was just told was rejected.
      //
      // `withMapping` is the discriminator, and only `remap()` passes it. A
      // failed RE-MAP must KEEP the preview: the mapping selects and the
      // "Re-map & re-preview" button both live inside `{preview && !result}`,
      // so clearing there removes the very control needed to retry — and
      // `remap()` has already written the rejected mapping to localStorage, so
      // every later upload re-sends it. The organiser is left with a bare file
      // input and an error telling them to map headers they can no longer see.
      // The plan kept in that case belongs to the SAME file, so committing it
      // is legitimate; it is not the wrong-file hazard above.
      //
      // In the catch rather than at the top of `upload()`, so a SUCCESSFUL
      // remap does not unmount the card mid-flight. And not in `fail()`, which
      // the commit path shares: a commit 402 must leave the plan on screen to
      // trim. (It does so by never clearing `preview` at all — `commit()`
      // handles 402 inline and returns before `fail()` is reached.)
      if (withMapping === undefined) setPreview(null);
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function remap() {
    if (!file) return;
    localStorage.setItem("import-mapping", JSON.stringify(mapping));
    await upload(file, mapping);
  }

  /** RS011 review round 3, finding 2: `override` is only ever passed on a
   *  confirmed retry from `EligibilityOverrideDialog` below — a plain Commit
   *  tap calls this with none. Re-POSTing is safe: `commitImport` re-plans
   *  and evaluates the whole commit inside ONE transaction that rolls back
   *  entirely on the 422 (nothing is written, and nothing is cached under
   *  the idempotency key — that only happens after a transaction actually
   *  commits), so a retry with the SAME `Idempotency-Key` re-runs the full
   *  plan → gate → execute sequence from scratch rather than replaying or
   *  double-executing any part of a prior attempt. Unlike `entrants-
   *  panel.tsx`'s CSV bulk-add, this client has no one-time side effect
   *  (person creation, etc.) ahead of the gated call to worry about — the
   *  whole commit lives server-side in one transaction. */
  async function commit(override?: { reason: string }) {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/imports/${preview.importId}/commit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": preview.importId,
        },
        body: JSON.stringify(override ? { eligibility_override: override } : {}),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        data?: CommitResult;
        error?: {
          code?: string;
          message?: string;
          feature_key?: string;
          violations?: EligibilityIssue[];
        };
      };
      if (!res.ok || payload.ok === false) {
        if (res.status === 402) {
          setPaywallFeature(String(payload.error?.feature_key ?? ""));
          return;
        }
        if (payload.error?.code === "ELIGIBILITY_VIOLATION") {
          setEligibilityGate({ violations: payload.error.violations ?? [] });
          return;
        }
        throw new Error(payload.error?.message ?? msg("import.commitFailed"));
      }
      setEligibilityGate(null);
      setResult(payload.data!);
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // Preview rows grouped by club ref/name (Jul3/01 §8 "grouped by club").
  const grouped = useMemo(() => {
    if (!preview) return [];
    const groups = new Map<string, ImportOp[]>();
    for (const op of preview.plan.ops) {
      const club =
        op.kind.startsWith("club.")
          ? String(op.after?.name ?? op.ref ?? "")
          : String((op.after?.club as { ref?: string } | undefined)?.ref ?? "").replace(/^club:/, "") ||
            (op.ref?.startsWith("team:club:") ? op.ref.slice("team:club:".length).split("/")[0]! : "");
      const key = club || msg("import.noClub");
      const list = groups.get(key) ?? [];
      list.push(op);
      groups.set(key, list);
    }
    return [...groups.entries()];
  }, [preview]);

  /** Forward-ref → the name the op creates. `squad.add` points at a person by
   *  ref, so without this its chip reads as a bare label with no player on it,
   *  which is the least useful line in the preview. A target that is an
   *  existing `id` has no name in the plan at all — the chip then carries the
   *  label alone, exactly as it did before. */
  const nameByRef = useMemo(() => {
    const byRef = new Map<string, string>();
    for (const op of preview?.plan.ops ?? []) {
      if (!op.ref) continue;
      const name = op.after?.name ?? op.after?.fullName ?? op.after?.displayName;
      if (name) byRef.set(op.ref, String(name));
    }
    return byRef;
  }, [preview]);

  return (
    <div className="space-y-5">
      <section className="card space-y-3 p-4">
        <label className="block text-sm font-medium text-slate-700" htmlFor="import-file">
          {msg("import.file")}
        </label>
        <input
          id="import-file"
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f) void upload(f);
          }}
        />
        <p className="text-xs text-slate-500">{msg("import.fileHint")}</p>
      </section>

      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {preview && !result && (
        <>
          <section className="card space-y-3 p-4">
            <h2 className="text-sm font-semibold text-slate-900">{msg("import.mapping")}</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {Object.keys(preview.mapping ?? mapping).length === 0 && (
                <p className="text-sm text-slate-500">{msg("import.noHeaders")}</p>
              )}
              {Object.entries(mapping).map(([header, field]) => (
                <label key={header} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm">
                  <span className="truncate font-mono text-xs text-slate-500">{header}</span>
                  <select
                    className="input w-40"
                    value={field}
                    aria-label={msg("import.mapColumn", { header })}
                    onChange={(e) => setMapping((m) => ({ ...m, [header]: e.target.value }))}
                  >
                    {FIELDS.map(([value, labelKey]) => (
                      <option key={value} value={value}>{msg(labelKey)}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button type="button" className="btn" onClick={remap} disabled={busy || !file}>
              {msg("import.remap")}
            </button>
          </section>

          <section className="card space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                {msg("import.preview", { filename: preview.filename, rows: preview.rowCount })}
              </h2>
              <p className="text-xs text-slate-500">
                {msg("import.stats", {
                  clubs: preview.plan.stats.clubs,
                  teams: preview.plan.stats.teams,
                  persons: preview.plan.stats.persons,
                  entrants: preview.plan.stats.entrants,
                  rosters: preview.plan.stats.rosters,
                  squads: preview.plan.stats.squads,
                })}
              </p>
            </div>

            {preview.plan.issues.length > 0 && (
              <ul className="space-y-1" aria-label={msg("import.issuesAria")}>
                {preview.plan.issues.map((issue, i) => {
                  const i18nEntry = ISSUE_I18N[issue.code];
                  const message =
                    i18nEntry && issue.messageArgs
                      ? msg(i18nEntry.messageKey, issue.messageArgs)
                      : issue.message;
                  const badgeLabel = i18nEntry ? msg(i18nEntry.badgeKey) : issue.code;
                  return (
                    <li
                      key={i}
                      className={`rounded-md px-3 py-1.5 text-sm ${
                        issue.severity === "error"
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {msg("import.row", { n: issue.rowNo })}
                      {issue.column ? ` (${issue.column})` : ""}: {message}
                      <span className="ml-2 font-mono text-xs opacity-70">{badgeLabel}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            {preview.plan.ops.length === 0 ? (
              <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg("import.nothing")}</p>
            ) : (
              <div className="space-y-3">
                {grouped.map(([club, ops]) => (
                  <div key={club}>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {club}
                    </h3>
                    <ul className="flex flex-wrap gap-1.5">
                      {ops.map((op, i) => {
                        const badge = OP_BADGE[op.kind];
                        const badgeLabel = badge ? msg(badge.labelKey) : op.kind;
                        const badgeCls = badge?.cls ?? "bg-slate-100 text-slate-600";
                        const name =
                          op.kind === "squad.add"
                            ? (op.person?.ref ? (nameByRef.get(op.person.ref) ?? "") : "")
                            : String(
                                op.after?.name ?? op.after?.fullName ?? op.after?.displayName ?? op.ref ?? "",
                              );
                        return (
                          <li
                            key={i}
                            className={`rounded-full px-2 py-0.5 text-xs ${badgeCls}`}
                            title={msg("import.rowsTitle", { rows: op.sourceRows.join(", ") })}
                          >
                            <span className="font-medium">{badgeLabel}</span> {name}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
              {warns.length > 0 && (
                <label className="flex items-center gap-2 text-sm text-amber-700">
                  <input
                    type="checkbox"
                    checked={warnsAcknowledged}
                    onChange={(e) => setWarnsAcknowledged(e.target.checked)}
                  />
                  {msg("import.reviewedWarnings", { n: warns.length })}
                </label>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy ||
                  errors.length > 0 ||
                  preview.plan.ops.length === 0 ||
                  (warns.length > 0 && !warnsAcknowledged)
                }
                onClick={() => void commit()}
              >
                {errors.length > 0 ? msg("import.fixErrors") : msg("import.commit")}
              </button>
            </div>
          </section>
        </>
      )}

      <EligibilityOverrideDialog
        open={eligibilityGate !== null}
        violations={eligibilityGate?.violations ?? []}
        busy={busy}
        onCancel={() => setEligibilityGate(null)}
        onConfirm={(reason) => void commit({ reason })}
        testId="import-eligibility-override"
      />

      {result && (
        <section className="card space-y-2 p-4">
          <h2 className="text-sm font-semibold text-emerald-700">{msg("import.committed")}</h2>
          <p className="text-sm text-slate-600">
            {msg("import.stats", {
              clubs: result.stats.clubs,
              teams: result.stats.teams,
              persons: result.stats.persons,
              entrants: result.stats.entrants,
              rosters: result.stats.rosters,
              squads: result.stats.squads,
            })}
            {result.divisionIds.length > 0 ? msg("import.acrossDivisions", { n: result.divisionIds.length }) : ""}.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPreview(null);
              setResult(null);
              setFile(null);
              if (fileRef.current) fileRef.current.value = "";
            }}
          >
            {msg("import.another")}
          </button>
        </section>
      )}
    </div>
  );
}
