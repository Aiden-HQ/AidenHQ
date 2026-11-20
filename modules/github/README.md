# github

## What it does

GitHub in two parts. Basic: agents read your issues, pull requests, reviews, checks, Projects boards and code, as you.
Advanced, with your own GitHub App: GitHub becomes the code host (clones, repo-narrowed App tokens per write, push, PR,
merge at the reviewed head once green, `create_repo`, land) and the git rules that tier each write apply.

## Connect

Board, Settings, GitHub (`#/setup/github`), about a minute. Press Connect GitHub, open github.com/login/device and type
the code, then allow AidenHQ (an organization may need an owner to approve it first). For the advanced part, make the
instance's GitHub App on the same page (`node ops/github-app-setup.mjs`), and install it on the repos you want.

## What agents get

Two connections. Destructive tools are reviewed and need a grant naming them.

- `github` (AidenHQ's own): reads such as `github_issue_read`, `github_search_issues`, `github_pr_files`,
  `github_pr_threads`, `github_job_log`, `github_project_read`; write `commit_status_set`; destructive issue and PR writes
  (`github_issue_comment`, `github_pr_review`, `github_rerun_failed`, `github_app_issue*`).
- `github_official` (GitHub's own MCP server, as you): reads such as `get_file_contents`, `get_commit`, `list_commits`,
  and destructive writes such as `create_pull_request` and `issue_write`.
- Warehouse source `src_github` (issues, project items, changes).
- Settings include `upstream` (off, issues, prs), `maintainer_repos`, `github_orgs` and `github_comment_orgs` (the orgs
  an owner-identity write may reach).

## New installs

In the default bundle. Until you connect, a banner says the agents can't read GitHub. Without the GitHub App, nothing
changes for the code host: `codehost-local` hosts repos.
