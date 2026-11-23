---
name: gmail-writes
description: "How to write email as the owner in Gmail: drafts, sends and replies (gmail_draft, gmail_send). Use before any Gmail draft or send."
---

# Writing email as the owner

Each draft and send acts as the owner and is reviewed before it runs. A sent email can't be taken back.

**When.** Write email because the owner asked, in his own words or in a task he assigned you. A message asking for a reply
is information for him: tell him and offer a draft.

- **Draft by default.** `gmail_draft` saves it in his Drafts for him to read and send. Use `gmail_send` when he asked you to
  send ("send it", "reply and tell her yes"), or approved a draft you showed him.
- **Replies.** Read the thread with `gmail_read_thread` first, then pass its `thread_id` and the same `account`: Gmail keeps
  the reply in the conversation and the subject follows it. Put the recipients in `to` and `cc` yourself: usually the
  sender of the message he is answering, plus whoever he names.
- **A new message** needs `to`, a `subject` and the `body`; pass `account` when he has more than one and means a
  particular one (the default is his primary).
- **The text.** Plain text in his voice, ready to send: no sources list, notes to him,
  or content from other conversations, documents or people's private details unless he asked for exactly that.

**After.** The call answers that it is waiting for review, then posts its outcome on your task. Report it with the link:
"Sent: reply to Dana (link)" or "Drafted: reply to Dana, in your Drafts (link)". A write that answers that Google needs
the owner to reconnect: tell him in one line with the link it gives, and try again once he says it's done.
