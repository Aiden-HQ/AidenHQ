# aria

## What it does

Aria is your executive assistant for the calendar. She answers small, time-sensitive asks fast and with a source, sets
reminders, and runs your calendar through your own Google account: she finds a free time (computed by `calendar_find_times`,
never by the model), books it rather than offering a menu, and tells the people involved. Summoned into a chat ("cc Aria"), she
books, confirms in the chat, follows up once and handles "8 doesn't work, how about 9?". Each calendar change is reviewed first,
and she has no accounts of her own. An optional nightly tidy-up moves meetings you organise to a better window, as a prompt
you write says (limits included).

Her page (Team, Aria) holds everything she needs to know about you: working hours and call windows, meeting lengths and limits
(empty means no limit), VIPs and your team, plain-English preferences, how she follows up, and the tidy-up. Aria reads your last
four weeks of meetings and proposes your hours, usual lengths and calendars (`aria_suggest`); the page shows them as a proposal
and nothing changes until you Save.

## Connect

Needs the `google` module with your Google account connected. Nothing else to connect: add her from the module catalog and open
her page. Slack, Glean and the warehouse are used for quick answers when they are connected.

## What agents get

The `aria` teammate reads your calendar, mail, Drive and Docs, may create, move, cancel and answer calendar events (each reviewed
first) and uses `calendar_find_times`. She holds `aria_config`, `aria_configure` (a proposal), `aria_suggest`, `wake_at` and her own tasks. The tidy-up
is a declared routine, `optimize-calendar`, paused until you resume it (Settings, Modules, Aria), at 2:00 AM on your clock; its
prompt is the `aria_optimizer_prompt` setting. A page cannot resume a routine or change its time today, so the page edits the prompt
and says where to resume it. Rules for booking live once, in the skill `scheduling`; the tidy-up's in `optimize-calendar`.
`evals/` holds the owner rulings and injection cases as scenarios (`ru-*`, `adv-*`); a case with a `status` marks one written
for the old standalone assistant's harness.

## New installs

Not in the default bundle (it needs Google to be useful). Once added, nothing is scheduled and nothing is spent: the tidy-up routine
is paused and nothing runs, and the page opens with Aria's suggestion for your hours when she has read your calendar (setting her up
as a teammate asks her to). With Google not connected the page says so and shows the defaults; every limit starts empty.
