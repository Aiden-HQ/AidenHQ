# App CI template

Every app repo's CI comes from `.github/` here: the workflow on the self-hosted runners, the AI code review and its gate, and
the supply-chain checks (`scripts/sync-shared.mjs` keeps `.github/supply-chain/` equal to the product's `scripts/supply-chain/`).
Apps start from the apps platform's starter (`modules/apps-platform/starter/`).
