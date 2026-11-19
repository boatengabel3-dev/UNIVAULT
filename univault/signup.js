let mode = "up";

async function redirectAfterAuth(userId) {
  const go = (dest, label) => {
    if (typeof uvTransition !== "undefined") {
      uvTransition.go(dest, label);
    } else {
      location.replace(dest);
    }
  };
  if (!userId) return go("app.html", "Opening UniVault...");
  try {
    const { data: adm } = await sb
      .from("admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    go(adm ? "admin.html" : "app.html", adm ? "Opening Admin Console..." : "Opening UniVault...");
  } catch {
    go("app.html", "Opening UniVault...");
  }
}

$("#tgl").onclick = (e) => {
  e.preventDefault();
  mode = mode === "up" ? "in" : "up";
  $("#ttl").textContent = mode === "up" ? "Create your vault" : "Welcome back";
  $("#name").hidden = mode === "in";
  $("#go").textContent = mode === "up" ? "Sign up" : "Sign in";
  $("#tgl").textContent =
    mode === "up" ? "Have an account? Sign in" : "New here? Sign up";
};

$("#f").onsubmit = async (e) => {
  e.preventDefault();
  $("#msg").textContent = "";
  const email = $("#em").value.trim();
  const password = $("#pw").value;
  const r =
    mode === "up"
      ? await sb.auth.signUp({
          email,
          password,
          options: { data: { full_name: $("#name").value.trim() } },
        })
      : await sb.auth.signInWithPassword({ email, password });

  if (r.error) {
    $("#msg").textContent = r.error.message;
    return;
  }

  if (r.data.session) {
    await redirectAfterAuth(r.data.session.user?.id);
  } else {
    $("#msg").textContent = "Check your email to confirm, then sign in.";
  }
};

document.onmousemove = (e) => {
  const x = e.clientX / innerWidth - 0.5;
  const y = e.clientY / innerHeight - 0.5;
  const tilt = $(".tilt");
  if (tilt) tilt.style.transform = `rotateY(${x * 18}deg) rotateX(${-y * 18}deg)`;
  document
    .querySelectorAll(".cube")
    .forEach((c, i) => (c.style.translate = `${x * (30 + i * 25)}px ${y * (30 + i * 25)}px`));
};

sb.auth.getSession().then(({ data }) => {
  if (data?.session) {
    redirectAfterAuth(data.session.user?.id);
  }
});
