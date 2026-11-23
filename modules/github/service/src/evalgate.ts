// The AI reviewer's own code: the one list of paths whose change runs the reviewer eval. CI's `checks` step reads it from the
// PR's base (`touchesReviewer`) and its `reviewer-eval` job, part of `ci-required`, runs the eval; a change merges only once
// ci-required is green, so nothing here gates a merge. Edit the list here and nowhere else.
/** The AI reviewer's own code, as product paths (the official modules sit under modules/ there). */
export const REVIEWER_CODE = [/^modules\/ai-reviewer\//, /^kernel\/sdk\/src\/(reviewer|pass-rule|instance-details)\.ts$/, /^kernel\/src\/(review-loop|reviews)\.ts$/];
export const touchesReviewer = (files: string[]) => files.some((f) => REVIEWER_CODE.some((r) => r.test(f)));
