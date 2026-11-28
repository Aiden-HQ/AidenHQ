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

The `google_workspace` connection. Read: `calendar_list_events`, `calendar_search_events`, `calendar_get_event`, `calendar_today`, `calendar_find_times`,
`drive_list_recent_files`, `drive_list_meeting_documents`, `drive_search_files`, `drive_read_file`, `gmail_search`,
`gmail_read_thread`, `docs_read`, and `gmail_inbox_new` (the inbox since the caller's cursor, automated mail set aside in
code) with `gmail_inbox_ack` (moves that cursor). Glean finds Drive documents faster; read them here for the exact current text.

Write, as you on one account (`account`, default the primary), granted only by name: `calendar_create_event`,
`calendar_update_event`, `calendar_delete_event`, `calendar_respond`, `gmail_draft` and `gmail_send`, each a record the
AI reviewer decides first; and `gmail_label` (your own existing labels only, never system ones), which runs at once.
`calendar_find_times` proposes ranked meeting slots from your working hours, buffers, notice and call windows, in the zone
you are in each day (flights, stays and working locations you organised or accepted move it, when they carry their own time zone). Creates refuse a time another
event holds and make one event per `request_key` on a retry; moves are refused when the event changed since it was read.
Agents that hold them list the skills `google.calendar-changes` and `google.gmail-writes`. Scopes: `calendar.events`,
`drive.readonly`, `gmail.modify`, and `calendar.events.freebusy`, which lets `calendar_find_times` read colleagues'
free/busy (Workspace shows it by default). An account connected before it keeps working: the tool answers from your own
calendar (`not_granted`) and Settings, Connections offers "Reconnect to see colleagues' calendars". Anyone whose calendar
the tool cannot see (an external person) is skipped, never an error; `attendees_local` (zone and hours, as the caller knows them) ranks slots into core hours, then stretch hours; you may be offered `stretch_hours` beyond your working hours, never further. An account connected before writes existed keeps reading; Settings, Connections asks you
to reconnect it once, and a write on it asks for that reconnect too.

## New installs

In the default bundle. Until you connect, agents have no calendar or mail context and the tools say how to connect. The
Researcher holds the calendar and email writes and uses them only when you ask.
