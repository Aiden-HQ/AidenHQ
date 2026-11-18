// Small helpers the grader reads from other homes, copied while the grader is the only reader that has no codehost service to ask:
// the model families and OpenRouter call (the runner's models.mjs), the task-text and PR-text helpers (agents.mjs, engineering's
// merge-queue.mjs, codehost-github's merge-gate.mjs, progress.ts). Each is a verbatim copy with types added; the runner's copies go
// at the switch, and these become the one way then.
// GPT Luna at medium, then DeepSeek Flash at high (the owner's pick, 2026-11-13). GLM Flash at high is the owner's checker model.
export const LUNA = "~openai/gpt-luna-latest";
export const DEEPSEEK = "~deepseek/deepseek-flash-latest";
export const GLM = "~z-ai/glm-flash-latest";
/** Each model's reasoning effort. */
export const EFFORT: Record<string, string> = { [LUNA]: "medium", [DEEPSEEK]: "high", [GLM]: "high" };
/** Output cap, reasoning included: room for high-effort reasoning; Luna allows 128,000. */
export const MAX_TOKENS = 100_000;
/** The largest diff a model reads (the grader's DIFF block); the AI reviewer sends a larger one back as too large. */
export const MAX_DIFF = 150_000;

/** The models to ask, in order: GPT Luna, then DeepSeek Flash, minus the author's own family (never its own, not even as the fallback). */
const FAMILIES: [string, RegExp][] = [
  [LUNA, /openai|gpt/i],
  [DEEPSEEK, /deepseek/i],
];
export const familyModels = (authorModel = "") => FAMILIES.filter(([, re]) => !re.test(String(authorModel))).map(([m]) => m);

/** OpenRouter chat completions with a strict JSON schema, ZDR providers only, no tools. Resolves { content, refusal, usage }. */
export function openRouterAsk(key: string, { timeoutMs = 600_000, fetchFn = fetch, schema, url = "https://openrouter.ai/api/v1/chat/completions" }: { timeoutMs?: number; fetchFn?: typeof fetch; schema: unknown; url?: string }) {
  return async (model: string, { system, user }: { system: string; user: string }) => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema } },
        provider: { zdr: true },
        reasoning: { effort: EFFORT[model] ?? "high" },
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = await res.json();
    const msg = json?.choices?.[0]?.message ?? {};
    return { content: msg.content ?? "", refusal: msg.refusal ?? null, usage: json?.usage };
  };
}


/** Remove HTML comments: hidden text never counts as the user's words. */
export const stripHidden = (s: unknown) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "");

/**
 * Remove a description's copies of a grade's rubric: each `Graded before done (…)` line and the numbered criteria under
 * it. A removed block is rubric material, not the request: the row's own rubric is the only criteria list the grader
 * answers (grade.ts), so extra criteria lines in the task's words must not reach the model as if they were criteria.
 */
export const stripRubric = (s: unknown) => {
  const text = String(s ?? "");
  const heading = /^[ \t]*Graded before done \([^)]*\):/;
  const criterion = /^[ \t]*\d+\.[ \t]/;
  const blank = /^[ \t]*$/;
  const kept: string[] = [];
  const lines = text.split("\n");
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    removed = true;
    // The heading and every criterion line after it; blank lines only when another criterion follows, so the request's
    // own text after the block stays as it was.
    while (i + 1 < lines.length) {
      if (criterion.test(lines[i + 1])) {
        i++;
        continue;
      }
      let k = i + 1;
      while (k < lines.length && blank.test(lines[k])) k++;
      if (k > i + 1 && k < lines.length && criterion.test(lines[k])) {
        i = k - 1;
        continue;
      }
      break;
    }
  }
  return removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
};

/** Marks a comment as the runner's own. */
export const RUNNER_MARKER = "<!-- aidenhq-runner -->";

const ADVISORY = new Set(["design-review"]);
const advisory = (n: any) => ADVISORY.has(n.name ?? n.context);

const IMAGE_FILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;

/**
 * The `image-scan` check skipped on a PR that changes an image definition: nothing was scanned, so it isn't green (CI
 * decides what to scan; this keeps a PR from passing by dodging it). Files unread or past the first page count as changed.
 */
export function skippedImageScan(pr: any) {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  if (!nodes.some((n: any) => n.name === "image-scan" && n.status === "COMPLETED" && n.conclusion === "SKIPPED")) return false;
  return !pr.files || pr.files.pageInfo?.hasNextPage || (pr.files.nodes ?? []).some((f: any) => IMAGE_FILE.test(f.path ?? ""));
}

export function namedChecks(rollup: any) {
  const pass = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return (rollup?.contexts?.nodes ?? [])
    .filter((n: any) => !advisory(n))
    .map((n: any) => ({ name: n.name ?? n.context, status: n.__typename === "CheckRun" ? (n.status === "COMPLETED" ? n.conclusion : "PENDING") : n.state }))
    .filter((c: any) => c.name)
    .map((c: any) => ({ name: c.name, status: c.status, ok: pass.has(c.status), pending: ["PENDING", "EXPECTED", null, undefined].includes(c.status), ...(c.status === "SKIPPED" ? { skipped: true } : {}) }));
}

export const GATE_CHECK = "ci-required";

export function findPrs(text: unknown) {
  const out: { repo: string; number: number; url: string }[] = [];
  const re = /(?:https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+))|(?:codehost:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/change\/(\d+))|(?<![\w./:-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
  for (const m of String(text ?? "").replace(/\\(.)/g, "$1").matchAll(re)) {
    const [org, name, number] = m[1] ? [m[1], m[2], m[3]] : m[4] ? [m[4], m[5], m[6]] : [m[7], m[8], m[9]];
    const repo = `${org}/${name}`;
    const url = org.toLowerCase() === "local" ? `codehost:${repo}/change/${number}` : `https://github.com/${repo}/pull/${number}`;
    if (!out.some((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.number === Number(number))) out.push({ repo, number: Number(number), url });
  }
  return out;
}

export function staleHead(recorded: string | null | undefined, head: string | null | undefined): string | undefined {
  if (!head) return "GitHub couldn't read its head branch";
  if (String(head) === String(recorded ?? "")) return undefined;
  return `its head branch is \`${head}\`, not the task's \`${recorded ?? ""}\``;
}
