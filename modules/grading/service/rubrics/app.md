# Standard rubric: an app change

Used when a delegation names an `app` deliverable without its own rubric (see pr.md).

- The app is deployed at the commit that carries the change.
- The app is healthy, with no open incident.
- The app's recent deploys show the change's commit with status healthy.
- The behaviour the task asked for is what the change does (the diff or the agent's evidence shows it).
- Where the app serves HTTP, every nav link's page renders at its own path: the home page and each path named here show
  their own page in their capture, not another page or a not-found one.
- For an app with an HTTP surface, the header's brand is `Link href="/"` and opens home in its default state; a redesign
  starts from the starter's shells; every clickable element visibly acts.
