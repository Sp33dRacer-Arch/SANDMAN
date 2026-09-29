# SANDMAN Google Merchant Feed V1.0.0

## What this is
A new, additive installer that generates `src/modules/feeds/feeds.routes.ts`:
an Express route serving your product catalog as a Google Merchant Center
feed (tab-separated, streamed with cursor pagination so memory stays flat
regardless of catalog size).

## How it decides field mappings
Reads `prisma/schema.prisma` directly and matches your real field names
(title/name, price, stock/quantity, images relation, brand, gtin/upc, mpn,
color, size) instead of assuming a fixed schema. Prints exactly what it
found and what it used for each attribute, so nothing is a silent guess.

## Style/variant handling
Detects, in order:
1. A dedicated variant/style model (`ProductVariant`, `ProductStyle`,
   `Variant`, or `Style`) related to `Product` — each variant becomes one
   feed row, grouped under the parent product as `item_group_id`.
2. A grouping field directly on `Product` (`groupId`/`familyId`/`parentId`)
   — each `Product` row becomes one feed row, grouped by that field.
3. Neither — each `Product` row becomes one feed row with no
   `item_group_id`.

## Wiring
Reuses your existing exported `prisma` client and `asyncHandler` helper
rather than creating new ones. Looks for the single file and single line
that mount your existing `experienceRouter`; if there's exactly one of
each, it adds a matching import + mount line for the new `feedsRouter`
right next to it. If that anchor isn't unambiguous, it changes nothing else
and prints the two lines for you to add by hand.

## Safety
Only ever writes two things: the new `feeds.routes.ts` file, and — at
most — an addition to the one file that mounts existing routers, never a
replacement of existing lines. Never touches Prisma schema/migrations,
`.env`, secrets, payment settings, or supplier-order settings. Re-running
without `--force` will not overwrite an existing `feeds.routes.ts`.

## Tested against
Mock backends matching your file layout (`src/lib`, `src/middleware`,
`src/modules/experience`, an exported `prisma` client, an `asyncHandler`
helper, and an `app.ts` mounting `experienceRouter`), covering:
- a flat `Product` model (single-row mode)
- a separate `ProductVariant` style/color/size model (variant-model mode)
- a `Product` model with a `groupId` field and no variant table
  (grouped-product-rows mode)
- `Product` missing a title/description field (installer fails closed
  instead of guessing)
- `Product` with price only on the variant model, not on `Product` itself
- no `Product` model in the schema at all (installer fails closed)
- no exported `asyncHandler` anywhere (falls back to a plain handler)
- two files importing `experienceRouter` (ambiguous — installer skips
  auto-wiring rather than guessing, leaves both files untouched)
- Windows CRLF line endings with a Prettier-style multi-line `app.use(...)`
  call (installer preserves CRLF throughout rather than producing a
  mixed-line-ending file)
- re-running without `--force` (fails closed, does not overwrite)

All of the above generate output that passes `node --check`, and the
static audit passes 6/6 on the successful cases. This has not been run
against your actual repository — the mock projects match the conventions
your existing patcher revealed about SANDMAN, not your literal schema.

## Fixed during testing (before this was ever handed to you)
- The installer originally required both title *and* price directly on
  `Product`, which would incorrectly fail closed on schemas (like yours
  may well be) where price lives on the variant/style model instead.
- `description` was read without a null-safety fallback; a schema missing
  it would have silently generated a broken property access instead of a
  clear error. The installer now requires title *and* description
  up front (both are required by Google) and fails closed with a clear
  message if either is missing.
- Auto-wiring into an existing CRLF file was inserting new lines with
  plain `\n`, producing a mixed-line-ending file. It now normalizes to
  `\n` for editing and converts back to `\r\n` on write, matching the
  technique your own V3.1.6 patcher uses.

## Known limitations (v1.0.0)
- `CURRENCY` and `SITE_URL` are placeholders in the generated file — set
  both before deploying.
- `google_product_category` is left blank if your schema has no matching
  field; Merchant Center will ask you to set a default category in that
  case.
- If your schema uses field names the pattern-matching doesn't recognize
  (e.g. title/description not found at all), the installer stops with an
  error rather than guessing — edit the FIELD MAP section of
  `scripts/apply-google-merchant-feed-v1.0.0.mjs` by hand in that case.
- Auto-wiring only looks for an `experienceRouter` mount point. If your
  entry file doesn't mount it the way the installer expects, you'll get the
  two manual lines to add instead — that's expected, not a failure.
