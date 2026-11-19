# The box's history, sourced by fast.sh and tests.sh ($OUT is the out folder): the base tree ($OUT/base) as one commit, the head tree as the next;
# AIDENHQ_BASE names the base, so `git diff $AIDENHQ_BASE HEAD` is exactly the change.
set -e
g() { git -c user.name=aidenhq-check -c user.email=check@aidenhq.invalid -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }
g init -q .
GIT_WORK_TREE=$OUT/base g add -A -f
g commit -q --allow-empty -m base
g add -A -f
g commit -q --allow-empty -m head
AIDENHQ_BASE=$(git rev-parse HEAD~1); export AIDENHQ_BASE
set +e
