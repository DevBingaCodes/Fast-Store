const User = require("../models/users");
const UserAuthProvider = require("../models/userAuthProvider");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");

const { notifyUser } = require("../services/notifications");
const { sendVerificationEmail } = require("./emailService");

const {
  asyncHandler,
  fail,
  emailValue,
  passwordValid,
  objectId,
} = require("../utils/http");

const {
  hashToken,
  issueTokens,
  setCookies,
  clearCookies,
} = require("../utils/session");

const GOOGLE_STATE_COOKIE = "googleOAuthState";
const googleCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Lax",
  path: "/api/auth/google/callback",
  maxAge: 10 * 60 * 1000,
});

const createGoogleOAuthClient = () =>
  new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL,
  );

//Begin the Google sign-in flow
const googleOAuthStart = (req, res) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } =
    process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
    return res
      .status(503)
      .json({ message: "Google sign-in is not configured" });
  }

  const state = crypto.randomBytes(32).toString("hex");
  res.cookie(GOOGLE_STATE_COOKIE, state, googleCookieOptions());
  const url = createGoogleOAuthClient().generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
  });
  return res.redirect(url);
};

//Callback
const googleOAuthCallback = async (req, res) => {
  try {
    const state = req.query?.state;
    const savedState = req.cookies?.[GOOGLE_STATE_COOKIE];
    res.clearCookie(GOOGLE_STATE_COOKIE, googleCookieOptions());

    if (
      typeof state !== "string" ||
      typeof savedState !== "string" ||
      state !== savedState
    ) {
      return res
        .status(400)
        .send("Google sign-in could not be verified. Please try again.");
    }

    if (req.query?.error) {
      return res.status(401).send("Google sign-in was cancelled or denied.");
    }

    if (typeof req.query?.code !== "string") {
      return res.status(400).send("Google did not return an authorization code.");
    }

    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } =
      process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
      return res.status(503).send("Google sign-in is not configured.");
    }

    const oauthClient = createGoogleOAuthClient();
    const { tokens } = await oauthClient.getToken({
      code: req.query.code,
      redirect_uri: GOOGLE_CALLBACK_URL,
    });

    if (!tokens.id_token) {
      return res.status(401).send("Google did not return a valid identity.");
    }

    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const googleUser = ticket.getPayload();

    if (
      !googleUser?.sub ||
      !googleUser.email ||
      googleUser.email_verified !== true
    ) {
      return res.status(401).send("A verified Google email is required.");
    }

    if (!process.env.CLIENT_URL) {
      return res.status(503).send("Storefront URL is not configured.");
    }

    const email = emailValue(googleUser.email);
    const provider = "google";
    let user;

    // The provider identity is stable even if the Google account email changes.
    const linkedProvider = await UserAuthProvider.findOne({
      provider,
      providerUserId: googleUser.sub,
    });

    if (linkedProvider) {
      user = await User.findById(linkedProvider.user).select("+sessionId");
      if (!user) {
        return res.status(409).send("The linked account could not be found.");
      }
    } else {
      // A verified Google email may link to an existing customer account.
      user = await User.findOne({ email }).select("+sessionId");

      if (user && user.role !== "Customer") {
        return res
          .status(403)
          .send("This Google account cannot be used to sign in as a customer.");
      }

      if (!user) {
        const fullName =
          typeof googleUser.name === "string" ? googleUser.name.trim() : "";
        const nameParts = fullName.split(/\s+/).filter(Boolean);
        const firstName =
          (typeof googleUser.given_name === "string" &&
            googleUser.given_name.trim()) ||
          nameParts[0] ||
          "Google";
        const lastName =
          (typeof googleUser.family_name === "string" &&
            googleUser.family_name.trim()) ||
          nameParts.slice(1).join(" ") ||
          "User";

        // The current user schema requires a password. This random value cannot
        // be used by the customer to sign in and is stored only as a hash.
        const unusablePassword = crypto.randomBytes(48).toString("base64url");
        try {
          user = await User.create({
            firstName,
            lastName,
            email,
            password: await bcrypt.hash(unusablePassword, 12),
            role: "Customer",
            isVerified: true,
          });
          await notifyUser(user._id, "Thank you for registering.", "signup");
        } catch (error) {
          if (error.code !== 11000) throw error;

          // Another first sign-in may have created this email in parallel.
          user = await User.findOne({ email }).select("+sessionId");
          if (!user || user.role !== "Customer") {
            return res
              .status(409)
              .send("An account already exists with this Google email.");
          }

          if (!user.isVerified) {
            user.isVerified = true;
            await User.updateOne(
              { _id: user._id },
              {
                $set: { isVerified: true },
                $unset: {
                  verificationToken: 1,
                  verificationTokenExpiry: 1,
                },
              },
            );
          }
        }
      } else if (!user.isVerified) {
        // Google has verified ownership of this email address.
        user.isVerified = true;
        await User.updateOne(
          { _id: user._id },
          {
            $set: { isVerified: true },
            $unset: {
              verificationToken: 1,
              verificationTokenExpiry: 1,
            },
          },
        );
      }

      try {
        await UserAuthProvider.create({
          user: user._id,
          provider,
          providerUserId: googleUser.sub,
        });
      } catch (error) {
        if (error.code !== 11000) throw error;

        // Another callback may have linked this provider identity concurrently.
        const racedProvider = await UserAuthProvider.findOne({
          provider,
          providerUserId: googleUser.sub,
        });
        if (!racedProvider || String(racedProvider.user) !== String(user._id)) {
          return res
            .status(409)
            .send("This Google account is linked to a different user.");
        }
      }
    }

    if (user.role !== "Customer") {
      return res
        .status(403)
        .send("This Google account cannot be used to sign in as a customer.");
    }

    // As in password login, keep an already active session for this same user.
    if (req.cookies?.accessToken) {
      let currentSession;
      try {
        currentSession = jwt.verify(
          req.cookies.accessToken,
          process.env.JWT_SECRET,
          { algorithms: ["HS256"] },
        );
      } catch {
        // Expired or invalid cookies can be replaced with a fresh session.
      }

      if (
        currentSession?.id === String(user._id) &&
        currentSession.sid === user.sessionId
      ) {
        return res.redirect(new URL("/", process.env.CLIENT_URL).toString());
      }
    }

    // Match password login's one-customer-session policy and refresh-token storage.
    const sessionTokens = issueTokens(user);
    const sessionResult = await User.updateOne(
      { _id: user._id },
      {
        $set: {
          sessionId: sessionTokens.sessionId,
          refreshTokenHash: hashToken(sessionTokens.refreshToken),
        },
      },
    );

    if (sessionResult.matchedCount !== 1) {
      return res.status(401).send("Google sign-in failed. Please try again.");
    }

    setCookies(res, sessionTokens);
    await notifyUser(user._id, "You have successfully logged in.", "login");

    return res.redirect(new URL("/", process.env.CLIENT_URL).toString());
  } catch (error) {
    console.error("Google OAuth callback failed:", error.message);
    return res.status(500).send("Google sign-in failed. Please try again.");
  }
};

