"use client";
// T17B fix 2, D23: the hand-over cover as a hook (camera-handover.ts is the session). The tile registers its <video>
// (`register`); Check in calls `begin()` BEFORE the test track is stopped, which keeps the preview's current frame;
// the tile's frame proof calls `onSdkFrame` once the SDK's own video has painted. Lives in the Screen, so the check-in
// tile and the live room's tile share one cover — a quick check-in can reach the board before the SDK's video does.
import { useCallback, useEffect, useRef, useState } from "react";
import { cameraHandover, captureFrame, IDLE_HANDOVER, type CameraHandoverSession, type HandoverView } from "./camera-handover";

export function useCameraHandover() {
  const [view, setView] = useState<HandoverView>(IDLE_HANDOVER);
  const session = useRef<CameraHandoverSession | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const s = cameraHandover(setView);
    session.current = s;
    return () => {
      session.current = null;
      s.dispose();
    };
  }, []);
  const register = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
  }, []);
  /** Keep the preview's frame NOW — the caller stops the camera right after, and a stopped track draws black. */
  const begin = useCallback(() => {
    const el = video.current;
    session.current?.begin(el === null ? null : captureFrame(el));
  }, []);
  // The tile calls it with the stream it proved; while covering, the only stream on show is the SDK's.
  const onSdkFrame: (stream: MediaStream) => void = useCallback(() => session.current?.sdkFrame(), []);
  return { view, register, begin, onSdkFrame };
}
