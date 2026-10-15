"use client";
// The hook over camera-session: join with the caller's OWN participant token
// (from the seat answer — never from the snapshot), expose the local preview
// stream and the status, leave on unmount. Our guard's faults are stamped on
// the server through `stamp` (I-1), and the camera's own state is reported to
// the server through `report` (D16, §5.6.3) - the OPPONENT's pill is that report,
// relayed: each player is in a meeting of their own, so nothing of the opponent
// is visible from here.
import { useEffect, useMemo, useRef, useState } from "react";
import { cameraSession, type CameraReportState, type CameraView } from "./camera-session";
import { joinOwnCamera, type JoinOwnCamera } from "./camera-loader";

/** Tells the server our guard's gap on this seat started or ended (I-1). */
export type CameraFaultStamp = (state: "start" | "end") => Promise<unknown>;

/** Tells the server what this camera is doing, for the opponent's pill (D16). A rejection is a request to re-send a change. */
export type CameraReport = (state: CameraReportState, heartbeat: boolean) => Promise<unknown>;

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
  /** D16: the camera's report for the opponent's pill; null sends none (no seat to report from). */
  report: CameraReport | null = null,
) {
  const [view, setView] = useState<CameraView>({ status: "idle", track: null });
  const session = useRef<ReturnType<typeof cameraSession> | null>(null);
  const joinRef = useRef(join);
  // A session lives until the room ends (or the page goes); the stamp and the report name the latest seat.
  const stampRef = useRef(stamp);
  const reportRef = useRef(report);
  useEffect(() => {
    stampRef.current = stamp;
    reportRef.current = report;
  });

  useEffect(() => {
    if (ended) return;
    const s = cameraSession(joinRef.current, setView, {
      stamp: (state) => stampRef.current?.(state),
      report: (state, heartbeat) => reportRef.current?.(state, heartbeat),
    });
    session.current = s;
    return () => {
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
  return {
    status: view.status,
    stream,
    enable: () => void session.current?.enable(),
  };
}
