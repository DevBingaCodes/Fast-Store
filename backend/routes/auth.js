const { authUserMiddleware } = require("../middleware/jwt");
const express = require("express");

const {
  loginUser,
  logoutUser,
  registerUser,
  checkLogin,
  refreshSession,
  googleOAuthStart,
  googleOAuthCallback,
} = require("../controllers/auth");

const router = express.Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/logout", logoutUser);
router.get("/check-session", authUserMiddleware, checkLogin);

router.get("/google", googleOAuthStart)
router.get("/google/callback", googleOAuthCallback)
// Exchange a valid refresh cookie for a new token pair.
router.post("/refresh", refreshSession);

module.exports = router;
