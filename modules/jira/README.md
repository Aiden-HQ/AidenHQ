# jira

## What it does

Jira and Confluence for your agents: Atlassian's remote MCP server passed through whole, signed in as you with the
scopes you pick. Issues, sprints, Confluence page metadata and changes also land in the warehouse (`src_jira`).

## Connect

Set your Atlassian site's address (`jira_url`, `*.atlassian.net`) on the module's Settings tab and approve the change,
then press Connect on the board. Until `jira_url` is set, the service isn't started.

## What agents get

The `jira` connection. Use it for exact fields, change history, comments and JQL; find the item with Glean first.

- Read (64 tools, 51 of them `named`, reached only by a grant naming them): `searchJiraIssuesUsingJql`, `getJiraIssue`,
  `listJiraIssueChangelogs`, `listJiraIssueComments`, `searchConfluence`, `getConfluenceContent` and more.
- Destructive (56, reviewed, named grants only): every Jira and Confluence write, such as `createJiraIssue`,
  `transitionJiraIssue`, `createConfluenceContent`.
- Setting `history_projects` reads quiet projects' last 365 days once into the warehouse.

## New installs

In the default bundle but inert until you set `jira_url`. Then a banner says the agents can't read it until you connect.
