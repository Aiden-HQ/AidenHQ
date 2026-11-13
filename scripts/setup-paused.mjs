/**
 * Routines setup paused itself (they left the config) are resumed when they return; owner and detector pauses stay.
 * `mine` is the set of routine ids setup paused (kept in a secrets-dir file by paperclip-setup.mjs).
 */
export function routineStatus(configStatus, current, id, mine) {
  if (configStatus) return configStatus;
  if (current?.status !== "paused") return "active";
  if (!mine.has(id)) return "paused";
  mine.delete(id);
  return "active";
}
