$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Project
Write-Host "SANDMAN V3.1.1 lean-storage hardening"
Write-Host "Project: $Project"

if (-not (Test-Path ".\package.json")) { throw "Copy this patch into C:\Users\asand\Downloads\SANDMAN-backend before running it." }
node --check .\scripts\apply-lean-hardening-v3.1.1.mjs
if ($LASTEXITCODE -ne 0) { throw "Lean-storage patcher syntax check failed. Do not commit or deploy." }
node --check .\scripts\static-lean-hardening-v3.1.1-audit.mjs
if ($LASTEXITCODE -ne 0) { throw "Lean-storage audit syntax check failed. Do not commit or deploy." }
node .\scripts\apply-lean-hardening-v3.1.1.mjs
if ($LASTEXITCODE -ne 0) { throw "Lean-storage patcher failed. Do not commit or deploy." }
node .\scripts\static-lean-hardening-v3.1.1-audit.mjs
if ($LASTEXITCODE -ne 0) { throw "Lean-storage static audit failed. Do not commit or deploy." }
if (Test-Path ".\VERIFY-STOREFRONT-REVAMP-FITMENT-V3.ps1") {
  powershell -ExecutionPolicy Bypass -File .\VERIFY-STOREFRONT-REVAMP-FITMENT-V3.ps1
  if ($LASTEXITCODE -ne 0) { throw "Existing SANDMAN V3 verifier failed. Do not commit or deploy." }
} elseif (Test-Path ".\VERIFY-V2.6.1-VINYASA.ps1") {
  powershell -ExecutionPolicy Bypass -File .\VERIFY-V2.6.1-VINYASA.ps1
  if ($LASTEXITCODE -ne 0) { throw "Existing SANDMAN verifier failed. Do not commit or deploy." }
} else {
  throw "Existing SANDMAN verifier not found. Do not commit or deploy."
}
Write-Host "SANDMAN V3.1.1 lean-storage hardening verification passed."
