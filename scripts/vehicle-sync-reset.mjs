#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(__dirname, "..", ".vehicle-sync-checkpoint.json");
try {
  await fs.unlink(file);
  console.log("Vehicle sync checkpoint cleared.");
} catch (e) {
  if (e.code === "ENOENT") console.log("No vehicle sync checkpoint exists.");
  else throw e;
}
