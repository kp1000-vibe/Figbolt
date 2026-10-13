/**
 * The public guide pages: /ai-crm, /crm-for-small-business,
 * /crm-for-solopreneurs.
 *
 * Each targets a search people actually make, and answers it properly. The
 * rule for every sentence here is the same as for the structured data in
 * src/lib/seo.ts: only claim what the product does today. A page that ranks
 * by promising features that do not exist loses the reader the moment they
 * sign up, and invites a manual action from search engines besides.
 */

export type GuideSection = {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
};

export type Guide = {
  path: '/ai-crm' | '/crm-for-small-business' | '/crm-for-solopreneurs';
  /** <title>, under ~60 characters so results do not truncate. */
  title: string;
  /** Meta description, under 160 characters. */
  description: string;
  eyebrow: string;
  h1: string;
  intro: string;
  sections: GuideSection[];
  faqs: { q: string; a: string }[];
  keywords: string[];
  /** When the content last changed, for the sitemap. Update when you edit. */
  updated: string;
};

export const GUIDES: Guide[] = [
  {
    path: '/ai-crm',
    title: 'AI CRM: what an AI-native CRM is and does · Figbolt',
    description:
      'An AI-native CRM builds your customer records from email and meetings instead of asking you to type them. What it does, how it differs, and when it fits.',
    eyebrow: 'AI CRM, explained',
    h1: 'What is an AI-native CRM?',
    intro:
      'An AI CRM is customer relationship software that uses artificial intelligence to do the work a CRM normally asks of you. An AI-native CRM goes further: it is built around AI from the first record, so the database fills itself in from the conversations you already have, rather than adding a chatbot to a system you still update by hand.',
    sections: [
      {
        heading: 'AI-native versus AI added on',
        paragraphs: [
          'Most CRMs were designed as forms: a person types a contact, logs a call, moves a deal to the next stage. Adding AI to that design usually means a writing assistant or a summary button. Useful, but the record is still only as good as what someone remembered to enter.',
          'An AI-native CRM starts from the other end. Email, calendar events and meeting transcripts come in, and the system works out who the customer is, what was said, what was promised and what changed. The record is derived from evidence, and every fact keeps a pointer to the message or sentence it came from.',
        ],
      },
      {
        heading: 'What an AI-native CRM like Figbolt does',
        paragraphs: ['In Figbolt, the work a CRM normally hands to you is done for you:'],
        bullets: [
          'Reads your email and calendar and files each conversation against the right customer.',
          'Turns promises in emails and meetings — "I will send the proposal on Friday" — into follow-ups with due dates.',
          'Summarises meetings from their transcripts, including from notetakers such as Granola, Fathom, Fireflies and Otter, or a self-hosted Whisper model.',
          'Captures in-person conversations from pocket AI recorders such as Pocket, Plaud and Omi.',
          'Sends AI voice agents to make follow-up calls, each one approved by a person and opening by saying it is an AI.',
          'Picks out concerns, objections and product requests, so they are not lost in an inbox.',
          'Scores each deal’s health with the factors shown, so you can see why a deal is at risk rather than trusting a number.',
          'Lets you ask questions in plain English — "who have I not followed up with?" — and answers with links to the records it used.',
          'Briefs you each morning on what changed and what needs you.',
        ],
      },
      {
        heading: 'Keeping AI in check',
        paragraphs: [
          'AI that can act needs limits. In Figbolt, every action is classed by risk, and anything that changes a deal or reaches a customer waits for a person to approve the exact change. Customer emails are treated as untrusted content, so an email that says "ignore your instructions" cannot instruct the AI. Answers cite their sources, and a citation that does not point at a record the system actually retrieved is dropped rather than shown.',
          'Figbolt also chooses the AI model for each job — a small, fast model for a quick classification, a stronger one for a hard question — using a decision model called Jev, so you are not paying frontier prices for simple work.',
        ],
      },
      {
        heading: 'When an AI CRM is the right choice',
        paragraphs: [
          'An AI-native CRM fits best where nobody has time to keep a traditional CRM current: small businesses, solopreneurs and small sales teams whose customer relationships live in email and meetings. If your organisation already runs on a heavily customised Salesforce with dedicated administrators, a lighter tool will feel limited — our comparison page is candid about where the older tools are still the better choice.',
        ],
      },
    ],
    faqs: [
      {
        q: 'What is an AI CRM?',
        a: 'An AI CRM is customer relationship management software that uses AI to capture, organise and act on customer information — for example by reading email and meetings, extracting follow-ups and answering questions about your customers.',
      },
      {
        q: 'What does AI-native mean for a CRM?',
        a: 'It means the CRM is designed around AI from the start: records are built automatically from your conversations instead of being typed in, and AI is how the system works rather than an add-on feature.',
      },
      {
        q: 'Does an AI CRM send emails on its own?',
        a: 'Not in Figbolt. It can draft an email, but anything that reaches a customer or changes a deal waits for you to approve the exact content first.',
      },
      {
        q: 'Is my customer data used to decide which AI model runs?',
        a: 'No. The routing decision is made from a description of the job — its type and size — not from your customers’ emails or transcripts.',
      },
    ],
    keywords: ['AI CRM', 'AI-native CRM', 'what is an AI CRM', 'AI CRM software', 'CRM with AI'],
    updated: '2026-10-04',
  },
  {
    path: '/crm-for-small-business',
    title: 'AI CRM for small business, with no data entry · Figbolt',
    description:
      'A CRM for small businesses that fills itself in from your email and meetings. No data entry, follow-ups found for you, and nothing sent without your approval.',
    eyebrow: 'For small businesses',
    h1: 'The AI-native CRM for small businesses that keeps itself up to date',
    intro:
      'Small businesses buy a CRM to stop losing track of customers — then find the CRM itself needs looking after. Someone has to log every call, update every deal and remember every promise. In a business of five or ten people, that someone is also the person talking to the customers, so the CRM goes stale. Figbolt is built so that nobody has to keep it up to date.',
    sections: [
      {
        heading: 'Why small businesses give up on their CRM',
        paragraphs: [
          'A traditional CRM is only as good as what people type into it. Large companies solve that with sales operations staff and rules about data entry. A small business cannot, so the records drift out of date, the reports stop being trusted, and the CRM quietly turns into an address book nobody opens.',
        ],
      },
      {
        heading: 'What Figbolt does instead',
        paragraphs: ['You connect your email and calendar once. From then on:'],
        bullets: [
          'Customers and deals appear from the conversations you have already had.',
          'Calls and meetings are summarised from their transcripts, so there are no notes to write up.',
          'Conversations in person are captured too, from a pocket AI recorder such as Pocket, Plaud or Omi.',
          'AI voice agents can make your follow-up calls, and you approve each one first.',
          'Promises made in email and meetings become follow-ups with due dates.',
          'Deals that are slipping are flagged, with the reasons shown — gone quiet, an open concern, usage dropping.',
          'A morning briefing tells you what changed and which customers need you today.',
          'You can ask Bolt, the built-in AI assistant, anything about your customers in plain English.',
        ],
      },
      {
        heading: 'Approve, don’t type',
        paragraphs: [
          'When Figbolt wants to update a deal or send an email, it asks first and shows you exactly what will change. One tap approves it. Nothing reaches a customer without you, and every decision is recorded, so a small team can let the system do the busywork without losing control of it.',
        ],
      },
      {
        heading: 'Built for teams of one to ten',
        paragraphs: [
          'Figbolt is designed for small businesses rather than cut down from an enterprise product. Setup is connecting your accounts rather than a consulting project; there are no administrators to hire and no fields to design before you start. It works on a phone as well as a desktop, and can be installed to your home screen.',
        ],
      },
    ],
    faqs: [
      {
        q: 'What is the best CRM for a small business?',
        a: 'The best CRM for a small business is one that stays accurate without anyone maintaining it. Figbolt is built for that: it fills itself in from your email and meetings, so the records stay current even when nobody has time to update them.',
      },
      {
        q: 'Do I need to import all my contacts first?',
        a: 'No. Connect your email and calendar and Figbolt builds your customers and deals from the conversations you have already had.',
      },
      {
        q: 'How long does it take to set up?',
        a: 'Setup is connecting your Gmail and Google Calendar. There are no custom fields or pipelines to design before you can start, and you can explore a demo workspace first.',
      },
      {
        q: 'Can Figbolt email my customers without asking?',
        a: 'No. Anything that reaches a customer or changes a deal waits for your approval, and you see the exact content before you approve it.',
      },
    ],
    keywords: [
      'CRM for small business',
      'AI CRM for small business',
      'small business CRM',
      'simple CRM',
      'CRM without data entry',
    ],
    updated: '2026-10-04',
  },
  {
    path: '/crm-for-solopreneurs',
    title: 'CRM for solopreneurs and freelancers · Figbolt',
    description:
      'A CRM for solopreneurs, freelancers and consultants that runs itself: it reads your email and meetings, tracks your promises and tells you who needs you today.',
    eyebrow: 'For solopreneurs',
    h1: 'A CRM for solopreneurs that runs itself',
    intro:
      'When you are the whole business, you are also the sales team, the account manager and the person who is meant to keep the CRM up to date. Most solopreneurs, freelancers and consultants end up managing clients from their inbox and memory instead. Figbolt is a CRM that does the keeping-up for you, so you get the benefit of one without the upkeep.',
    sections: [
      {
        heading: 'The problem with a CRM when you work alone',
        paragraphs: [
          'Every minute spent updating a CRM is a minute not spent on client work. So the CRM is the first thing to slip — and the moment it is out of date, you stop trusting it, and you are back to searching your inbox to remember what you promised a client last month.',
        ],
      },
      {
        heading: 'How Figbolt works for one person',
        paragraphs: ['Connect your email and calendar, and Figbolt:'],
        bullets: [
          'Builds a record for each client from your existing email threads and meetings.',
          'Catches the promises you make — a proposal by Friday, a call next week — and reminds you before they are late.',
          'Summarises each client meeting, so the details are there the next time you speak.',
          'Captures client conversations on the go with a pocket AI recorder such as Pocket, Plaud or Omi.',
          'Lets an AI voice agent make routine follow-up calls for you, only after you approve each one.',
          'Tells you each morning which clients need a reply, which have gone quiet, and which commitments are due.',
          'Answers questions like "what did this client say about budget?" with links to the exact email or meeting.',
        ],
      },
      {
        heading: 'Stay in control of every client conversation',
        paragraphs: [
          'Figbolt can draft follow-ups, but it never sends one without you. You see the exact message and approve it, so your clients always hear from you, in your words. Your client emails are treated as private data: they are not used to decide which AI model runs, and nothing from your workspace is kept on your phone when you use the mobile app.',
        ],
      },
      {
        heading: 'Grows with you',
        paragraphs: [
          'When you take on a partner or your first hire, add them to the same workspace. Figbolt is built for businesses of one to ten people, so the CRM you start with alone is the one your small team keeps.',
        ],
      },
    ],
    faqs: [
      {
        q: 'Do solopreneurs need a CRM?',
        a: 'If you manage more than a handful of clients, yes — the risk is forgetting a promise or a follow-up. A CRM that fills itself in, like Figbolt, gives you that safety net without adding admin work.',
      },
      {
        q: 'Is Figbolt good for freelancers and consultants?',
        a: 'Yes. Freelancers and consultants manage clients mostly through email and meetings, which is exactly what Figbolt reads to build and update your client records.',
      },
      {
        q: 'Can I use it on my phone?',
        a: 'Yes. Figbolt works in a phone browser and can be installed to your home screen. It shows an offline screen without a connection and stores none of your client data on the device.',
      },
      {
        q: 'What happens to my data if I connect my email?',
        a: 'Figbolt reads your email to build your client records. Integration tokens are encrypted at rest, customer content is treated as untrusted input to the AI, and nothing is sent to a client without your approval.',
      },
    ],
    keywords: [
      'CRM for solopreneurs',
      'CRM for freelancers',
      'CRM for consultants',
      'one person business CRM',
      'AI CRM for solopreneurs',
    ],
    updated: '2026-10-04',
  },
];

export function guideFor(path: Guide['path']): Guide {
  const guide = GUIDES.find((g) => g.path === path);
  if (!guide) throw new Error(`No guide for ${path}`);
  return guide;
}