// Register User
// Create customer accounts;
// callers cannot assign roles or verification status.
const registerUser = asyncHandler(async (req, res) => {
  const { firstName, lastName, phone, password } = req.body;

  const email = emailValue(req.body.email);

  // Validate name and phone.
  if (
    ![firstName, lastName, phone].every(
      (value) => typeof value === "string" && value.trim(),
    )
  ) {
    throw fail(400, "Name and phone are required.");
  }

  // Validate password.
  if (!passwordValid(password)) {
    throw fail(
      400,
      "Use a strong password of at least 8 characters (maximum 72 bytes).",
    );
  }

  // Prevent duplicate accounts.
  const existingUser = await User.findOne({
    $or: [{ email }, { phone: phone.trim() }],
  });

  if (existingUser) {
    throw fail(409, "Account already exists. Sign in or resend verification.");
  }

  // Generate email verification token.
  const token = crypto.randomBytes(32).toString("hex");

  // Create user.
  const newUser = await User.create({
    firstName,
    lastName,
    email,
    phone: phone.trim(),
    password: await bcrypt.hash(password, 12),
    verificationToken: hashToken(token),
    verificationTokenExpiry: new Date(Date.now() + 30 * 60 * 1000),
  });

  // Create signup notification.
  await notifyUser(newUser._id, "Thank you for registering.", "signup");

  // Send verification email.
  try {
    await sendVerificationEmail(email, token);
  } catch {
    return res.status(201).json({
      message:
        "Account created, but verification email could not be sent. Please resend verification.",
      verificationEmailSent: false,
    });
  }

  res.status(201).json({
    message: "Account created. Please verify your email.",
    verificationEmailSent: true,
  });
});

