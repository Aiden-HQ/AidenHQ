/** The open PRs the fleet opened: warehouse rows kept only where the kernel's records name the same repo and number. A PR made by hand has no record, in the fleet org or anywhere else. */
export function fleetOnly<T extends { repo: string; number: number }>(rows: T[], ours: { repo: string; number: number }[]): T[] {
  const mine = new Set(ours.map((o) => `${o.repo.toLowerCase()}#${o.number}`));
  return rows.filter((x) => mine.has(`${x.repo.toLowerCase()}#${x.number}`));
}
