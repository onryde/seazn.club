"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";

type LobbyPayload = {
  phase: "ready_up" | "countdown" | "closed";
  side: "home" | "away";
  homeReady: boolean;
  awayReady: boolean;
  playUrl: string | null;
  expiresAt: string | null;
  token: string | null;
  channel: string;
};

type Copy = {
  ready: string;
  youReady: string;
  opponentReady: string;
  waiting: string;
  countdown: string;
  missed: string;
  signIn: string;
  signInCta: string;
  play: string;
  failed: string;
};

export function ExternalPlayLobby({
  fixtureId,
  signInHref,
  copy,
}: {
  fixtureId: string;
  signInHref: string;
  copy: Copy;
}) {
  const [lobby, setLobby] = useState<LobbyPayload | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const apply = useCallback((data: LobbyPayload) => {
    setLobby(data);
    setFailed(false);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/fixtures/${fixtureId}/external-play/lobby`, {
      credentials: "same-origin",
    });
    if (res.status === 401 || res.status === 403) {
      setSignedOut(true);
      return;
    }
    if (!res.ok) return;
    const body = (await res.json()) as { data?: LobbyPayload };
    if (body.data) apply(body.data);
  }, [apply, fixtureId]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load is async; the effect only starts it
    void load().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (!lobby?.token) return;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    if (!url || /stub\.supabase\.co/i.test(url)) return;
    let channel: { unsubscribe: () => void } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const sb = supabaseBrowser();
        await sb.realtime.setAuth(lobby.token!);
        if (cancelled) return;
        channel = sb
          .channel(lobby.channel, { config: { private: true } })
          .on("broadcast", { event: "lobby_changed" }, () => {
            void load();
          })
          .subscribe();
      } catch {
        // No anon key — the clicker's own POST response still updates this screen.
      }
    })();
    return () => {
      cancelled = true;
      channel?.unsubscribe();
    };
  }, [lobby?.token, lobby?.channel, load]);

  useEffect(() => {
    if (lobby?.phase !== "countdown" || !lobby.expiresAt) return;
    const expiresAt = lobby.expiresAt;
    const id = setInterval(() => {
      const left = new Date(expiresAt).getTime() - Date.now();
      setNowMs(Date.now());
      if (left <= 0) void load();
    }, 250);
    return () => clearInterval(id);
  }, [lobby?.phase, lobby?.expiresAt, load]);

  const secondsLeft =
    lobby?.phase === "countdown" && lobby.expiresAt
      ? Math.max(0, Math.ceil((new Date(lobby.expiresAt).getTime() - nowMs) / 1000))
      : null;

  async function clickReady() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/v1/fixtures/${fixtureId}/external-play/lobby`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const body = (await res.json()) as { data?: LobbyPayload };
      if (body.data) apply(body.data);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (signedOut) {
    return (
      <p className="mb-4 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
        {copy.signIn}{" "}
        <a className="font-semibold underline" href={signInHref} data-testid="external-play-signin">
          {copy.signInCta}
        </a>
      </p>
    );
  }

  if (!lobby || lobby.phase === "closed") return null;

  const mine = lobby.side === "home" ? lobby.homeReady : lobby.awayReady;
  const theirs = lobby.side === "home" ? lobby.awayReady : lobby.homeReady;

  if (lobby.phase === "countdown" && lobby.playUrl) {
    return (
      <div className="mb-4 rounded-md bg-slate-50 px-3 py-3 text-sm text-slate-800" data-testid="external-play-countdown">
        <p className="mb-2">
          {secondsLeft === 0 ? copy.missed : copy.countdown.replace("{seconds}", String(secondsLeft ?? 0))}
        </p>
        <a
          data-testid="external-play-cta"
          href={lobby.playUrl}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink"
        >
          {copy.play}
        </a>
      </div>
    );
  }

  return (
    <div className="mb-4" data-testid="external-play-lobby">
      <p className="mb-2 text-sm text-slate-600">
        {mine && !theirs ? copy.youReady : theirs && !mine ? copy.opponentReady : copy.waiting}
      </p>
      <button
        type="button"
        data-testid="external-play-ready"
        disabled={busy || mine}
        onClick={() => void clickReady()}
        className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink disabled:opacity-60"
      >
        {mine ? copy.youReady : copy.ready}
      </button>
      {failed ? <p className="mt-2 text-sm text-amber-800">{copy.failed}</p> : null}
    </div>
  );
}
