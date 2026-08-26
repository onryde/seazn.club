// Registration hub — Registrants tab, the row-expand detail (RS005 W2b
// task 2). A plain server component — no "use client", no hooks — every
// field row below is a host-element <div>/<dt>/<dd>, deliberately never a
// wrapped custom component: the hook-harness's walk()/textOf() only expand
// a nested CUSTOM component when the test manually invokes it (see
// _hook-harness.tsx's own header), and every OTHER field on this row is a
// plain string/derived value with nothing worth extracting a component
// for — so this file stays fully walkable/textOf'able from its test with
// no manual-invoke ceremony anywhere. The ONE genuine exception is the
// join-code copy control (registration-hub-registrant-join-code.tsx),
// which is deliberately its own "use client" component (see that file's
// header) and IS found by `e.type === RegistrationHubRegistrantJoinCode`
// in tests rather than walked into.
//
// Deliberately does NOT import anything from registration-hub-registrant-
// table.tsx: that file imports THIS one (to render inside each row's
// <details>), and a back-import here would make the two modules circular.
// The one piece that file's cell renderers could have supplied (the
// formatted amount) is inlined instead — a few lines, not worth a
// cross-file dependency in the wrong direction.
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { formatMinor, asCurrency } from "@/lib/currency";
import { fmtDateTime } from "@/lib/format";
import { isTerminalRegistrationStatus } from "@/lib/registration-status";
import type { RegistrationFormField } from "@/server/api-v1/schemas";
import type { RegistrationListRow } from "@/server/usecases/registrations";
import type { RegistrantRosterPlayer, RegistrantCartSibling } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import {
  REGISTRANT_STATUS_STYLE,
  CONSENT_STATUS_STYLE,
  deriveRegistrantPaymentState,
  answerLabel,
  registrantRowAnchor,
} from "@/components/registration-hub-registrant-derive";
import { RegistrationHubRegistrantJoinCode } from "@/components/registration-hub-registrant-join-code";
import { deriveRegistrantActionFlags } from "@/components/registration-hub-registrant-derive";
import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";

export interface RegistrationHubRegistrantDetailProps {
  row: RegistrationListRow;
  dict: Dict;
  /** organizations.timezone (or DEFAULT_TZ) — same org lane the table's
   *  submittedAt column and the Settings tab's window column already use. */
  orgTz: string;
  /** Owner ruling (2026-08-25): the join code is a bearer secret that grants
   *  a WRITE (adding players to the roster) a viewer does not otherwise
   *  have — absent for a viewer, never merely disabled. */
  canEdit: boolean;
  /** Already resolved for THIS row and ordered by the data layer
   *  (fetchRegistrantDetails) — this component renders the order it is
   *  given, it does not re-sort. */
  roster: RegistrantRosterPlayer[];
  /** THIS row's own id already excluded by the caller — every entry here is
   *  a genuine OTHER member of the cart. Empty means "alone in its cart",
   *  which is why the section is absent rather than shown empty (task 4). */
  siblings: RegistrantCartSibling[];
  /** This entry's OWN division's declared fields (task 3's 2-query design —
   *  see fetchRegistrantDetails) — used only for the answers label lookup. */
  formFields: RegistrationFormField[];
  /** The Registrants tab's base URL with NO filters applied — required for
   *  a cart-sibling's link to actually resolve: the sibling may not match
   *  whatever filter produced the CURRENT row set (a different status, for
   *  instance), so the link clears filters and relies on the anchor hash
   *  (registrantRowAnchor) to land on the right row once the page reloads
   *  unfiltered. Same value as the panel's own `clearHref`. */
  baseHref: string;
}

function detailField(label: string, value: ReactNode): ReactNode {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{value}</dd>
    </div>
  );
}

const SECTION_HEADING = "mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400";

