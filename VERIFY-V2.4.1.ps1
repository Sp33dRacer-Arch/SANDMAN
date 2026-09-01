$ErrorActionPreference = "Stop"

function Run-Step([string]$Name, [scriptblock]$Command) {
  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $Name (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host "PASSED: $Name" -ForegroundColor Green
}

Write-Host "SANDMAN V2.4.1 verification" -ForegroundColor Yellow
Write-Host "Project: $(Get-Location)"

Run-Step "Storefront/admin static UI audit" { npm run verify:ui }
Run-Step "Prisma client generation" { npx prisma generate }
Run-Step "Prisma schema validation" { npx prisma validate }
Run-Step "TypeScript typecheck" { npm run typecheck }
Run-Step "Automated tests" { npm test }
Run-Step "Production build" { npm run build }
Run-Step "Git whitespace check" { git --no-pager diff --check }

Write-Host ""
Write-Host "==> Git status" -ForegroundColor Cyan
git status --short
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "SANDMAN V2.4.1 verification passed." -ForegroundColor Green
Write-Host "Review git status, then commit/push. Railway should run prisma migrate deploy before start."
