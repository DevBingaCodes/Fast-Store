const mongoose = require("mongoose");

const userAuthProviderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 50,
    },
    providerUserId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
  },
  { timestamps: true },
);

// A provider account can only be linked once, while users can link multiple providers.
userAuthProviderSchema.index(
  { provider: 1, providerUserId: 1 },
  { unique: true },
);

module.exports = mongoose.model("UserAuthProvider", userAuthProviderSchema);
