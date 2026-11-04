import type { Metadata } from "next";
import Link from "next/link";

import { ContactLink, LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <LegalSection title="About the service">
        <p>
          Kids Studio is a tool for creating original animated children&apos;s stories and videos and publishing them
          to your own YouTube and TikTok accounts. By using it you agree to these terms.
        </p>
      </LegalSection>

      <LegalSection title="Your accounts">
        <p>
          You may only connect YouTube channels and TikTok accounts that you own or are authorized to manage. You can
          disconnect them at any time from Settings. Your use of those platforms remains subject to the YouTube Terms
          of Service and the TikTok Terms of Service.
        </p>
      </LegalSection>

      <LegalSection title="Your content">
        <ul>
          <li>You own the content you create and publish with Kids Studio.</li>
          <li>
            You are responsible for what you publish, including captions, privacy settings and any required content
            disclosures (such as branded or AI-generated content labels).
          </li>
          <li>
            You must not use the service to create or publish content that infringes others&apos; rights, uses
            characters or franchises you don&apos;t have rights to, or violates platform community guidelines or
            child-safety rules.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Publishing">
        <p>
          Videos are only posted when you start a post and confirm it. Kids Studio does not post on your behalf
          automatically. Platforms may reject, limit or remove posts under their own policies.
        </p>
      </LegalSection>

      <LegalSection title="Privacy">
        <p>
          How we handle data from connected accounts is described in the{" "}
          <Link href="/privacy" className="text-primary underline underline-offset-4">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="Availability and liability">
        <p>
          The service is provided &quot;as is&quot; without warranties. We are not liable for lost content, failed
          uploads, or actions taken by YouTube or TikTok on your accounts. We may change or discontinue the service at
          any time.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>We may update these terms. Continuing to use the service after a change means you accept it.</p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about these terms: <ContactLink />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
