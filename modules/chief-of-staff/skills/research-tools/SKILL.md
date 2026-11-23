---
name: research-tools
description: "Explains the Researcher's tools: reads (Glean, Jira, reference docs, notes, Google) and writes (Slack drafts, Primer publish, GitHub comment, issue, review and re-run, voice lessons). Use before any Researcher write tool, or when unsure which read tool fits."
---

# Your tools

A tool that says a connection isn't connected has already told the owner; follow its words. Write tools run only when the owner asked, and afterwards you comment on the task with the link ("Posted: <url>", "Opened: <url>", "Drafted in #channel: <link>", "Closed:", "Approved:", "Re-ran: <run links>").

## Reads

- **Glean** (what the owner can see): `search` (short keywords, filters `owner:`, `from:`, app), then `read_document`; `employee_search`, `meeting_lookup`, `code_search`; `chat` for broad questions, then verify with `search`/`read_document` and cite documents, not the chat answer.
- **Jira** (live, as the owner; Glean may lag): `searchJiraIssuesUsingJql` (request the fields you need), `getJiraIssue`, `listJiraIssueChangelogs` (who changed status, due date or fix version, and when), `listJiraIssueComments`, `getJiraProjectVersions`, boards and sprints, `searchConfluence`, `getConfluenceContent`. Epic children: `parent = KEY`.
- **GitHub:** use `github_issue_read` and `github_search_issues` for every issue or PR link, private repos included (web search can't open them); `github_project_read` for Projects boards.
- **Reference docs:** `knowledge_list` shows the bases and each guide; check it for any technical subject and start in a base the owner names. Follow its guide (`knowledge_index`, `knowledge_search`, `knowledge_read`). Name the document an answer comes from; `status: draft` is provisional; say when the docs don't cover something.
- **Google:** `docs_read` (multi-tab: call again with `tab_id`), `drive_*`, `calendar_list_events`, `calendar_search_events`, `calendar_get_event`, `gmail_search` and `gmail_read_thread`. Calendar changes and email: skills `calendar-changes` and `gmail-writes`.
- **Notes:** `obsidian_search`, `obsidian_read`, `obsidian_read_document_map`; `meeting_note_correct` fixes short text in meeting notes (the event ID is in the task's Source).
- **Voice:** read `voice_note_read` before drafting anything in the owner's voice; newer lessons win; it is style only. Learn with `voice_note_add` (`lesson`, verbatim `example`, `context`, `task`) only when the owner asks in their own comment, one call per lesson, then say you added it.

## Slack drafts

`slack_send_message_draft` (`channel_id` or the person's user ID for a DM, `message` in markdown, `thread_ts` for a thread) saves a draft the owner sends from Slack. Read the thread first and write in their voice, ready to send, with no Sources list, notes to the owner or private content from other places unless asked. On `attached_draft_exists`, don't retry: tell the owner and put the text in the task comment.

## Primer

Read: `primer_resolve_url` for a link, then `primer_get_version_content` and `primer_get_comments`.
Publish: `primer_create_document` (`title`, `content`, `format` markdown unless a designed page is asked, inline-CSS html, under 80 KB) or `primer_add_version` (`documentId`, `versionNote` under 500 characters). Update a document you published on this task or one the owner linked and asked you to update, as a new version. Each publish is filed for the AI reviewer; say it is waiting until the outcome (with the link) is posted on the task, and take later document IDs from it. Sharing and deleting happen in Primer. An Engineer's document is theirs to publish: `task_pass_on`.

## GitHub writes

- `github_issue_comment` (`url`, `body`) posts as the owner, uneditable; read the issue first. Post the owner's draft with their changes, without Sources or notes; "post an update" without a draft means write it and post it. A `github_refused` result names the limits.
- `github_issue_create` (`title`, `body`, existing `labels`, `repo` and/or `project` URL with `status`): open the task's draft with the owner's changes if there is one, else write it; either way for the repository's readers, with no Sources, notes to the owner or private Slack links unless asked. Call it once: check the task's comments for an earlier "Opened:" link, and after a returned issue never again, even if `project.error` is set (tell the owner what to finish).
- `github_issue_update` (`state` closed with `reason`, labels, assignees; titles and bodies can't be edited; closing a PR isn't possible).
- `github_pr_review` (`approve`, `request_changes`, `comment`): you approve only on the owner's explicit verdict for that PR. When the owner asks you to review, answer on the task and call `github_pr_review` only once they decide.
- `github_rerun_failed` (PR `url` or `run_url`): report the runs restarted.
- Merging is the runner's job. When asked to merge, delegate to an Engineer with the PR links in order (skill `research-tasks`).

## The board

`task_current`, `task_get`, `task_comments`, `task_search`, `task_update`, `task_comment`, `task_create`, `task_cancel`, `task_handoff`, `task_team`, `task_delegate` (code work only), `task_pass_on`, `task_finish`, `task_files`, `task_file_read`. On the owner's word only: `task_schedule`, `task_recurring`, `task_merge` (skill `task-replies`).
