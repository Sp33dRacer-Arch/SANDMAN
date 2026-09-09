$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Project
Write-Host "SANDMAN storefront revamp + fitment + SEO V3 verification"
Write-Host "Project: $Project"

function Run-Step([string]$Name, [scriptblock]$Command) {
  Write-Host "`n==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
  Write-Host "PASSED: $Name"
}

$required = @(
  @{ Path = ".\public\store\app.js"; Marker = "VINYASA / CONNECTED CATALOG" },
  @{ Path = ".\public\store\app.js"; Marker = '$$(' },
  @{ Path = ".\public\store\app.js"; Marker = "setMeta('property', 'og:title', title)" },
  @{ Path = ".\src\modules\products\products.routes.ts"; Marker = "const weighted = (bScore + imagePriority(b))" },
  @{ Path = ".\src\services\vinyasa-normalizer.ts"; Marker = "break fitmentExpansion" },
  @{ Path = ".\src\services\vehicle-catalog-bootstrap.service.ts"; Marker = "const curatedEngine = clean(row.engine);" },
  @{ Path = ".\src\services\storefront-seo.service.ts"; Marker = "'@type': 'Product'" },
  @{ Path = ".\src\services\storefront-seo.service.ts"; Marker = "legacySupplierTitle" },
  @{ Path = ".\src\services\vinyasa.service.ts"; Marker = "VINYASA_SUPPLIER_FITMENT_NOTE" },
  @{ Path = ".\public\store\app.js"; Marker = "function clientProductSeo(p)" },
  @{ Path = ".\src\app.ts"; Marker = "const SITEMAP_PRODUCT_PAGE_SIZE = 45_000;" },
  @{ Path = ".\src\app.ts"; Marker = "buildProductSeo(product, env.APP_URL)" },
  @{ Path = ".\src\server.ts"; Marker = ".finally(() => startVinyasaScheduler())" }
)
foreach ($item in $required) {
  if (-not (Test-Path $item.Path)) { throw "Missing required file: $($item.Path)" }
  if (-not (Select-String -Path $item.Path -SimpleMatch $item.Marker -Quiet)) { throw "V3 marker missing in $($item.Path): $($item.Marker)" }
}

Run-Step "V3 patcher syntax" { node --check .\scripts\apply-storefront-revamp-fitment-v3.mjs }
Run-Step "SEO patcher syntax" { node --check .\scripts\apply-storefront-seo-v3.mjs }
Run-Step "V3 hardening patcher syntax" { node --check .\scripts\apply-storefront-v3-hardening.mjs }
Run-Step "Storefront JavaScript syntax" { node --check .\public\store\app.js }
Run-Step "V3 audit script syntax" { node --check .\scripts\static-storefront-revamp-fitment-v3-audit.mjs }
Run-Step "SEO audit script syntax" { node --check .\scripts\static-storefront-seo-v3-audit.mjs }
Run-Step "V3 hardening audit script syntax" { node --check .\scripts\static-storefront-v3-hardening-audit.mjs }
Run-Step "V3 storefront + fitment audit" { node .\scripts\static-storefront-revamp-fitment-v3-audit.mjs }
Run-Step "V3 product SEO audit" { node .\scripts\static-storefront-seo-v3-audit.mjs }
Run-Step "V3 storefront hardening audit" { node .\scripts\static-storefront-v3-hardening-audit.mjs }

if (Test-Path ".\VERIFY-STOREFRONT-UX-VINYASA-5M.ps1") {
  Run-Step "Existing storefront UX + Vinyasa 5M/full SANDMAN verifier" { powershell -ExecutionPolicy Bypass -File .\VERIFY-STOREFRONT-UX-VINYASA-5M.ps1 }
} elseif (Test-Path ".\VERIFY-V2.6.1-VINYASA.ps1") {
  Run-Step "Existing full SANDMAN V2.6.1 verifier" { powershell -ExecutionPolicy Bypass -File .\VERIFY-V2.6.1-VINYASA.ps1 }
} else {
  throw "No existing SANDMAN V2.6.1 verifier found. Do not commit or deploy without dependency-backed verification."
}

Write-Host "`nSANDMAN storefront revamp + fitment + SEO V3 hardened verification passed."
