#!/bin/sh
# The board's suite: server tests on Node's own globals, the web tests (test/web) with happy-dom's window registered by the
# preload. Two runs because that preload replaces fetch, Request and friends, which the server tests need native. They run side
# by side; the script fails if either does.
bun test --parallel=2 --timeout=30000 --path-ignore-patterns 'test/web/**' test/ & server=$!
bun test --parallel=2 --timeout=30000 --preload ./test/web/dom.ts test/web/ || web=1
wait "$server" || exit 1
exit "${web:-0}"
