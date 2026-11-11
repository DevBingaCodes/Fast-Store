// Load environment settings exactly once,
// before importing controllers or services.
const path = require("path");

require("dotenv").config({
    path: path.join(__dirname, ".env"),
});


// Imports
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const {
    collectDefaultMetrics,
    Counter,
    Histogram,
    register,
} = require("@prometheus-io/client");

const { fail, errorHandler } = require("./utils/http");
const rateLimit = require("./middleware/rateLimit");

// Initialize Express
const app = express();

collectDefaultMetrics();

const httpRequests = new Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests handled by the API.",
    labelNames: ["method", "status_code"],
});

const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// CORS
// Preserve the Vite origin and allow explicitly configured deployment origins.
const allowedOrigins = new Set(
    [
        "http://localhost:5173",
        ...(process.env.CORS_ORIGINS || "").split(","),
        process.env.CLIENT_URL,
        process.env.ADMIN_CLIENT_URL,
    ]
        .filter(Boolean)
        .map((value) => value.trim())
);

const corsOptions = {
    origin(origin, callback) {
        callback(
            !origin || allowedOrigins.has(origin)
                ? null
                : fail(403, "Origin is not allowed."),
            true
        );
    },

    credentials: true,
};

app.use(cors(corsOptions));

// Track request volume and latency without using URL paths as labels,
// which could create unbounded metric cardinality.
app.use((req, res, next) => {
    if (req.path === "/metrics") {
        return next();
    }

    const endTimer = httpRequestDuration.startTimer({
        method: req.method,
    });

    res.once("finish", () => {
        httpRequests.inc({
            method: req.method,
            status_code: String(res.statusCode),
        });
        endTimer();
    });

    next();
});


// Cookie-authenticated writes reject untrusted browser origins before execution.
app.use((req, res, next) => {
    const safeMethods = ["GET", "HEAD", "OPTIONS"];
    const origin = req.get("Origin");

    if (
        !safeMethods.includes(req.method) &&
        origin &&
        !allowedOrigins.has(origin)
    ) {
        return next(fail(403, "Origin is not allowed."));
    }

    next();
});

// Middleware
// Stripe signature verification requires the untouched request body.
app.use("/api/webhook", require("./routes/webhook"));

app.use(
    express.json({
        limit: "100kb",
    })
);

app.use(cookieParser());

// Rate Limiting
// Account and messaging throttles are independent from normal browsing.
for (const prefix of ["auth", "password", "verify", "phone"]) {
    app.use(
        `/api/${prefix}`,
        rateLimit(prefix === "auth" ? 60 : 20)
    );
}

app.use(
    "/api/admin/auth",
    rateLimit(20)
);

// Routes
const routes = {
    auth: "auth",
    "admin/auth": "adminAuth",
    verify: "emailService",
    phone: "phoneService",
    products: "product",
    categories: "category",
    flashsale: "flashsales",
    promo: "promo",
    brands: "brand",
    wishlist: "wishlist",
    cart: "cart",
    users: "users",
    checkout: "checkout",
    orders: "orders",
    address: "address",
    password: "password",
    notifications: "notification",
    refunds: "refund",
    wallet: "wallet",
    deliveries: "delivery",
    "payment-transactions": "paymentTransaction",
    stock: "stock",
};

for (const [prefix, file] of Object.entries(routes)) {
    app.use(
        `/api/${prefix}`,
        require(`./routes/${file}`)
    );
}



// Health Checks


// Liveness and readiness are separate for deployment health checks.
app.get("/health/live", (req, res) => {
    res.json({
        status: "ok",
    });
});

app.get("/health/ready", (req, res) => {
    const isReady = mongoose.connection.readyState === 1;

    res
        .status(isReady ? 200 : 503)
        .json({
            ready: isReady,
        });
});

// Prometheus scrape endpoint.
app.get("/metrics", async (req, res, next) => {
    try {
        res.set("Content-Type", register.contentType);
        res.end(await register.metrics());
    } catch (error) {
        next(error);
    }
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({
        message: "Endpoint not found.",
    });
});


// Global Error Handler
app.use(errorHandler);

// Application Startup
// Do not accept traffic until required configuration and MongoDB are ready.
async function start() {
    // Validate required environment variables.
    for (const key of [
        "MONGO_URI",
        "JWT_SECRET",
        "JWT_REFRESH_SECRET",
        "ADMIN_JWT_SECRET",
        "ADMIN_JWT_REFRESH_SECRET",
        "ADMIN_REGISTRATION_KEY",
        "CLIENT_URL",
    ]) {
        if (!process.env[key]) {
            throw new Error(
                `Missing required environment variable: ${key}`
            );
        }
    }

    // Validate JWT secret lengths.
    const jwtSecretKeys = [
        "JWT_SECRET",
        "JWT_REFRESH_SECRET",
        "ADMIN_JWT_SECRET",
        "ADMIN_JWT_REFRESH_SECRET",
    ];

    for (const key of jwtSecretKeys) {
        if (process.env[key].length < 32) {
            throw new Error(
                `${key} must contain at least 32 characters.`
            );
        }
    }

    // Access and refresh tokens must not use the same secret.
    const jwtSecrets = jwtSecretKeys.map(
        (key) => process.env[key]
    );

    if (new Set(jwtSecrets).size !== jwtSecrets.length) {
        throw new Error(
            "Customer and administrator JWT secrets must all differ."
        );
    }

    if (process.env.ADMIN_REGISTRATION_KEY.length < 32) {
        throw new Error(
            "ADMIN_REGISTRATION_KEY must contain at least 32 characters."
        );
    }

    // Connect to MongoDB.
    await mongoose.connect(process.env.MONGO_URI, {
        autoIndex: process.env.NODE_ENV !== "production",
    });

    // Start HTTP server.
    const server = app.listen(
        Number(process.env.PORT) || 5500,
        "0.0.0.0",
        () => {
            console.log("Backend is ready.");
        }
    );

    // Order Reconciliation

    // Reconciliation is serialized within this process
    // and safe across replicas via transactions.
    let reconciling = false;

    const timer = setInterval(async () => {
        if (reconciling) {
            return;
        }

        reconciling = true;

        try {
            await require("./services/reconcile").reconcileOrders();
        } catch (err) {
            console.error(
                "Order reconciliation failed:",
                err.message
            );
        } finally {
            reconciling = false;
        }
    }, 60000);

    timer.unref();

    // Graceful Shutdown

    // Stop accepting traffic before closing the database
    // on deployment shutdown.
    const shutdown = () => {
        clearInterval(timer);

        server.close(async () => {
            await mongoose.disconnect();
            process.exit(0);
        });

        setTimeout(() => {
            process.exit(1);
        }, 10000).unref();
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    return server;
}

// Entry Point
if (require.main === module) {
    start().catch((err) => {
        console.error(
            "Startup failed:",
            err.message
        );

        process.exit(1);
    });
}

module.exports = {
    app,
    start,
};
