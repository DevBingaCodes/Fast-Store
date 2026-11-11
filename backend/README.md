# FastStore API

## Configuration and startup

Copy `.env.example` to `.env` only for a new installation. Existing `.env` files should be updated rather than overwritten. Set distinct random values for `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_JWT_SECRET`, and `ADMIN_JWT_REFRESH_SECRET` (at least 32 characters each). Set a private `ADMIN_REGISTRATION_KEY` of at least 32 characters, plus `MONGO_URI` and `CLIENT_URL`. `CORS_ORIGINS` is an optional comma-separated allowlist, and `ADMIN_CLIENT_URL` can declare the administrator frontend explicitly. Vite at localhost:5173 is supported.

`npm start` loads backend/.env exactly once, validates required variables, connects to MongoDB, then listens on PORT (default 5500). `npm run dev` uses nodemon. Optional Stripe, mail and SMS credentials are checked when their features are used. `/health/live` checks the process and `/health/ready` checks MongoDB connectivity. Prometheus can scrape `/metrics` for Node.js process metrics and HTTP request totals and durations; restrict access to this endpoint to your monitoring network.

## Session contract

- POST `/api/auth/login`: `{ email, password }`. Accounts must be email-verified. Returns a safe user summary and sets accessToken (one hour) and refreshToken (seven days) HttpOnly cookies. Local cookies use SameSite=Lax; deployed HTTPS cookies use SameSite=None and Secure. Administrator cookies are also partitioned for a cross-site admin frontend.
- POST `/api/auth/refresh`: sends the refresh cookie, rotates it atomically, and issues a new access cookie. Clients should serialize refresh requests.
- POST `/api/auth/logout`: revokes the database session and clears cookies.
- GET `/api/auth/check-session`: validates the access JWT and stored session; expired access returns 401, allowing the client to refresh.

Administrator authentication is completely separate:

- POST `/api/admin/auth/register`: accepts the normal registration fields and requires the private `X-Admin-Registration-Key` header. It creates an unverified Admin and sends the usual verification email. Do not place this key in frontend code.
- POST `/api/admin/auth/login`: accepts `{ email, password }` and sets `adminAccessToken` and `adminRefreshToken` cookies.
- POST `/api/admin/auth/refresh`: rotates the administrator refresh token.
- POST `/api/admin/auth/logout`: revokes only the administrator session.
- GET `/api/admin/auth/check-session`: validates the administrator cookie and current database role.
- PUT `/api/password/reset/password`: `{ currentPassword, newPassword, confirmPassword }`. Password changes and recovery revoke existing sessions.

Use `credentials: "include"` or Axios `withCredentials: true`. Production cookies require HTTPS. Keep the frontend origin in the API CORS allowlist. There is one active session per account; a new login revokes the previous session. Legacy storeSession cookies no longer authenticate.

Customer is the default role. Customer login accepts only Customer accounts, and management routes accept only the separate administrator session. Administrator registration requires the server-side registration key. Rotate or remove that key after controlled onboarding; never send it from a public browser application.

## Shopping API changes

- PATCH `/api/cart/quantity`: `{ productId, quantity }`.
- POST `/api/wishlist/add-to-wishlist`: `{ productId }`; DELETE `/api/wishlist` takes the catalog productId too.
- PUT/DELETE `/api/address/:id`: operate on the authenticated user's selected address. A single defaultAddressId on the user selects the default address. The older `/update` and `/delete` paths accept `addressId` in the body.
- PATCH `/api/notifications/:id/read`: marks an owned notification read.
- Product creation and updates use multipart form-data. Upload 1–4 files under the repeated `images` key. Text fields are `name`, `currentPrice`, `originalPrice`, `costPrice`, `quantity`, `reorderPoint`, `reorderQuantity`, `category`, `description`, `reviews`, and `newArrival`. `costPrice` is private and is used for inventory value, cost of goods sold, and estimated gross profit.
- Categories may be repeated `category` fields or one JSON array. Reviews may be one JSON value such as `{"rate":4.5,"count":12}`, or separate `reviews.rate` and `reviews.count` fields.
- Product images are stored in S3. Configure `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_S3_BUCKET`. JPEG, PNG, and WebP files up to 5 MB each are accepted.
- Brand creation also uses multipart form-data: send `name` and `slogan` as text and one `logo` file. Logos are stored under the `brand-logos/` S3 prefix.
- List endpoints accept page and limit (1–100). Empty customer lists return arrays or `{ products: [] }` as appropriate.

## Payments and MongoDB deployment

Checkout requires a MongoDB replica set (a single-node replica set works locally) because stock reservation and settlement use transactions. A standalone mongod supports authentication and browsing but cannot execute checkout transactions. Configure the replica set before payment integration; no database configuration is changed by this code update.

