// One opener of a jobs database, for the concurrency test (jobs.test.ts): the kernel's jobs half over JOBS_DB, as main.ts makes
// it. Exits 0 when setup finished, printing the failure and exiting 1 when it did not.
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../../src/jobs.ts";

const db = new DatabaseSync(process.env.JOBS_DB!);
try {
  createJobs({ db, cfg: {}, cp: {}, mayDispatch: () => false, log: () => {}, boxWrap: "" });
  db.close();
  process.exit(0);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
