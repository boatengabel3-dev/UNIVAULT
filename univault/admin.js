// Real protection is enforced server-side (RLS, RPCs, and edge functions check the admins table).
let currentSession = null;
let allQuestions = [];
let ovStatusFilter = "all";
let adminDupTimer = null;
let adminAttachment = null;
let lastAdminUploadBody = "";

function showAdminTab(tab) {
  const target = document.getElementById("av-" + tab);
  if (!target) return;
  const activeBtn = document.querySelector(`header nav button[data-av="${tab}"]`);
  const label = activeBtn ? `Opening ${activeBtn.textContent}...` : "Loading view...";
  const alreadyVisible = !target.hidden;

  const apply = () => {
    document.querySelectorAll("main>section").forEach((s) => {
      const match = s.id === "av-" + tab;
      s.hidden = !match;
      s.classList.remove("uv-view-enter");
      if (match) {
        void s.offsetWidth;
        s.classList.add("uv-view-enter");
        window.uvRevealReset?.(s);
        window.uvRevealObserve?.(s);
      }
    });
    document
      .querySelectorAll("header nav button")
      .forEach((b) => b.classList.toggle("on", b.dataset.av === tab));
  };

  if (alreadyVisible || typeof uvTransition === "undefined") {
    apply();
  } else {
    uvTransition.tab(apply, label);
  }
}

document.querySelectorAll("header nav button").forEach((b) => {
  b.onclick = () => showAdminTab(b.dataset.av);
});

$("#aout").onclick = async () => {
  await sb.auth.signOut();
  if (typeof uvTransition !== "undefined") {
    uvTransition.go("index.html", "Signing out...");
  } else {
    location.href = "index.html";
  }
};

