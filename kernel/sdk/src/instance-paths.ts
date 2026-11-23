// The instance repo files an apply may land and a settings write may touch: instance.yaml, apps.yaml, the owner's profile,
// a module agent's added rules (agents/<key>.md) and handbook fork (agents/<key>/AGENTS.md), and a local module's
// module.yaml, agents' handbooks and skills. Pure: the kernel's apply and both code hosts (codehost-local imports it,
// codehost-github holds a copy, scripts/sync-shared.ts) read this one list.
export const APPLY_PATHS = /^(instance\.yaml|apps\.yaml|owner\/profile\.md|agents\/[\w.-]+\.md|agents\/[a-z0-9][a-z0-9-]*\/AGENTS\.md|modules\/[a-z0-9][a-z0-9-]*\/(module\.yaml|agents\/[a-z0-9][a-z0-9-]*\/AGENTS\.md|skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md))$/;

/** Files a change touches outside what apply may land. */
export const strayFiles = (files: string[]) => files.filter((f) => !APPLY_PATHS.test(f));
