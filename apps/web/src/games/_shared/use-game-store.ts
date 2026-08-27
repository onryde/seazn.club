// Generic SSR-guarded localStorage state for the games toolkit — same
// posture as chess-quest's lib/progress.tsx (loadBlob): try/catch around
// JSON.parse, discard-and-restart on any corrupt or malformed value, safe
// to call when window/localStorage doesn't exist. Unlike progress.tsx this
// isn't one game's bespoke profile blob — it's a plain `key -> T` store any
// new game can reach for.
//
// The load/save logic is exported as plain functions (not just used inside
// the hook) so it's directly unit-testable without a DOM — this workspace's
// vitest runs under Node with no jsdom, so a live, interactive render of the
// hook isn't possible; see use-game-store.test.tsx's header for the same
// reasoning applied to progress.test.ts.
import { useCallback, useState } from "react";

/**
 * Reads `key` from `storage`, JSON-parses it, and optionally runs it through
 * `migrate` to validate/coerce the parsed value into a well-formed `T`.
 * Falls back to `initial` — logging a `console.warn`, never throwing, never
 * reporting to Sentry (this repo's standing policy for corrupt game state)
 * — whenever `storage` is absent, the key is unset, the stored text isn't
 * valid JSON, or `migrate` itself throws while trying to coerce it.
 */
export function loadStoredValue<T>(
  storage: Storage | undefined,
  key: string,
  initial: T,
  migrate?: (raw: unknown) => T,
): T {
  if (!storage) return initial;
  let raw: unknown;
  try {
    const item = storage.getItem(key);
    if (item == null) return initial;
    raw = JSON.parse(item);
  } catch {
    console.warn(`[games] discarding corrupt value for "${key}"`);
    return initial;
  }
  if (!migrate) return raw as T;
  try {
    return migrate(raw);
  } catch {
    console.warn(`[games] discarding invalid value for "${key}"`);
    return initial;
  }
}

/**
 * Persists `value` under `key`. A no-op (never throws) when `storage` is
 * absent (SSR) or the write itself fails (private browsing / quota) — same
 * "run without persistence" posture as progress.tsx's save().
 */
export function saveStoredValue<T>(storage: Storage | undefined, key: string, value: T): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota exceeded — run without persistence */
  }
}

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/**
 * `useState`, backed by localStorage under `key`. Reads once, lazily, on
 * mount (safe because every game using this mounts client-only via
 * next/dynamic({ ssr: false }) — same assumption chess-quest's
 * ProgressProvider makes) and writes back on every update. `migrate` lets a
 * caller validate/coerce whatever was parsed from storage into a well-formed
 * `T`, falling back to `initial` if it can't.
 */
export function useGameStore<T>(
  key: string,
  initial: T,
  migrate?: (raw: unknown) => T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() =>
    loadStoredValue(browserStorage(), key, initial, migrate),
  );

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        saveStoredValue(browserStorage(), key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}