POST `/api/checkout/create-checkout-session` requires an Idempotency-Key header (16–100 letters/digits/underscores/hyphens) and `{ items: [{ productId, quantity }], addressId, source: "cart" | "buy-now" }`. Reuse a key for retries of exactly the same purchase. Prices are resolved from the database; stock is reserved transactionally. Orders include a shipping-address snapshot. Stripe and PayPal payments write idempotent `PaymentTransaction` ledger entries. Existing M-Pesa code remains available, but M-Pesa is intentionally excluded from the new ledger and refund workflows for now.

Configure Stripe webhook events checkout.session.completed and checkout.session.expired to POST `/api/webhook`. The raw body is signature-verified. Paid settlement and expired reservation releases are idempotent. A minute-based reconciliation loop checks overdue reservations against Stripe before releasing stock, including lost session-creation responses. A canceled checkout holds its reservation until expiry (approximately one hour). Email delivery is at-least-once: an ambiguous delivery failure can result in a duplicate email, but stock and cart mutations are not repeated.

## Administrator commerce operations

All management endpoints below require the separate administrator session. Money metrics are returned per currency so unlike currencies are never added together.

- GET `/api/payment-transactions`: lists ledger entries; optional `provider` and `type` filters are supported.
- GET `/api/payment-transactions/metrics`: returns gross paid revenue, refunds, net sales, transaction counts, and the gross-revenue change against the preceding equal-length period. Optional `from` and `to` ISO dates are supported.
- GET `/api/stock/metrics`: returns inventory units and cost value, low/out-of-stock counts and percentages, units sold, sell-through rate, cost of goods sold, and estimated gross profit.
- GET `/api/stock/movements`: lists the inventory audit trail; optional `productId` filtering is supported.
- POST `/api/stock/:productId/adjust`: accepts `{ quantityChange, reason }` and atomically records the resulting inventory movement.
- GET `/api/refunds`: lists refund requests. POST `/api/refunds/:id/approve` sends the refund to Stripe or PayPal with an idempotency key; POST `/api/refunds/:id/reject` accepts `{ reason }`.
- Damaged-product and wrong-product refund requests may include up to two JPEG, PNG, or WebP files under the repeated multipart field `evidence`. Each file is limited to 5 MB and is stored under the `refund-evidence/` S3 prefix.
- POST `/api/deliveries/orders/:orderId/initiate`: starts simulated delivery for a paid order. GET `/api/deliveries` lists delivery records.

Customer endpoints require the customer session:

- POST `/api/refunds/orders/:orderId/request`: accepts `{ reason, amount?, explanation? }`. Omitting `amount` requests the remaining refundable balance. GET `/api/refunds/user` lists the customer’s requests.
- GET `/api/deliveries/user`: lists the customer’s deliveries. POST `/api/deliveries/:id/confirm` simulates successful delivery and marks the owned order delivered.

Refund success is finalized from the immediate provider response or a later webhook, then recorded as a separate ledger transaction. Subscribe Stripe to `refund.created`, `refund.updated`, and `refund.failed` in addition to checkout events. Subscribe PayPal to `PAYMENT.CAPTURE.REFUNDED` in addition to capture events. A payment refund does not automatically return physical stock; an administrator should inspect the returned item and use the stock adjustment endpoint when it is sellable.

Demo catalog photos can come from a license-compatible source such as Unsplash or Pexels. Download the chosen files and submit them through the existing multipart `images` fields so the application owns stable S3 copies under `products/`; no media-asset collection is required.

The customer frontend includes payment-result, account verification, password reset, and wallet pages integrated with this API.

## Existing data and indexes

No live data is migrated automatically. Back up and inspect existing data before deployment:

1. User documents without role default to Customer; users must verify email before login. New secret/session fields are optional. Normalize legacy email casing and resolve collisions before relying on case-normalized login.
2. Legacy wishlist snapshots have no productId. Rebuild their references after identifying the corresponding products, or ask users to re-add them. Do not guess product identities from names without review.
3. Remove duplicate carts per user, wishlists per user, product names and (product, type) promos before creating their new unique indexes.
4. The old addresses.email unique index must be dropped explicitly; removing unique from a Mongoose schema does not remove an existing database index.
5. Create the product name/description text index and the new unique indexes using a reviewed database migration. In production, do not rely on automatic index creation. Existing legacy orders remain readable; automatic reconciliation targets only new reserved orders.

The application does not run syncIndexes or delete existing data. Database migrations and real Stripe/SMTP/Twilio checks are deployment tasks, not performed by the unit tests.

## Tests and operational limits

Run `npm test`. Tests mock external services and database operations; no emails, SMS messages or payments are sent. Rate limits are in-process; configure shared throttling at the gateway for multi-instance deployment. Configure proxy trust only for your actual reverse-proxy topology before relying on client IPs behind it.

