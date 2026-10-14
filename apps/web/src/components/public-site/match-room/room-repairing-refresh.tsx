"use client";
// Final re-review 4, I2: a room page loaded INSIDE an unpair → re-pair gap has no snapshot to run a room on — the
// server answered 409 ROOM_BEING_REPAIRED (room.ts boardBeingRepaired). The page renders the re-pair card headerless
// (room-unavailable.tsx) and this re-asks the SERVER page at the room's own idle cadence: router.refresh() re-runs
// page.tsx, which renders the room once the board is paired to this player again, or the not-available card on a
// refusal (the room's 404) — and either way this unmounts, so the asking stops there.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { IDLE_POLL_MS } from "./use-room";

export function RepairingRefresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
