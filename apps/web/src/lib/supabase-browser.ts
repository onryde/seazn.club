"use client";

import { createClient } from "@supabase/supabase-js";

let _browser: ReturnType<typeof createClient> | null = null;

/** Supabase client for realtime subscriptions only. Never use for DB reads/writes. */
export function supabaseBrowser() {
  if (_browser) return _browser;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase env vars not configured");
  _browser = createClient(url, key);
  return _browser;
}

/**
 * A realtime token family (realtime push nudges, spec §4.2). `realtime.setAuth`
 * is SOCKET-wide: it replaces the token every channel on that client joins and
 * re-joins with. A page holding a fixture token (`use-live-fixture`,
 * `use-fixture-stream`) or a lobby token (`use-room`) AND a division token (the
 * hub, the slideshow, the board) on one client would have each overwrite the
 * other, and the loser's channels would rejoin with a token their policy
 * refuses. So each family has its own client and socket; a page that mounts two
 * families pays one extra socket.
 */
export type RealtimeFamily = "fixture" | "division" | "lobby";

function familyClient(url: string, key: string, family: RealtimeFamily) {
  return createClient(url, key, {
    // Realtime only, never a user session: no session is read from or written
    // to browser storage, and each family has its own storage key, so two
    // family clients are never two GoTrue instances on one key.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `sb-realtime-${family}`,
    },
  });
}

const _families = new Map<RealtimeFamily, ReturnType<typeof familyClient>>();

/** The realtime-only client for `family`: one per family, the same one on every call. Never use for DB reads/writes. */
export function realtimeClient(family: RealtimeFamily) {
  const held = _families.get(family);
  if (held) return held;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase env vars not configured");
  const client = familyClient(url, key, family);
  _families.set(family, client);
  return client;
}
