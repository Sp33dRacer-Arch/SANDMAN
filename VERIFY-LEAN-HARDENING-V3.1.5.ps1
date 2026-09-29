$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Project
node --check .\scripts\apply-lean-hardening-v3.1.5.mjs
if ($LASTEXITCODE -ne 0) { throw "Lean-storage patcher syntax check failed." }
node --check .\scripts\static-lean-hardening-v3.1.5-audit.mjs
if ($LASTEXITCODE -ne 0) { throw "Lean-storage audit syntax check failed." }
node .\scripts\static-lean-hardening-v3.1.5-audit.mjs
if ($LASTEXITCODE -ne 0) { throw "Lean-storage static audit failed." }
if (Test-Path ".\VERIFY-STOREFRONT-REVAMP-FITMENT-V3.ps1") {
  powershell -ExecutionPolicy Bypass -File .\VERIFY-STOREFRONT-REVAMP-FITMENT-V3.ps1
} elseif (Test-Path ".\VERIFY-V2.6.1-VINYASA.ps1") {
  powershell -ExecutionPolicy Bypass -File .\VERIFY-V2.6.1-VINYASA.ps1
} else {
  throw "Existing SANDMAN verifier not found."
}
if ($LASTEXITCODE -ne 0) { throw "Existing SANDMAN verifier failed." }
Write-Host "SANDMAN V3.1.5 lean-storage hardening verification passed."
