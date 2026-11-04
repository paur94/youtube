import type { Metadata } from "next";

import { ContactLink, LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <LegalSection title="Overview">
        <p>
          Kids Studio is a production tool for creating original animated children&apos;s stories and videos and
          publishing them to the creator&apos;s own YouTube and TikTok accounts. This policy explains what data the app
          handles when you connect those accounts, and how you can remove it.
        </p>
        <p>
          Kids Studio is used by content creators. It is not directed at children and does not collect personal
          information from the viewers of published videos.
        </p>
      </LegalSection>

      <LegalSection title="Data we collect from TikTok">
        <p>When you connect a TikTok account, you authorize the following permissions:</p>
        <ul>
          <li>
            <strong>user.info.basic</strong>: your TikTok open ID, display name, username and avatar URL, used to show
            which account is connected.
          </li>
          <li>
            <strong>video.publish</strong>: permission to post videos you choose to your account.
          </li>
        </ul>
        <p>
          We also store the OAuth access and refresh tokens TikTok issues, plus a record of each post you make (the
          caption, privacy level, TikTok&apos;s publish ID and status, and the resulting post link).
        </p>
      </LegalSection>

      <LegalSection title="Data we collect from YouTube">
        <p>
          When you connect a YouTube channel, we store the OAuth tokens Google issues and the basic channel details
          needed to upload videos, set their metadata and manage playlists that you start from the app. Use of data
          received from Google APIs follows the Google API Services User Data Policy.
        </p>
      </LegalSection>

      <LegalSection title="How we use it">
        <ul>
          <li>To show the connected account and the status of your posts.</li>
          <li>To upload and publish videos only when you start a post in the app. Nothing is posted automatically.</li>
        </ul>
        <p>
          We do not sell your data, use it for advertising, or share it with third parties other than the platform
          you are posting to.
        </p>
      </LegalSection>

      <LegalSection title="Storage and security">
        <p>
          Data is stored in the app&apos;s private database. Access and refresh tokens are encrypted with AES-256-GCM
          and are only ever used on the server; they are never sent to the browser.
        </p>
      </LegalSection>

      <LegalSection title="Disconnecting and deletion">
        <p>
          You can disconnect TikTok or YouTube at any time from the app&apos;s Settings page. Disconnecting TikTok
          revokes our access with TikTok and deletes the stored tokens and account details. You can also revoke
          access from your TikTok or Google account settings.
        </p>
        <p>
          To have all remaining data about you deleted, including post records, email <ContactLink />. We respond
          within 30 days.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>We may update this policy. The date at the top shows when it last changed.</p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about this policy: <ContactLink />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
