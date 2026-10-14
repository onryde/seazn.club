"use client";
// T17B fix 2, D15: the check-in's camera test as a hook (camera-test.ts is the session). Active only while it can
// matter — camera "required", not yet checked in, and no meeting joined (a seat answer with a participant token means
// the SDK has, or is about to have, the camera: the test then never asks for it). Inactive, the session is stopped
// and its camera released.
import { useCallback, useEffect, useRef, useState } from "react";
import { cameraTest, IDLE, type CameraTestSession, type CameraTestView, type GetUserMedia } from "./camera-test";

/** The platform's getUserMedia, or null where there is none (a server render, an insecure page, an old browser). */
function platformGetUserMedia(): GetUserMedia | null {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") return null;
  return (c) => navigator.mediaDevices.getUserMedia(c);
}

export function useCameraTest(active: boolean, getUserMedia?: GetUserMedia | null) {
  const [view, setView] = useState<CameraTestView>(IDLE);
  const session = useRef<CameraTestSession | null>(null);
  const gum = useRef(getUserMedia);
  useEffect(() => {
    if (!active) return;
    const s = cameraTest(gum.current === undefined ? platformGetUserMedia() : gum.current, setView);
    session.current = s;
    return () => {
      session.current = null;
      s.stop();
    };
  }, [active]);
  const onTest = useCallback(() => void session.current?.start(), []);
  const onFrame = useCallback((stream: MediaStream) => session.current?.frame(stream), []);
  const onHandOver = useCallback(() => session.current?.handOver(), []);
  return { view: active ? view : IDLE, onTest, onFrame, onHandOver };
}
