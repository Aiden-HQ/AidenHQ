// Host-only deploy for stateful apps (ops/app-deploy.sh): calls the running server so its per-app lock applies.
const [cmd, name, sha] = process.argv.slice(2);
if (cmd !== "deploy" || !name) {
  console.error("usage: app-deploy.sh deploy <name> [sha]");
  process.exit(2);
}
const { readFileSync } = await import("node:fs");
const token = readFileSync(process.env.APPS_INTERNAL_TOKEN_FILE ?? "/run/secrets/apps_internal_token", "utf8").trim();
const res = await fetch("http://127.0.0.1:8090/internal/deploy", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ name, sha, by: "host-cli", approved_comment_id: "host" }),
});
console.log(await res.text());
process.exit(res.ok ? 0 : 1);
