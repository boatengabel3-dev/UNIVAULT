const urlParams = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const authFlowType = hashParams.get("type") || urlParams.get("type") || "";
const urlAuthError =
  hashParams.get("error_description") ||
  urlParams.get("error_description") ||
  hashParams.get("error") ||
  urlParams.get("error") ||
  "";

const tokenHash = urlParams.get("token_hash") || "";

let mode = urlParams.get("mode") === "up" ? "up" : "in";
let isSubmitting = false;
let isRedirecting = false;
let isRecoveryMode = authFlowType === "recovery" && !urlAuthError;
let lastPendingEmail = "";

function getRedirectBaseUrl() {
  return `${location.origin}/signup.html?mode=in`;
}

function getSafeNextUrl() {
  try {
    const raw = urlParams.get("next") || "";
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (/^(?:\/(?!\/)|app\.html(?:\?|#|$))/.test(trimmed)) {
      return trimmed;
    }
  } catch {}
  return "";
}

function setMsg(text, isOk = false) {
  const m = $("#msg");
  if (!m) return;
  m.textContent = text || "";
  m.classList.toggle("ok", Boolean(isOk));
}

function setRecMsg(text, isOk = false) {
  const m = $("#recMsg");
  if (!m) return;
  m.textContent = text || "";
  m.classList.toggle("ok", Boolean(isOk));
}

function showResendButton(email) {
  lastPendingEmail = String(email || "").trim().toLowerCase();
  const btn = $("#resendVerifyBtn");
  if (btn) btn.hidden = !lastPendingEmail;
}

const SAVED_EMAIL_KEY = "uv_saved_email";

function restoreSavedEmail() {
  try {
    const saved = localStorage.getItem(SAVED_EMAIL_KEY) || "";
    if (saved && $("#em") && !$("#em").value) {
      $("#em").value = saved;
    }
    if (saved && $("#recEmail") && !$("#recEmail").value) {
      $("#recEmail").value = saved;
    }
  } catch {}
}

async function saveCredentialsToBrowser(email, password, fullName = "") {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const shouldRemember = $("#rememberCreds") ? $("#rememberCreds").checked : true;
  try {
    if (shouldRemember && cleanEmail) {
      localStorage.setItem(SAVED_EMAIL_KEY, cleanEmail);
    } else if (!shouldRemember) {
      localStorage.removeItem(SAVED_EMAIL_KEY);
    }
  } catch {}

  if (!shouldRemember || !cleanEmail || !password) return;
  if (typeof window.PasswordCredential === "function" && navigator.credentials?.store) {
    try {
      const cred = new window.PasswordCredential({
        id: cleanEmail,
        password,
        name: String(fullName || cleanEmail).trim(),
      });
      await navigator.credentials.store(cred);
    } catch {}
  }
}

function showRecoveryForm(noticeText = "", userEmail = "") {
  isRecoveryMode = true;
  if ($("#f")) $("#f").hidden = true;
  if ($("#recoveryForm")) $("#recoveryForm").hidden = false;
  if ($("#recEmail")) {
    const fallback = (() => {
      try {
        return localStorage.getItem(SAVED_EMAIL_KEY) || "";
      } catch {
        return "";
      }
    })();
    if (userEmail || fallback) $("#recEmail").value = userEmail || fallback;
  }
  if (noticeText) setRecMsg(noticeText, true);
}

function applyMode(nextMode) {
  mode = nextMode === "up" ? "up" : "in";
  const isUp = mode === "up";
  if ($("#tabIn")) {
    $("#tabIn").classList.toggle("on", !isUp);
    $("#tabIn").setAttribute("aria-selected", String(!isUp));
  }
  if ($("#tabUp")) {
    $("#tabUp").classList.toggle("on", isUp);
    $("#tabUp").setAttribute("aria-selected", String(isUp));
  }
  if ($("#ttl")) $("#ttl").textContent = isUp ? "Create your account" : "Sign in to your account";
  if ($("#authSub")) {
    $("#authSub").textContent = isUp
      ? "Register with your name and email to access past papers and AI study tools."
      : "Enter your registered email and password to continue.";
  }
  if ($("#nameGroup")) $("#nameGroup").hidden = !isUp;
  if ($("#name")) {
    $("#name").hidden = !isUp;
    $("#name").required = isUp;
  }
  if ($("#pw")) {
    $("#pw").setAttribute("autocomplete", isUp ? "new-password" : "current-password");
  }
  if ($("#go")) $("#go").textContent = isUp ? "Create account" : "Sign in";
  if ($("#tgl")) {
    $("#tgl").textContent = isUp ? "Already have an account? Sign in" : "New here? Create an account";
  }
  if ($("#forgotPw")) $("#forgotPw").hidden = isUp;
  showResendButton("");
  setMsg("");
}

function saveWelcomeState(user, authMode) {
  const fullName =
    user?.user_metadata?.full_name ||
    $("#name")?.value?.trim() ||
    (user?.email ? user.email.split("@")[0] : "");
  try {
    sessionStorage.setItem(
      "uv_just_signed_in",
      JSON.stringify({
        name: fullName,
        mode: authMode,
        ts: Date.now(),
      })
    );
  } catch {}
  return fullName;
}

function appendWelcomeParam(dest, authMode) {
  try {
    const u = new URL(dest, location.href);
    u.searchParams.set("welcome", authMode === "up" ? "new" : "back");
    return u.pathname.replace(/^\//, "") + u.search + u.hash;
  } catch {
    return dest;
  }
}

async function redirectAfterAuth(user, authMode = null) {
  if (isRedirecting || isRecoveryMode) return;
  isRedirecting = true;
  const userId = user?.id;
  const nextUrl = getSafeNextUrl();
  const useDirectNav =
    window.innerWidth < 860 ||
    (window.matchMedia && window.matchMedia("(hover: none)").matches);

  const go = (dest, label) => {
    const finalDest = authMode ? appendWelcomeParam(dest, authMode) : dest;
    if (!useDirectNav && typeof uvTransition !== "undefined") {
      uvTransition.go(finalDest, label);
    } else {
      location.replace(finalDest);
    }
  };

  if (!userId) return go(nextUrl || "app.html", "Opening UniVault...");
  try {
    const { data: adm } = await sb
      .from("admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (nextUrl && !adm) {
      return go(nextUrl, "Opening shared past paper...");
    }
    go(
      adm ? "admin.html" : (nextUrl || "app.html"),
      adm ? "Opening Admin Console..." : "Opening UniVault..."
    );
  } catch {
    go(nextUrl || "app.html", "Opening UniVault...");
  }
}

if ($("#tabIn")) $("#tabIn").onclick = () => applyMode("in");
if ($("#tabUp")) $("#tabUp").onclick = () => applyMode("up");
if ($("#tgl")) {
  $("#tgl").onclick = (e) => {
    e.preventDefault();
    applyMode(mode === "up" ? "in" : "up");
  };
}

function bindPwToggle(btnSel, inputSel) {
  const btn = $(btnSel), inp = $(inputSel);
  if (!btn || !inp) return;
  btn.onclick = () => {
    const hidden = inp.type === "password";
    inp.type = hidden ? "text" : "password";
    btn.textContent = hidden ? "Hide" : "Show";
    btn.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  };
}
bindPwToggle("#togglePw", "#pw");
bindPwToggle("#toggleNewPw", "#newPw");

if ($("#resendVerifyBtn")) {
  $("#resendVerifyBtn").onclick = async () => {
    const email = lastPendingEmail || $("#em").value.trim().toLowerCase();
    if (!email) return;
    $("#resendVerifyBtn").disabled = true;
    setMsg("Resending verification email...", true);
    try {
      const { error } = await sb.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: getRedirectBaseUrl() },
      });
      if (error) {
        setMsg(error.message);
      } else {
        setMsg(`Verification link re-sent to ${email}. Check Inbox and Spam.`, true);
      }
    } catch (err) {
      setMsg(err?.message || "Could not resend verification email.");
    } finally {
      $("#resendVerifyBtn").disabled = false;
    }
  };
}

