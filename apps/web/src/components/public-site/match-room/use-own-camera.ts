"use client";
// The hook over camera-session: join with the caller's OWN participant token
// (from the seat answer — never from the snapshot), expose the local preview
// stream and the status, leave on unmount. Our guard's faults are stamped on
// the server through `stamp` (I-1). And the opponent's presence pill,
// read from that same join (review I8) on a local timer — no network.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cameraSession, type CameraView } from "./camera-session";
import { joinOwnCamera, type JoinOwnCamera, type MeetingLink } from "./camera-loader";
import { opponentPresenceView, PRESENCE_TICK_MS, type OpponentPresenceWire } from "./opponent-presence";

/** Tells the server our guard's gap on this seat started or ended (I-1). */
export type CameraFaultStamp = (state: "start" | "end") => Promise<unknown>;

export function useOwnCamera(
  authToken: string | null,
  join: JoinOwnCamera = joinOwnCamera,
  stamp: CameraFaultStamp | null = null,
  /** R3-1: whose token it is — another participant is another meeting, and the camera moves to it. */
  participantId: string | null = null,
  /** T17B fix 2 (D8a): the room is over or closed (room-screen `cameraEnds`) — leave the meeting at once, and join
   *  nothing while it stays so. A board that comes back from its closed card (a hold lifted) gets a fresh session.
   *  Neither screen shows the camera, so the ended session's last view is never painted. */
  ended = false,
) {
  const [view, setView] = useState<CameraView>({ status: "idle", track: null });
  const session = useRef<ReturnType<typeof cameraSession> | null>(null);
  const joinRef = useRef(join);
  // A session lives until the room ends (or the page goes); the stamp names the latest seat.
  const stampRef = useRef(stamp);
  useEffect(() => {
    stampRef.current = stamp;
  });
  // The presence hook subscribes ONCE; each session relays its link changes to whoever is subscribed now.
  const linkListeners = useRef(new Set<() => void>());

  useEffect(() => {
    if (ended) return;
    const listeners = linkListeners.current; // one Set for the hook's life
    const s = cameraSession(joinRef.current, setView, { stamp: (state) => stampRef.current?.(state) });
    session.current = s;
    const unrelay = s.onLinkChange(() => {
      for (const cb of [...listeners]) cb();
    });
    return () => {
      unrelay();
      session.current = null;
      void s.stop();
    };
  }, [ended]);

  // `ended` too: a fresh session (the room back from its closed card) starts with the seat's token in hand. While
  // ended there is no session to start.
  useEffect(() => {
    if (authToken) void session.current?.start(authToken, participantId);
  }, [authToken, participantId, ended]);

  const stream = useMemo(() => (view.track ? new MediaStream([view.track]) : null), [view.track]);
  // Stable: the presence hook's effect depends on them.
  const link = useCallback((): MeetingLink | null => session.current?.link() ?? null, []);
  const onLinkChange = useCallback((cb: () => void) => {
    linkListeners.current.add(cb);
    return () => {
      linkListeners.current.delete(cb);
    };
  }, []);
  return {
    status: view.status,
    stream,
    enable: () => void session.current?.enable(),
    link,
    onLinkChange,
  };
}

/** The opponent's pill: true on camera, false camera off (a fact), null no
 *  pill. Re-read on every meeting change and on a local tick (producer
 *  changes emit nothing in the SDK). */
export function useOpponentPresence(
  camera: { link: () => MeetingLink | null; onLinkChange: (cb: () => void) => () => void },
  opponent: OpponentPresenceWire,
): boolean | null {
  const [view, setView] = useState<boolean | null>(null);
  // The snapshot is a fresh object every read: key the effect by its value.
  const key = opponent === null ? null : (opponent.participantId ?? "");
  const { link, onLinkChange } = camera;
  useEffect(() => {
    const wire: OpponentPresenceWire = key === null ? null : { participantId: key === "" ? null : key };
    const read = () => setView(opponentPresenceView(link(), wire, Date.now()));
    read();
    const off = onLinkChange(read);
    const timer = setInterval(read, PRESENCE_TICK_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [key, link, onLinkChange]);
  return key === null ? null : view;
}
