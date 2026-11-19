// A comment a bridge posts with the owner's key on someone else's behalf (a colleague's Slack @mention, the owner's message
// for other agents only) carries this marker: it is never the owner's words to the task's agent, wherever that is decided.
// The same holds for the old runner's comments, posted with the owner's key before the switch and still in task histories
// (marked aidenhq-runner, or aidenhq-reply for an Engineer's reply): agent text, never the owner's. Nothing writes either marker now.
//
// First-party modules and the board hold byte-identical copies (scripts/sync-shared.mjs: edit this one and run it).
export const FOR_OTHERS = "<!-- aidenhq-for-others -->";
const OLD_RUNNER = /<!-- aidenhq-(?:runner|reply) -->/;

/** Whether a comment was posted for someone else: data at most, never the owner's words. Call this on a comment an agent didn't write. */
export const forOthers = (body: unknown) => String(body ?? "").includes(FOR_OTHERS) || OLD_RUNNER.test(String(body ?? ""));
