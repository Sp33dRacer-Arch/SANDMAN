$ErrorActionPreference = "Stop"
Write-Host "SANDMAN V2.5 local verification" -ForegroundColor Cyan
Write-Host "Project: $PWD"
Write-Host ""
function Run-Step([string]$Name, [scriptblock]$Command) {
  Write-Host "==> $Name" -ForegroundColor Yellow
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
  Write-Host "PASSED: $Name" -ForegroundColor Green
  Write-Host ""
}
Run-Step "Storefront/admin + V2.4 security baseline + V2.5 audit" { npm run verify:ui }
Run-Step "Prisma client generation" { npm run prisma:generate }
Run-Step "Prisma schema validation" { npx prisma validate }
Run-Step "TypeScript typecheck" { npm run typecheck }
Run-Step "Automated tests" { npm test }
Run-Step "Production build" { npm run build }
Run-Step "Git whitespace check" { git diff --check }
Write-Host "SANDMAN V2.5 local verification passed." -ForegroundColor Green
Write-Host "Do not deploy unless all steps above pass. Railway pre-deploy remains: npm run prisma:deploy"
