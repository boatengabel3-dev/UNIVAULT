// Real protection is enforced server-side (RLS, RPCs, and edge functions check the admins table).
let currentSession = null;
let allQuestions = [];
let ovStatusFilter = "all";

function showAdminTab(tab) {
  document.querySelectorAll("main>section").forEach((s) => (s.hidden = s.id !== "av-" + tab));
  document
    .querySelectorAll("header nav button")
    .forEach((b) => b.classList.toggle("on", b.dataset.av === tab));
}

document.querySelectorAll("header nav button").forEach((b) => {
  b.onclick = () => showAdminTab(b.dataset.av);
});

$("#aout").onclick = async () => {
  await sb.auth.signOut();
  location.href = "index.html";
};

(async () => {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) return location.replace("index.html");
  currentSession = session;
  const { data: a } = await sb
    .from("admins")
    .select("user_id")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (!a) return location.replace("app.html");
  document.body.hidden = false;
  await load();
})();

function renderQuestionsOverview() {
  const listEl = $("#allQuestions");
  const filtered =
    ovStatusFilter === "all"
      ? allQuestions
      : allQuestions.filter((q) => q.status === ovStatusFilter);

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="row-item"><div class="row-main"><strong>No ${ovStatusFilter === "all" ? "" : esc(ovStatusFilter) + " "}questions recorded</strong><span>Published and student-submitted papers appear here.</span></div></div>`;
    return;
  }

  listEl.innerHTML = filtered
    .slice(0, 25)
    .map((q) => {
      const cls =
        q.status === "approved"
          ? "st-approved"
          : q.status === "rejected"
            ? "st-rejected"
            : "st-pending";
      const dt = q.created_at ? new Date(q.created_at).toLocaleDateString() : "";
      const desc = q.description ? ` · ${esc(q.description)}` : "";
      return `<div class="row-item"><div class="row-main"><strong>${esc(q.course_code)}${q.course_title ? " — " + esc(q.course_title) : ""}</strong><span>${esc(q.department)} · ${q.year}${q.semester ? " S" + q.semester : ""}${desc}</span></div><div class="row-meta"><span style="color:var(--mut)">${esc(dt)}</span><span class="${cls}">${esc(q.status)}</span></div></div>`;
    })
    .join("");
}

$("#ovFilter").onclick = (e) => {
  const st = e.target?.dataset?.st;
  if (!st) return;
  ovStatusFilter = st;
  document
    .querySelectorAll("#ovFilter button")
    .forEach((b) => b.classList.toggle("on", b.dataset.st === st));
  renderQuestionsOverview();
};

async function load() {
  const [qRes, pRes, profRes, payRes] = await Promise.all([
    sb
      .from("questions")
      .select("*,question_content(content)")
      .order("created_at", { ascending: false }),
    sb.from("payouts").select("*").order("created_at", { ascending: false }),
    sb.from("profiles").select("id,full_name,premium_until,balance"),
    sb.from("payments").select("reference,amount,created_at").order("created_at", { ascending: false }),
  ]);

  allQuestions = qRes.data || [];
  const payouts = pRes.data || [];
  const profiles = profRes.data;
  const payments = payRes.data;

  const pendingQ = allQuestions.filter((x) => x.status === "pending");
  const approvedQ = allQuestions.filter((x) => x.status === "approved");
  const pendingPayouts = payouts.filter((x) => x.status === "pending");

  $("#ovApproved").textContent = String(approvedQ.length);
  $("#ovPending").textContent = String(pendingQ.length);
  $("#ovPayouts").textContent = String(pendingPayouts.length);

  if (Array.isArray(profiles)) {
    const now = new Date();
    const activePrem = profiles.filter(
      (p) => p.premium_until && new Date(p.premium_until) > now
    ).length;
    $("#ovUsers").textContent = String(profiles.length);
    $("#ovPremium").textContent = String(activePrem);
  } else {
    $("#ovUsers").textContent = "Run SQL update";
    $("#ovPremium").textContent = "—";
  }

  if (Array.isArray(payments)) {
    const rev = payments.reduce((sum, item) => sum + (item.amount || 0), 0);
    $("#ovRevenue").textContent = fmt(rev);
  } else {
    $("#ovRevenue").textContent = "—";
  }

  renderQuestionsOverview();

  // Activity feed: recent payouts + payments
  const feedItems = [];
  payouts.slice(0, 10).forEach((x) => {
    feedItems.push({
      title: `Payout · ${fmt(x.amount)} to ${esc(x.account_name || x.momo)}`,
      sub: `${esc(x.network || "")} · ${esc(x.momo || "")}`,
      date: x.created_at,
      status: x.status,
      cls:
        x.status === "paid"
          ? "st-approved"
          : x.status === "failed"
            ? "st-rejected"
            : "st-pending",
    });
  });
  if (Array.isArray(payments)) {
    payments.slice(0, 10).forEach((x) => {
      feedItems.push({
        title: `Subscription · ${fmt(x.amount)}`,
        sub: `Ref ${esc(x.reference)}`,
        date: x.created_at,
        status: "paid",
        cls: "st-approved",
      });
    });
  }
  feedItems.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

  $("#activityFeed").innerHTML =
    feedItems
      .slice(0, 12)
      .map(
        (item) =>
          `<div class="row-item"><div class="row-main"><strong>${item.title}</strong><span>${item.sub}</span></div><div class="row-meta"><span style="color:var(--mut)">${item.date ? new Date(item.date).toLocaleDateString() : ""}</span><span class="${item.cls}">${esc(item.status)}</span></div></div>`
      )
      .join("") ||
    `<div class="row-item"><div class="row-main"><strong>No recent payouts or payments</strong><span>Subscription receipts and Mobile Money withdrawals appear here.</span></div></div>`;

  // Pending moderation cards
  $("#pend").innerHTML =
    pendingQ
      .map(
        (x) =>
          `<article class="card"><small>${esc(x.department)} · ${x.year} S${x.semester || "-"}</small><h3>${esc(x.course_code)}<span>${esc(x.course_title)}</span></h3>${x.description ? `<p style="color:var(--mut);font-size:.86rem;margin-top:6px">${esc(x.description)}</p>` : ""}<pre>${esc(x.question_content?.content)}</pre><div class="chips"><button data-a="approve_question" data-id="${x.id}">Approve (+GH₵3)</button><button class="ghost" data-a="reject_question" data-id="${x.id}">Reject</button></div></article>`
      )
      .join("") || "<p style='color:var(--mut)'>No pending student uploads right now.</p>";

  // Pending payouts cards
  $("#po").innerHTML =
    pendingPayouts
      .map(
        (x) =>
          `<article class="card"><h3>${fmt(x.amount)}</h3><p>${esc(x.account_name)} · ${esc(x.momo)} · ${esc(x.network)}</p><button data-pay="${x.id}" style="margin-top:10px">Send via Paystack</button></article>`
      )
      .join("") || "<p style='color:var(--mut)'>No pending payout requests.</p>";

  // Payout history
  $("#poHistory").innerHTML =
    payouts
      .filter((x) => x.status !== "pending")
      .map((x) => {
        const cls = x.status === "paid" ? "st-approved" : "st-rejected";
        return `<div class="row-item"><div class="row-main"><strong>${fmt(x.amount)} · ${esc(x.account_name)}</strong><span>${esc(x.network)} · ${esc(x.momo)}</span></div><div class="row-meta"><span class="${cls}">${esc(x.status)}</span></div></div>`;
      })
      .join("") ||
    `<div class="row-item"><div class="row-main"><strong>No completed payouts yet</strong></div></div>`;
}

$("#adminUploadForm").onsubmit = async (e) => {
  e.preventDefault();
  const msgEl = $("#amsg");
  msgEl.style.color = "var(--c)";
  msgEl.textContent = "Publishing...";

  const payload = {
    d: $("#ad").value.trim(),
    c: $("#ac").value.trim().toUpperCase(),
    t: $("#at").value.trim(),
    y: +$("#ay").value,
    s: +$("#as").value,
    body: $("#ab").value.trim(),
    descr: $("#adescr").value.trim() || null,
  };

  let { error } = await sb.rpc("admin_publish_question", payload);

  // Fallback if admin_publish_question RPC hasn't been added in Supabase SQL Editor yet
  if (error && /admin_publish_question/i.test(error.message)) {
    const subPayload = {
      d: payload.d,
      c: payload.c,
      t: payload.t,
      y: payload.y,
      s: payload.s,
      body: payload.body,
    };
    const subRes = await sb.rpc("submit_question", subPayload);
    error = subRes.error;
    if (!error) {
      const { data: latest } = await sb
        .from("questions")
        .select("id")
        .eq("uploader", currentSession.user.id)
        .eq("course_code", payload.c)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest?.id) {
        await sb.rpc("approve_question", { qid: latest.id });
      }
    }
  }

  if (error) {
    msgEl.style.color = "#fca5a5";
    msgEl.textContent = error.message;
    return;
  }

  msgEl.style.color = "#6ee7b7";
  msgEl.textContent = `Published ${payload.c} (${payload.y}) to the live archive.`;
  $("#adminUploadForm").reset();
  await load();
};

document.onclick = async (e) => {
  const t = e.target;
  let r;
  if (t.dataset.a) {
    r = await sb.rpc(t.dataset.a, { qid: t.dataset.id });
  } else if (t.dataset.pay) {
    t.disabled = true;
    const { error } = await sb.functions.invoke("admin-payout", {
      body: { id: t.dataset.pay },
    });
    r = { error };
  } else {
    return;
  }
  if (r.error) alert(r.error.message || "Failed");
  await load();
};
