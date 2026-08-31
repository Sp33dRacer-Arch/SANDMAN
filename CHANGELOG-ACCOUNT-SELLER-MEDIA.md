# SANDMAN Account, Seller Studio & Product Media Upgrade

## Product images
- Admin product create/edit now supports up to 8 product images.
- Marketplace sellers can upload up to 8 images per listing.
- Existing image-URL entry remains available as a fallback.
- File uploads use signed direct-to-Cloudinary uploads so the API secret never reaches browser code.
- Existing `ProductImage` records are reused; no Prisma migration is required.
- Product galleries automatically use all stored images and the first image remains the cover.

## Seller workflow
- Sellers can create listings and upload photos before payout verification.
- Listings save as DRAFT until seller payouts are ready; only payout-ready sellers can publish ACTIVE listings.
- Existing seller listings can now be edited, including images and fitment selections.
- Seller Studio has richer overview metrics, recent listings, recent sales, listing management, shipping forms, offers, messages, buyer-protection cases, seller profile and payout status.
- Shipping tracking is entered in-page instead of browser prompts.

## Account/profile
- Account landing page is now an overview instead of immediately opening orders.
- Added dedicated Purchases, Sales and Listings views.
- Profile & Settings supports first name, last name and phone updates.
- Email verification state is shown consistently and verification can be requested.
- Sign out is available directly from account/profile.
- Appearance setting lets the user switch between light and dark themes.
- Garage, Builds, Wishlist, Messages, Offers, Buyer Protection and Security remain accessible from one account navigation.

## Theme
- Light mode is now the default for first-time visitors on both storefront and admin.
- A previously saved explicit dark-mode preference is still respected.

## Admin
- Product media can be managed from the existing product modal, including replacing/removing images on existing products.
- Admin Settings reports whether Cloudinary product-media uploads are configured.

## Security
- Cloudinary API secret is server-only.
- Browser uploads receive a short-lived signed upload request and send image bytes directly to Cloudinary.
- Catalogue upload signatures require ADMIN or STAFF role.
- Marketplace upload signatures require an authenticated account.

## Post-scan hardening
- Moved theme restoration out of inline HTML so strict production CSP no longer blocks it; light remains the first-visit default and an explicit saved dark choice is still restored.
- Preserved existing verified ProductFitment rows during seller edits instead of deleting/recreating unchanged fitments.
- Preserved existing non-Garage fitments when a seller edits other listing details.
- Seller sales now expose the paid buyer's full shipping destination to the owning seller for fulfilment.
- Seller payout setup requires an explicit two-letter legal seller country instead of silently assuming South Africa.
- Existing saved phone number is now included in login/refresh public-user state for Profile & Settings.
- Image URLs now require HTTPS in both browser and API validation.
- Aligned seller/profile form limits with backend validation and capped generated image alt text to the API limit.