// Login User
// Issue a one-hour access token and a seven-day,
// database-backed refresh token.
const loginUser = asyncHandler(async (req, res) => {
  const email = emailValue(req.body.email);
  const { password } = req.body;

  // Validate password input.
  if (
    typeof password !== "string" ||
    !password ||
    Buffer.byteLength(password) > 72
  ) {
    throw fail(400, "Password is required and must not exceed 72 bytes.");
  }

  // Find user and explicitly retrieve protected authentication fields.
  const user = await User.findOne({
    email,
    role: "Customer",
  }).select("+password +sessionId");

  // Validate credentials.
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw fail(401, "Invalid credentials. Please try again.");
  }

  // Prevent unverified users from signing in.
  if (!user.isVerified) {
    throw fail(403, "Please verify your email before signing in.");
  }

  // Ignore expired cookies, but do not replace
  // an already valid session accidentally.
  if (req.cookies?.accessToken) {
    let existing;

    try {
      existing = jwt.verify(req.cookies.accessToken, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      // An expired cookie is safe to replace.
    }

    if (existing?.id === String(user._id) && existing.sid === user.sessionId) {
      throw fail(400, "You are already logged in.");
    }
  }

  // Generate access and refresh tokens.
  const tokens = issueTokens(user);

  // Store the new session and hashed refresh token.
  await User.updateOne(
    {
      _id: user._id,
    },
    {
      $set: {
        sessionId: tokens.sessionId,
        refreshTokenHash: hashToken(tokens.refreshToken),
      },
    },
  );

  // Set authentication cookies.
  setCookies(res, tokens);

  // Create login notification.
  await notifyUser(user._id, "You have successfully logged in.", "login");

  res.status(200).json({
    message: "Sign in successful",
    user: {
      id: user._id,
      email: user.email,
      role: user.role || "Customer",
    },
  });
});

// Refresh Session
// Rotate refresh tokens atomically
// so a token cannot be redeemed twice.
const refreshSession = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;

  let decoded;

  // Verify refresh token.
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
      algorithms: ["HS256"],
    });
  } catch {
    clearCookies(res);

    throw fail(401, "Invalid or expired refresh token.");
  }

  // Validate token payload.
  if (!objectId(decoded.id) || typeof decoded.sid !== "string") {
    throw fail(401, "Invalid session.");
  }

  // Match the refresh token against the stored session.
  const filter = {
    _id: decoded.id,
    sessionId: decoded.sid,
    refreshTokenHash: hashToken(token),
    isVerified: true,
    role: "Customer",
  };

  const user = await User.findOne(filter);

  // Session no longer exists.
  if (!user) {
    clearCookies(res);

    throw fail(401, "Session has ended.");
  }

  // Generate a new token pair while retaining the session ID.
  const tokens = issueTokens(user, decoded.sid);

  // Atomically replace the stored refresh token.
  const result = await User.updateOne(filter, {
    $set: {
      refreshTokenHash: hashToken(tokens.refreshToken),
    },
  });

  // Prevent refresh token reuse.
  if (result.modifiedCount !== 1) {
    throw fail(401, "Refresh token already used.");
  }

  // Set the rotated authentication cookies.
  setCookies(res, tokens);

  res.json({
    message: "Session refreshed.",
  });
});

// Logout User

// Revocation affects access tokens as well as refresh tokens
// through sessionId.
const logoutUser = asyncHandler(async (req, res) => {
  const cookies = [
    ["refreshToken", process.env.JWT_REFRESH_SECRET],
    ["accessToken", process.env.JWT_SECRET],
  ];

  for (const [cookie, secret] of cookies) {
    let decoded;

    try {
      decoded = jwt.verify(req.cookies?.[cookie], secret, {
        algorithms: ["HS256"],
      });
    } catch {
      continue;
    }

    if (objectId(decoded.id) && typeof decoded.sid === "string") {
      await User.updateOne(
        {
          _id: decoded.id,
          sessionId: decoded.sid,
        },
        {
          $unset: {
            sessionId: 1,
            refreshTokenHash: 1,
          },
        },
      );
    }
  }

  // Remove authentication cookies.
  clearCookies(res);

  res.json({
    message: "Logout successful.",
  });
});

// Check Login
const checkLogin = (req, res) => {
  res.json({
    isLoggedIn: true,
    userId: req.userId,
    user: {
      id: req.userId,
      email: req.user.email,
      role: req.user.role || "Customer",
    },
  });
};

// Exports

module.exports = {
  googleOAuthStart,
  googleOAuthCallback,
  registerUser,
  loginUser,
  refreshSession,
  logoutUser,
  checkLogin,
};
