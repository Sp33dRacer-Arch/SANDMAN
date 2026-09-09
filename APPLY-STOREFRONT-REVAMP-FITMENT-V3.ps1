$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Project
Write-Host "SANDMAN V2.6.1 storefront revamp + fitment + SEO V3"
Write-Host "Project: $Project"

if (-not (Test-Path ".\package.json")) { throw "Copy this patch into C:\Users\asand\Downloads\SANDMAN-backend before running it." }
if (-not (Test-Path ".\scripts\apply-storefront-revamp-fitment-v3.mjs")) { throw "V3 patcher is missing." }
if (-not (Test-Path ".\scripts\apply-storefront-seo-v3.mjs")) { throw "V3 SEO patcher is missing." }
if (-not (Test-Path ".\scripts\apply-storefront-v3-hardening.mjs")) { throw "V3 hardening patcher is missing." }
if (-not (Test-Path ".\src\services\vehicle-catalog-bootstrap.service.ts")) { throw "V3 vehicle bootstrap service is missing." }
if (-not (Test-Path ".\src\services\storefront-seo.service.ts")) { throw "V3 storefront SEO service is missing." }

node .\scripts\apply-storefront-revamp-fitment-v3.mjs
if ($LASTEXITCODE -ne 0) { throw "Storefront revamp/fitment V3 patcher failed with exit code $LASTEXITCODE. Do not commit or deploy." }

node .\scripts\apply-storefront-seo-v3.mjs
if ($LASTEXITCODE -ne 0) { throw "Storefront SEO V3 patcher failed with exit code $LASTEXITCODE. Do not commit or deploy." }

node .\scripts\apply-storefront-v3-hardening.mjs
if ($LASTEXITCODE -ne 0) { throw "Storefront V3 hardening patcher failed with exit code $LASTEXITCODE. Do not commit or deploy." }

powershell -ExecutionPolicy Bypass -File .\VERIFY-STOREFRONT-REVAMP-FITMENT-V3.ps1
if ($LASTEXITCODE -ne 0) { throw "Storefront revamp/fitment/SEO V3 verifier failed with exit code $LASTEXITCODE. Do not commit or deploy." }
