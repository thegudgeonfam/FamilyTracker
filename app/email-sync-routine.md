# Email → Tracker sync routine

This is the procedure the scheduled "childcare-email-sync" routine follows on each run.
Its job: read **new inbound** childcare emails, reflect them on the tracker, and never send anything.

## How this routine writes changes (single-writer model)

The routine must **never** edit `family-ops-backup.json` or run `git` directly —
attempting it is what used to make the sync fail silently. (The scheduled task may be
installed under **both** macOS accounts at **staggered times** — Corey 8:07, Justine
9:00 — so it runs whichever account is active. That's safe only because the server
rejects stale writes by revision and the epoch/threadId watermarks make the second
run a no-op; never register two copies under the *same* account.)

The local tracker server (`app/server.py`) is the **only** writer. The routine
talks to it over HTTP:

- **Read:**  `GET  http://127.0.0.1:4173/api/data` → the full tracker JSON.
- **Write:** `PUT  http://127.0.0.1:4173/api/data` with the **entire** modified JSON as the
  body (`Content-Type: application/json`). The server writes the file, commits, and pushes
  to GitHub itself. The routine runs no git commands.

The PUT body must be the whole document and still contain the top-level `boards` and
`boardOrder` keys, or the server returns HTTP 400. GET the document, mutate it in place
(leave the top-level `revision` field untouched — the server uses it to detect
concurrent edits), PUT it back. If the server is unreachable, **stop and report it** —
do not fall back to editing files or git.

- **HTTP 409** on PUT means someone edited the tracker while you were working: GET the
  document again and re-apply your changes to the fresh copy, then PUT again. Do not
  retry the stale body.
- **HTTP 400** mentioning card removal means your payload lost cards — that's a bug in
  your mutation, not something to confirm past. Stop and report it.

## Ground rules

- **Read-only on email.** Never send, reply, draft, archive, or label. Only read.
- **Inbound only.** Ignore anything in `SENT`. You are reflecting what centres tell us.
- **Auto-apply only when confident. Flag everything else.** A wrong-but-silent status
  change is worse than a flag. When in doubt, flag.
- **Toronto reality:** many centres use shared inbox domains, and OneHSN / Network Child
  Care send one email covering **multiple** centres at once. One sender ≠ one card.

## Data shape (inside the JSON you GET/PUT)

- `boards.childcare.cards[]` — each `{ id, status, fields:{ name, address, contact, confirmationReceived, lastReconfirm, ... } }`
- `boards.childcare.statuses` — the valid status values (e.g. `Watching`, `To Apply`,
  `Applied – Awaiting Confirmation`, `On Waitlist`, `Offer Received`, `Enrolled`, `Not Pursuing`)
- `emailSync` — `{ lastRunAt, lastProcessedEpoch, activity[], pending[] }`

## Steps each run

1. **GET** `http://127.0.0.1:4173/api/data`. Keep the full JSON — you will PUT it back later.
   If the GET fails (connection refused), the server is down: stop and report it so a human
   can restart it. Do not touch files or git.

2. **Find new mail.** Read `emailSync.lastProcessedEpoch` (unix seconds of the newest email
   examined last run). Search Gmail using that epoch directly — Gmail's `after:` accepts unix
   seconds — e.g. query: `after:<lastProcessedEpoch> -in:sent (waitlist OR "waiting list" OR
   daycare OR childcare OR "child care" OR onehsn OR "child care centre" OR enrol OR offer)`.
   No fixed-day window, no widening logic. Skip anything at or before `lastProcessedEpoch`.

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

5. **Decide auto-apply vs flag** (edit the in-memory JSON object).
   - **Auto-apply** only when: exactly **one** card matches, the match is unambiguous
     (address or dedicated email, not just a shared domain), and the signal is clear.
     On auto-apply: set `card.status`, set `fields.confirmationReceived = "Yes"`,
     set `fields.lastReconfirm` = the email date (YYYY-MM-DD). Append an `emailSync.activity`
     entry with `action:"auto-applied"`, the from/subject/threadId, `cardName`, and `change`.
     **Every activity entry must include `at` (now, ISO) and `threadId`** — dedupe and the
     audit trail depend on them.
   - **Flag** (append to `emailSync.pending`) when: more than one card could match, the
     sender domain is shared across several cards, it's a multi-centre email, there are
     duplicate cards for the same centre, or the target status is unclear. Each pending item:
     `{ id, threadId, receivedAt, from, subject, snippet, reason, candidates:[
       { cardId, cardName, boardId:"childcare", currentStatus, suggestedStatus, selected } ] }`.
     Set `selected:true` on the candidate(s) you'd recommend, `false` on alternates.
     Write a plain-English `reason` explaining why it needs a human call.
   - **Never auto-move to `Enrolled`, `Offer Received`, or `Not Pursuing`** — those are always flags.

6. **Update bookkeeping.** Set `emailSync.lastRunAt` = now (ISO), and
   `emailSync.lastProcessedEpoch` = the unix seconds of the newest email **examined this
   run — auto-applied, flagged, or ignored as informational, all of them count.** Flagged
   mail is safe to advance past because it's already durably in `pending`. (Leaving the
   epoch behind makes every future run re-scan an ever-growing window.)

7. **PUT** the full modified JSON back to `http://127.0.0.1:4173/api/data`. Confirm the
   response is HTTP 200 `{"ok": true}`. The server writes, commits, and pushes on its own.
   On 409, GET fresh and re-apply (see above). Any other non-200: report it plainly — do
   not retry blindly and do not touch files/git.

8. **Offers are time-critical.** Toronto centres commonly give 24–48 hours to accept a
   spot. If this run flagged a suspected **offer**, send a push notification (if a
   notification tool is available in this session) naming the centre and the email's
   received date, so it doesn't sit unseen until someone opens the tracker. If no
   notification tool is available, make the offer the first line of your run summary.

## Notes

- Don't re-flag an email whose `threadId` already appears in `emailSync.pending` or `activity`.
- The browser UI reads and writes through the same server, so your PUT is what everyone sees.
- Keep `reason` strings honest and specific — they're what the user sees when deciding.