export function RegistrationHubRegistrantDetail({
  row,
  dict,
  orgTz,
  canEdit,
  roster,
  siblings,
  formFields,
  baseHref,
}: RegistrationHubRegistrantDetailProps) {
  const paymentState = deriveRegistrantPaymentState(row);
  // ONE source with the buttons themselves — the actions component calls the
  // same function internally, so the heading can never advertise a control set
  // the row does not actually offer.
  const hasAnyAction = Object.values(deriveRegistrantActionFlags(row)).some(Boolean);
  const answers = Object.entries(row.answers ?? {});
  // RS005 F2 finding 2 — same waitlisted override as registration-hub-
  // registrant-table.tsx's renderRegistrantPaymentCell (this file
  // deliberately does not import that one, see the file header — the
  // condition is one field read, not worth a cross-file dependency either
  // way), reusing the SAME key so the two can't drift into two different
  // words for the same fact.
  const amountText =
    row.status === "waitlisted"
      ? t(dict, "reg.hub.registrants.detail.paymentState.waitlisted")
      : row.amount_cents === 0
        ? t(dict, "reg.hub.row.fee.free")
        : formatMinor(row.amount_cents, asCurrency(row.currency));
  const paymentMethodText = row.payment_method
    ? t(dict, row.payment_method === "stripe" ? "reg.settings.cardPayment" : "reg.settings.payOrganiser")
    : "—";
  // Data-driven, not entrant_kind-driven: a pair/individual entry's
  // join_code is always null (RS001 — only a team entry ever mints one), so
  // checking the code itself already implies "and it's a team", with no
  // separate entrant_kind check that could drift out of sync with the DB.
  //
  // RS005 R1 second-wave finding: also excludes a TERMINAL entry
  // (withdrawn/rejected/expired) — `joinTeamEntry` (registration-submit.ts)
  // refuses all three with "This entry is no longer accepting players", so
  // a withdrawn entry's code was inert and its "Anyone with this code can
  // add players to this entry" warning described a capability nobody had.
  // `isTerminalRegistrationStatus` (@/lib/registration-status) is the SAME
  // source `deriveRegistrantActionFlags`'s canWithdraw/canResend use — a
  // plain server component importing it drags in nothing (dependency-free).
  const showJoinCode = canEdit && row.join_code !== null && !isTerminalRegistrationStatus(row.status);

  return (
    <div data-registration-hub-registrant-detail className="grid gap-5 sm:grid-cols-2">
      <section aria-label={t(dict, "reg.hub.registrants.detail.section.contact")}>
        <h4 className={SECTION_HEADING}>{t(dict, "reg.hub.registrants.detail.section.contact")}</h4>
        <dl className="space-y-1 text-sm">
          {detailField(t(dict, "reg.hub.registrants.table.name"), row.contact_name)}
          {detailField(t(dict, "reg.hub.registrants.detail.field.email"), row.contact_email)}
        </dl>
      </section>

      <section aria-label={t(dict, "reg.hub.registrants.detail.section.entry")}>
        <h4 className={SECTION_HEADING}>{t(dict, "reg.hub.registrants.detail.section.entry")}</h4>
        <dl className="space-y-1 text-sm">
          {detailField(t(dict, "reg.hub.registrants.detail.field.entryName"), row.display_name)}
          {detailField(t(dict, "reg.hub.registrants.table.division"), row.division_name)}
          {detailField(t(dict, "reg.hub.registrants.table.kind"), t(dict, `divset.entrants.kind.${row.entrant_kind}`))}
          {detailField(t(dict, "reg.hub.registrants.table.status"), t(dict, `reg.hub.registrants.status.${row.status}`))}
          {detailField(t(dict, "reg.hub.registrants.table.submittedAt"), fmtDateTime(orgTz, row.created_at))}
          {detailField(t(dict, "reg.hub.registrants.table.payment"), amountText)}
          {detailField(t(dict, "reg.hub.registrants.detail.field.paymentMethod"), paymentMethodText)}
          {detailField(
            t(dict, "reg.hub.registrants.detail.field.paymentState"),
            t(dict, `reg.hub.registrants.detail.paymentState.${paymentState}`),
          )}
          {detailField(t(dict, "reg.hub.registrants.detail.field.refCode"), row.ref_code ?? "—")}
        </dl>

        {showJoinCode && (
          <div className="mt-3">
            <RegistrationHubRegistrantJoinCode
              code={row.join_code!}
              label={t(dict, "reg.hub.registrants.detail.joinCode.label")}
              hint={t(dict, "reg.hub.registrants.detail.joinCode.hint")}
              copyLabel={t(dict, "reg.hub.registrants.detail.joinCode.copy")}
              copiedLabel={t(dict, "reg.hub.registrants.detail.joinCode.copied")}
            />
          </div>
        )}
      </section>

      <section className="sm:col-span-2" aria-label={t(dict, "reg.hub.registrants.detail.section.answers")}>
        <h4 className={SECTION_HEADING}>{t(dict, "reg.hub.registrants.detail.section.answers")}</h4>
        {answers.length === 0 ? (
          <p className="text-sm text-slate-500">{t(dict, "reg.hub.registrants.detail.answers.empty")}</p>
        ) : (
          <dl className="space-y-1 text-sm">
            {answers.map(([key, value]) =>
              // Function-called, not a mapped <AnswerRow/> element — same
              // opaque-nesting reason detailField exists as a function.
              detailField(
                answerLabel(key, formFields),
                typeof value === "boolean"
                  ? t(dict, value ? "reg.hub.registrants.detail.answers.yes" : "reg.hub.registrants.detail.answers.no")
                  : String(value),
              ),
            )}
          </dl>
        )}
      </section>

      <section className="sm:col-span-2" aria-label={t(dict, "reg.hub.registrants.detail.section.roster")}>
        <h4 className={SECTION_HEADING}>{t(dict, "reg.hub.registrants.detail.section.roster")}</h4>
        {roster.length === 0 ? (
          <p className="text-sm text-slate-500">{t(dict, "reg.hub.registrants.detail.roster.empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {roster.map((p) => (
              <li
                key={p.id}
                data-registration-hub-registrant-roster-player
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
              >
                <span className="font-medium text-slate-800">{p.full_name}</span>
                {p.squad_number !== null && (
                  <span className="text-xs tabular-nums text-slate-500">
                    {t(dict, "reg.hub.registrants.detail.roster.squadNumber", { number: p.squad_number })}
                  </span>
                )}
                {p.is_captain && (
                  <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-medium text-purple-700">
                    {t(dict, "reg.hub.registrants.detail.roster.captain")}
                  </span>
                )}
                <span
                  data-registration-hub-registrant-consent={p.consent_status}
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${CONSENT_STATUS_STYLE[p.consent_status]}`}
                >
                  {t(dict, `reg.hub.registrants.detail.consent.${p.consent_status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {siblings.length > 0 && (
        <section className="sm:col-span-2" aria-label={t(dict, "reg.hub.registrants.detail.section.siblings")}>
          <h4 className={SECTION_HEADING}>{t(dict, "reg.hub.registrants.detail.section.siblings")}</h4>
          <ul className="space-y-1">
            {siblings.map((s) => (
              <li key={s.id}>
                <a
                  href={`${baseHref}#${registrantRowAnchor(s.id)}`}
                  data-registration-hub-registrant-sibling-link
                  data-registration-id={s.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-purple-700 underline underline-offset-2"
                >
                  <span>{s.display_name}</span>
                  <span className="text-xs text-slate-500">{s.division_name}</span>
                  <span
                    data-registration-hub-registrant-status={s.status}
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${REGISTRANT_STATUS_STYLE[s.status]}`}
                  >
                    {t(dict, `reg.hub.registrants.status.${s.status}`)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* RS005 W3: the row's mutating action controls (approve/reject/
          withdraw/promote/resend) — the SAME canEdit gate as the join-code
          control above, and for the same owner ruling (2026-08-25):
          mutating controls are ABSENT for a viewer, never merely disabled.
          The write APIs all 403 a viewer regardless, so a disabled button
          here would only advertise a capability they don't have. */}
      {/* ...and only when at least ONE action is legal. A terminal entry
          (withdrawn/rejected/expired) has none — every control is correctly
          gated off — which left an "Actions" heading standing over nothing.
          Same class as the "Only available for team divisions." hint that was
          removed from the config panel: a section header for a section with no
          content tells the organiser something is missing rather than that
          nothing applies. Derived through the SHARED flag function, not a
          second rule that could disagree with the buttons it describes. */}
      {canEdit && hasAnyAction && (
        <section className="sm:col-span-2" aria-label={t(dict, "reg.hub.registrants.detail.section.actions")}>
          <h4 className={SECTION_HEADING}>{t(dict, "reg.hub.registrants.detail.section.actions")}</h4>
          <RegistrationHubRegistrantActions
            registrationId={row.id}
            status={row.status}
            approval={row.approval}
            amountCents={row.amount_cents}
            paymentIntentId={row.payment_intent_id}
          />
        </section>
      )}
    </div>
  );
}
