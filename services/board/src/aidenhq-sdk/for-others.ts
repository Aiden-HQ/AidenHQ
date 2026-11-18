// A comment a bridge posts with the owner's key on someone else's behalf (a colleague's Slack @mention, the owner's message
// for other agents only) carries this marker: it is never the owner's words to the task's agent, wherever that is decided.
//
// First-party modules and the board hold byte-identical copies (scripts/sync-shared.mjs: edit this one and run it).
export const FOR_OTHERS = "<!-- aidenhq-for-others -->";

/** Whether a comment was posted for someone else: data at most, never the owner's words. */
export const forOthers = (body: unknown) => String(body ?? "").includes(FOR_OTHERS);
