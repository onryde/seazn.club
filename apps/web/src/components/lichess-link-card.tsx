"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/components/i18n/dict-provider";
import { lichessLinkStartHref } from "@/lib/lichess-link";

type Props = {
  linkedUsername: string | null;
  configured: boolean;
  /** The club the link start names (T20 — online chess is offered per club): the settings page's own club, or on
   *  `/me` a club offered online chess that the player is entered in. `null` ⇒ no club to start at, so no link. */
  orgSlug: string | null;
  /** Where the linking flow lands afterwards (a same-origin path). Defaults to the account tab. */
  next?: string;
  /** Linked, but the grant is not enough to play (the play gate answers LICHESS_RECONSENT_REQUIRED). */
  needsReconsent?: boolean;
};

/** Control to link / re-link / unlink a Lichess account for online chess (account tab, and `/me`). */
export function LichessLinkCard({ linkedUsername, configured, orgSlug, next = "/settings?tab=account", needsReconsent = false }: Props) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users/me/external-accounts/lichess", { method: "DELETE" });
      if (!res.ok) {
        setError(t("settings.account.lichess.unlinkError"));
        return;
      }
      router.refresh();
    } catch {
      setError(t("settings.account.lichess.unlinkError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3 p-5" data-testid="lichess-link-card">
      <h2 className="text-sm font-semibold text-slate-800">{t("settings.account.lichess.title")}</h2>
      <p className="text-sm text-slate-500">{t("settings.account.lichess.desc")}</p>
      {!configured ? (
        <p className="text-sm text-amber-700" data-testid="lichess-not-configured">
          {t("settings.account.lichess.notConfigured")}
        </p>
      ) : linkedUsername ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 break-words text-sm text-slate-700" data-testid="lichess-linked-username">
            {t("settings.account.lichess.linkedAs", { username: linkedUsername })}
          </p>
          {needsReconsent && (
            <>
              <p className="basis-full text-sm text-amber-800" data-testid="lichess-reconsent">
                {t("settings.account.lichess.reconsentRequired")}
              </p>
              {orgSlug !== null && (
                <a
                  href={lichessLinkStartHref(orgSlug, next)}
                  className="btn btn-primary text-xs inline-flex"
                  data-testid="lichess-relink"
                >
                  {t("settings.account.lichess.consent.cta")}
                </a>
              )}
            </>
          )}
          <button
            type="button"
            className="btn btn-ghost text-xs"
            data-testid="lichess-unlink"
            disabled={busy}
            onClick={() => void unlink()}
          >
            {busy ? t("settings.account.lichess.unlinking") : t("settings.account.lichess.unlink")}
          </button>
        </div>
      ) : orgSlug !== null ? (
        <a
          href={lichessLinkStartHref(orgSlug, next)}
          className="btn btn-primary text-xs inline-flex"
          data-testid="lichess-link"
        >
          {t("settings.account.lichess.link")}
        </a>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
