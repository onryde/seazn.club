import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import { CookieSettingsButton } from "@/components/cookie-settings-button";

export const metadata: Metadata = {
  title: "Cookie Policy — Seazn Club",
};

export default function CookiePolicyPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">Cookie Policy</h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 29 October 2026</p>
        <div className="space-y-6 text-sm text-slate-700">

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">What are cookies?</h2>
            <p>Cookies are small text files stored on your device by your browser. We use them to keep you logged in and remember your preferences.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Cookies we set</h2>
            <div className="scroll-x scroll-x-fade rounded-xl border border-purple-100 bg-white">
              <table className="table w-full">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Purpose</th>
                    <th>Expiry</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="font-mono">seazn_session</td>
                    <td>Keeps you logged in</td>
                    <td>30 days</td>
                    <td>Essential</td>
                  </tr>
                  <tr>
                    <td className="font-mono">seazn_signed_in</td>
                    <td>Tells our pages that you are logged in, so they only ask for your own details when you are. It holds no personal data.</td>
                    <td>30 days</td>
                    <td>Essential</td>
                  </tr>
                  <tr>
                    <td className="font-mono">seazn_org</td>
                    <td>Remembers your active organisation</td>
                    <td>30 days</td>
                    <td>Functional</td>
                  </tr>
                  <tr>
                    <td className="font-mono">seazn_cookie_consent</td>
                    <td>Records your analytics consent choice</td>
                    <td>Persistent (localStorage)</td>
                    <td>Functional</td>
                  </tr>
                  <tr>
                    <td className="font-mono">ph_* / __ph_*</td>
                    <td>PostHog product analytics — only set after you Accept</td>
                    <td>1 year</td>
                    <td>Analytics (opt-in)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Third-party cookies</h2>
            <p>We use <a href="https://posthog.com/" className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">PostHog</a> for product analytics to understand how Seazn Club is used and improve it. These cookies are only set if you choose <strong>Accept</strong> on the cookie banner — reject and none are set. We do not use advertising cookies. Stripe may set cookies during the checkout flow — see <a href="https://stripe.com/cookies-policy/legal" className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">Stripe's cookie policy</a>.</p>
          </section>

          <section id="youtube-player">
            <h2 className="mb-2 text-lg font-semibold text-slate-800">YouTube replays</h2>
            <p>A recorded match on a public match page can show its replay from YouTube. The page puts no player on screen until you tap play. Until then your browser fetches only the video&apos;s thumbnail picture, from <span className="font-mono">i.ytimg.com</span>: our page sets no cookie and loads no Google script or player. Like any picture on a web page, that request reaches Google&apos;s servers with your IP address and browser details.</p>
            <p className="mt-2">After you tap play, the player is loaded from <span className="font-mono">youtube-nocookie.com</span>, YouTube&apos;s privacy-enhanced mode, and Google may set its own cookies or similar storage on your device. Those are Google&apos;s, not ours, and are covered by the <a href="http://www.google.com/policies/privacy" className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>. If you do not tap play, nothing from the player loads.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Managing cookies</h2>
            <p>Essential cookies are required for the service to function and cannot be disabled. Analytics cookies are opt-in — you can change or withdraw your consent at any time:</p>
            <p className="mt-3">
              <CookieSettingsButton className="btn btn-ghost text-xs">
                Manage cookie preferences
              </CookieSettingsButton>
            </p>
            <p className="mt-3">You can also clear all cookies through your browser settings, but this will log you out. Most browsers also offer a "Do Not Track" option.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">Contact</h2>
            <p>Questions about cookies: <a href="mailto:privacy@seazn.club" className="text-purple-600 underline">privacy@seazn.club</a></p>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}
