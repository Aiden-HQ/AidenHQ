# models-openrouter

## What it does

OpenRouter as the model provider: it asks for your OpenRouter key. Any model OpenRouter lists works by its id: the gateway
prices each call from OpenRouter's own models list and records what OpenRouter billed for it. An id OpenRouter doesn't list
is refused.

## Connect

Paste your OpenRouter API key (`openrouter_key`, `sk-or-...`) in the board's setup. It goes into the vault and only the
kernel's model gateway reads it. Agents can't run without it. Set a spend limit on the key itself.

## What agents get

No tools. Agents name a model by id (for example `~deepseek/deepseek-flash-latest`, `~openai/gpt-luna-latest`,
`~openai/gpt-sol-latest`), and the gateway checks it against OpenRouter's list and the spend caps.

## New installs

In the default bundle. A new install also gets an install-wide cap of $10 a day (`spend_day_usd`); past it a call is
refused and one card asks you to raise it.
