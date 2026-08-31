#!/usr/bin/env node
/**
 * SANDMAN Vehicle Catalogue Sync V1
 *
 * Populates the EXISTING Prisma VehicleVariant model without changing schema.
 * Sources:
 *   1) SANDMAN curated global supplement (helps with EU/SA/JDM models)
 *   2) NHTSA vPIC public API (large model-year catalogue, primarily US-market)
 *
 * This is catalogue data only. It MUST NOT be treated as proof that a product fits a vehicle.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient, Prisma } from "@prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const prisma = new PrismaClient();

function arg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(v => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
const nowYear = new Date().getFullYear();
const sourceMode = String(arg("source", "curated")).toLowerCase(); // curated | nhtsa | both
const nhtsaMode = String(arg("mode", "popular")).toLowerCase();     // popular | all
const fromYear = Number(arg("from", "1996"));
const toYear = Number(arg("to", String(nowYear + 1)));
const delayMs = Math.max(0, Number(arg("delay", nhtsaMode === "all" ? "350" : "220")));
const limitMakes = Math.max(0, Number(arg("limit-makes", "0")));
const onlyMake = arg("only-make", null);
const dryRun = hasFlag("dry-run");
const checkpointPath = path.join(projectRoot, ".vehicle-sync-checkpoint.json");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v;
const key = v => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slug = s => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

function titleish(value) {
  const s = clean(value);
  if (!s) return s;
  if (s === s.toUpperCase() && s.length > 3) {
    return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\bBmw\b/g, "BMW")
      .replace(/\bGmc\b/g, "GMC")
      .replace(/\bMini\b/g, "MINI");
  }
  return s;
}

async function loadJson(rel) {
  return JSON.parse(await fs.readFile(path.join(projectRoot, rel), "utf8"));
}

function vehicleModelMeta() {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === "VehicleVariant");
  if (!model) {
    throw new Error("Your Prisma schema has no VehicleVariant model. This package is intended for the SANDMAN Garage/fitment schema.");
  }
  return model;
}

function scalarFieldMap(model) {
  return new Map(model.fields.filter(f => f.kind !== "object").map(f => [f.name, f]));
}

function pickExisting(fields, names) {
  for (const n of names) if (fields.has(n)) return n;
  return null;
}

function enumFirst(field) {
  const en = Prisma.dmmf.datamodel.enums.find(e => e.name === field.type);
  return en?.values?.[0]?.name ?? en?.values?.[0] ?? null;
}

function fallbackForRequired(field, record) {
  const display = `${record.year} ${record.make} ${record.model}`.trim();
  if (field.name === "id") return `veh_${crypto.createHash("sha1").update(`${record.source}|${record.year}|${record.make}|${record.model}|${record.engine ?? ""}`).digest("hex").slice(0, 24)}`;
  if (/slug/i.test(field.name)) return `${slug(display)}-${crypto.createHash("md5").update(`${record.make}|${record.model}|${record.year}`).digest("hex").slice(0, 8)}`;
  if (/display|label|name|title/i.test(field.name)) return display;
  if (/source/i.test(field.name)) return record.source ?? "SANDMAN";
  if (/code/i.test(field.name)) return record.engineCode ?? record.engine ?? "UNKNOWN";
  if (field.kind === "enum") return enumFirst(field);
  switch (field.type) {
    case "String": return "UNKNOWN";
    case "Int":
    case "BigInt": return 0;
    case "Float":
    case "Decimal": return 0;
    case "Boolean": return false;
    case "DateTime": return new Date();
    case "Json": return {};
    default: return null;
  }
}

function buildData(record, model) {
  const fields = scalarFieldMap(model);
  const data = {};

  const mappings = [
    [["year","modelYear"], record.year],
    [["yearStart","fromYear","startYear"], record.year],
    [["yearEnd","toYear","endYear"], record.year],
    [["make","makeName","manufacturer"], record.make],
    [["model","modelName"], record.model],
    [["trim","trimName"], record.trim],
    [["engine","engineName","engineDescription"], record.engine],
    [["engineCode","motorCode"], record.engineCode],
    [["transmission","transmissionName"], record.transmission],
    [["drivetrain","driveType","driveTrain"], record.drivetrain],
    [["fuelType","fuel"], record.fuelType],
    [["bodyStyle","bodyType"], record.bodyStyle],
    [["vehicleType"], record.vehicleType],
    [["source","dataSource"], record.source],
    [["sourceId","externalId","nhtsaId"], record.sourceId],
    [["makeId","nhtsaMakeId"], record.makeId],
    [["modelId","nhtsaModelId"], record.modelId],
  ];

  for (const [candidates, value] of mappings) {
    if (value === undefined || value === null || value === "") continue;
    const fieldName = pickExisting(fields, candidates);
    if (fieldName) data[fieldName] = value;
  }

  const display = `${record.year} ${record.make} ${record.model}`.trim();
  for (const n of ["displayName","label","name","title"]) {
    if (fields.has(n) && data[n] === undefined) data[n] = display;
  }

  for (const field of model.fields) {
    if (field.kind === "object") continue;
    if (field.name === "createdAt" || field.name === "updatedAt") continue;
    if (data[field.name] !== undefined) continue;
    if (!field.isRequired || field.hasDefaultValue || field.isList) continue;
    const fb = fallbackForRequired(field, record);
    if (fb !== null && fb !== undefined) data[field.name] = fb;
  }
  return data;
}

function buildIdentity(record, model) {
  const fields = scalarFieldMap(model);
  const yearField = pickExisting(fields, ["year","modelYear","yearStart","fromYear","startYear"]);
  const makeField = pickExisting(fields, ["make","makeName","manufacturer"]);
  const modelField = pickExisting(fields, ["model","modelName"]);
  const where = {};
  if (yearField) where[yearField] = record.year;
  if (makeField) where[makeField] = record.make;
  if (modelField) where[modelField] = record.model;
  const engineField = pickExisting(fields, ["engineCode","motorCode","engine","engineName","engineDescription"]);
  if (engineField && (record.engineCode || record.engine)) where[engineField] = record.engineCode || record.engine;
  if (Object.keys(where).length < 2) {
    throw new Error(`VehicleVariant needs recognizable make/model fields. Fields found: ${[...fields.keys()].join(", ")}`);
  }
  return where;
}

async function upsertRecord(record, model, stats) {
  record.make = titleish(record.make);
  record.model = clean(record.model);
  if (!record.make || !record.model || !Number.isInteger(record.year)) return;

  const identity = buildIdentity(record, model);
  const data = buildData(record, model);
  if (dryRun) {
    stats.preview++;
    if (stats.preview <= 15) console.log("[dry-run]", identity);
    return;
  }

  const delegate = prisma.vehicleVariant;
  const existing = await delegate.findFirst({ where: identity });
  if (existing) {
    const id = existing.id;
    if (id !== undefined) {
      const update = { ...data };
      delete update.id;
      await delegate.update({ where: { id }, data: update });
      stats.updated++;
    } else {
      stats.skipped++;
    }
  } else {
    await delegate.create({ data });
    stats.created++;
  }
}

async function importCurated(model, stats) {
  const file = await loadJson("data/sandman-global-vehicles.json");
  const records = file.records ?? [];
  const chosen = onlyMake ? records.filter(r => key(r.make) === key(onlyMake)) : records;
  console.log(`Curated source: ${chosen.length} model ranges.`);
  for (const row of chosen) {
    const start = Math.max(Number(row.yearFrom), fromYear);
    const end = Math.min(Number(row.yearTo), toYear);
    for (let year = start; year <= end; year++) {
      await upsertRecord({
        year,
        make: row.make,
        model: row.model,
        trim: row.trim,
        engine: row.engine,
        engineCode: row.engineCode,
        transmission: row.transmission,
        drivetrain: row.drivetrain,
        fuelType: row.fuelType,
        bodyStyle: row.bodyStyle,
        source: row.source ?? "SANDMAN_CURATED",
        sourceId: `curated:${key(row.make)}:${key(row.model)}:${year}`,
      }, model, stats);
    }
  }
}

async function fetchJson(url, tries = 6) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "SANDMAN-Vehicle-Catalog/1.0"
        },
        signal: AbortSignal.timeout(30000)
      });
      if (res.ok) return await res.json();
      const retryAfter = Number(res.headers.get("retry-after") || 0) * 1000;
      if (attempt === tries) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      await sleep(Math.max(retryAfter, 800 * attempt));
    } catch (err) {
      if (attempt === tries) throw err;
      await sleep(900 * attempt);
    }
  }
}

async function getCheckpoint() {
  try { return JSON.parse(await fs.readFile(checkpointPath, "utf8")); }
  catch { return {}; }
}
async function saveCheckpoint(x) {
  await fs.writeFile(checkpointPath, JSON.stringify(x, null, 2));
}

async function nhtsaMakes() {
  if (onlyMake) return [{ Make_ID: null, Make_Name: onlyMake }];
  if (nhtsaMode === "popular") {
    const names = await loadJson("data/nhtsa-popular-makes.json");
    return names.map(name => ({ Make_ID: null, Make_Name: name }));
  }
  const data = await fetchJson("https://vpic.nhtsa.dot.gov/api/vehicles/GetAllMakes?format=json");
  let makes = data.Results ?? [];
  if (limitMakes > 0) makes = makes.slice(0, limitMakes);
  return makes;
}

async function importNhtsa(model, stats) {
  const makes = await nhtsaMakes();
  const checkpoint = await getCheckpoint();
  console.log(`NHTSA mode=${nhtsaMode}, makes=${makes.length}, years=${fromYear}-${toYear}.`);
  console.log("NHTSA rate-controls traffic. This importer is deliberately paced and resumable.");

  let requestNo = 0;
  for (let year = fromYear; year <= toYear; year++) {
    for (let mi = 0; mi < makes.length; mi++) {
      const m = makes[mi];
      const cpKey = `${nhtsaMode}|${year}|${m.Make_ID ?? key(m.Make_Name)}`;
      if (checkpoint[cpKey] === "done") continue;

      const url = m.Make_ID
        ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeIdYear/makeId/${encodeURIComponent(m.Make_ID)}/modelyear/${year}?format=json`
        : `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(m.Make_Name)}/modelyear/${year}?format=json`;

      let data;
      try {
        data = await fetchJson(url);
      } catch (err) {
        console.error(`NHTSA failed ${year} ${m.Make_Name}:`, err?.message ?? err);
        stats.apiErrors++;
        continue;
      }

      const results = data.Results ?? [];
      const localSeen = new Set();
      for (const r of results) {
        const make = titleish(r.Make_Name || m.Make_Name);
        const modelName = clean(r.Model_Name);
        const uniq = `${key(make)}|${key(modelName)}|${year}`;
        if (!modelName || localSeen.has(uniq)) continue;
        localSeen.add(uniq);
        await upsertRecord({
          year,
          make,
          model: modelName,
          makeId: Number.isFinite(Number(r.Make_ID)) ? Number(r.Make_ID) : undefined,
          modelId: Number.isFinite(Number(r.Model_ID)) ? Number(r.Model_ID) : undefined,
          source: "NHTSA_VPIC",
          sourceId: `nhtsa:${r.Make_ID ?? key(make)}:${r.Model_ID ?? key(modelName)}:${year}`,
        }, model, stats);
      }

      checkpoint[cpKey] = "done";
      await saveCheckpoint(checkpoint);
      requestNo++;
      if (requestNo % 25 === 0) {
        console.log(`NHTSA progress: ${requestNo} requests this run; +${stats.created} created, ${stats.updated} updated.`);
      }
      await sleep(delayMs);
    }
  }
}

async function main() {
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear < 1886 || toYear < fromYear) {
    throw new Error("Invalid --from/--to year range.");
  }
  const model = vehicleModelMeta();
  console.log("SANDMAN VehicleVariant fields:");
  console.log(model.fields.filter(f => f.kind !== "object").map(f => f.name).join(", "));
  console.log("");
  const stats = { created: 0, updated: 0, skipped: 0, preview: 0, apiErrors: 0 };

  if (sourceMode === "curated" || sourceMode === "both") await importCurated(model, stats);
  if (sourceMode === "nhtsa" || sourceMode === "both") await importNhtsa(model, stats);
  if (!["curated","nhtsa","both"].includes(sourceMode)) throw new Error("--source must be curated, nhtsa, or both");

  const count = dryRun ? null : await prisma.vehicleVariant.count();
  console.log("\nDONE");
  console.log(JSON.stringify({ ...stats, totalVehicleVariants: count, dryRun }, null, 2));
  console.log("\nReminder: a catalogue record means the vehicle exists. Product fitment must still be verified separately.");
}

main()
  .catch(err => {
    console.error("\nVEHICLE SYNC FAILED\n", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
