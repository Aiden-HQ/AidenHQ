# App code standards

What every AidenHQ app holds. A change that touches an app brings the part it touches up to these; a task can also ask
for one on its own.

- **Built on the app starter and the design system.** shadcn/ui + Tailwind from the product's app starter
  (`modules/apps-platform/starter/`; `/opt/aidenhq/app-starter` in an agent computer), themed by the design system
  (`modules/apps-platform/design-system/`; `/opt/aidenhq/design-system`), with `tokens.css` and `shadcn.css` vendored
  unchanged. A repository made with `aidenhq create-repo` already holds the starter on main, so the app's first change
  holds only its own work; another app repo copies it in. An app still on the old plain-CSS kit or server-rendered pages
  moves to the starter when its UI is next changed (the design-system README's migration guide). How to build the UI:
  skill `design-system`.
- **An `AGENTS.md` map.** Which file owns each screen and route, and the run, test, lint and local-preview commands (the
  app starter's `AGENTS.md` is the model). A change that adds, moves or removes a screen or route updates it; a repo
  without one, or whose map no longer matches its screens, gets it written.
- **A replaced pattern leaves in the same change.** When a change replaces a pattern, component or page, the same PR
  deletes the old one with its imports, styles and tests, so the code shows only the current way and the next change
  copies it.
- **The shared identity middleware.** The starter's `aidenhq-identity.mjs`, copied unchanged, wraps the app's whole
  request handler in `server.mjs` (upgrades too; only `GET` on its health path is open) and gives it `req.user` (`sub`,
  `email`, `name`, `role`, `kind` person or agent) from the signed `X-AidenHQ-Identity` header the gate and the platform
  add (the product's `docs/design/app-identity.md`). The app keys its own rules and per-user data on `sub` and `role` only. It stays in an app with no login of its
  own: "no app login" means no sign-in of the app's own, with this check in place.
- **An agent API that describes itself.** An app agents write to through `app_api` serves `GET <path>/schema`, listing
  every operation (reads with their query parameters, writes with their payload shapes), generated from the types its
  parser uses. Agents read it instead of guessing, and call a write path only with a real payload.
- **Its own CI files.** `REVIEW.md` and the data-app migration and security-fix rules in the skill's "App repositories" section.
