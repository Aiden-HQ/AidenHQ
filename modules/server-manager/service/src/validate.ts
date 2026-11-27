// The module's validate hook (module.yaml `validate:`): the kernel posts a settings change and a pasted/cleared key here with the
// service key. Two questions, each answered before anything is saved (spec §7, §9):
//   - a whole settings.servers_machines list, entry by entry, against the entry schema;
//   - a clear of one key of the servers_keys map, refused while a machine still names it (a clear can't be read back, so the kernel
//     fails closed when this hook can't be asked).
// A written key value is checked only for shape by the kernel (its setup pattern); the key material is never read, logged or echoed
// here — this function looks at a key's NAME in the list and nothing else.
import { listProblems, savedUsersOfKey } from "./config.ts";

export interface ValidateInput {
  settings?: Record<string, unknown>;
  secret?: { name?: string };
  value?: string;
  /** On a clear of one map key: the key, with no value. */
  key?: string;
}
export type FieldError = { field: string; message: string };
export type Validation = { ok: true } | { ok: false; errors: FieldError[] };

export const KEYS_SECRET = "servers_keys";

export function validate(input: ValidateInput, saved?: string): Validation {
  const errors: FieldError[] = [];
  const machines = input.settings && "servers_machines" in input.settings ? input.settings.servers_machines : undefined;
  if (input.settings && "servers_machines" in input.settings) for (const p of listProblems(machines)) errors.push({ field: p.field, message: p.message });
  // A clear of one key (no value): refused while a machine still names it. A whole-map paste (value, no key) is left to the kernel.
  // The kernel sends no settings with a clear, so the machines come from the list the instance holds (`saved`), never from an
  // absent field: treating "no settings" as "no machines" would let a key a machine still uses be cleared.
  if (input.secret?.name === KEYS_SECRET && input.key !== undefined && input.value === undefined) {
    // Every saved entry that names the key counts, valid or not: an entry with a bad port is still in the list with its key, and
    // dropping the key first would leave the owner unable to fix it (the value cannot be read back).
    const used = Array.isArray(machines)
      ? savedUsersOfKey(JSON.stringify(machines), input.key)
      : savedUsersOfKey(saved, input.key);
    if (used.length) errors.push({ field: "servers_keys", message: `the key ${input.key} is still used by ${used.join(", ")}: change ${used.length === 1 ? "that machine's key" : "those machines' keys"} first` });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
