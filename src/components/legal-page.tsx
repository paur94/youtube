// Shared shell for the public Terms of Service and Privacy Policy pages (linked from the TikTok app listing).

// Shown on both pages. Replace with a mailbox you read before submitting the TikTok app for review.
export const LEGAL_CONTACT_EMAIL = "privacy@your-domain.com";
export const LEGAL_UPDATED = "November 3, 2026";

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl space-y-8 pb-12">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">Kids Studio · Last updated {LEGAL_UPDATED}</p>
      </header>
      {children}
    </article>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 text-sm leading-relaxed text-muted-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function ContactLink() {
  return (
    <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="text-primary underline underline-offset-4">
      {LEGAL_CONTACT_EMAIL}
    </a>
  );
}
