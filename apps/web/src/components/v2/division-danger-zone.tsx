"use client";

// Division delete/archive (v3/09 §4). Delete asks for the typed division
// name and states exactly what is destroyed vs kept; a 409
// DIVISION_HAS_RESULTS pivots the dialog to the archive suggestion. Archive
// uses a plain danger confirm — it is reversible from competition settings.
// A paid Online Chess package (spec 2026-11-23 §11): the delete dialog says what
// its refund gives back, and archive — which holds the package — says how to
// get the credits back (switch Online Chess off), off the server's own figure,
// led by WHY it can still come back (no round has opened) and in a paragraph of
// its own (Task 15 fix round 2, owner: read inside the refused delete's results
// sentence it promised a refund mid-event). A paid package a round has frozen is
// never refunded, and both dialogs say so.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { routes } from "@/lib/routes";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";

interface Props {
  divisionId: string;
  divisionName: string;
  orgSlug: string;
  compSlug: string;
  /**
   * Would archiving this division keep its `divisions.per_competition.max`
   * slot spent? (V354 — recorded results, minus a staff waiver.)
   *
   * Passed DOWN from the division page rather than fetched here. The answer is
   * a SQL predicate (`division_has_results`), it is the same predicate the
   * quota charge uses, and there is no v1 endpoint that exposes it — inventing
   * one so a client component could ask would put a second copy of the rule on
   * the wire for the sake of one boolean the server already had in hand.
   *
   * Named for the CONSEQUENCE, not for "has results": those two answers differ
   * exactly when staff have waived the slot, and in that state the fixtures
   * are still there but the charge is not. Warning a supported org that their
   * slot will not come back — after support handed it back — is the same
   * species of lie this warning exists to remove.
   *
   * Optional, defaulting to false: `false` renders what this component always
   * rendered, so a caller that has not been taught the question yet shows no
   * warning rather than an unconditional one.
   */
  slotHeldOnArchive?: boolean;
  /**
   * The division's paid Online Chess package, as the SERVER reads its refund
   * (`divisionPackageRefund`, the refund's own split — never worked out here):
   * unfrozen, the credits that come back, the included credits of an earlier
   * month that do not, and whether a delete would take it (`onDelete`: false
   * once the division has started, when the delete is refused); frozen (a round
   * has opened), `{ frozen: true }` and no figure — it is never refunded (P7).
   * Null or absent: no money was paid (none, unpaid), and no money line shows.
   */
  packageRefund?: { back: number; forfeited: number; onDelete: boolean; frozen?: never } | { frozen: true } | null;
}

