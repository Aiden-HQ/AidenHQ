# Sharing a local module

The owner publishes one of the instance's own modules (`modules/<name>/` in the instance repo, tier `local`, `library`
included) to a public GitHub repo with a `marketplace.json`. Another instance adds that marketplace at a pinned commit and
installs the module through the usual grants diff and AI review. Spec: `docs/superpowers/specs/2026-11-22-agent-anatomy-design.md` §5.

## What leaves

Only what a local module may hold, read as git blobs at one instance commit (`kernel/src/module-share.ts` `exportModule`):

- `module.yaml`, as written, with these exceptions (the preview lists each under "not shared", with its reason):
  - an agent's `reports_to` and `image`;
  - a routine whose `agent` isn't in the module;
  - a routine with a literal `event.resource`.
  - The module gets `isolation: trusted` when an agent's effective grants include a write or destructive tool, or it
    carries code. An importer runs a third-party module untrusted unless it says so, and saying so is new authority on
    the importer's apply card.
- each agent's `agents/<key>/AGENTS.md`;
- `skills/**`. A file there that isn't Markdown is listed as code.

Any other file in the folder (a stray `memory.md`, a binary) is listed as not shared. The limits are 100 files and 512 KB.

**Never shared:** memory (it lives on the kernel's data volume), the owner profile (`owner/profile.md`), vault secrets and
setting values. None of them is a module file.

**The scan is a backstop.** It blocks the share when the text holds any of these:

- a vault secret or an instance-set setting value of 6+ characters, plain, base64 or URL-encoded;
- a memory fact or profile line of 20+ characters;
- a known token or key shape;
- another local module's path, or the instance repo's name.

Findings name the file and the kind, never the value.

**Limit.** Prose can carry owner data in words the scan can't match: a paraphrased fact, a colleague's name in a handbook.
The preview shows every file whole for that reason, and the owner reads it before he saves.

## The flow

1. **Preview.** The Share section of a local module's page calls `POST /api/modules/share/preview {module, repo, ref}`,
   which goes to the kernel's `POST /v1/modules/share/preview`.
   - The kernel exports the module at the instance's main.
   - It asks the code host for the destination (`POST /aidenhq/v1/publish/tip` on the github service): the branch's tip,
     whether the repo is private, and whether a `<module>/` folder or marketplace entry there belongs to another source.
   - The answer shows the files (whole only when nothing blocks), what isn't shared and why, the findings, the effective
     grants, any code, a private-repo warning, and `{source, base, digest}`.
   - `digest` is sha256 of the canonical `{source, files}` (`modules/github/service/src/share.ts` `digestOf`).
2. **Save.** "Publish exactly this" files a settings change of kind `share`, bound to that preview's `module, repo, ref,
   source, base, digest`.
   - The board files it as the owner's own settings task. It accepts the board's signed-in session only, never an MCP
     client, and it is the only change on its task.
   - The kernel (`POST /v1/modules/share`) checks the session's account (`settings-change.ts` `ownerTask`). It checks the
     module's folder at main is unchanged since `source`, exports again at `source` and refuses a finding or a different
     digest. It then files `github.publish_module` through `writes.fileKernel` with `owner`, decided as his account at
     filing (Tier 2, `via: save`).
3. **Publish.** `github.publish_module` is `floor: 2, filer: owner, stale: fail`.
   - `filer: owner`: no job, module or kernel filing without the owner's save may file it. `admit()` refuses it for
     everyone, and `admission` gives it to no job.
   - The code host's plan (`plan.ts` `publishModulePart`, `service.ts` `stateFor`) refuses:
     - the product or instance repo, a `local/` repo, and a name that isn't `owner/name`;
     - a missing or private repo, and a folder or entry that isn't this module's;
     - files whose digest isn't the preview's, and a tip that isn't `base`.
   - The record's own args and target `{repo, ref, commit: base}` are the preview's durable evidence.
   - At execution the kernel re-plans (revalidation). A moved tip fails the record ("preview again"): `stale: fail`, never
     refiled.
   - The code host's commit assembly (`commitOnHead`, on `ref`) writes the previewed files under `<module>/` and removes
     any other file there. It adds the `marketplace.json` entry `{name, source: "./<module>"}`, keeps an existing one, and
     makes one commit on `base`, pushed without force.

The end-to-end check is `services/board/test/share-e2e.test.ts` (V4).

## Installing a shared module

The importer adds the marketplace (`marketplaces:` with the repo and a commit) and turns the module on. Compile reads it as a
third-party module (tier `declared`), and its routines are created paused (Browse says "start paused"). The owner turns
each one on.

## New installs

- **Without GitHub** (the module off), the Share section says "Sharing needs GitHub connected." While GitHub is signed
  out, the preview answers the code host's "GitHub isn't connected".
- **A fresh install has no local modules** until the owner or an agent makes one (`library` holds agent-made skills and
  routines), so nothing is shareable at first.
- **Another owner's modules** share the same way. Only tier `local` modules are shared. Official and imported modules come
  from their own marketplaces.
