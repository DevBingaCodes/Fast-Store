import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, endpoint, errorMessage } from "../api";
import Footer from "../components/Footer";
import { safeReturnPath } from "../utils/navigation";
import { useStore } from "../store/context";

const inputClass =
  "h-11 w-full rounded-sm border bg-surface-container-lowest px-3.5 text-on-surface placeholder:text-outline focus:border-primary-container focus:ring-2 focus:ring-primary-container/20 disabled:opacity-60";

export default function Login() {
  const { session, login } = useStore();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedReturnTo = location.state?.returnTo;
  const returnTo = safeReturnPath(requestedReturnTo);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);

  const locked = useRef(false);
  const alertRef = useRef(null);

  const handleGoogleLogin = () => {
    window.location.assign(`${endpoint}/api/auth/google`);
  };

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Sign in — FastStore";

    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  if (session.status === "authenticated") {
    return <Navigate to={returnTo} replace />;
  }

  function resetFeedback() {
    setFailure(null);
    setMessage("");
    setErrors({});
  }

  async function submit(event) {
    event.preventDefault();

    if (locked.current || session.status === "checking") return;

    const nextErrors = {};
    const normalizedEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      nextErrors.email = "Enter a valid email address.";
    }

    // Login accepts existing passwords; registration's strength rules do not apply here.
    if (!password || new TextEncoder().encode(password).length > 72) {
      nextErrors.password = "Enter your password (maximum 72 bytes).";
    }

    resetFeedback();
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length) {
      document.getElementById(`login-${Object.keys(nextErrors)[0]}`)?.focus();
      return;
    }

    locked.current = true;
    setPending(true);

    try {
      await login({ email: normalizedEmail, password });
      setPassword("");
      navigate(returnTo, { replace: true });
    } catch (error) {
      setFailure({
        message: errorMessage(error),
        unverified:
          error.response?.status === 403 &&
          /verify your email/i.test(error.response?.data?.message || ""),
      });
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  async function resend() {
    if (locked.current) return;

    locked.current = true;
    setResending(true);
    setMessage("");

    try {
      const { data } = await api.post("/verify/resend/account/verification", {
        email: email.trim().toLowerCase(),
      });
      setMessage(
        data.message || "If verification is needed, an email will be sent.",
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      locked.current = false;
      setResending(false);
    }
  }

  const disabled = pending || resending || session.status === "checking";

  return (
    <div className="flex min-h-screen flex-col bg-surface font-body-md text-on-surface">
      <header className="border-b border-outline-variant bg-surface-container-lowest">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 py-2 sm:px-8">
          <Link
            to="/"
            className="font-headline-md text-headline-md font-extrabold tracking-tight text-primary"
          >
            FastStore
          </Link>
          <Link
            to="/"
            className="flex items-center gap-1.5 text-label-md text-on-surface-variant hover:text-primary"
          >
            <span
              className="material-symbols-outlined text-[18px]"
              aria-hidden="true"
            >
              arrow_back
            </span>
            Continue browsing
          </Link>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-lg space-y-4">
          {failure && (
            <div
              ref={alertRef}
              tabIndex={-1}
              role="alert"
              className={`rounded-xl border p-4 ${
                failure.unverified
                  ? "border-outline-variant bg-surface-container-high/60"
                  : "border-error/20 bg-error-container/40"
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[20px]"
                >
                  {failure.unverified ? "mail_lock" : "warning"}
                </span>
                <div className="flex-1 space-y-2">
                  <h2 className="font-semibold">
                    {failure.unverified
                      ? "Verification required"
                      : "Unable to continue"}
                  </h2>
                  <p className="text-sm text-on-surface-variant">
                    {failure.message}
                  </p>
                  {failure.unverified && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={resend}
                      className="rounded-sm border border-outline-variant bg-white px-3 py-2 text-sm font-semibold text-primary disabled:opacity-60"
                    >
                      {resending
                        ? "Requesting verification email…"
                        : "Resend verification email"}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss error notice"
                  onClick={() => setFailure(null)}
                  className="p-1"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {message && (
            <p
              role="status"
              className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4 text-sm"
            >
              {message}
            </p>
          )}

          <div className="rounded-md border border-outline-variant bg-surface-container-lowest p-6 sm:p-8">
            <div className="mb-6 text-center">
              <h1 className="font-headline-md text-headline-md font-semibold tracking-tight">
                Sign in to FastStore
              </h1>
              <p className="mt-1.5 text-body-md text-on-surface-variant">
                Access your orders, saved wishlist, and faster checkout.
              </p>
            </div>

            <form onSubmit={submit} noValidate aria-busy={pending}>
              <fieldset disabled={disabled} className="min-w-0 space-y-4">
                <legend className="sr-only">Sign-in details</legend>

                <div className="space-y-1.5">
                  <label
                    htmlFor="login-email"
                    className="block text-label-md font-medium"
                  >
                    Email address
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    name="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      resetFeedback();
                    }}
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    placeholder="name@example.com"
                    aria-invalid={Boolean(errors.email)}
                    aria-describedby={
                      errors.email ? "login-email-error" : undefined
                    }
                    className={`${inputClass} ${errors.email ? "border-error" : "border-outline-variant"}`}
                  />
                  {errors.email && (
                    <p id="login-email-error" className="text-sm text-error">
                      {errors.email}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="login-password"
                      className="text-label-md font-medium"
                    >
                      Password
                    </label>
                    <Link
                      to="/password-reset"
                      className="text-label-sm font-medium text-primary hover:underline"
                    >
                      Forgot password?
                    </Link>
                  </div>
                  <div className="relative">
                    <input
                      id="login-password"
                      name="password"
                      type={visible ? "text" : "password"}
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        resetFeedback();
                      }}
                      placeholder="Enter your password"
                      aria-invalid={Boolean(errors.password)}
                      aria-describedby={
                        errors.password ? "login-password-error" : undefined
                      }
                      className={`${inputClass} pr-12 ${errors.password ? "border-error" : "border-outline-variant"}`}
                    />
                    <button
                      type="button"
                      onClick={() => setVisible((value) => !value)}
                      aria-label={visible ? "Hide password" : "Show password"}
                      aria-pressed={visible}
                      className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-outline"
                    >
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-[20px]"
                      >
                        {visible ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                  </div>
                  {errors.password && (
                    <p id="login-password-error" className="text-sm text-error">
                      {errors.password}
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-sm bg-primary-container px-4 py-2 font-semibold text-white hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {pending && (
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined animate-spin text-[18px]"
                    >
                      progress_activity
                    </span>
                  )}
                  {session.status === "checking"
                    ? "Checking session…"
                    : pending
                      ? "Signing in…"
                      : "Sign in"}
                </button>
              </fieldset>
            </form>

            <div className="my-5 flex items-center gap-3 text-label-sm text-outline">
              <span className="flex-1 border-t border-outline-variant" />
              <span>or</span>
              <span className="flex-1 border-t border-outline-variant" />
            </div>

            <button
              onClick={handleGoogleLogin}
              type="button"
              className="flex min-h-11 w-full items-center justify-center gap-3 rounded-sm border border-outline-variant bg-surface-container-lowest px-4 py-2 font-semibold text-on-surface shadow-sm transition-colors hover:bg-surface-container-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <svg aria-hidden="true" viewBox="0 0 48 48" className="h-5 w-5">
                <path
                  fill="#4285F4"
                  d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z"
                />
                <path
                  fill="#34A853"
                  d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z"
                />
                <path
                  fill="#FBBC05"
                  d="M12.6 27.6a12 12 0 0 1 0-7.2v-5.3H5.8a20 20 0 0 0 0 17.8l6.8-5.3Z"
                />
                <path
                  fill="#EA4335"
                  d="M24 11.9c3 0 5.7 1 7.8 3.1l5.9-5.9A19.7 19.7 0 0 0 24 4 20 20 0 0 0 5.8 15.1l6.8 5.3c1.6-4.9 6.1-8.5 11.4-8.5Z"
                />
              </svg>
              Sign in with Google
            </button>

            <div className="my-6 flex items-center gap-3 text-label-sm text-outline">
              <span className="flex-1 border-t border-outline-variant" />
              <span>New to FastStore?</span>
              <span className="flex-1 border-t border-outline-variant" />
            </div>
            <p className="text-center text-body-md text-on-surface-variant">
              Don’t have an account?{" "}
              <Link
                to="/register"
                className="font-semibold text-primary hover:underline"
              >
                Signup
              </Link>
            </p>
          </div>

          <p className="text-center text-caption text-outline">
            {requestedReturnTo
              ? "After signing in, you’ll return to the page you were viewing."
              : "After signing in, you’ll return to the homepage."}
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