export function DivisionDangerZone({
  divisionId,
  divisionName,
  orgSlug,
  compSlug,
  slotHeldOnArchive = false,
  packageRefund = null,
}: Props) {
  const msg = useMsg();
  const plural = useMsgPlural();
  // A frozen package has no figure: it is never refunded, and the dialogs say exactly that.
  const frozen = packageRefund?.frozen === true;
  const refund = packageRefund !== null && packageRefund.frozen !== true ? packageRefund : null;
  // Archive holds the package (§11), so wherever archive is offered and credits would come back, the organiser is told the
  // door that gives them back. Nothing to get back (every credit an earlier month's) is nothing to say.
  const switchOffBack = refund !== null && refund.back > 0 ? refund.back : null;
  const router = useRouter();
  const [dialog, setDialog] = useState<"none" | "delete" | "archive">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestArchive, setSuggestArchive] = useState(false);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}`, { method: "DELETE" });
      router.push(routes.competition(orgSlug, compSlug));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "DIVISION_HAS_RESULTS") {
        setSuggestArchive(true);
        setDialog("archive");
      } else {
        setError(err instanceof Error ? err.message : msg("danger.deleteFailed"));
        setDialog("none");
      }
    } finally {
      setBusy(false);
    }
  }

  async function doArchive() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/archive`, { method: "POST" });
      router.push(routes.competition(orgSlug, compSlug));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("danger.archiveFailed"));
      setDialog("none");
    } finally {
      setBusy(false);
    }
  }

  return (
    // No own card/heading: the settings "Danger zone" disclosure Group is the
    // card AND the label — the inner h2 duplicated it ("Danger zone" twice).
    <section>
      <p className="text-xs text-slate-500">{msg("danger.desc")}</p>
      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      {/* BEFORE the button, not inside the confirm dialog and not after the
          redirect. `danger.archiveBody` still promises the division "stops
          counting against your plan", which is true for the unplayed division
          people archive by mistake and false for a played one — and the org
          only found out when a later create hit a paywall it could not see the
          cause of. Amber rather than red: nothing here is destructive or
          refused, it is a price the reader has not been told. */}
      {slotHeldOnArchive && (
        <p
          data-slot-warning
          className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700"
        >
          {msg("division.archive.slotWarning")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-ghost text-slate-600"
          onClick={() => {
            setSuggestArchive(false);
            setDialog("archive");
          }}
          disabled={busy}
        >
          {msg("danger.archive")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => setDialog("delete")}
          disabled={busy}
        >
          {msg("danger.delete")}
        </button>
      </div>

      <ConfirmDialog
        open={dialog === "delete"}
        title={msg("danger.deleteTitle", { name: divisionName })}
        confirmLabel={msg("danger.deleteConfirm")}
        typedName={divisionName}
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDialog("none")}
      >
        <p>
          <strong>{msg("danger.destroyedLabel")}</strong> {msg("danger.destroyedText")}
        </p>
        <p>
          <strong>{msg("danger.keptLabel")}</strong> {msg("danger.keptText")}
        </p>
        {/* Only when the delete would take the package: a started division's delete is refused, and a refund it never makes
            is not promised here (the refused delete's pivot below says what to do instead). */}
        {refund !== null && refund.onDelete && (
          <p data-online-refund>
            <strong>{msg("danger.refundedLabel")}</strong> {plural("danger.onlineRefund", refund.back, { count: refund.back })}
            {refund.forfeited > 0 && <> {plural("danger.onlineForfeit", refund.forfeited, { count: refund.forfeited })}</>}
          </p>
        )}
        {frozen && <p data-online-frozen>{msg("danger.onlineFrozen")}</p>}
        <p>{msg("danger.cannotUndo")}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "archive"}
        title={msg("danger.archiveTitle", { name: divisionName })}
        confirmLabel={msg("danger.archiveConfirm")}
        busy={busy}
        onConfirm={() => void doArchive()}
        onCancel={() => setDialog("none")}
      >
        {/* The refused delete's reason, about results only: the money is its own paragraph below (fix round 2). */}
        {suggestArchive && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-700">{msg("danger.suggestArchive")}</p>
        )}
        {/* The same fork as the warning above the button, off the same prop —
            the two sit one glance apart and until now they disagreed.
            `danger.archiveBody` promises the division "stops counting against
            your plan": true for the unplayed division archived by mistake,
            false for a played one. So the held case gets its own sentence
            rather than a hedge bolted onto copy that is already correct for
            the case people actually hit. `slotHeldOnArchive` is false for a
            staff-waived division, which is exactly right — support has handed
            the slot back, so that archive really is free. */}
        <p>{msg(slotHeldOnArchive ? "danger.archiveBodySlotHeld" : "danger.archiveBody")}</p>
        {/* The way to get the credits back, led by why they still can (no round has opened yet): from the Archive button and
            under the refused delete's pivot alike, once. A frozen package has no way back, and says so. */}
        {switchOffBack !== null && (
          <p data-online-archive-hint className="rounded-md bg-amber-50 px-3 py-2 text-amber-700">
            {plural("danger.archiveOnline", switchOffBack, { count: switchOffBack })}
          </p>
        )}
        {frozen && <p data-online-frozen>{msg("danger.onlineFrozen")}</p>}
      </ConfirmDialog>
    </section>
  );
}
