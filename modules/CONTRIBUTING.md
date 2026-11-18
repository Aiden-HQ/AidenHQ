# Contributing

The full rules live in the product repo's
[CONTRIBUTING.md](https://github.com/Aiden-HQ/AidenHQ/blob/main/CONTRIBUTING.md). They apply here too. In short:

- Fork, branch, open a PR against `main`. Never push to `main`.
- Sign the [CLA](https://github.com/Aiden-HQ/AidenHQ/blob/main/CLA.md).
- The PR title is a Conventional Commit (`feat(board): ...`, `fix(tasks): ...`). The repo is squash-only, so the title
  becomes the commit. The body says why.
- Supply chain: unless it is a security fix, do not adopt a dependency, package, image or action published less than 7
  days ago. Pin every dependency exactly (images by digest, actions by SHA) and state the release date of any pin you
  bump. CI enforces this.
- Keep modules generic. New behaviour is an agent handbook, a tool or a module, not a special case in the kernel.
- Keep tests few. A test should prove the thing works end to end.
- Use neutral examples (`acme`, `example.com`). No real names, emails, hostnames or IPs.

Run the tests for what you touched before opening the PR. See "Test locally" in the [README](README.md).
