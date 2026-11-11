process.env.JWT_SECRET = "access-test-secret-that-is-not-for-production";
process.env.JWT_REFRESH_SECRET =
  "refresh-test-secret-that-is-not-for-production";
process.env.CLIENT_URL = "http://localhost:5173";
process.env.ADMIN_CLIENT_URL = "https://admin.fast-store.skirill.org";
const request = require("supertest");
const { app } = require("../index");

// HTTP-level checks catch missing middleware imports and CORS registration errors.
test("Vite receives credentialed CORS headers", async () => {
  const result = await request(app)
    .get("/health/live")
    .set("Origin", "http://localhost:5173");

  expect(result.status).toBe(200);
  expect(result.headers["access-control-allow-origin"]).toBe(
    "http://localhost:5173",
  );
  expect(result.headers["access-control-allow-credentials"]).toBe("true");
});
test("administrator deployment receives credentialed CORS headers", async () => {
  const result = await request(app)
    .get("/health/live")
    .set("Origin", "https://admin.fast-store.skirill.org");

  expect(result.status).toBe(200);
  expect(result.headers["access-control-allow-origin"]).toBe(
    "https://admin.fast-store.skirill.org",
  );
  expect(result.headers["access-control-allow-credentials"]).toBe("true");
});

test("untrusted browser origins are rejected", async () => {
  const result = await request(app)
    .post("/api/auth/logout")
    .set("Origin", "https://untrusted.example");

  expect(result.status).toBe(403);
});

test.each([
  "/api/users",
  "/api/orders",
  "/api/cart/carts",
  "/api/wishlist/wishlists",
  "/api/address/user",
  "/api/orders/payment-status?session_id=cs_test",
  "/api/refunds/user",
  "/api/wallet",
  "/api/wallet/admin",
  "/api/wallet/admin/users/507f1f77bcf86cd799439011",
  "/api/deliveries/pending",
  "/api/deliveries/user",
  "/api/refunds",
  "/api/deliveries",
  "/api/payment-transactions",
  "/api/payment-transactions/metrics",
  "/api/stock/metrics",
  "/api/stock/movements",
])("private endpoint %s rejects anonymous access", async (path) => {
  expect((await request(app).get(path)).status).toBe(401);
});

test.each([
  "/api/products/add-new",
  "/api/brands/add",
  "/api/flashsale/add",
  "/api/promo/add",
  "/api/notifications",
  "/api/phone",
  "/api/wallet/topups",
  "/api/checkout/wallet",
  "/api/wallet/topups/507f1f77bcf86cd799439011/confirm",
  "/api/refunds/orders/507f1f77bcf86cd799439011/request",
  "/api/refunds/507f1f77bcf86cd799439011/approve",
  "/api/deliveries/orders/507f1f77bcf86cd799439011/initiate",
  "/api/deliveries/507f1f77bcf86cd799439011/confirm",
  "/api/stock/507f1f77bcf86cd799439011/adjust",
])("management endpoint %s rejects anonymous writes", async (path) => {
  expect((await request(app).post(path).send({})).status).toBe(401);
});

test("readiness remains unavailable without a database connection", async () => {
  expect((await request(app).get("/health/ready")).status).toBe(503);
});

test.each([
  "/api/wallet/admin",
  "/api/wallet/admin/users/507f1f77bcf86cd799439011",
  "/api/deliveries/pending",
])("customer session cannot access %s", async (path) => {
  const token = require("jsonwebtoken").sign(
    {
      id: "507f1f77bcf86cd799439011",
      sid: "customer-session",
    },
    process.env.JWT_SECRET,
  );

  const result = await request(app)
    .get(path)
    .set("Cookie", `accessToken=${token}`);

  expect(result.status).toBe(401);
});
