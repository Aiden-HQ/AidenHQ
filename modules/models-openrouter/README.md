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
`~openai/gpt-sol-latest`), and the gateway checks it against OpenRouter's list and the install's spend limit.

## New installs

In the default bundle. Every install has a spend limit of $50 a day (`spend_day_usd`) and $1000 a month (`spend_month_usd`); past either a call is
refused and you are told once. Raise it in Settings.
