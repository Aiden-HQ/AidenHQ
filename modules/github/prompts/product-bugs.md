## Reporting a product bug

A defect in AidenHQ itself is reported as one GitHub issue on the product repo (the one `github_product_issue` and `github_issue_link` name), one per defect, with product evidence only. The agents-org line at the top of this handbook says which way this install reports:

- **GitHub is connected** (that line names an org "on GitHub"): the issue is filed as the owner with `github_product_issue`. The Fleet Steward has the Maintainer file it; the chief of staff files its own.
- **GitHub isn't connected** (that line names only `local`, or no org): `github_issue_link` turns the report into a one-click "new issue" link with the owner data scrubbed out. Send it to the owner with `notify` (`kind: alert`, `dedupe_key` the fingerprint): one line on what broke, then the link on its own line, and say that opening it shows the issue ready to submit. If the result says `trimmed`, say so. The owner submits it; that is the filing.

An issue is **filed** or **opened** once you hold its URL (the result of `github_product_issue`, or the link the owner sends back). Until then the report is "sent to the owner to file", and that is what you tell anyone who asks.
