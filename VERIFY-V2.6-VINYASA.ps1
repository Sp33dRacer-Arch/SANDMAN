$ErrorActionPreference = "Stop"

Write-Host "SANDMAN V2.6.1 Vinyasa local verification"
Write-Host "Project: $(Get-Location)"
Write-Host ""

function Run-Step([string]$Name, [scriptblock]$Command) {
  Write-Host "==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
  Write-Host "PASSED: $Name"
  Write-Host ""
}

Run-Step "Storefront/admin + security + PayPal/wallet + Vinyasa audits" { npm run verify:ui }
Run-Step "Prisma client generation" { npm run prisma:generate }
Run-Step "Prisma schema validation" { npx prisma validate }
Run-Step "TypeScript typecheck" { npm run typecheck }
Run-Step "Automated tests" { npm test }
Run-Step "Production build" { npm run build }
Run-Step "Git whitespace check" { git --no-pager -c core.safecrlf=false diff --no-ext-diff --no-textconv --check -- . }

Write-Host "SANDMAN V2.6.1 Vinyasa local verification passed."
