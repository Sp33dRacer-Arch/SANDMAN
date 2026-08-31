# SANDMAN Responsive + Admin Optimization Patch

This patch improves the existing SANDMAN V2.0 project in place. It does **not** rewrite the backend, Prisma schema, payments, marketplace, supplier routing, vehicle fitment, Garage, Builds, or API architecture.

## Storefront

- Replaced the crowded desktop navigation with four primary destinations: Shop, Vehicles, Builds and Marketplace.
- Added accessible Vehicles and Builds dropdown menus that preserve every existing destination.
- Kept Search and Bag reachable on mobile while moving secondary actions into the mobile menu.
- Reorganized the mobile menu into Shop, Vehicle, Build and Account groups and made it vertically scrollable with safe-area support.
- Added a mobile filter bottom sheet instead of placing the full filter panel above the catalogue.
- Kept product grids at two columns on normal phones, falling back to one column only below 360px.
- Added a sticky mobile product buy bar above the bottom navigation.
- Added reduced-motion support, stronger focus-visible states and larger mobile touch targets.
- Added mobile safe-area handling for bottom navigation, drawers and fixed purchase controls.
- Added request cancellation to live search suggestions to prevent stale responses from replacing newer searches.
- Added explicit image dimensions/async decoding for catalogue images.
- Added a 720px WebP SANDMAN logo asset (~54 KB versus the ~1.49 MB PNG) and switched storefront logo usage to the optimized asset.
- Reduced expensive decorative effects on small screens.
- Improved footer readability in both dark and light mode.

## Footer information pages

These footer destinations now render real in-app pages:

- Buyer protection
- Shipping
- Returns
- Terms
- Privacy
- About

The pages include their own information navigation and operational content. The legal pages carry a production-review notice so draft storefront copy is not represented as final jurisdiction-specific legal advice.

## Admin

- Added a proper mobile sidebar backdrop, body scroll lock, Escape-to-close and aria-expanded state.
- Made the sidebar independently scrollable and increased mobile navigation touch targets.
- Simplified the mobile top bar and collapses the Add Product label to a compact plus button on narrow screens.
- Added a responsive-table enhancer: existing admin tables automatically become labelled mobile cards without rewriting every admin renderer.
- Improved mobile page headings, metrics, toolbars, table actions and toast positioning.
- Added reduced-motion and focus-visible accessibility support.
- Preserved the dense desktop admin layout for operations work.

## Intentionally unchanged

- Express/TypeScript backend
- Prisma schema and migrations
- Checkout/payment logic
- Stripe/PayPal configuration
- Marketplace payout logic
- Supplier adapters/routing
- Vehicle fitment semantics
- Existing API endpoints
