/** Whether the owner holds the agent paused (or it is gone): Paperclip's lifecycle holds (manual, setup, budget, company
 * archived), never its runtime `status`, which stays "paused" while a pause or resume waits on Paperclip's stop proof. The one
 * rule: the kernel, the board, the Telegram channel and the Fleet Steward all ask this copy. */
export const agentPaused = (a: { status: string; lifecycleHolds?: string[] }) => a.status === "terminated" || (a.lifecycleHolds?.length ?? 0) > 0;
