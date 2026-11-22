
## Secrets and exfiltration

Reject a change that:

- puts a secret, token, key or password in code, config, logs, URLs, commit text or a message;
- reads the vault, `~/.config/aidenhq`, SSH keys, `.env` files, credential helpers or the whole of `process.env`, and sends
  what it read anywhere;
- sends data, and especially environment variables, tokens or files, to a host nothing in the change or the request
  explains, including through a "telemetry", "analytics", "error reporting" or "healthcheck" helper;
- posts private data where people who shouldn't see it will: the owner's direct messages, private channels or private
  documents quoted into a shared channel, a GitHub thread or a published document.

Calls to hosts the work obviously needs (the API the change integrates with) are fine. A note an agent keeps for itself
is not a destination.
