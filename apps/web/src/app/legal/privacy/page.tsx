import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import Link from "next/link";
import { GOOGLE_PRIVACY_URL, YOUTUBE_TOS_URL } from "@/lib/youtube";

/** Where Google's Developer Policies (III.A.2.h) say a policy must tell a user they can revoke access, spelled as Google spells it. The
 *  Disconnect notice's `GOOGLE_THIRD_PARTY_ACCESS_URL` (lib/youtube.ts) is Google's newer address for the same page; the policy names this one. */
const GOOGLE_PERMISSIONS_URL = "https://security.google.com/settings/security/permissions";

export const metadata: Metadata = {
  title: "Privacy Policy — Seazn Club",
  description: "How Seazn Club collects, uses, and protects your personal data.",
};

export default function PrivacyPage() {
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="mb-2 text-3xl font-bold text-purple-900">Privacy Policy</h1>
        <p className="mb-8 text-sm text-slate-400">Last updated: 29 October 2026</p>
        <div className="prose prose-slate max-w-none space-y-6 text-sm text-slate-700">

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">1. Who we are</h2>
            <p>Seazn Club ("we", "us") operates the tournament management platform at seazn.club. We are the data controller for personal data processed through the service.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">2. Data we collect</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Account data:</strong> email address, display name, avatar URL.</li>
              <li><strong>Organisation data:</strong> organisation name, slug, member roles.</li>
              <li><strong>Tournament data:</strong> player names, results, standings, audit logs.</li>
              <li><strong>Billing data:</strong> subscription status, plan. Card details are held by Stripe and never stored on our servers.</li>
              <li><strong>Usage data:</strong> product analytics events (e.g. "first tournament created", page views) collected via PostHog, only with your consent. Withdraw anytime by clearing cookies or rejecting the cookie banner.</li>
              <li><strong>Communication preferences:</strong> email suppression list (bounces / complaints).</li>
              <li><strong>Consent records:</strong> when you create an account or submit a competition registration we record the time and policy version of your acceptance, so we can demonstrate it later.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">3. Legal basis (GDPR)</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Contract</strong> — processing necessary to provide the service you signed up for.</li>
              <li><strong>Legitimate interests</strong> — security logging, fraud prevention.</li>
              <li><strong>Consent</strong> — product analytics (PostHog), set only after you accept the cookie banner and withdrawable at any time.</li>
              <li><strong>Legal obligation</strong> — tax records, dispute resolution.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">4. How we use your data</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>Providing, operating, and improving the service.</li>
              <li>Sending transactional emails (verification, sign-in links, billing receipts).</li>
              <li>Detecting and preventing abuse or fraud.</li>
              <li>Responding to support requests.</li>
            </ul>
            <p className="mt-2">We do not sell your data or use it for advertising.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">5. Automated grouping when we build a schedule</h2>
            <p>When we lay out a timetable, player records that carry the same name are <strong>treated as one player while a timetable is built</strong>, so one person is never booked onto two courts at the same time. It is a scheduling safeguard only. <strong>No records are merged</strong>: the records stay separate on rosters, results and reports, nothing is written to them, and the grouping is discarded when the run ends. Every grouping we make is listed back to the organiser before they apply the schedule, so a wrong match can be corrected. This is not automated decision-making under Article 22 — it decides only what time a match is played.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">6. Online chess: camera video and your Lichess account</h2>
            <p>When a competition is played online, each player links a Lichess account and plays from a match room on seazn.club with their camera on.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li><strong>Your Lichess account:</strong> we store your Lichess username and the OAuth token you grant us, encrypted at rest. We use the token only to play your online games at Lichess: creating them, sending your moves and reading their state. Unlinking the account deletes the token and asks Lichess to revoke it. The game itself is played at Lichess under your own account, and Lichess&rsquo;s privacy policy applies to it.</li>
              <li><strong>Your camera:</strong> during a match your camera video is carried by Cloudflare RealtimeKit (see the <Link href="/legal/sub-processors" className="text-purple-600 underline">sub-processors list</Link>). Your opponent can&rsquo;t see your camera. The competition&rsquo;s organisers, acting as arbiters, can watch both players&rsquo; cameras live. We do not record the video.</li>
              <li><strong>Camera on or off:</strong> after the match, Cloudflare tells us when each player&rsquo;s camera was on. We use it only to flag long gaps to the organiser, who decides what, if anything, follows. The flags are kept with the competition&#x27;s records.</li>
            </ul>
          </section>

          <section id="youtube-api-services">
            <h2 className="mb-2 text-lg font-semibold text-slate-800">7. YouTube live streaming (YouTube API Services)</h2>
            <p>Seazn Club uses YouTube API Services. If an organiser of your organisation connects its YouTube channel, we use them (the YouTube Data API and Google sign-in) so that a match can be streamed live to that channel. By using this feature you agree to be bound by the <a href={YOUTUBE_TOS_URL} className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a>. What Google does with your data is described in the <a href={GOOGLE_PRIVACY_URL} className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>. Nothing in this section applies unless an organiser connects a channel.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li><strong>What we access:</strong> with the permission you give at Google, your channel&apos;s id and title, and the live broadcasts and live streams on that channel. For a match your organisation streams, we create a broadcast and a stream key on the channel, start the broadcast, and end it when the match is over.</li>
              <li><strong>What we store:</strong> the channel id and title; an identifier of the Google account that granted access; a refresh token (encrypted at rest); for each broadcast, its id, which is also its video id, and its title (the two sides, the division and the competition); the stream keys we create on the channel (encrypted at rest); the visibility and made-for-kids choices your organisation made; and a record of who agreed to connect, when, and to which wording.</li>
              <li><strong>How we use it:</strong> only to stream your organisation&apos;s matches: to create, start and end broadcasts, to show a replay link on the match page once a broadcast is complete, and to check each day that the channel is still connected and still has the name we show. We do not use it for advertising, we do not sell it, and we do not use it for anything else.</li>
              <li><strong>Who it is shared with:</strong> Google, which receives the match picture and the title and description we set, as part of the broadcast your organisation asked for, under Google&apos;s own privacy policy. We share it with no one else. A replay link is shown on the match&apos;s page to anyone who can open that page; a broadcast that is private on YouTube is not shown there.</li>
              <li><strong>How long we keep it:</strong> the refresh token and the channel details are kept while the channel is connected. Everything else we store from YouTube (broadcast and video ids and titles, replay links, stream keys) is refreshed or deleted within 30 days: we re-confirm each stored video with YouTube after 25 days and delete it if YouTube no longer has it, we delete any that has not been confirmed within 30 days, and we delete a stream key that nothing has used for 30 days. If Google stops honouring the connection (for example because you removed Seazn Club at Google), Seazn Club shows it as needing to be reconnected, and if it is not reconnected within 7 days of that we delete everything we stored from it and ask Google to revoke the grant.</li>
            </ul>
            <p className="mt-2"><strong>Disconnecting and revoking access.</strong> An organiser can disconnect the channel at any time from the Streaming page (not while a match is streaming through it). Disconnecting deletes at once everything we stored from YouTube for that channel: the refresh token and stream keys, the broadcast and video ids and titles, the replay links on match pages, the channel id and title, the Google account identifier, and any connection that was started and not finished. It also asks Google to revoke the access. You can revoke Seazn Club&apos;s access yourself, at any time, in your Google account&apos;s <a href={GOOGLE_PERMISSIONS_URL} className="text-purple-600 underline" target="_blank" rel="noopener noreferrer">security settings</a>; the connection then stops working and the deletion described above follows.</p>
            <p className="mt-2"><strong>Cookies and your device.</strong> A recorded match on a public match page can show its replay in YouTube&apos;s player. Nothing from the player loads until you tap play: before that, only the video&apos;s thumbnail is fetched from YouTube&apos;s image servers. After you tap, Google&apos;s player may store cookies or similar data on your device, under Google&apos;s policy. See our <Link href="/legal/cookie-policy" className="text-purple-600 underline">Cookie Policy</Link>.</p>
            <p className="mt-2"><strong>Questions or complaints</strong> about how we handle YouTube data: <a href="mailto:privacy@seazn.club" className="text-purple-600 underline">privacy@seazn.club</a>.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">8. Sub-processors</h2>
            <p>We share data with trusted sub-processors to operate the service. See our <Link href="/legal/sub-processors" className="text-purple-600 underline">sub-processors list</Link> for details.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">9. Data retention</h2>
            <p>Account data is retained for the life of your account plus 30 days after deletion. Tournament records may be anonymised rather than deleted at your request. Billing records are retained for 7 years for tax compliance.</p>
            <p className="mt-2">Scheduling instructions you preview but do not run are deleted within the hour; a preview you did run is kept for 30 days so a disputed plan can be re-checked.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">10. Your rights (GDPR)</h2>
            <p>You have the right to access, correct, or delete your personal data. You can export your data from Settings → Account → Export my data. To exercise other rights, email us at privacy@seazn.club. We respond within 30 days.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">11. Cookies</h2>
            <p>We use essential session cookies plus, with your consent, PostHog analytics cookies. No advertising cookies. See our <Link href="/legal/cookie-policy" className="text-purple-600 underline">Cookie Policy</Link>.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">12. Security</h2>
            <p>Data is encrypted in transit (TLS) and at rest. Sign-in is by a single-use emailed link or by Google. Access is controlled by row-level security policies at the database level. Staff access is logged and audited.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">13. Changes</h2>
            <p>We will notify you by email of material changes to this policy at least 14 days in advance.</p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-slate-800">14. Contact</h2>
            <p>Privacy questions: <a href="mailto:privacy@seazn.club" className="text-purple-600 underline">privacy@seazn.club</a></p>
          </section>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}
