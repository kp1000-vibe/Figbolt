import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { guideJsonLd, jsonLdScript } from '@/lib/seo';
import type { Guide } from '@/lib/guides';
import { MARKETING_LINKS, SiteFooter, SiteHeader } from './site-chrome';
import { VisitBeacon } from './visit-beacon';

/**
 * One public guide page: a question people search for, answered properly.
 *
 * Plain, fast HTML — one heading hierarchy, real text, no client JavaScript —
 * because that is what both readers and crawlers do best with. The FAQ is
 * rendered visibly as well as in structured data: search engines only honour
 * FAQ markup for questions the page actually shows.
 */
export async function GuidePage({ guide }: { guide: Guide }) {
  const signedIn = Boolean(await getCurrentUser());
  const related = MARKETING_LINKS.filter((link) => link.href !== guide.path);

  return (
    <main className="min-h-dvh bg-bg">
      <script
        type="application/ld+json"
        // Built from our own constants; escaped so no string can close the tag.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(guideJsonLd(guide)) }}
      />
      <SiteHeader signedIn={signedIn} />
      <VisitBeacon path={guide.path} />

      <article className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 lg:py-14">
        <nav aria-label="Breadcrumb" className="text-2xs text-text-subtle">
          <Link href="/" className="inline-flex min-h-6 items-center hover:text-accent-text">
            Figbolt
          </Link>
          <span aria-hidden className="mx-1.5">
            /
          </span>
          <span>{guide.eyebrow}</span>
        </nav>

        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-text text-balance sm:text-4xl">
          {guide.h1}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-text-muted text-pretty">{guide.intro}</p>

        {guide.sections.map((section) => (
          <section key={section.heading} className="mt-10">
            <h2 className="text-xl font-semibold tracking-tight text-text text-balance">
              {section.heading}
            </h2>
            {section.paragraphs.map((p) => (
              <p key={p.slice(0, 40)} className="mt-3 text-[15px] leading-relaxed text-text-muted text-pretty">
                {p}
              </p>
            ))}
            {section.bullets && (
              <ul className="mt-4 space-y-2.5">
                {section.bullets.map((b) => (
                  <li key={b} className="flex gap-2.5 text-[15px] leading-relaxed text-text">
                    <span aria-hidden className="mt-0.5 text-accent-text">
                      —
                    </span>
                    <span className="text-pretty">{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <section className="mt-12 border-t border-border pt-10">
          <h2 className="text-xl font-semibold tracking-tight text-text">Frequently asked questions</h2>
          <dl className="mt-5 space-y-6">
            {guide.faqs.map((faq) => (
              <div key={faq.q}>
                <dt className="text-[15px] font-semibold text-text">{faq.q}</dt>
                <dd className="mt-1.5 text-[15px] leading-relaxed text-text-muted text-pretty">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-12 rounded-[var(--radius-lg)] border border-border bg-bg-subtle p-6 text-center sm:p-8">
          <p className="text-lg font-semibold tracking-tight text-text">See it with real-looking data</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-text-muted text-pretty">
            Open the demo workspace — every summary, follow-up and score in it was built from email and
            meeting transcripts. No credit card.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={signedIn ? '/home' : '/signup'}
              className="rounded-[var(--radius-md)] bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-sm)] transition-colors hover:bg-accent-hover"
            >
              {signedIn ? 'Go to dashboard' : 'Start free'}
            </Link>
            <Link
              href="/login"
              className="rounded-[var(--radius-md)] border border-border-strong bg-surface px-5 py-2.5 text-sm font-medium text-text transition-colors hover:bg-surface-hover"
            >
              Explore the demo
            </Link>
          </div>
        </section>

        <nav aria-label="Related" className="mt-10">
          <p className="text-2xs font-medium uppercase tracking-[0.14em] text-text-subtle">Read next</p>
          <ul className="mt-3 space-y-1">
            {related.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="inline-flex min-h-6 items-center text-sm text-accent-text hover:underline"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </article>

      <SiteFooter />
    </main>
  );
}
