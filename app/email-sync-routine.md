# Email → Tracker sync routine

This is the procedure the scheduled "childcare-email-sync" routine follows on each run.
Its job: read **new inbound** childcare emails, reflect them on the tracker, and never send anything.

## Ground rules

- **Read-only on email.** Never send, reply, draft, archive, or label. Only read.
- **Inbound only.** Ignore anything in `SENT`. You are reflecting what centres tell us.
- **Auto-apply only when confident. Flag everything else.** A wrong-but-silent status
  change is worse than a flag. When in doubt, flag.
- **Toronto reality:** many centres use shared inbox domains, and OneHSN / Network Child
  Care send one email covering **multiple** centres at once. One sender ≠ one card.

## Data file

Edit `family-ops-backup.json` at the repo root. Relevant structure:

- `boards.childcare.cards[]` — each `{ id, status, fields:{ name, address, contact, confirmationReceived, lastReconfirm, ... } }`
- `boards.childcare.statuses` — the valid status values (e.g. `Watching`, `To Apply`,
  `Applied – Awaiting Confirmation`, `On Waitlist`, `Offer Received`, `Enrolled`, `Not Pursuing`)
- `emailSync` — `{ lastRunAt, lastProcessedEpoch, activity[], pending[] }`

## Steps each run

1. **Sync the repo.** `git pull --rebase` in the repo so you're not editing a stale file.

2. **Find new mail.** Read `emailSync.lastProcessedEpoch` (unix seconds of the newest email
   handled last run). Search Gmail for childcare-related inbound mail newer than that, e.g.
   query: `newer_than:7d -in:sent (waitlist OR "waiting list" OR daycare OR childcare OR
   "child care" OR onehsn OR "child care centre" OR enrol OR offer)`. Widen the window only
   if `lastProcessedEpoch` is older than 7 days. Skip anything at or before `lastProcessedEpoch`.

3. **For each new email, identify the centre(s).** Match, in priority order:
   - sender address / domain vs. a card's `fields.contact` email or the centre's known domain;
   - centre-name tokens and street addresses in the subject/body vs. card `name` / `address`.
   A single email may name several centres (Network, OneHSN) — collect **all** matched cards.

4. **Classify the signal.**
   - **Waitlist confirmation** ("you're on the waiting list", "added to our waitlist",
     "registration received", "officially on"): target status `On Waitlist`.
   - **Offer** ("a space is available", "we'd like to offer", "spot has opened"):
     target status `Offer Received`.
   - **Navigation / general info** (e.g. OneHSN pointing you to the City, no specific centre):
     not actionable — record nothing or flag as informational.

5. **Decide auto-apply vs flag.**
   - **Auto-apply** only when: exactly **one** card matches, the match is unambiguous
     (address or dedicated email, not just a shared domain), and the signal is clear.
     On auto-apply: set `card.status`, set `fields.confirmationReceived = "Yes"`,
     set `fields.lastReconfirm` = the email date (YYYY-MM-DD). Append an `activity` entry
     with `action:"auto-applied"`, the from/subject/threadId, `cardName`, and `change`.
   - **Flag** (append to `emailSync.pending`) when: more than one card could match, the
     sender domain is shared across several cards, it's a multi-centre email, there are
     duplicate cards for the same centre, or the target status is unclear. Each pending item:
     `{ id, threadId, receivedAt, from, subject, snippet, reason, candidates:[
       { cardId, cardName, boardId:"childcare", currentStatus, suggestedStatus, selected } ] }`.
     Set `selected:true` on the candidate(s) you'd recommend, `false` on alternates.
     Write a plain-English `reason` explaining why it needs a human call.
   - **Never auto-move to `Enrolled`, `Offer Received`, or `Not Pursuing`** — those are always flags.

6. **Update bookkeeping.** Set `emailSync.lastRunAt` = now (ISO), and
   `emailSync.lastProcessedEpoch` = the newest processed email's unix seconds.

7. **Commit & push.** If anything changed: `git add family-ops-backup.json && git commit`
   with a message summarizing auto-applied vs flagged counts, then `git push`. If nothing
   changed, still update `lastRunAt` but a no-op commit is fine to skip.

## Notes

- Don't re-flag an email whose `threadId` already appears in `emailSync.pending` or `activity`.
- The local app (if running) reads this same file, so your edits appear the next time it loads.
- Keep `reason` strings honest and specific — they're what the user sees when deciding.
