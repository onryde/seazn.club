// Every OTHER path under /app: bare /app, /app/other, anything deeper, and their trailing-slash forms. Left to Next, each
// is the not-found page inside the root layout, which loads analytics and a third-party tracking script while the URL
// fragment, a live credential on an app link, is still in the address. So they get the same bare page, as a 404
// (lib/app-fallback-page.ts). The three real routes beside this one win over it, trailing slash or not.
import { appFallbackResponse } from "@/lib/app-fallback-page";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return appFallbackResponse("stray", request);
}
