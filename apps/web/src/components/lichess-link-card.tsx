"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/components/i18n/dict-provider";

type Props = {
  linkedUsername: string | null;
  configured: boolean;
};

/** Account-tab control to link / unlink a Lichess account for online chess. */
export function LichessLinkCard({ linkedUsername, configured }: Props) {
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
          <p className="text-sm text-slate-700" data-testid="lichess-linked-username">
            {t("settings.account.lichess.linkedAs", { username: linkedUsername })}
          </p>
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
      ) : (
        <a
          href={`/api/auth/lichess?next=${encodeURIComponent("/settings?tab=account")}`}
          className="btn btn-primary text-xs inline-flex"
          data-testid="lichess-link"
        >
          {t("settings.account.lichess.link")}
        </a>
      )}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
