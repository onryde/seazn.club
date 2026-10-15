"use client";
// T17B fix 2, D23: the hand-over cover as a hook (camera-handover.ts is the session). The tile registers its <video>
// (`register`); Check in calls `begin()` BEFORE the test track is stopped, which keeps the preview's current frame;
// the tile's frame proof calls `onSdkFrame` once the SDK's own video has painted. Lives in the Screen, so the check-in
// tile and the live room's tile share one cover — a quick check-in can reach the board before the SDK's video does.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import {
  cameraHandover,
  captureFrame,
  handoverBreadcrumb,
  IDLE_HANDOVER,
  type CameraHandoverSession,
  type HandoverEnd,
  type HandoverView,
} from "./camera-handover";

export function useCameraHandover() {
  const [view, setView] = useState<HandoverView>(IDLE_HANDOVER);
  const session = useRef<CameraHandoverSession | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    // D23-fix m4: how each hand-over ended and how long it took, once — the stg measurement of whether 8 s is right.
    const s = cameraHandover(setView, { onEnd: (e) => Sentry.addBreadcrumb(handoverBreadcrumb(e)) });
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
  /** D23-fix: the room knows there is nothing left to wait for (the camera failed, the screen left, the budget spent). */
  const end = useCallback((by: Exclude<HandoverEnd, "sdk" | "ceiling">) => session.current?.end(by), []);
  return { view, register, begin, onSdkFrame, end };
}
