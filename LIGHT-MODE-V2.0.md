# SANDMAN V2.0 Light Mode

This UI patch adds a shared light/dark appearance switch to both the customer storefront and the admin console.

## Behaviour

- SANDMAN remains dark by default.
- The user's choice is saved in `localStorage` under `sandman-theme`.
- The same preference follows the user between `/` and `/admin` on the same domain.
- The page theme-color is updated for the active mode.
- Theme is applied in `<head>` before CSS rendering to reduce theme flash.
- Light mode keeps the SANDMAN bone/sand identity instead of using a generic pure-white theme.
- No API, Prisma schema, product, order, fitment, supplier, checkout, or payment logic is changed.

## Files changed

- `public/store/index.html`
- `public/store/app.js`
- `public/store/styles.css`
- `public/admin/index.html`
- `public/admin/app.js`
- `public/admin/styles.css`
