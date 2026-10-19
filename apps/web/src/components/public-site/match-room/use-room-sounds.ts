"use client";
// T17B fix 2, D19: the room's sounds, wired. One observation of the room's state per render goes through soundStep
// (room-sounds.ts); the switch decides only whether a sound is PLAYED — the room keeps watching while it is off, so
// turning it on never replays a ply that arrived meanwhile. A tap or a key anywhere on the page unlocks audio (the
// browser allows sound only after a gesture). Low time is one timer to the instant the player's own clock reaches
// 10 s — never a tick, so the room does not re-render to listen for it.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { remainingMs } from "./clock-math";
import { ROOM_AUDIO, type RoomAudio } from "./room-audio";
import { LOW_TIME_MS, lowTimeStep, observe, soundStep, type LowTimeMemory, type SoundMemory } from "./room-sounds";
import type { RoomState } from "./room-state";
import { ROOM_SOUND_PREF, type SoundPrefStore } from "./sound-pref";

export function useRoomSounds(state: RoomState, on: boolean, audio: RoomAudio = ROOM_AUDIO): void {
  // The gesture that lets the page make sound.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const unlock = () => audio.unlock();
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, [audio]);

  // Plies, the start, the end, a draw offer: one observation per change of what the room shows.
  const mem = useRef<SoundMemory | null>(null);
  const seen = JSON.stringify(observe(state));
  useEffect(() => {
    const r = soundStep(mem.current, JSON.parse(seen));
    mem.current = r.mem;
    if (r.sound !== null && on) audio.play(r.sound);
  }, [seen, on, audio]);

  // Low time: the player's own clock, on the server's clock.
  const g = state.snap.game;
  const me = state.snap.you.colour;
  const gameId = g?.gameId ?? null;
  const ended = (g?.over ?? false) || state.snap.result !== null;
  const myBase = g === null ? 0 : me === "white" ? g.whiteMs : g.blackMs;
  const asOf = g?.clockAsOf ? Date.parse(g.clockAsOf) : 0;
  const running = g !== null && g.clockRunning && !ended && g.turn === me;
  const skewMs = state.skewMs;
  const low = useRef<LowTimeMemory | null>(null);
  useEffect(() => {
    if (gameId === null || ended) return;
    let id: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const ms = remainingMs({ baseMs: myBase, asOfMs: asOf, nowMs: Date.now() + skewMs, running });
      const r = lowTimeStep(low.current, gameId, ms);
      low.current = r.mem;
      if (r.fire && on) audio.play("lowTime");
      if (running && r.mem.armed) id = setTimeout(check, Math.max(20, ms - LOW_TIME_MS));
    };
    check();
    return () => {
      if (id !== null) clearTimeout(id);
    };
  }, [gameId, ended, myBase, asOf, running, skewMs, on, audio]);
}

/** The sound switch (drawn in the player's own clock bar): on/off from the device's memory, and a press. Turning sounds ON plays one short move sound,
 *  so the player hears that it works (the press is itself a gesture, so audio is unlocked first). */
export function useSoundSwitch(store: SoundPrefStore = ROOM_SOUND_PREF, audio: RoomAudio = ROOM_AUDIO) {
  const on = useSyncExternalStore(store.subscribe, store.get, store.server);
  const toggle = useCallback(() => {
    const next = !store.get();
    store.set(next);
    if (next) {
      audio.unlock();
      audio.play("move");
    }
  }, [store, audio]);
  return { on, toggle };
}
