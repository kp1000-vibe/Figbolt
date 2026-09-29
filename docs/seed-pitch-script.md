# Figbolt — seed pitch narration

Timed to the auto-advancing deck. Total runtime **1:44**. Word counts assume a
measured ~145 wpm — comfortable, not rushed. Each slide's duration is set in
the deck's `data-ms`, so if you speak faster or slower, change the number there
rather than fighting the timing.

**Recording:** open the deck full screen, start your recorder, press play. The
controls fade out of the way; the progress bar at the bottom shows pacing.

---

### 1 · Title — 4s
> Figbolt. The CRM nobody has to fill in.

*(Let it breathe. Don't rush the open.)*

---

### 2 · The problem — 7.5s
> Every CRM ever sold is a database your team maintains for a machine.
> Salesforce and HubSpot are filing cabinets. They're excellent at storing what
> someone typed — and they know nothing you didn't type.

---

### 3 · What it costs — 8s
> So the record is always stale, and the rep pays for it. Updating the CRM
> isn't selling. A deal says "Proposal" because somebody remembered to change a
> dropdown. And the person filling it in gets almost nothing back.

---

### 4 · The inversion — 8s
> Figbolt inverts it. The machine keeps the record. It reads the email,
> meetings, tickets and product usage you already generate, derives the
> customer record from them, and asks a person only for the decisions that
> deserve one.

---

### 5 · Derived record — 8.5s
> This account page was never filled in. Commitments, objections, stakeholders,
> product requests — each one extracted from a specific email or transcript
> line, and each one traceable back to it.

---

### 6 · Grounded answers — 8.5s
> Ask why a deal stalled, and every claim cites the evidence behind it. When
> the evidence is thin, Bolt says so instead of producing a confident guess.
> Citations are validated against what was actually retrieved — it cannot cite
> a record it never read.

---

### 7 · The loop — 9.5s
> Here's the loop that closes. The call is scheduled from Figbolt, so it knows
> the deal. It's transcribed and attributed. Extraction pulls out the decisions
> and the next steps. Those become typed CRM actions, validated against real
> schemas. And then you approve them. That last step is the rep's only job.

---

### 8 · Human in the loop — 8.5s
> It proposes; a person decides. A transcript is untrusted input — a customer
> could say anything into it — so nothing derived from one ever executes on its
> own. The payload you approve is the payload that runs.

---

### 9 · Defensibility — 9s
> The moat is the plumbing, not the prompt. Bitemporal memory, so history is
> answerable. Citation validation, so answers can't drift. A five-gate
> dispatcher, so an agent can never exceed the person who authorised it. And a
> learning loop, where every human correction becomes a regression test.

---

### 10 · Built — 9s
> This isn't a mockup. It's live at figbolt.com today: two hundred and nineteen
> tests passing, every eval case green, fifty-nine tables, twenty-nine typed
> agent tools — plus an MCP server, so other agents can use the CRM with the
> same permission checks a person gets.

---

### 11 · Why now — 8s
> Why now: reading everything a customer ever sent you just became affordable.
> Small models are cheap enough to run over every email and transcript, and a
> routing layer sends each job to the smallest model that can do it.

---

### 12 · The ask — 8s
> We're raising a seed round to get from working to used: design partners,
> production connectors, and the first engineering hires.

**→ Replace with your actual sentence once the number is set.** Something like:
*"We're raising £X to reach Y design partners and Z in ARR over the next
eighteen months."*

---

### 13 · Close — 5s
> Figbolt. Sweet deals, lightning fast.

---

## Before you send this to anyone

Three things in the deck are mine to build and yours to decide. I have not
filled them in, because inventing them would be worse than leaving them blank.

1. **The ask (slide 12).** The amount, the use of funds and the terms. The slide
   currently shows a dashed placeholder — it is obvious on screen, by design,
   so it cannot be shipped by accident.

2. **Traction.** There is none yet, and the deck does not claim any. No users,
   no revenue, no pipeline. If you have design-partner conversations underway,
   that is the single highest-value slide you could add.

3. **Market sizing.** Deliberately absent. A TAM number I generated would be
   fiction, and investors test those first.

## What the deck does claim, and where it comes from

Every number on slide 10 is measured from the repository, not estimated:

| Claim | Source |
|---|---|
| 219 tests passing | `npx vitest run` |
| 21/21 eval cases | `npm run eval -- --no-propose` |
| 59 database tables | `pgTable(` declarations in `src/db/schema/` |
| 29 typed agent tools | 18 read + 11 write in `src/lib/agents/tools/` |
| 56k lines of TypeScript | tracked `.ts`/`.tsx` excluding tests |
| 36 application routes | `page.tsx` files under `src/app` |
| Live at figbolt.com | verified HTTP 200 |

The problem framing on slides 2 and 3 is an argument, not a statistic. If you
want to quote the industry research on how little time reps spend selling, add
the citation to the slide — an uncited percentage is the first thing a partner
will push on.
