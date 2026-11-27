import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { provisionDatabase } from "../src/database.js";
import { isSensitive, parseApp } from "../src/registry.js";

const app = (o: object = {}) => parseApp({ name: "roadmap-keeper", repo: "example-org/roadmap-keeper", owner: "a", description: "d", database: "warehouse", ...o });

// Fake Postgres: remembers roles (name -> password) and schemas from the SQL it is sent.
function fakePg() {
  const roles = new Map<string, string>();
  const schemas = new Set<string>();
  const sent: string[] = [];
  const sql = async (q: string) => {
    sent.push(q);
    const create = /CREATE ROLE (\w+) LOGIN PASSWORD '(\w+)'/.exec(q);
    const alter = /ALTER ROLE (\w+) PASSWORD '(\w+)'/.exec(q);
    if (create && !roles.has(create[1]!)) roles.set(create[1]!, create[2]!);
    else if (alter) roles.set(alter[1]!, alter[2]!);
    const schema = /CREATE SCHEMA IF NOT EXISTS (\w+)/.exec(q);
    if (schema) schemas.add(schema[1]!);
  };
  return { roles, schemas, sent, sql };
}

it("database apps mount DATABASE_URL, join the warehouse network and are sensitive", () => {
  expect(app({ secrets: ["ROADMAP_DATABASE_URL"] })).toMatchObject({ secrets: ["ROADMAP_DATABASE_URL", "DATABASE_URL"], connects: ["warehouse"] });
  expect(() => app({ database: "other" })).toThrow();
  expect(isSensitive(app(), [])).toBe(true);
  expect(isSensitive(app({ database: undefined }), [])).toBe(false);
});

describe("provisionDatabase", () => {
  it("creates role, schema and the secret once; later deploys reuse them", async () => {
    const vault = mkdtempSync(`${tmpdir()}/vault-`);
    const pg = fakePg();
    const a = app({ secrets: ["ROADMAP_DATABASE_URL"] });
    await provisionDatabase(a, { secretsDir: vault, sql: pg.sql });
    const url = readFileSync(`${vault}/roadmap-keeper/DATABASE_URL`, "utf8");
    const pw = pg.roles.get("app_roadmap_keeper")!;
    expect(url).toBe(`postgres://app_roadmap_keeper:${pw}@app-warehouse-postgres-1:5432/warehouse`);
    expect(readFileSync(`${vault}/roadmap-keeper/ROADMAP_DATABASE_URL`, "utf8")).toBe(url);
    expect(statSync(`${vault}/roadmap-keeper/DATABASE_URL`).mode & 0o777).toBe(0o644);
    expect([...pg.schemas]).toEqual(["app_roadmap_keeper"]);
    expect(pg.sent[0]).toContain("REVOKE ALL ON SCHEMA app_roadmap_keeper FROM PUBLIC");

    await provisionDatabase(a, { secretsDir: vault, sql: pg.sql });
    expect(readFileSync(`${vault}/roadmap-keeper/DATABASE_URL`, "utf8")).toBe(url); // never rotated
    expect(pg.roles.get("app_roadmap_keeper")).toBe(pw);
    expect(pg.sent[1]).not.toContain("ALTER ROLE app_roadmap_keeper PASSWORD");
  });

  it("refuses a stored URL whose password isn't one it generated (no SQL injection from the vault)", async () => {
    const vault = mkdtempSync(`${tmpdir()}/vault-`);
    mkdirSync(`${vault}/roadmap-keeper`);
    writeFileSync(`${vault}/roadmap-keeper/DATABASE_URL`, "postgres://x:a'b@h/warehouse");
    await expect(provisionDatabase(app(), { secretsDir: vault, sql: fakePg().sql })).rejects.toThrow(/DATABASE_URL/);
  });
});