(async () => {
  try {
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
  } catch (err) {
    if (typeof isInvalidRefreshTokenError === "function" && isInvalidRefreshTokenError(err)) {
      clearStaleSupabaseAuthStorage?.(sb);
    }
    location.replace("index.html");
  } finally {
    window.dispatchEvent(new CustomEvent("uv:rendered"));
  }
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
  window.uvRevealObserve?.(listEl);
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
  const [qRes, pRes, profRes, payRes, testRes, settingsRes] = await Promise.all([
    sb
      .from("questions")
      .select("*,question_content(content)")
      .order("created_at", { ascending: false }),
    sb.from("payouts").select("*").order("created_at", { ascending: false }),
    sb.from("profiles").select("id,full_name,premium_until,balance"),
    sb.from("payments").select("reference,amount,created_at").order("created_at", { ascending: false }),
    sb.from("testimonials").select("*").order("created_at", { ascending: false }),
    sb.from("app_settings").select("price_ghs,free_ai_limit").eq("id", 1).maybeSingle(),
  ]);

  if (settingsRes?.data) {
    if ($("#setPriceGhs")) {
      $("#setPriceGhs").value = String(Number(settingsRes.data.price_ghs) || 30);
    }
    if ($("#setFreeAiLimit")) {
      $("#setFreeAiLimit").value = String(
        settingsRes.data.free_ai_limit !== null && settingsRes.data.free_ai_limit !== undefined
          ? Number(settingsRes.data.free_ai_limit)
          : 5
      );
    }
  } else if (settingsRes?.error && $("#settingsMsg")) {
    $("#settingsMsg").style.color = "var(--warn-ink)";
    $("#settingsMsg").textContent = "Run the app_settings SQL in schema.sql to persist changes.";
  }

  allQuestions = qRes.data || [];
  const payouts = pRes.data || [];
  const profiles = profRes.data;
  const payments = payRes.data;
  const testimonials = testRes.data;

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

  if ($("#pendTestimonials")) {
    if (!Array.isArray(testimonials)) {
      $("#pendTestimonials").innerHTML =
        "<p style='color:var(--mut)'>Run the testimonials SQL in schema.sql to enable moderation.</p>";
    } else if (testimonials.length === 0) {
      $("#pendTestimonials").innerHTML =
        "<p style='color:var(--mut)'>No contributor testimonials submitted yet.</p>";
    } else {
      $("#pendTestimonials").innerHTML = testimonials
        .map(
          (x) =>
            `<article class="card"><small>${x.approved ? "Published" : "Pending review"} · ${x.created_at ? new Date(x.created_at).toLocaleDateString() : ""}</small><h3>${esc(x.author_name)}<span>${esc(x.role)}</span></h3><p style="color:var(--ink);font-size:.9rem;margin-top:10px">“${esc(x.quote)}”</p><div class="chips">${x.approved ? `<button class="ghost" data-tact="hide" data-tid="${x.id}">Unpublish</button>` : `<button data-tact="approve" data-tid="${x.id}">Approve &amp; Publish</button>`}<button class="ghost" data-tact="delete" data-tid="${x.id}">Delete</button></div></article>`
        )
        .join("");
    }
  }

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

  window.uvRevealObserve?.(document.body);
}

if ($("#settingsForm")) {
  $("#settingsForm").onsubmit = async (e) => {
    e.preventDefault();
    const msgEl = $("#settingsMsg");
    const btn = $("#saveSettingsBtn");
    const priceGhs = Number($("#setPriceGhs").value);
    const freeAiLimit = Math.floor(Number($("#setFreeAiLimit").value));

    if (!Number.isFinite(priceGhs) || priceGhs < 1) {
      if (msgEl) {
        msgEl.style.color = "var(--err-ink)";
        msgEl.textContent = "Subscription price must be at least GH₵ 1.";
      }
      return;
    }
    if (!Number.isFinite(freeAiLimit) || freeAiLimit < 0) {
      if (msgEl) {
        msgEl.style.color = "var(--err-ink)";
        msgEl.textContent = "Free AI uses must be 0 or greater.";
      }
      return;
    }

    if (btn) btn.disabled = true;
    if (msgEl) {
      msgEl.style.color = "var(--c)";
      msgEl.textContent = "Saving settings...";
    }
    try {
      const { error } = await sb.from("app_settings").upsert({
        id: 1,
        price_ghs: priceGhs,
        free_ai_limit: freeAiLimit,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        if (msgEl) {
          msgEl.style.color = "var(--err-ink)";
          msgEl.textContent = /app_settings/i.test(error.message)
            ? "Run the new app_settings SQL in schema.sql first, then retry."
            : error.message;
        }
        return;
      }
      if (msgEl) {
        msgEl.style.color = "var(--ok-ink)";
        msgEl.textContent = `Saved: GH₵${priceGhs}/month & ${freeAiLimit} free AI use${freeAiLimit === 1 ? "" : "s"} before Premium.`;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

function showAdminDupBanner(result) {
  const banner = $("#adminDupAlert");
  if (!banner) return;
  if (!result || (!result.duplicate && !result.verifiedMessage)) {
    banner.hidden = true;
    banner.className = "dup-banner";
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  if (result.duplicate) {
    banner.className = "dup-banner is-dup";
    banner.textContent = result.reason || "This past question already exists in UniVault.";
  } else {
    banner.className = "dup-banner is-ok";
    banner.textContent = result.verifiedMessage;
  }
}

async function runAdminDupCheck(showClear = false) {
  if (!currentSession?.access_token) return { duplicate: false };
  const normCode = window.uvFileTools
    ? window.uvFileTools.normCourseCode($("#ac").value).canonical
    : $("#ac").value.trim().toUpperCase();
  const payload = {
    department: $("#ad").value.trim(),
    courseCode: normCode,
    year: $("#ay").value ? Number($("#ay").value) : null,
    semester: $("#as").value ? Number($("#as").value) : null,
    bodyText: $("#ab").value.trim(),
  };

  // Local instant check against loaded allQuestions first
  const compact = normCode.replace(/[^A-Z0-9]/g, "");
  if (compact && payload.year) {
    const match = allQuestions.find((q) => {
      if (q.status === "rejected") return false;
      const qKey = String(q.course_code || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      return (
        qKey === compact &&
        Number(q.year) === payload.year &&
        (!payload.semester || !q.semester || Number(q.semester) === payload.semester)
      );
    });
    if (match) {
      const localDup = {
        duplicate: true,
        reason: `Duplicate past question detected: ${match.course_code} (${match.year}${match.semester ? " Sem " + match.semester : ""}) already exists (${match.status}).`,
      };
      showAdminDupBanner(localDup);
      return localDup;
    }
  }

  try {
    const dupRes = await fetch("/api/check-duplicate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentSession.access_token}`,
      },
      body: JSON.stringify(payload),
    });
    if (dupRes.ok) {
      const dup = await dupRes.json();
      if (dup.duplicate) {
        showAdminDupBanner(dup);
        return dup;
      }
      if (showClear && (compact || payload.bodyText.length >= 30)) {
        showAdminDupBanner({
          duplicate: false,
          verifiedMessage: `Normalized check passed (${dup.normalizedCode || normCode || "ready"}): no duplicate past question found.`,
        });
      } else {
        showAdminDupBanner(null);
      }
      return dup;
    }
  } catch {}
  if (showClear) showAdminDupBanner(null);
  return { duplicate: false };
}

function scheduleAdminDupCheck() {
  if (adminDupTimer) clearTimeout(adminDupTimer);
  adminDupTimer = setTimeout(() => runAdminDupCheck(false), 450);
}

["#ac", "#ay", "#as", "#ab"].forEach((sel) => {
  const node = $(sel);
  if (node) {
    node.addEventListener("input", scheduleAdminDupCheck);
    node.addEventListener("change", scheduleAdminDupCheck);
  }
});

function clearAdminPreview(resetExtractedBody = true) {
  if ($("#adminUploadFile")) $("#adminUploadFile").value = "";
  window.uvFileTools?.renderUploadPreview($("#adminUploadPreview"), null);
  if ($("#adminFileStatus")) {
    $("#adminFileStatus").textContent =
      "Client-side PDF & Image OCR + Gemini AI extraction & duplicate normalization check.";
  }
  if (resetExtractedBody && lastAdminUploadBody && $("#ab")?.value === lastAdminUploadBody) {
    $("#ab").value = "";
  }
  lastAdminUploadBody = "";
  adminAttachment = null;
  if ($("#adminExplainBar")) $("#adminExplainBar").hidden = true;
  if ($("#adminExplainOut")) $("#adminExplainOut").hidden = true;
  showAdminDupBanner(null);
}

if ($("#adminUploadFile")) {
  $("#adminUploadFile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const stEl = $("#adminFileStatus");
    if (stEl) stEl.textContent = `Starting client-side reader for "${file.name}"...`;
    window.uvFileTools?.renderUploadPreview($("#adminUploadPreview"), null);
    showAdminDupBanner(null);
    if ($("#adminExplainOut")) $("#adminExplainOut").hidden = true;

    try {
      if (!window.uvFileTools?.processFile) {
        throw new Error("OCR reader script failed to load.");
      }
      const data = await window.uvFileTools.processFile(file, (msg) => {
        if (stEl) stEl.textContent = msg;
      });
      adminAttachment = data;

      const formattedBody =
        data.transcript && data.transcript !== data.extractedText
          ? `${data.extractedText}\n\n[Transcript]\n${data.transcript}`
          : data.extractedText || data.transcript || "";
      if (formattedBody) {
        $("#ab").value = formattedBody;
        lastAdminUploadBody = formattedBody;
      }

      const meta = data.metadata || {};
      if (meta.department && !$("#ad").value.trim()) $("#ad").value = meta.department;
      if (meta.course_code && !$("#ac").value.trim()) $("#ac").value = meta.course_code;
      if (meta.course_title && !$("#at").value.trim()) $("#at").value = meta.course_title;
      if (meta.year && !$("#ay").value.trim()) $("#ay").value = String(meta.year);
      if ((meta.semester === 1 || meta.semester === 2) && $("#as")) {
        $("#as").value = String(meta.semester);
      }
      if (meta.description && $("#adescr") && !$("#adescr").value.trim()) {
        $("#adescr").value = meta.description;
      }

      window.uvFileTools.renderUploadPreview($("#adminUploadPreview"), data, () =>
        clearAdminPreview(true)
      );

      if ($("#adminExplainBar")) {
        $("#adminExplainBar").hidden = false;
        $("#adminAttachName").textContent = `${data.fileName} (${data.mediaType === "audio" ? "Audio Transcript" : data.mediaType === "video" ? "Video Transcript & Frames" : data.ocrUsed ? "Client OCR + Document" : "Written Document"})`;
        $("#adminAttachSummary").textContent =
          data.summary || "Extracted material ready for review or AI explanation.";
        const qSel = $("#adminDetectedQ");
        if (qSel) {
          const qs = Array.isArray(data.questionsDetected) ? data.questionsDetected : [];
          if (qs.length > 0) {
            qSel.hidden = false;
            qSel.innerHTML =
              '<option value="">Explain full material / overview</option>' +
              qs
                .map(
                  (q, i) =>
                    `<option value="${esc(q)}">Q${i + 1}: ${esc(q.slice(0, 75))}${q.length > 75 ? "..." : ""}</option>`
                )
                .join("");
          } else {
            qSel.hidden = true;
            qSel.innerHTML = "";
          }
        }
      }

      if (stEl) {
        stEl.textContent =
          data.mediaType === "written"
            ? `${data.ocrUsed ? "Client OCR + Gemini AI extracted" : "Extracted"} "${file.name}". Review preview & fields, then click Publish Question.`
            : `Transcribed ${data.mediaType} recording "${file.name}". Review preview & click Publish Question.`;
      }

      const dup = await runAdminDupCheck(true);
      if (data.duplicateCheck?.duplicate && !dup.duplicate) {
        showAdminDupBanner(data.duplicateCheck);
      }
    } catch (err) {
      if (stEl) stEl.textContent = err.message || "Could not process uploaded file.";
    } finally {
      $("#adminUploadFile").value = "";
    }
  };
}

if ($("#adminExplainBtn")) {
  $("#adminExplainBtn").onclick = async () => {
    const out = $("#adminExplainOut");
    const bodyText = $("#ab").value.trim();
    const selectedQ = $("#adminDetectedQ")?.value || "";
    if (!bodyText && !adminAttachment) {
      showAdminDupBanner({
        duplicate: true,
        reason: "Upload a file or paste question text first to generate a detailed AI explanation.",
      });
      return;
    }
    $("#adminExplainBtn").disabled = true;
    out.hidden = false;
    out.textContent = "Generating detailed Gemini AI explanation...";
    try {
      const normCode = window.uvFileTools
        ? window.uvFileTools.normCourseCode($("#ac").value).canonical
        : $("#ac").value.trim().toUpperCase();
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({
          mode: "explain",
          course: normCode,
          targetQuestion:
            selectedQ ||
            `Provide a detailed step-by-step explanation of this ${normCode || "course"} material.`,
          attachmentContext: bodyText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate explanation.");
      out.textContent = data.text || "No explanation returned.";
    } catch (err) {
      out.textContent = err.message || "Failed to generate explanation.";
    } finally {
      $("#adminExplainBtn").disabled = false;
    }
  };
}

$("#adminUploadForm").onsubmit = async (e) => {
  e.preventDefault();
  const msgEl = $("#amsg");
  msgEl.style.color = "var(--c)";
  msgEl.textContent = "Checking duplicates & publishing...";

  const normCode = window.uvFileTools
    ? window.uvFileTools.normCourseCode($("#ac").value).canonical
    : $("#ac").value.trim().toUpperCase();
  const normDep = window.uvFileTools
    ? window.uvFileTools.normSpaces($("#ad").value)
    : $("#ad").value.trim();
  const normTitle = window.uvFileTools
    ? window.uvFileTools.normSpaces($("#at").value)
    : $("#at").value.trim();

  $("#ad").value = normDep;
  $("#ac").value = normCode;
  $("#at").value = normTitle;

  const payload = {
    d: normDep,
    c: normCode,
    t: normTitle,
    y: +$("#ay").value,
    s: +$("#as").value,
    body: $("#ab").value.trim(),
    descr: $("#adescr").value.trim() || null,
  };

  const dup = await runAdminDupCheck(false);
  if (dup.duplicate) {
    msgEl.style.color = "var(--err-ink)";
    msgEl.textContent = dup.reason || "Duplicate past question already exists.";
    return;
  }

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
    msgEl.style.color = "var(--err-ink)";
    msgEl.textContent = error.message;
    showAdminDupBanner({ duplicate: true, reason: error.message });
    return;
  }

  clearAdminPreview(false);
  msgEl.style.color = "var(--ok-ink)";
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
  } else if (t.dataset.tact && t.dataset.tid) {
    t.disabled = true;
    if (t.dataset.tact === "delete") {
      r = await sb.from("testimonials").delete().eq("id", t.dataset.tid);
    } else {
      r = await sb
        .from("testimonials")
        .update({ approved: t.dataset.tact === "approve" })
        .eq("id", t.dataset.tid);
    }
  } else {
    return;
  }
  if (r.error) alert(r.error.message || "Failed");
  await load();
};
