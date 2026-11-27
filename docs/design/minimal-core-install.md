# Installing without a tailnet

A server off a tailnet gets public HTTPS with a mandatory authenticator (TOTP), and a host with no public IPv4 gets `local`
(an SSH tunnel). Tailscale is installed only in `tailscale` mode. The canonical text lives in [access.md](access.md):

- **Modes, the firewall, choosing and switching a mode:** "Exposure modes".
- **The public front door** (Caddy, the IP certificate, the fall back to `local`, the certificate watch): "The public front door (Caddy)".
- **Sign-in hardening** (lockout, per-address ban, new-sign-in notices, the one-time setup link and its 24-hour life in
  public mode): "Accounts and sign-in".
- **Apps without the tailnet apps node:** [app-doors.md](app-doors.md).
- **Checks:** `scripts/verify-security.sh` compares the live firewall with the mode and, in public mode, checks the door as
  the Internet meets it.

Sign-ins that return to a loopback address (Glean, Jira, Grafana Cloud, ClickHouse, Primer, HubSpot) work from the board's own
host, or by pasting the address the tab ends on into the Connect dialog: [setup.md](../setup.md).
