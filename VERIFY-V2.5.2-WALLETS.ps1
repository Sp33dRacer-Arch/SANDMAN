$ErrorActionPreference = "Stop"
Write-Host "SANDMAN V2.5.2 PayPal + Wallets verification" -ForegroundColor Cyan
Write-Host "Project: $PWD"
Write-Host ""
function Run-Step([string]$Name, [scriptblock]$Command) {
  Write-Host "==> $Name" -ForegroundColor Yellow
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
  Write-Host "PASSED: $Name" -ForegroundColor Green
  Write-Host ""
}
Run-Step "Storefront/admin + security + V2.5 + PayPal + wallet audits" { npm run verify:ui }
Run-Step "Prisma client generation" { npm run prisma:generate }
Run-Step "Prisma schema validation" { npx prisma validate }
Run-Step "TypeScript typecheck" { npm run typecheck }
Run-Step "Automated tests" { npm test }
Run-Step "Production build" { npm run build }
Run-Step "Git whitespace check" { git --no-pager -c core.safecrlf=false diff --no-ext-diff --no-textconv --check -- . }
Write-Host "SANDMAN V2.5.2 local verification passed." -ForegroundColor Green
Write-Host "PayPal, Google Pay and Apple Pay still require real PayPal sandbox/live eligibility and end-to-end transactions before production certification." -ForegroundColor Yellow
