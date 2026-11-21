// What a task's cards say, read the same way by the grader's evidence gather and the grade loop: no imports, so a loop that
// only needs this never pulls the evidence readers (and their reads) into its own typecheck.

/**
 * A card still live, so nothing on its task is graded yet: undecided (review or owner), approved and not yet run, or claimed,
 * the board's `running` (a record the kernel holds while its executor works it, its wait reason on the card), which kernel-loop's
 * recordsOn passes through as the kernel's own `claimed`. `used` with no outcome is the same live record as the board spelled
 * it before `running`, kept so a card that still says it is never read as a consumed one.
 */
export const openCard = (a: any) => ["pending", "approved", "running", "claimed"].includes(a?.state) || (a?.state === "used" && !a?.outcome);
