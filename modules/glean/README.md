# glean

## What it does

Company search for your agents: your organization's Glean, passed through whole as you. One search covers Slack, Drive,
Confluence, Jira, GitHub, meeting transcripts and people, ranked by relevance and by your permissions. Agents start
here for anything about the company.

## Connect

Board, Settings, Connections: press Connect Glean, give your Glean MCP address (`glean_mcp_url`, a `*.glean.com`
address) and allow access.

## What agents get

The `glean` connection.

- Read: `search`, `read_document`, `employee_search`, `meeting_lookup`, `code_search`, `chat`, `user_activity`,
  `memory_schema`. Two of them are `named`: only a grant naming them reaches them.
- Destructive (reviewed, named grants only): `memory`, `create_image`, `edit_image`, `upload_artifact`,
  `update_artifact`, `share_artifact`.

## New installs

In the default bundle. Unconnected, a banner says the Researcher can't search company knowledge, and each call says how
to connect.
