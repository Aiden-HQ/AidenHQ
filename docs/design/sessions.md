# Sessions on the board

Long-lived coding harnesses (opencode) on the always-on computer, each held by one task
(`docs/superpowers/specs/2026-11-25-sessions-design.md`). The board lists them, starts them and opens their terminal.

## Pages

- `#/sessions`: Active and Ended lists. A row has the state (Working, Waiting, Starting, Stopped, Failed), the title with its
  task id and repository, what it is doing (its own column from 1400px wide), who started it, spend and age. "Show more" pages through ended
  sessions. A fresh install shows what a session is and one button, "Start a session".
- `#/sessions/<identifier>`: the console (a real terminal through ttyd, or the harness's web view; a phone opens on the web
  view) beside the facts and the task thread, which also takes a message that wakes the
  session. On a narrow screen the parts are a switch: Session, Thread, Details.
- Start: name, first instruction, optional repository. It uses the board's ordinary task path (`api.create` then
  `api.addAgent` with the Session agent, whose Paperclip id `/api/sessions` returns). The agent's part of the task is the
  session, so Start opens that one, and the signed-in account is its creator.

## States

| State | What shows |
| --- | --- |
| loading | row skeletons |
| first install | the empty state above |
| starting | "Starting" with a pulsing dot; the console says the computer is preparing its folder |
| working | green dot; the terminal is live |
| waiting | blue dot; "Asleep, using no tokens" and its last words; the terminal is live |
| stopped / failed | the console shrinks to a note; failed also gets a banner with the cause; the thread stays readable |
| someone else's | the console says who started it; the thread is readable |
| terminal unreachable | the pane probes the proxy every 4s (it can't see the sandboxed frame's own socket): "Retrying" (one or two misses), then "Offline" with Reconnect; the frame reloads itself when the link returns |

The console stays dark in both themes (`--term-*` tokens). Everything else is the board's kit.

## Access

Opening is two steps. `POST /api/sessions/<task>/open` (board sign-in) passes `mayOpen`: the account that created the task, or
for an agent-made task the creator of its nearest person-made ancestor (the board's `authored` record; a failed Paperclip read
is a 502, never "someone else's"). It returns paths `/sessions/<task>/<token>/term/` and `/web/`, where the token is an HMAC
of the task and an expiry (30 minutes; the console re-mints on every reload, and a probe that gets a 401 reloads the frame).

`/sessions/<task>/<token>/…` (HTTP and WebSocket) is authorised by that token alone, never by the board cookie. Harness content
(ttyd's page, opencode's web UI, anything a process in the box serves) must not run with the board's origin: responses carry
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads` (an opaque origin, even when the page
is opened on its own for the phone), the board frames them in an iframe with the same `sandbox` and never `allow-same-origin`,
upstream cookies and CSP are dropped, and the requests' `Origin: null` is allowed because the token is the credential. The
board adds its key (`computer_session_key`) for the launcher, which adds the box-side credentials
(`services/computer/session-proxy.ts`). Neither credential reaches the browser.

The phone link is the page's own address (`#/sessions/<identifier>`), so a phone signs in first and then lands on the session.

The kernel side is `GET /v1/work?sessions=1` and `?session=<task>` (`kernel/src/work.ts sessions()`, board key): a session is
the newest job of a task whose agent's grants have profile `session`; running is "the gateway billed a call in the last two
minutes", waiting is alive and idle.

## Development

`node web/dev/mock-api.ts` serves the page with `?sessions=full|fresh|off|error` and a fake terminal and web view
(`?term=up|down|flaky`). Terminal and web view are not proxied with a matching Origin under `npm run dev:web`, so only
their first GET works there. Screenshots at 1512, 1920, 2560, 1024, 768 and 375, light and dark, are in `sessions/`.

## Follow-ups

- Watches ("Asleep until PR #412 merges"): the sessions service keeps them in its own database, which the kernel can't read, so the
  page shows the agent's last words instead. A feed of armed watches (facts or a kernel read) would bring the line back.