if ($("#forgotPw")) {
  $("#forgotPw").onclick = async () => {
    const email = $("#em").value.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMsg("Enter a valid email address above first, then tap Forgot password.");
      $("#em").focus();
      return;
    }
    if (!isValidSupabaseUrl || typeof sb?.auth?.resetPasswordForEmail !== "function") {
      setMsg("Password reset is unavailable until Supabase is configured.");
      return;
    }
    $("#forgotPw").disabled = true;
    setMsg("Sending password reset link...", true);
    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/signup.html?type=recovery`,
      });
      if (error) {
        if (/rate limit/i.test(error.message)) {
          setMsg("Too many reset emails requested recently. Wait an hour or configure Custom SMTP in Supabase.");
        } else if (/error sending recovery email/i.test(error.message)) {
          setMsg("Supabase failed to send the recovery email. Reset your Reset Password email template to default or configure Custom SMTP in Supabase (built-in email is limited to 2/hour).");
        } else {
          setMsg(error.message);
        }
      } else {
        setMsg(
          `Password reset email sent to ${email}. Check Inbox and Spam, then open the link on this site.`,
          true
        );
      }
    } catch (err) {
      setMsg(err?.message || "Could not send password reset link.");
    } finally {
      $("#forgotPw").disabled = false;
    }
  };
}

if ($("#recoveryForm")) {
  $("#recoveryForm").onsubmit = async (e) => {
    e.preventDefault();
    const p1 = $("#newPw")?.value || "";
    const p2 = $("#confirmNewPw")?.value || "";
    if (p1.length < 6) {
      setRecMsg("Password must be at least 6 characters.");
      return;
    }
    if (p1 !== p2) {
      setRecMsg("Passwords do not match.");
      return;
    }
    $("#saveNewPwBtn").disabled = true;
    setRecMsg("Updating your password...", true);
    try {
      const { data, error } = await sb.auth.updateUser({ password: p1 });
      if (error) {
        setRecMsg(error.message);
        return;
      }
      isRecoveryMode = false;
      const u = data?.user;
      const recEmail = u?.email || $("#recEmail")?.value || "";
      if (recEmail) await saveCredentialsToBrowser(recEmail, p1, u?.user_metadata?.full_name || "");
      if (u) saveWelcomeState(u, "in");
      setRecMsg("Password updated! Signing you into UniVault...", true);
      setTimeout(() => {
        if (u) {
          redirectAfterAuth(u, "in");
        } else {
          location.replace("signup.html?mode=in");
        }
      }, 650);
    } catch (err) {
      setRecMsg(err?.message || "Could not update password. Request a new reset link.");
    } finally {
      $("#saveNewPwBtn").disabled = false;
    }
  };
}

applyMode(mode);
restoreSavedEmail();

if (urlAuthError) {
  setMsg(
    decodeURIComponent(urlAuthError.replace(/\+/g, " ")) +
      " Request a new verification or password reset email below."
  );
} else if (isRecoveryMode) {
  showRecoveryForm();
} else if (authFlowType === "signup" || authFlowType === "email") {
  setMsg("Email verified! Opening your vault...", true);
}

$("#f").onsubmit = async (e) => {
  e.preventDefault();
  if (isSubmitting) return;
  setMsg("");
  showResendButton("");

  if (!isValidSupabaseUrl) {
    setMsg("Supabase is not configured. Check your environment settings.");
    return;
  }

  const email = $("#em").value.trim().toLowerCase();
  const password = $("#pw").value;
  const fullName = $("#name")?.value.trim() || "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMsg("Please enter a valid email address.");
    $("#em").focus();
    return;
  }
  if (!password || password.length < 6) {
    setMsg("Password must be at least 6 characters.");
    $("#pw").focus();
    return;
  }
  if (mode === "up" && fullName.length < 2) {
    setMsg("Please enter your full name.");
    $("#name").focus();
    return;
  }

  $("#em").value = email;
  isSubmitting = true;
  if ($("#go")) {
    $("#go").disabled = true;
    $("#go").textContent = mode === "up" ? "Creating account..." : "Signing in...";
  }

  try {
    const r =
      mode === "up"
        ? await sb.auth.signUp({
            email,
            password,
            options: {
              data: { full_name: fullName },
              emailRedirectTo: getRedirectBaseUrl(),
            },
          })
        : await sb.auth.signInWithPassword({ email, password });

    if (r.error) {
      if (mode === "in" && /email not confirmed/i.test(r.error.message)) {
        setMsg(
          "Your email is not verified yet. Check your inbox for the verification link or tap Resend below."
        );
        showResendButton(email);
      } else if (mode === "in" && /invalid login credentials/i.test(r.error.message)) {
        setMsg("Incorrect email or password. Check your password or create a new account.");
      } else if (mode === "up" && /already registered/i.test(r.error.message)) {
        setMsg("That email already has an account. Switch to Sign in above.");
      } else {
        setMsg(r.error.message);
      }
      return;
    }

    await saveCredentialsToBrowser(
      email,
      password,
      fullName || r.data?.user?.user_metadata?.full_name || ""
    );

    if (r.data?.session) {
      const signedInName = saveWelcomeState(r.data.session.user, mode);
      setMsg(
        mode === "up"
          ? `Welcome to UniVault${signedInName ? ", " + signedInName : ""}! Opening your vault...`
          : `Welcome back${signedInName ? ", " + signedInName : ""}! Signing you in...`,
        true
      );
      await redirectAfterAuth(r.data.session.user, mode);
    } else {
      const rememberNote = $("#rememberCreds")?.checked
        ? " Your email is saved for next time (accept your browser's Save Password prompt if shown)."
        : "";
      setMsg(
        `Verification email sent to ${email}! Open the link in your email to verify and sign in.${rememberNote}`,
        true
      );
      showResendButton(email);
    }
  } catch (err) {
    setMsg(err?.message || "Could not reach the sign-in service. Please try again.");
  } finally {
    isSubmitting = false;
    if ($("#go") && !isRedirecting) {
      $("#go").disabled = false;
      $("#go").textContent = mode === "up" ? "Create account" : "Sign in";
    }
  }
};

function resolveAuthFlow() {
  return authFlowType === "signup" || authFlowType === "email" ? "up" : null;
}

if (typeof sb?.auth?.onAuthStateChange === "function") {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      showRecoveryForm("Reset link verified! Enter your new password below.");
      return;
    }
    if (event === "SIGNED_IN" && session && !isRecoveryMode && !isSubmitting) {
      const flow = resolveAuthFlow();
      if (flow) saveWelcomeState(session.user, flow);
      redirectAfterAuth(session.user, flow);
    }
  });
}

(async () => {
  if (urlAuthError) return;

  const pkceCode = urlParams.get("code");
  if (tokenHash && authFlowType && typeof sb?.auth?.verifyOtp === "function") {
    try {
      const { error: otpErr } = await sb.auth.verifyOtp({
        token_hash: tokenHash,
        type: authFlowType,
      });
      if (otpErr) {
        if (isRecoveryMode) {
          showRecoveryForm();
          setRecMsg(otpErr.message + " Request a new reset link on the sign-in page.");
        } else {
          setMsg(otpErr.message);
        }
      }
    } catch (err) {
      if (isRecoveryMode) {
        showRecoveryForm();
        setRecMsg(err?.message || "Could not verify reset link.");
      } else {
        setMsg(err?.message || "Could not verify link.");
      }
    }
  } else if (pkceCode && typeof sb?.auth?.exchangeCodeForSession === "function") {
    try {
      const { error: exErr } = await sb.auth.exchangeCodeForSession(pkceCode);
      if (exErr) {
        if (isRecoveryMode) {
          showRecoveryForm();
          setRecMsg(
            "This reset link could not verify here. Open the link in the same browser where you requested it, or request a new reset email."
          );
        } else {
          setMsg(exErr.message);
        }
      }
    } catch (err) {
      setMsg(err?.message || "Could not complete sign-in.");
    }
  }

  const { data } = await sb.auth.getSession();
  if (isRecoveryMode) {
    showRecoveryForm(
      data?.session ? "Reset link verified! Enter your new password below." : "",
      data?.session?.user?.email || ""
    );
    if (!data?.session && !$("#recMsg")?.textContent) {
      setRecMsg(
        "Reset session not found or expired. Open the reset link in the same browser you requested it from, or request a new one."
      );
    }
    return;
  }
  if (data?.session && !isSubmitting) {
    const flow = resolveAuthFlow();
    if (flow) saveWelcomeState(data.session.user, flow);
    redirectAfterAuth(data.session.user, flow);
  }
})();
