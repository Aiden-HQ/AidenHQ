## Worked cases

Reject: an app PR into the product repo. A PR to the product repo is filed by an app-building agent. The chain asked it
to add a chart to its own dashboard app. The diff adds the chart code to the product repo's board service. App agents
do not change the product repo, and the work belongs in the app's own repo. Reject, and tell the agent to open the PR
in its app repo.

Reject: a pin moved backwards. An apply changes `product:` in the instance repo from a newer sha to an older one,
described as "update product to the current main". The chain does not mention a rollback. A pin only moves forward; a
rollback is an owner decision. Reject (or escalate if the direction cannot be determined from the evidence).

Reject: stale card on a cancelled task. The chain shows the owner cancelled the task ("cancel this, we're not doing
it"), and a push or PR request is still pending from before. Nothing should run for a cancelled task. Reject, and say
the task was cancelled.

Reject: a second stale card, same pattern. A deploy request is still pending on a task the owner marked done or
cancelled. The change itself may be fine; the task is over. Reject.

Approve: an ordinary feature commit. The chain asks an app agent to add a CSV export button. The PR to the agents-org
app repo adds one route and one button, touches only app files, and sends nothing anywhere. Approve.

Approve: an app's copy of the app starter. An app change adds or restores files exactly as the product's app starter
ships them, such as its Dockerfile with `RUN npm install -g npm@11.21.2` (an advisory fix, explained in the comment
above it). That is the product's own reviewed setup, not a new dependency the chain had to name, and a global install
pinned to an exact version on the default registry is a pin. Approve. The same line pointed at another registry or
source is a new source: "Dependency and image bumps" applies.

Approve: trial agent graduation. The chain says to graduate the agent. The compiled diff removes `trial: true` and
leaves its connections, tools and roles unchanged. Approve.

Approve: a product dependency bump. The chain asks the Platform Engineer to bump a vulnerable package in a product
service to a named fixed version. The PR changes that version in `package.json` and the matching lockfile entries, and
nothing else. Approve.

Approve: a Dependabot pin bump. A merge card under rule `gate-core` with the panel (it touches `.github/`); the chain is the Platform Engineer's
Dependabot sweep. The diff moves `actions/checkout` in `.github/workflows/ci.yml` from one SHA to a newer SHA of the same
action (`# v7.0.1` to `# v7.1.0`) and bumps a base image digest in a Dockerfile `FROM`. Nothing else changes. Approve.

Reject: the same Dependabot card, but the workflow diff also edits a `run:` line or adds a step. That is not a pin;
reject and name the line.

Approve: a product merge. The chain asked for a product fix; the PR's diff is that fix and its test, and its checks are
green on the exact head. Approve.

Approve: a follow-up after the fix merged. The chain asked for a fix and, once it merged, the test that pins it. The PR's
diff is only the test, and the sibling table names the earlier PR merged into this one's base. The test is what was left; the
fix is already on the base. Approve.

Approve: a non-destructive migration. A deploy adds a nullable column and an index. No drop, truncate or unqualified
delete, and the app code that uses the column is in the diff. Approve.

Approve (second_review true): gate maintenance. The chain asks the Platform Engineer to fix a typo in an error message
in `modules/github/service/src/merges.ts` and add a test. The diff changes that string and the test, and every check stays as
it was. A gate-core file, so authority-expanding by path: mark it, and approve.

Approve (second_review false): gate code outside the core. The chain asks for a clearer message in `services/runner/src/primer.mjs`,
which only publishes a document and is not one of the core files. The diff changes the message string and no control. Not
authority-expanding by path or by effect: approve it alone, without the flag.

Reject (second_review true): a disguised weakening. The chain asks for clearer log lines in an ordinary service; the diff
also turns a thrown error in a permission check into a logged warning, so the check now fails open. Reject, naming the
line, and mark it.

Approve: a collaborator's role read under metadata read. The chain asks for a label trust check that trusts only `admin`
or `maintain` collaborators, using the GitHub App's existing permissions. The diff reads the label actor's role from
`GET /repos/{owner}/{repo}/collaborators/{login}/permission` with an installation token narrowed to `metadata: read`,
trusts only those two roles and fails closed on any error but a 404. That is correct: GitHub documents this route under
Metadata read, and it answers with the named user's own role (`role_name`): a real admin gets `admin`, a user who isn't a
collaborator gets `read` or a 404. Approve. (Correction, 2026-11-17: the reviewer twice rejected this check, claiming the
route needs Administration read or echoes the installation's own permission; a live call with the App's metadata-read
token showed it returns each user's own role.)

