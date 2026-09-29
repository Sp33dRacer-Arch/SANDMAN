param([switch]$Force)

$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Project
Write-Host "SANDMAN Google Merchant feed installer V1.0.0"
Write-Host "Project: $Project"

if (-not (Test-Path ".\package.json")) { throw "Copy this into your SANDMAN backend root (next to package.json) before running it." }

node --check .\scripts\apply-google-merchant-feed-v1.0.0.mjs
if ($LASTEXITCODE -ne 0) { throw "Installer syntax check failed. Do not run." }

if ($Force) {
  node .\scripts\apply-google-merchant-feed-v1.0.0.mjs --force
} else {
  node .\scripts\apply-google-merchant-feed-v1.0.0.mjs
}
if ($LASTEXITCODE -ne 0) { throw "Installer failed. See the message above." }

node --check .\src\modules\feeds\feeds.routes.ts
if ($LASTEXITCODE -ne 0) { throw "Generated feed route has a syntax error. Do not commit." }

node --check .\scripts\static-google-merchant-feed-v1.0.0-audit.mjs
if ($LASTEXITCODE -ne 0) { throw "Audit script syntax check failed. Do not run." }

node .\scripts\static-google-merchant-feed-v1.0.0-audit.mjs
if ($LASTEXITCODE -ne 0) { throw "Static audit failed. Do not commit." }

Write-Host "SANDMAN Google Merchant feed V1.0.0 install checks passed."
Write-Host "Next: run your dev server and open /feeds/google-merchant.txt to check real rows,"
Write-Host "then follow the Merchant Center scheduled-fetch steps from INSTALL-GOOGLE-MERCHANT-FEED-V1.0.0.txt."
