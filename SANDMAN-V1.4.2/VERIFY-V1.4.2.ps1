$ErrorActionPreference = 'Stop'

Write-Host 'SANDMAN V1.4.2 verification' -ForegroundColor Cyan
npm install
npx prisma generate
npx prisma validate
npm run typecheck
npm test
npm run build

Write-Host ''
Write-Host 'PASS: install, Prisma, typecheck, tests and build completed.' -ForegroundColor Green
Write-Host 'package-lock.json should now exist. Commit it before deploying.' -ForegroundColor Yellow
