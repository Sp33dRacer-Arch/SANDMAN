# SANDMAN V2.4.1 — Security, Identity, Social & Mobile

## V2.4.1 scan fixes
- Fixed storefront runtime crashes caused by missing `renderVehicleFinder()`, `renderAdvisor()` and `renderRequests()` implementations.
- Added a route-to-render static audit so this class of error is caught even when `node --check` passes.
- Password changes now require the configured second factor when 2FA is enabled.
- Added `TOTP_ENCRYPTION_KEY` so authenticator-secret encryption can be separated from JWT signing-key rotation.
- Hardened one-time recovery-code consumption with an atomic compare-and-swap update.
- Expanded remote image URL protections to reject loopback, link-local and private-network IPv4/IPv6 destinations.
- Registration now reports verification-email delivery state instead of implying delivery when the provider failed.
- Fixed a Prisma schema/migration mismatch where unused `PasswordResetToken.codeHash` / `attempts` fields existed in the schema but were not shipped by the migration.
- Added a dedicated registration rate limit to reduce automated account/email abuse.
- Cloudinary upload signatures now require a verified email, reducing storage abuse from throwaway unverified accounts.
- Updated runtime/UI version markers to 2.4.1 and retained the V2.3 search-ranking TypeScript fix.

## Account security
- Rebuilt authenticator-app 2FA around a QR-code setup flow.
- TOTP secret stays pending until the first valid six-digit authenticator code succeeds.
- Raw `otpauth://` URI is not rendered in the storefront; the manual setup key is hidden behind an explicit fallback control.
- Ten one-time recovery codes are generated at enable time; regeneration and 2FA disable require password + second factor.
- Active sessions/devices can be reviewed and revoked, including “revoke other sessions”.
- Security-event history and new-device alerts are recorded.
- Login, password recovery, verification and 2FA endpoints use tighter rate limits.
- Repeated failed passwords from the same account/network temporarily throttle login attempts.
- Stronger password rule: 10–128 chars with uppercase, lowercase and number.
- Sensitive email/account actions require current password and, when enabled, a second factor.
- Verification codes are HMAC-hashed at rest rather than stored in plaintext.

## Email + phone verification delivery
- Email verification issues a 6-digit code and a high-entropy link token.
- Direct Resend integration plus provider-neutral email webhook support.
- Phone verification issues a 6-digit SMS OTP with a 10-minute expiry.
- Direct Twilio integration plus provider-neutral SMS webhook support.
- Changing an email verifies the NEW address first, alerts the OLD address, revokes other sessions and rotates the access token identity.
- SMS verifies a phone number; it is not treated as proof that an email address is owned.

## Profiles, identity and dealer verification
- Unique usernames with protected SANDMAN/admin/support/security names.
- Unicode-safe first/last-name rules allow legitimate international names while rejecting URLs, control/invisible Unicode and high-confidence sexual terms.
- Display names that could masquerade as an official SANDMAN account are blocked.
- Shared surnames are allowed: real people can legitimately have the same surname. Impersonation is handled with unique usernames, verified badges, reports and risk signals instead.
- Public profiles support avatar, banner, display name, bio, country and privacy controls.
- Dealer applications require verified email, verified phone and enabled 2FA before submission.
- Admins/staff can approve, reject or suspend dealer verification; approved profiles receive a verified-dealer indicator.
- Strong identity overlap with an already verified dealer can create a POSSIBLE_IMPERSONATION security signal for human review rather than auto-banning legitimate same-name users.

## Social + notifications
- Follow/unfollow users and sellers.
- Follower/following lists with privacy controls.
- Block users; blocking also removes follow relationships.
- Social posts + images and a Following feed.
- Followers can receive in-site notifications for new posts, marketplace listings and public builds.
- Storefront refreshes notification state while open instead of requiring a full-page reload.
- Notification preferences cover following activity, messages, marketplace and orders, with optional email delivery.
- Email notification links are expanded to the canonical `APP_URL` rather than unusable relative/hash-only email links.
- Report flows include scam, counterfeit, sexual content, hate/abuse, impersonation, spam, dangerous product, misleading listing and stolen image.

## Content and upload safety
- Text moderation hooks cover profiles, posts, listings, reviews, dealer data and support content.
- User image URLs must be HTTPS and cannot target localhost loopback addresses.
- Profile media, social images, listing photos, review photos, support evidence and dealer documents pass through the image-safety hook before publication.
- In production, user-generated images FAIL CLOSED if a moderation scanner is missing, unavailable or returns an ambiguous decision.
- Cloudinary signed browser uploads remain constrained by client + server upload purpose, file count/size and image MIME checks; Cloudinary credentials stay server-side.

## Trust & Safety administration
- Dealer application queue.
- Content report queue and enforcement actions.
- Security-event view.
- Audit log for important security/moderation actions.
- Heuristic account-risk view based on account age, verification state, failed logins, new devices, unresolved reports and possible impersonation signals.
- Risk scoring is review assistance only; it does not automatically ban accounts.

## Privacy and account controls
- Profile, Garage, following-list, message and online-status privacy settings.
- Account JSON data export behind sensitive re-authentication.
- Account deactivation/deletion request archives public listings/posts, removes public profile media/contact details and revokes sessions while preserving transactional records needed for operational/legal retention.
- Deactivated account usernames remain reserved to reduce impersonation/name-takeover risk.

## UI / mobile / light mode
- Repaired/hardened light-mode tokens and component overrides.
- Mobile-first account tabs, profiles, verification, security, notification center, social feed and listing layouts.
- QR code scales to phone width; recovery codes and manual-key controls wrap safely.
- Security/action modals become safe-area-aware bottom sheets on small screens.
- Touch targets are at least ~44 px on coarse-pointer devices; mobile form inputs use 16 px text to avoid iOS zoom.
- Admin Trust & Safety cards/tables/modals collapse for phone widths.
- Both storefront and admin use `viewport-fit=cover` for modern mobile safe areas.

## Database
Adds migration:
`prisma/migrations/20260901143000_v24_security_identity_social/migration.sql`

## Required external configuration
V2.4.1 contains the secure verification/moderation flows, but third-party credentials are not embedded in source. For real production delivery configure:
- Resend OR `EMAIL_DELIVERY_WEBHOOK_URL`
- Twilio OR `SMS_DELIVERY_WEBHOOK_URL` (only if SMS verification is wanted)
- `CONTENT_MODERATION_WEBHOOK_URL` before allowing production user-generated image publication
- Existing Cloudinary credentials for browser image-file uploads
