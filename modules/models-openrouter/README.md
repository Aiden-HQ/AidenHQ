# models-openrouter

## What it does

The list of OpenRouter models the gateway may call, with their prices and output limits. A model an agent asks for by an
id not listed here is refused. It also asks for your OpenRouter key.

## Connect

Paste your OpenRouter API key (`openrouter_key`, `sk-or-...`) in the board's setup. It goes into the vault and only the
kernel's model gateway reads it. Agents can't run without it. Set a spend limit on the key itself.

## What agents get

No tools. Agents name a model by id (for example `~deepseek/deepseek-flash-latest`, `~openai/gpt-luna-latest`,
`~openai/gpt-sol-latest`), and the gateway checks it against this list and the spend caps.

## New installs

In the default bundle. A new install also gets an install-wide cap of $10 a day (`spend_day_usd`); past it a call is
refused and one card asks you to raise it.
