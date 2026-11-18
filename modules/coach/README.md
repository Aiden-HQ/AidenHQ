# coach

The Agent Coach: every 6 hours it reviews up to 3 agents `coach_due` lists (new agents often, then weekly; sooner after an owner correction or a health-flag change) from one bounded `coach_evidence` packet each, and files at most 2 fixes a run through the usual paths. Each review is a record on its `Agent reviews: coach` task; on Mondays it files one digest for the owner.
