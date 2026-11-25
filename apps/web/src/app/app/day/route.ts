// The "Open in app" fallback for /app/day (lib/app-fallback-page.ts). The Android app's intent filter owns `/app/*`, so no
// other page may be added under `app/app/`.
import { appFallbackResponse } from "@/lib/app-fallback-page";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return appFallbackResponse("day", request);
}
