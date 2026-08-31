# SANDMAN V2.0 Changelog

## Automotive core
- Added V2 Vehicle Finder using Make → Model → Year → Variant.
- Added vehicle resolution and catalogue-status endpoints.
- Bundled corrected vehicle-catalogue importer and curated/NHTSA data tooling.
- Added customer missing-vehicle requests.

## Fitment
- Added `FitmentSource` and verification metadata to `ProductFitment`.
- Added a single fitment-evaluation service shared by V2, products and builds.
- Changed missing evidence from a false “does not fit” claim to `UNKNOWN`.
- Added verified/catalogue/unconfirmed UI states.
- Added admin verification controls and catalogue-health metrics.
- Added checkout preflight for missing vehicle selection, missing fitment evidence and stock.

## Search + storefront
- Added vehicle-aware V2 search across product, SKU, OEM/MPN, brand, category, engine, chassis, make and model.
- Added Vehicle Finder navigation and page.
- Added Sourcing Desk customer page for missing vehicles and parts.
- Added Build Advisor page.
- Updated homepage positioning to an automotive parts platform.

## Builds
- Added build goal and target torque fields.
- Added deterministic Build Advisor priorities for Daily, Reliability, Street and Track use.
- Build compatibility now distinguishes verified/catalogue/unconfirmed evidence.

## Suppliers
- Added supplier-product lead time, warehouse country and reliability score.
- Supplier feed and operations imports can persist the new metadata.
- Public supplier-option endpoint exposes availability/logistics metadata but not supplier cost.

## Admin
- Admin label updated to V2.0.
- Added Sourcing navigation and request workflow.
- Added health cards for unverified fitments, fitment gaps, missing images and open sourcing requests.
- Fitment manager can mark exact variants as verified and record evidence source.

## Database
- Added `RequestStatus` and `FitmentSource` enums.
- Added `VehicleRequest` and `PartRequest` models.
- Extended `ProductFitment`, `SupplierProduct` and `Build`.
- Added migration `20260831110000_v20_vehicle_fitment_requests`.

## Intentionally not included
- Generative-AI mechanic responses.
- VIN decoder integration.
- OEM diagram licensing/data.
- 3D car configurator / crash or engineering simulation.
- Automatic claims about horsepower gains or part compatibility without evidence.
