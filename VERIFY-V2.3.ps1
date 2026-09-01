$ErrorActionPreference = "Stop"
Write-Host "SANDMAN V2.3 verification" -ForegroundColor Cyan

node --check public\store\app.js
node --check public\admin\app.js
npx prisma generate
npx prisma validate
npm run typecheck
npm test
npm run build
git diff --check

Write-Host "SANDMAN V2.3 verification passed." -ForegroundColor Green
