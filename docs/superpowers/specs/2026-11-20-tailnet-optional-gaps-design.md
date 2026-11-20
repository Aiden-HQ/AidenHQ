# Tailnet optional: close the last gaps

Status: draft for owner approval, 2026-11-20. Second of three setup simplifications. Small change.

## Intent

Most of "Tailscale is optional" is already built (minimal-core install): a fresh install off a tailnet defaults to
public HTTPS with a real certificate on its IP, Tailscale is installed only in `tailscale` mode, and agent-built apps
have app doors in `public` and `local`. The owner rule is that every feature works in every exposure mode
(public, tailscale, local). Five gaps remain.

## Goals, non-goals

- Goal: each remaining feature works in every mode, and nothing in the docs or the installer prompt says Tailscale is
  required.
- Non-goal: a `cloudflare` board mode (owner, 2026-11-20: fix the docs now; it is a backlog feature issue).
- Anti-goal: a per-mode special path where one mechanism covers all modes.

## Approaches

One sensible way: fix each gap in the mechanism that already exists. A free automatic hostname for the board
(`<ip>.sslip.io`) was considered and rejected again: it reopens the 2026-11-16 decision (not on the Public Suffix List,
shared issuance limits, same-site with strangers' hosts) and isn't needed once Google stops requiring a named address.

## Design

1. **Google connects on a bare-IP board.** Delete `needs_name` from `modules/google/module.yaml`. A Desktop client
   already signs in through `127.0.0.1` with paste-back whenever the board is elsewhere
   (`google-workspace-mcp/src/reconnect.ts:30-44`), so the board's address never matters. If nothing else sets
   `needs_name`, delete the field from `modules/board/schemas/setup_flows.json`, `services/board/src/setup-flows.ts`
   (`namedHost`) and `SetupFlow.tsx` (one way). Step 8's paste-back text already covers it.
2. **App doors in `tailscale` mode without the apps key.** When `TS_APPS_AUTHKEY` is absent, `tailscale` mode gets the
   same app door `public` uses (`scripts/edge.ts`, `apps-mcp/src/doors.ts`, `docs/design/app-doors.md` table), served on
   the board's tailnet name. With the key, the apps tailnet node stays as it is. (Builder: confirm the door's host form on
   a tailnet name; if the sslip.io form is IP-only, use `<app>.<board tailnet name>` via the existing `tailscale serve`.)
3. **Docs and the installer prompt.**
   - `docs/setup.md`: the prerequisites table drops `TS_APPS_AUTHKEY` as required (optional, only for the apps tailnet
     node), and step 5 "Sign in" covers all three modes (link lifetime per mode).
   - `docs/setup.md` ~419 and `docs/design/access.md:29`: drop `cloudflare` as a board exposure mode; Cloudflare stays
     only as the optional edge for sharing apps.
   - distro `site/prompt.md:68,148,167`: Tailscale optional, no "isn't on the tailnet" wording.
4. **claude.ai and the owner MCP.** claude.ai connectors need a public https address, so in `tailscale` and `local`
   mode the board's MCP page says so in one line ("claude.ai needs public mode; Claude Code works here over the
   tunnel/tailnet") instead of failing silently.
5. **Paperclip console.** `docs/operations.md`: one line on reaching Paperclip's console (127.0.0.1:3100) over an SSH
   tunnel in `public` and `local` mode.

## Left to the builder

Test shape (the Google flow renders steps on a bare-IP board; an app door resolves in tailscale-without-key); exact copy.

## Built differently: item 2

A door on the board's tailnet name cannot work (MagicDNS resolves no `<app>.<node>` names, `tailscale serve` certifies only
the node's own name, sslip.io needs a public address, and an app on a port of the board's name shares its cookies). Owner
decision (2026-11-20): the apps node signs in interactively instead. In `tailscale` mode compile always runs `apps-edge`;
without `tailscale_apps_authkey` it has no `TS_AUTHKEY`, so it starts logged out with persistent `/state`. When an exposed
app first has a good deploy, apps-mcp (`edgeLogin`) reads `tailscale status --json`; on `NeedsLogin` it takes the `AuthURL`
(`tailscale up` without a key if none yet) and sends the owner one `decision` notice, `dedupe_key` `apps-edge:login`
(apps-platform requests `kernel.owner-notice`). After approval apps work as with the key. Test:
`modules/apps-platform/apps-mcp/test/edge-login.test.ts`.