### Brevo emails, receipts, and wallet

Customer emails use the Brevo transactional HTTPS API, with `BREVO_API_KEY`,
`CLIENT_URL`, and optionally `BREVO_SENDER_EMAIL` (defaults to
`info@fast-store.skirill.org`; the sender must belong to `fast-store.skirill.org`).
Verify/authorize that sender in Brevo. Gmail SMTP credentials are no longer used.
Templates share the storefront colors and include plain text alternatives.
Paid orders receive an itemized email receipt with a stable receipt number,
provider payment reference, paid date, currency, quantities, prices, and total.
The existing reconciliation worker retries unsent receipts, including orders
that have since been refunded. Email delivery remains at least once after a
process crash between sending and recording success.

The customer `/wallet` page stores balances per currency and displays the latest
100 activity entries. USD top-ups accept $1–$1,000 through Stripe Checkout or
PayPal. Wallet checkout pays the full USD order from the available balance; withdrawals
are not supported. Existing Stripe/PayPal credentials and
frontend PayPal configuration are reused. Stripe webhook subscriptions should
include `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
and `checkout.session.expired`; PayPal uses the existing completed order/capture
webhooks. Server retrieval also recovers missed webhooks. The server validates
amount, currency, identity, and confirmed payment before crediting the wallet.
Top-up creation requires an `Idempotency-Key`; reuse it for retries of the same
amount/provider. MongoDB transactions and unique indexes prevent duplicate
credits. MongoDB must run as a replica set, as for existing order/refund flows.

Customers can choose original-payment refunds (the default) or wallet credit.
Both require administrator approval and reserve the refundable order balance.
Wallet approval credits funds and finalizes the refund atomically without
requesting a provider refund. Wallet refunds appear in financial refund metrics;
top-ups are wallet liabilities and do not count as product sales.
The reconciliation worker sends wallet credit and refund status emails with
leases and retries. Do not directly edit wallet balances; use the ledger flows.

API: `GET /api/wallet`, `POST /api/wallet/topups` with `{amount, provider}`,
and `POST /api/wallet/topups/:id/confirm`, all customer authenticated.
`POST /api/checkout/wallet` accepts items, addressId, source, and
expectedTotalCents with an Idempotency-Key. Price changes require review before
payment. The debit, ledger entry, stock reservation, and paid order commit in one
transaction. Wallet purchase refunds always return to the wallet.
Refund requests additionally accept `destination: "original" | "wallet"`.

### Webhook subscriptions

Reuse the existing webhook endpoints; wallet checkout itself is an internal
transaction and requires no provider webhook. For top-ups and order/refund
updates, check these subscriptions on the same Stripe/PayPal apps used by the
server (sandbox and live have separate webhook configuration):

| Provider | Backend path | Events |
| --- | --- | --- |
| Stripe | `/api/webhook` | `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `refund.created`, `refund.updated`, `refund.failed` |
| PayPal | `/api/webhook/paypal` | `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` |

`checkout.session.async_payment_succeeded` supports delayed payment methods;
current Stripe card top-ups primarily use `checkout.session.completed`.
The PayPal handler also accepts `CHECKOUT.ORDER.COMPLETED` if already configured;
standard capture completion is sufficient for these top-ups. Set `WEBHOOK_SECRET`
to the Stripe endpoint signing secret and `PAYPAL_WEBHOOK_ID` to the PayPal
webhook registration ID. Existing values stay valid when adding event types to
the same registration.

### Wallet administration and delivery requests

- GET `/api/wallet/admin?limit=20&page=1` lists wallet balances with customer names and emails; optional `userId` filters one customer.
- GET `/api/wallet/admin/users/:userId?limit=20&page=1` returns that customer's balances and paginated wallet ledger. Both endpoints require an administrator session.
- Confirmed payment creates a `requested` delivery in the same database transaction. Customers see it immediately before delivery initiation. Legacy paid, unfulfilled orders also appear in the pending queue.
- GET `/api/deliveries/pending?limit=20&page=1` returns `{orders,total}` for paid or partially refunded orders awaiting initiation. Optional `orderId` supports email deep links. Administrator sessions only.
- Set `ADMIN_CLIENT_URL` to the deployed admin frontend origin. Paid-order alerts go to verified `Admin` accounts and link to `/deliveries/pending?orderId=…`. Initiation sends the customer a delivery confirmation with a tracking link. Failed emails are retried by the reconciliation worker; emails remain at least once if the provider response is ambiguous. Email failure never hides orders from the pending queue.
- These notifications and wallet administration use existing confirmed-payment handling; no additional Stripe or PayPal webhook subscriptions are required.
