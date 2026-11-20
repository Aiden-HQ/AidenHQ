# Module building blocks: test, reconfigure, help, validate

Status: design. The owner asked for these from the start, not when a module first needs them (2026-11-20).

## Why

Research into plugin ecosystems found that declared settings drawn by the host win:
- Home Assistant's config, options and reauth flows;
- VS Code's configuration schema;
- n8n's and Airbyte's declared connector specs.

They also found four things our declarations lack. Each makes setup easier on the board and for the owner's Claude,
which drives the same declarations through the AidenHQ MCP (`2026-11-20-owner-mcp-design.md`).

## The four

1. **Test connection.**
   - Every sign-in's service answers `GET /auth/check`, a sibling of its `status_url` like `start` and `finish`. It makes
     one live, read-only call upstream (a whoami or a tools list) and returns `{ ok: true }` or
     `{ ok: false, message, fix? }`. `message` is plain words about what's wrong; `fix` is a short instruction ("Reconnect",
     "Paste a new token").
   - The SDK vendor proxy (`kernel/sdk/src/vendor/proxy.ts`) implements it once, for every proxy connection. The
     first-party sign-ins (Google, GitHub) implement the same contract.
   - The board shows a **Test** button on each connected sign-in. The MCP `connect` tool runs it and returns the result.
   - No declaration is needed: every sign-in has it. Compile checks that each `board.signins` service is built on the proxy
     or lists `/auth/check` (a fixture test per first-party one).
2. **Reconfigure after setup.**
   - A finished `board.setup_flows` flow can be opened again from the module's page ("Change setup"). It reopens with the
     current values: the mode picked, the secrets present (never their values) and the pairing state.
   - Changing the mode files a settings change, as the first pick does. Replacing a secret writes the vault, as the first
     paste does.
   - This is the same flow, so there is no new schema and no second path. MCP `connect` returns the same link with
     `?change=1`.
3. **Help on every setting.**
   - The comment above each setting in `module.yaml` is already its `doc` (`scripts/modules.ts` `settingsDoc`). Compile now
     refuses a module setting without one.
   - A setting may add `pattern` (anchored, like a secret's `setup.pattern`) and `when: { <setting>: <value> }`. With
     `when`, it is shown and settable only in that mode, the same rule that sign-in `secrets` and `choose.inputs` already
     use.
   - The board shows the doc beside the field. The MCP `modules` tool returns `doc`, `values`, `pattern` and `when` for
     each setting.
4. **Validation hook.**
   - A module may declare `validate: http://<service>:<port>/validate` (top level in `module.yaml`; `auth` is one of its
     own secrets, as `checks` use).
   - Before the board files a settings change to that module's settings, or writes a pasted secret to its vault, it posts
     `{ settings?: {..proposed..}, secret?: { name } }`. The secret's value is sent in a separate field only to its own
     module, never logged.
   - The hook answers `{ ok: true }` or `{ ok: false, errors: [{ field, message }] }`. Errors show under the field and
     come back from MCP `change_settings` and `connect` the same way.
   - A hook that doesn't answer within 10 s doesn't block. The change files, and the board says it couldn't be checked.
     It ships in observe mode first (CLAUDE.md, non-security gates): failures log `gate.would_block`, and the hook is
     promoted to enforce once its entries are reviewed.

## Non-goals

- Module views, the sandboxed MCP Apps escape hatch. They come later (owner, 2026-11-20).
- New setting types beyond what the board already draws.

## New installs

Nothing changes until a module is connected:
- Test shows only on connected sign-ins.
- A module without `validate` behaves as today.
- The doc rule fails compile only for an official module missing a comment. The fix lands with this change, for every
  module.

## Tests

- **The proxy's `/auth/check`:** connected gives ok; a revoked token gives `ok: false` with a fix.
- **Setup flow:** one test that a finished flow reopens with its mode, and that changing it files a settings change.
- **Validation:** a fake module hook refuses a value, the board's settings change returns the field error, and in observe
  mode it files anyway with a `gate.would_block` event.
- **Compile:** refuses an undocumented setting.

## Left to the builder

- Which upstream call each first-party check makes.
- The exact placement of Test and "Change setup" in the kit (`board-ui.md`: `Button`, `Banner`).
