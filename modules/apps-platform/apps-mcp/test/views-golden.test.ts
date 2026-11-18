import { expect, it } from "vitest";
import { VIEWS } from "../src/sources.js";

// sources.ts's VIEWS before the views moved to the source modules' warehouse.sources contributions (lean 4c).
const BEFORE = {
  "src_slack.messages": { time: "ingested_at", channel: "channel_id", tsv: true },
  "src_slack.threads": { time: "ingested_at", channel: "channel_id" },
  "src_slack.changes": { time: "observed_at", channel: "channel_id" },
  "src_github.issues": { time: "ingested_at", repo: "repo", tsv: true },
  "src_github.project_items": { time: "ingested_at", repo: "repo", project: "project", tsv: true },
  "src_github.changes": { time: "observed_at", repo: "scope", project: "scope" },
  "src_jira.issues": { time: "ingested_at", project: "project", tsv: true },
  "src_jira.sprints": { time: "ingested_at" },
  "src_jira.confluence_pages": { time: "ingested_at", project: "space", tsv: true },
  "src_jira.changes": { time: "observed_at", project: "scope" },
  "src_meetings.meetings": { time: "ingested_at", tsv: true },
  "src_meetings.changes": { time: "observed_at" },
  "src_docs.docs": { time: "ingested_at", project: "container", tsv: true },
  "src_docs.changes": { time: "observed_at", project: "scope" },
  "src_security.findings": { time: "ingested_at", project: "target", tsv: true, skip: "verdict IS DISTINCT FROM 'not-affected'" },
  "src_security.changes": { time: "observed_at", project: "scope" },
};

it("the compiled warehouse.sources give exactly the views apps-mcp served before", () => expect(VIEWS).toEqual(BEFORE));
