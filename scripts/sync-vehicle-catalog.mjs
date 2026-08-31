#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const prisma = new PrismaClient();

function arg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(v => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }
const sourceMode = String(arg("source", "curated")).toLowerCase();
const nhtsaMode = String(arg("mode", "popular")).toLowerCase();
const currentYear = new Date().getFullYear();
const fromYear = Number(arg("from", "1996"));
const toYear = Number(arg("to", String(currentYear + 1)));
const onlyMake = arg("only-make", null);
const delayMs = Math.max(0, Number(arg("delay", nhtsaMode === "all" ? "350" : "220")));
const limitMakes = Math.max(0, Number(arg("limit-makes", "0")));
const dryRun = hasFlag("dry-run");
const checkpointPath = path.join(projectRoot, ".vehicle-sync-checkpoint.json");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const clean = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
const norm = value => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slug = value => String(value).normalize("NFKD").toLowerCase().replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
function titleish(value) {
  const s = clean(value);
  if (!s) return s;
  if (s === s.toUpperCase() && s.length > 3) {
    return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bBmw\b/g, "BMW").replace(/\bGmc\b/g, "GMC").replace(/\bMini\b/g, "MINI");
  }
  return s;
}
async function loadJson(rel) { return JSON.parse(await fs.readFile(path.join(projectRoot, rel), "utf8")); }

async function getOrCreateMake(makeName, stats) {
  const name = titleish(makeName);
  const makeSlug = slug(name);
  if (dryRun) return { id: `dry-make-${makeSlug}`, name, slug: makeSlug };
  let make = await prisma.vehicleMake.findUnique({ where: { name } });
  if (make) {
    if (make.slug !== makeSlug) make = await prisma.vehicleMake.update({ where: { id: make.id }, data: { slug: makeSlug } });
    return make;
  }
  make = await prisma.vehicleMake.create({ data: { name, slug: makeSlug } });
  stats.makesCreated++;
  return make;
}

async function getOrCreateModel(make, modelName, stats) {
  const name = clean(modelName);
  const modelSlug = slug(name);
  if (dryRun) return { id: `dry-model-${make.id}-${modelSlug}`, makeId: make.id, name, slug: modelSlug };
  const where = { makeId_slug: { makeId: make.id, slug: modelSlug } };
  let model = await prisma.vehicleModel.findUnique({ where });
  if (model) {
    if (model.name !== name) model = await prisma.vehicleModel.update({ where: { id: model.id }, data: { name } });
    return model;
  }
  model = await prisma.vehicleModel.create({ data: { makeId: make.id, name, slug: modelSlug } });
  stats.modelsCreated++;
  return model;
}

function normalizedVariant(row) {
  const yearStart = Number(row.yearStart ?? row.yearFrom ?? row.year);
  const yearEnd = Number(row.yearEnd ?? row.yearTo ?? row.year ?? yearStart);
  return {
    yearStart,
    yearEnd,
    trim: clean(row.trim) || null,
    chassisCode: clean(row.chassisCode) || null,
    engineCode: clean(row.engineCode || row.engine) || "UNSPECIFIED",
    engineName: clean(row.engineName || row.engine) || "Multiple / unspecified engines",
    displacementCc: Number.isFinite(Number(row.displacementCc)) ? Number(row.displacementCc) : null,
    aspiration: clean(row.aspiration) || null,
    fuelType: clean(row.fuelType) || null,
    transmission: clean(row.transmission) || null,
    drivetrain: clean(row.drivetrain) || null
  };
}

async function upsertVariant(makeName, modelName, raw, stats) {
  const make = await getOrCreateMake(makeName, stats);
  const model = await getOrCreateModel(make, modelName, stats);
  const v = normalizedVariant(raw);
  if (!Number.isInteger(v.yearStart) || !Number.isInteger(v.yearEnd) || v.yearStart < 1886 || v.yearEnd < v.yearStart) { stats.skipped++; return; }
  if (dryRun) {
    stats.preview++;
    if (stats.preview <= 25) console.log("[dry-run]", { make: make.name, model: model.name, ...v });
    return;
  }
  const existing = await prisma.vehicleVariant.findFirst({
    where: { modelId: model.id, yearStart: v.yearStart, yearEnd: v.yearEnd, engineCode: v.engineCode, trim: v.trim, chassisCode: v.chassisCode }
  });
  if (existing) {
    await prisma.vehicleVariant.update({ where: { id: existing.id }, data: { engineName: v.engineName, displacementCc: v.displacementCc, aspiration: v.aspiration, fuelType: v.fuelType, transmission: v.transmission, drivetrain: v.drivetrain } });
    stats.variantsUpdated++;
  } else {
    await prisma.vehicleVariant.create({ data: { modelId: model.id, ...v } });
    stats.variantsCreated++;
  }
}

