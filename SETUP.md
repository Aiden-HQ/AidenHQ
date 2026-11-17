# Set up your own AidenHQ

The easy way is one paste. Your own AI coding agent does the install and shows its progress; you open one link.

## 1. Paste the prompt

Paste this into your AI coding agent (Claude Code, Codex or similar):

```text
Install AidenHQ by following https://aidenhq.ai/prompt.md
```

It asks where to install (a server you can SSH into, or your Mac) and your email, then installs everything and tells
you how far along it is. Nothing else is needed from you. On a Mac, keep it awake and on power so your agents keep
working.

## 2. Open the link

When the install reaches 100% your agent prints one setup link (one use, valid 72 hours). Open it. The first-run page
asks you to:

1. create your account and set up an authenticator app,
2. connect OpenRouter (or paste a model key), which is what runs your agents.

Next you see the recovery key page: save the key somewhere safe.

## 3. Three quick steps

The board then offers a short wizard: save your recovery key, connect Telegram, connect Slack. Each is skippable and
can be done later from the board.

## 4. Talk to Aiden

Aiden says hello, learns how you work and takes your first job.

## Prefer to do it by hand?

[docs/setup.md](docs/setup.md) is the manual setup, step by step with a check after each one: your own VM, the
secrets, accounts, the GitHub App, upgrading the product. It also has the reference for account recovery and shared
access. In Claude Code, the `setup-aidenhq` skill walks it for you.

Day-to-day use: [docs/USAGE.md](docs/USAGE.md). Operations, backups and logs: [docs/operations.md](docs/operations.md).
