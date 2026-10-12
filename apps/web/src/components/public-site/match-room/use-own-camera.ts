"use client";
// The hook over camera-session: join with the caller's OWN participant token
// (from the seat answer — never from the snapshot), expose the local preview
// stream and the status, leave on unmount.
import { useEffect, useMemo, useRef, useState } from "react";
import { cameraSession, type CameraView } from "./camera-session";
import { joinOwnCamera, type JoinOwnCamera } from "./camera-loader";

export function useOwnCamera(authToken: string | null, join: JoinOwnCamera = joinOwnCamera) {
  const [view, setView] = useState<CameraView>({ status: "idle", track: null });
  const session = useRef<ReturnType<typeof cameraSession> | null>(null);
  const joinRef = useRef(join);

  useEffect(() => {
    const s = cameraSession(joinRef.current, setView);
    session.current = s;
    return () => {
      session.current = null;
      void s.stop();
    };
  }, []);

  useEffect(() => {
    if (authToken) void session.current?.start(authToken);
  }, [authToken]);

  const stream = useMemo(() => (view.track ? new MediaStream([view.track]) : null), [view.track]);
  return {
    status: view.status,
    stream,
    enable: () => void session.current?.enable(),
  };
}
