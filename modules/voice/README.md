# voice

## What it does

Talk to Aiden by voice in Telegram. Your voice notes are transcribed on this server (Whisper, `small` model), and the
audio never leaves it. Typed messages work without it.

## Connect

Nothing to set up: add the module. It joins `channel-telegram`'s network and needs Telegram paired.

## What agents get

No tools. It only transcribes your voice notes for `channel-telegram`.

## New installs

Not in the default bundle: off until you add it. It adds a 2 GB speech-to-text service and about 8 GB of disk, and the
model unloads after 5 idle minutes. While off, a voice note gets "Voice notes are off".
