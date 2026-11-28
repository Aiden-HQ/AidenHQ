# google

## What it does

Aiden reads your Google Workspace to brief you and follow up: Calendar events, Drive and Docs text, and Gmail threads.
Agents you grant it can also change your calendar and write email as you, each change reviewed by the AI reviewer first.
Drive metadata also lands in the warehouse as `src_docs`.

## Connect

Board, Settings, Google (`#/setup/google`), about 5 minutes in the Google Cloud console. Create a Desktop-app OAuth
client, paste its client id and secret (`google_client_id`, `google_client_secret`), then press Connect Google from the
board's loopback address (or paste the redirected address back). Google only accepts a named address or `127.0.0.1` for
sign-in. By hand: `scripts/google-auth.sh <client.json>`.

## What agents get

The `google_workspace` connection. Read: `calendar_list_events`, `calendar_search_events`, `calendar_get_event`, `calendar_today`, `calendar_find_times`, `calendar_free_busy`, `calendar_check_times`,
`drive_list_recent_files`, `drive_list_meeting_documents`, `drive_search_files`, `drive_read_file`, `gmail_search`,
`gmail_read_thread`, `docs_read`, and `gmail_inbox_new` (the inbox since the caller's cursor, automated mail set aside in
code) with `gmail_inbox_ack` (moves that cursor). Glean finds Drive documents faster; read them here for the exact current text.

Write, as you on one account (`account`, default the primary), granted only by name: `calendar_create_event`,
`calendar_update_event`, `calendar_delete_event`, `calendar_respond`, `gmail_draft` and `gmail_send`, each a record the
AI reviewer decides first; and `gmail_label` (your own existing labels only, never system ones), which runs at once.
`calendar_free_busy` returns people's busy blocks, hours and working locations, and `calendar_check_times` verifies candidate times you composed (the owner's conflicts, each person's status and hours-tier). `calendar_find_times` proposes ranked meeting slots (`required` people must be free, `optional` ones only raise `optional_free`; `owner_hours` strict/stretch/any, `movable_event_ids`, `weeks`, `days`, `preferred`) from your working hours, buffers, notice and call windows, in the zone
you are in each day (flights, stays and working locations you organised or accepted move it, when they carry their own time zone). Creates refuse a time another
event holds and make one event per `request_key` on a retry; moves are refused when the event changed since it was read.
Agents that hold them list the skills `google.calendar-changes` and `google.gmail-writes`. Scopes: `calendar.events`,
`drive.readonly`, `gmail.modify`, and `calendar.events.freebusy`, which lets `calendar_find_times` read colleagues'
free/busy (Workspace shows it by default). An account connected before it keeps working: the tool answers from your own
calendar (`not_granted`) and Settings, Connections offers "Reconnect to see colleagues' calendars". Anyone whose calendar
the tool cannot see (an external person) is skipped, never an error; `attendees_local` (zone and hours, as the caller knows them) ranks slots into core hours, then stretch hours; you may be offered `stretch_hours` beyond your working hours, never further. A colleague with a zone and no hours given gets theirs inferred from their last 28 days of free/busy (at least 8 busy days and a span of 4 to 14 hours, else the defaults), kept 7 days per account; `attendees[].hours.source` says `given`, `inferred` or `default`. An account connected before writes existed keeps reading; Settings, Connections asks you
to reconnect it once, and a write on it asks for that reconnect too.

## Agent email addresses

An address that lands in your Gmail and that you can send as can be an agent's own: a Workspace alias or group
(`abotley@company.com`) or a plus-address of yours (`you+aria@company.com`). List them in the setting
`google_agent_addresses` (`[{ agent: aria, address: abotley@company.com }]`); empty (the default) turns it all off.

- **People write to the agent.** Every minute the service searches your Gmail for new mail to or cc an address (group
  deliveries and your own sent mail included, drafts and automated mail not) and hands each message to the kernel as an
  event for that agent (`to_agent`, `entry: gmail:<account>:<address>`). A new address starts from now. When you cc an
  agent's address on your own mail, that is a summons (`from_owner`).
- **The agent answers as that address.** The reply is a reply-all in the thread, `From:` the address, after Gmail's
  send-as check (a verified "Send mail as" entry, or a plus-address of your own). The kernel's `prepare` call freezes
  the anchor message, the account, the address and the exact recipients before review, and `reply` sends only that.
- **One consumer.** Mail to an agent's address is the poller's: `gmail_inbox_new` leaves it out (`dropped`
  `agent-address`), so Intake never triages it. An address belongs to the first connected account (the primary first)
  that can send as it; while none can (its "Send mail as" entry is unverified, or Gmail's answer is unavailable), its mail
  stays in the feed, and a failed lookup fails that account's feed call instead.
- **Provenance.** Every agent send, `gmail_send` included, is recorded durably and stamped with an `X-AidenHQ-Token`
  header. An unclear failure is reconciled against the account's sent mail before any retry, and a stamped message that
  comes back through the poller is dropped, so an agent's own send is never read as your words.

## New installs

In the default bundle. Until you connect, agents have no calendar or mail context and the tools say how to connect. The
Researcher holds the calendar and email writes and uses them only when you ask.
