$ErrorActionPreference = "Stop"

Write-Host "SANDMAN V2.0 verification" -ForegroundColor Cyan
Write-Host "1/5 Prisma client"
npm run prisma:generate
Write-Host "2/5 Prisma schema"
npx prisma validate
Write-Host "3/5 TypeScript"
npm run typecheck
Write-Host "4/5 Tests"
npm test
Write-Host "5/5 Production build"
npm run build
Write-Host "SANDMAN V2.0 verification passed." -ForegroundColor Green
