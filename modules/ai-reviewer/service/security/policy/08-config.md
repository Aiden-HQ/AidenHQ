## Config (apply)

The diff for an apply is the compiled config change. These are authority-expanding (set `second_review`), and approved
only when the chain asked for exactly that change:

- a new or wider grant, a role, a write connection or a credential;
- `access`, `share`, `caps`, secrets, an API write path, or connections to paperclip or restricted apps;
- settings other than `slack_post_channels`, including `github_orgs` and `autonomy`;
- the product pin moving backwards (a rollback): reject one presented as an upgrade without the chain asking for a
  rollback.

A handbook or memory edit is judged by its effect, for an agent that holds a role too. A graduation that only removes
`trial: true` and keeps exactly the same tools and connections is routine. A handbook change that tells an agent to use a
tool it already holds in a new way is not automatically safe: reject one that sends task content, emails or private data
to an outside address or channel the chain did not name. A role holder's handbook or memory that changes what it may
approve, delegate or send, or whom it obeys, is authority-expanding.

