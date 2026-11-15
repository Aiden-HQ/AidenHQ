// Shapes shared across the runner's modules.

/** A step that failed with a message for the agent or the task (a GitHub or git read, a card the board refused). */
export interface Failed {
  error: string;
}

/**
 * A step's result: `{ error }`, or what it read (main's fleetBranch, productBump and fileApproval return these). The
 * success side has no `error`, so `if (r.error !== undefined) …` narrows to one side or the other. A bare `if (r.error)`
 * does not narrow: an empty message would read as success.
 */
export type Result<T extends object> = Failed | (T & { error?: undefined });

/** The runner's logger: a message and optional fields. */
export type Log = (msg: string, extra?: Record<string, unknown>) => void;
