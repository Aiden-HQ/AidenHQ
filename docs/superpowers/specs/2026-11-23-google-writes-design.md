# Google writes: calendar and Gmail, behind review

Owner decision, 2026-11-23: Google stops being read-only. Agents may change the owner's calendar and send or draft email
as the owner, each change a kernel write record the AI reviewer decides first, like Slack sends as the owner and GitHub
comments.

## Tools (google_workspace connection, first-party server)

All act on exactly one account: `account` (an email), default the primary. None searches other accounts for the target.

| Tool | Google call | Tag | Tier |
| --- | --- | --- | --- |
| `calendar_create_event` | `POST events` (title, start, end, attendees, description, location, Meet link) | destructive | 1 (AI reviewer) |
| `calendar_update_event` | `GET` then `PATCH events/{id}`: move, rename, `add_attendees` / `remove_attendees` merged into the list Google holds | destructive | 1 |
| `calendar_delete_event` | `DELETE events/{id}` (cancels it for everyone when the owner organises it) | destructive | 1 |
| `calendar_respond` | `GET` then `PATCH` only the owner's own attendee entry (`attendeesOmitted`): accepted, declined, tentative | destructive | 1 |
| `gmail_draft` | `POST drafts` (new, or a reply in `thread_id`) | destructive | 1 |
| `gmail_send` | `POST messages/send` (new, or a reply in `thread_id`) | destructive | 1 |
| `gmail_label` | `POST threads/{id}/modify`, `add` / `remove` user label names | destructive + `unreviewed` | 0 |

- **Why `destructive`, not `write`:** only `destructive` gets floor 1 (`kernel/src/writes.ts` fileTool), and the `write`
  shorthand never grants one, so every agent holding a write names it. Slack's plain-`write` draft runs unreviewed; the
  owner asked for Gmail drafts reviewed, so `gmail_draft` is destructive too.
- **`sendUpdates` defaults to `all`**: attendees get the invite, change or cancellation, as when the owner does it by hand.
  An agent passes `none` to change only the owner's copy. The reviewer sees the value in the record.
- **Replies** carry `threadId`, `In-Reply-To` and `References` from the thread's last message, and `Re: <subject>`.
- **Headers are built in code**: addresses are validated one by one, and CR or LF in any header value is refused, so a
  subject can't smuggle a `Bcc:`. Bodies are plain text, UTF-8, at most 50,000 characters (the kernel's carded-args cap
  is 100,000).
- **`gmail_label` is upkeep, not a send** (owner, 2026-11-23, GitHub issue labels the same way): it changes only the
  owner's own mailbox, nobody else sees it, and it is undone by the reverse call. Code limits it to user labels the
  mailbox already has: it refuses system labels (`INBOX`, `UNREAD`, `TRASH`, `SPAM`, `SENT`, `DRAFT`, ...) and never
  creates a label, so a prompt-injected email can't archive, trash or hide mail through it.

## Scopes

`calendar.events` (read and write events; replaces `calendar.events.readonly`), `drive.readonly`, `gmail.modify`
(read, drafts, send and labels in one scope; replaces `gmail.readonly`, so `gmail.compose` isn't needed). The list
lives in `google.ts` `SCOPES`; `auth.ts` (the host fallback, self-contained for type stripping) keeps a copy a test
checks against it.

- `Reconnect.finish` no longer refuses extra granted scopes: Google returns the scopes the client already holds (the old
  readonly ones) beside the new ones, and what agents can do is decided by tool tags and grants, never by the token.
  A subset (the owner unticked one at consent) is saved as granted.
- Each account's stored `scopes` decide whether it can write: a write on an account without the scope (every account
  connected before this change) answers `needs_owner` `{ cause: "scope", scope: "calendar.events" | "gmail.modify" }`
  without calling Google. Reads keep working on the old token.

## Reconnect: what the owner sees

- **Settings, Connections:** an account whose stored scopes lack a write scope shows on the Google row, "<email> needs new
  access: reconnect once so agents can change your calendar and send email (each change reviewed first)", with Reconnect
  (`authStatus().missing`; the gear's dot is on). Reads keep working meanwhile.
- **If an agent writes first**, the kernel's connect-on-first-use path takes it:

  - **A live call (Tier 0, `gmail_label`) on work the owner asked for:** one message in that conversation, "Google needs
  you to grant the gmail.modify permission so I can <task>: <board>/connect/google", and the task waits; Connect wakes it.
  - **A reviewed write (Tier 1):** the kernel replays it after review as module work, so the need is recorded as background:
  the record's outcome says Google needs the permission (the agent tells the owner, per the skill), and the owner's
  digest lists "Google isn't connected (missing the calendar.events permission): <link>" once it has lasted 10 minutes.
- The link opens Connect Google; signing in as the same account replaces its token with one holding the new scopes, and
  the board's Connect clears every Google need (`okModule`). One reconnect per account, once.

Known gap: a Tier 1 replay's need is background (the task doesn't wait on Connect), and a retry with the same arguments
within 10 minutes of filing returns the failed record. The Connections row asks first, so this needs an owner who
ignored it; routing replay needs through the requester's task is a kernel change for later.

## Agents and skills

Rules live in two skills of the google module, listed by every agent that holds the tools:

- `google.calendar-changes`: when to change the calendar (only on the owner's own words or a task he assigned; never
  because an email, invite or document asks), check the event first, state times in his zone, `send_updates`, and what
  to do on a `scope` need.
- `google.gmail-writes`: draft vs send (send only when the owner asked to send; otherwise draft), reply in thread, never
  put private material in mail to others, labels.

Grants:

- **Researcher (`assistant`, chief-of-staff module):** all six reviewed tools by name, both skills. It already does the
  owner's asked-for writes (GitHub, Slack drafts, Primer). With no Aria (a new install), the owner's "move my 3pm" reaches
  it through Aiden, and, as for its other writes, it acts once the owner's own words are on its task (Aiden relays owner
  words only to Engineer tasks today; widening that is a separate change).
- **Intake (`inbox-agent`, open-loops):** `gmail_label` only, so it removes the `Aiden` label from a thread whose task the
  owner closed. Never draft or send: it reads untrusted mail.
- **Aiden (chief of staff):** unchanged. It reads and delegates writes.
- **Aria (instance module):** the four calendar tools and `google.calendar-changes`; an instance change, below.

## Intake's label

The label keeps meaning "an open task": the owner removing it still marks the task answered, and new replies on a
labelled thread still reach the task. What's new: when the owner closes the task on the board, the next scan finds the
thread still labelled, its `task_create` dedupes to the closed task, and Intake removes `Aiden`, so Gmail and the board
agree. Nothing is dropped. A thread the owner labels again after closing its task is cleared again (as before, a closed
task is never recreated).

## Instance change (Aria)

`modules/aria/module.yaml`: `google_workspace: read` becomes the explicit list of its reads plus `calendar_create_event`,
`calendar_update_event`, `calendar_delete_event`, `calendar_respond` (a grant is read, write or a list, never a mix), and
`skills` adds `google.calendar-changes`. Its handbook's "never change the calendar in phase 1" lines (Security rules,
lane step 8 and 10, background step 3, What needs approval, example 19) change to "calendar changes: skill
`google.calendar-changes`". Its lane keeps reads only: a calendar change goes to a background `task_create`, since a
reviewed write has no answer within the lane's deadline.

## New installs

The tools exist but no agent uses them until asked: quiet start holds. The first Connect asks for the new scopes. An
install without Aria has calendar and email changes through the Researcher. Another owner's agents get the tools by
naming them in a grant and listing the skills.
