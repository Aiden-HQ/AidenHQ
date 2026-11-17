import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The default modules a new instance lists (ops/setup.sh writes them); compile enables exactly what an instance lists.
export const BUNDLE = JSON.parse(readFileSync(fileURLToPath(new URL("../../modules/marketplace.json", import.meta.url)), "utf8")).bundle;