async function importCurated(stats) {
  const file = await loadJson("data/sandman-global-vehicles.json");
  let records = file.records ?? [];
  if (onlyMake) records = records.filter(r => norm(r.make) === norm(onlyMake));
  console.log(`Curated model ranges selected: ${records.length}`);
  for (const row of records) {
    const originalStart = Number(row.yearFrom ?? row.yearStart);
    const originalEnd = Number(row.yearTo ?? row.yearEnd ?? originalStart);
    const yearStart = Math.max(originalStart, fromYear);
    const yearEnd = Math.min(originalEnd, toYear);
    if (yearEnd < yearStart) continue;
    await upsertVariant(row.make, row.model, { ...row, yearStart, yearEnd }, stats);
  }
}

async function fetchJson(url, tries = 6) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "SANDMAN-Vehicle-Catalog/1.1" }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.json();
      const retryAfter = Number(res.headers.get("retry-after") || 0) * 1000;
      if (attempt === tries) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      await sleep(Math.max(retryAfter, attempt * 900));
    } catch (error) {
      if (attempt === tries) throw error;
      await sleep(attempt * 1000);
    }
  }
}
async function getCheckpoint() { try { return JSON.parse(await fs.readFile(checkpointPath, "utf8")); } catch { return {}; } }
async function saveCheckpoint(checkpoint) { await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2)); }

async function getNhtsaMakes() {
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

async function importNhtsa(stats) {
  const makes = await getNhtsaMakes();
  const checkpoint = await getCheckpoint();
  console.log(`NHTSA mode=${nhtsaMode}; makes=${makes.length}; years=${fromYear}-${toYear}`);
  let requestNo = 0;
  for (let year = fromYear; year <= toYear; year++) {
    for (const make of makes) {
      const cpKey = `${nhtsaMode}|${year}|${make.Make_ID ?? norm(make.Make_Name)}`;
      if (checkpoint[cpKey] === "done") continue;
      const url = make.Make_ID
        ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeIdYear/makeId/${encodeURIComponent(make.Make_ID)}/modelyear/${year}?format=json`
        : `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make.Make_Name)}/modelyear/${year}?format=json`;
      let data;
      try { data = await fetchJson(url); }
      catch (error) { console.error(`NHTSA request failed: ${year} ${make.Make_Name}:`, error?.message ?? error); stats.apiErrors++; continue; }
      const seen = new Set();
      for (const row of data.Results ?? []) {
        const resolvedMake = titleish(row.Make_Name || make.Make_Name);
        const modelName = clean(row.Model_Name);
        if (!modelName) continue;
        const k = `${norm(resolvedMake)}|${norm(modelName)}|${year}`;
        if (seen.has(k)) continue;
        seen.add(k);
        await upsertVariant(resolvedMake, modelName, { yearStart: year, yearEnd: year, engineCode: "UNSPECIFIED", engineName: "Multiple / unspecified engines" }, stats);
      }
      checkpoint[cpKey] = "done";
      await saveCheckpoint(checkpoint);
      requestNo++;
      if (requestNo % 25 === 0) console.log(`NHTSA progress: ${requestNo} requests; ${stats.variantsCreated} variants created`);
      await sleep(delayMs);
    }
  }
}

async function counts() {
  const [makes, models, variants] = await Promise.all([prisma.vehicleMake.count(), prisma.vehicleModel.count(), prisma.vehicleVariant.count()]);
  return { makes, models, variants };
}

async function main() {
  if (!["curated", "nhtsa", "both"].includes(sourceMode)) throw new Error("--source must be curated, nhtsa, or both");
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear < 1886 || toYear < fromYear) throw new Error("Invalid --from / --to year range");
  const stats = { makesCreated: 0, modelsCreated: 0, variantsCreated: 0, variantsUpdated: 0, skipped: 0, preview: 0, apiErrors: 0 };
  console.log("SANDMAN Vehicle Catalogue Sync V1.1");
  console.log("Schema: VehicleMake -> VehicleModel -> VehicleVariant");
  console.log(`Source: ${sourceMode}`);
  if (onlyMake) console.log(`Only make: ${onlyMake}`);
  const before = dryRun ? null : await counts();
  if (before) console.log("Before:", before);
  if (sourceMode === "curated" || sourceMode === "both") await importCurated(stats);
  if (sourceMode === "nhtsa" || sourceMode === "both") await importNhtsa(stats);
  const after = dryRun ? null : await counts();
  console.log("\nDONE");
  console.log(JSON.stringify({ stats, before, after, dryRun }, null, 2));
  console.log("\nCatalogue import does not create ProductFitment links.");
}

main().catch(error => { console.error("\nVEHICLE SYNC FAILED\n", error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
