let Q = [], user = null, P = {}, hist = [], cur = null, quiz = [], myUploads = [], myPayouts = [], dashStatus = "all", activeAttachment = null, dupCheckTimer = null, isAdminUser = false, lastUploadBody = "", appSettings = { price_ghs: Number(C.PRICE_GHS || 30), free_ai_limit: 5 };

function setMenuOpen(open) {
  const menu = $("#navMenu"), btn = $("#menuBtn");
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}

function syncUrlParams(updates) {
  try {
    const u = new URL(location.href);
    Object.entries(updates).forEach(([k, v]) => {
      if (v === null || v === undefined || v === "") {
        u.searchParams.delete(k);
      } else {
        u.searchParams.set(k, String(v));
      }
    });
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  } catch {}
}

function show(v, skipTransition = false) {
  const targetSection = document.getElementById(v);
  if (!targetSection) return;
  const activeBtn = document.querySelector(`nav button[data-v="${v}"]`);
  const label = activeBtn ? `Opening ${activeBtn.textContent}...` : "Loading view...";
  const alreadyVisible = !targetSection.hidden;

  const apply = () => {
    document.querySelectorAll("main>section").forEach((s) => {
      const match = s.id === v;
      s.hidden = !match;
      s.classList.remove("uv-view-enter");
      if (match) {
        void s.offsetWidth;
        s.classList.add("uv-view-enter");
      }
    });
    document.querySelectorAll("nav button").forEach((b) => {
      const active = b.dataset.v === v;
      b.classList.toggle("on", active);
      if (active && $("#activeViewLabel")) $("#activeViewLabel").textContent = b.textContent;
    });
    syncUrlParams({ view: v === "browse" ? null : v, ...(v !== "browse" ? { paper: null } : {}) });
    if (v === "chat" && $("#log") && $("#log").children.length === 0) {
      bub(
        "AI Tutor is ready. Ask any KNUST exam question, pick a course above to use its past papers, click Predict lecturer's style, or upload a PDF/image/audio/video.",
        "a"
      );
    }
    window.uvRevealObserve?.(targetSection);
  };

  setMenuOpen(false);
  if (v !== "chat") stopVoiceInput?.();
  if (alreadyVisible || skipTransition || typeof uvTransition === "undefined") {
    apply();
  } else {
    uvTransition.tab(apply, label);
  }
}

document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.v)));

if ($("#menuBtn")) {
  $("#menuBtn").onclick = (e) => {
    e.stopPropagation();
    const menu = $("#navMenu");
    setMenuOpen(menu ? menu.hidden : false);
  };
}

if ($("#brandHome")) {
  $("#brandHome").onclick = (e) => {
    e.preventDefault();
    show("browse");
  };
}

document.addEventListener("click", (e) => {
  const menu = $("#navMenu"), btn = $("#menuBtn");
  if (!menu || menu.hidden) return;
  if (!menu.contains(e.target) && !btn?.contains(e.target)) setMenuOpen(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setMenuOpen(false);
});

const initialParams = new URLSearchParams(location.search);

(async () => {
  try {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session) {
      const nextDest = location.pathname + location.search;
      return location.replace("signup.html?next=" + encodeURIComponent(nextDest));
    }
    user = session.user;
    await refresh();
    await load();

    const initView = initialParams.get("view");
    const initPaper = initialParams.get("paper");
    if (initPaper) {
      await openPaperById(initPaper);
    } else if (initView && initView !== "browse") {
      show(initView, true);
    }
    if (!initPaper && window.uvGuide?.init) {
      window.uvGuide.init({
        user,
        profile: P,
        showView: (viewId) => show(viewId, true),
      });
    }
  } finally {
    window.dispatchEvent(new CustomEvent("uv:rendered"));
  }
})();

if ($("#startTourBtn")) {
  $("#startTourBtn").onclick = () => {
    setMenuOpen(false);
    window.uvGuide?.startTour();
  };
}

$("#out").onclick = async () => {
  await sb.auth.signOut();
  if (typeof uvTransition !== "undefined") {
    uvTransition.go("index.html", "Signing out...");
  } else {
    location.href = "index.html";
  }
};

function renderDashboard() {
  const approvedCount = myUploads.filter((q) => q.status === "approved").length;
  const pendingCount = myUploads.filter((q) => q.status === "pending").length;
  const currentBalance = P.balance || 0;
  const withdrawnOrQueued = myPayouts
    .filter((p) => p.status !== "failed")
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const totalAccumulated = Math.max(currentBalance + withdrawnOrQueued, approvedCount * 300);

  if ($("#dashTotalEarned")) $("#dashTotalEarned").textContent = fmt(totalAccumulated);
  if ($("#dashBalance")) $("#dashBalance").textContent = fmt(currentBalance);
  if ($("#dashApproved")) $("#dashApproved").textContent = String(approvedCount);
  if ($("#dashPending")) $("#dashPending").textContent = String(pendingCount);

  const listEl = $("#dashList");
  if (!listEl) return;

  const items =
    dashStatus === "all"
      ? myUploads
      : myUploads.filter((q) => q.status === dashStatus);

  if (items.length === 0) {
    listEl.innerHTML = `<div class="row-item"><div class="row-main"><strong>No ${dashStatus === "all" ? "" : esc(dashStatus) + " "}uploaded papers yet</strong><span>Submit a verified past paper under Upload &amp; Earn to earn GH₵3 per approved upload.</span></div><button type="button" onclick="show('upload')">Upload a Paper</button></div>`;
    return;
  }

  listEl.innerHTML = items
    .map((q) => {
      const statusLabel =
        q.status === "approved"
          ? "Approved · +GH₵3.00"
          : q.status === "rejected"
            ? "Rejected"
            : "Pending Review";
      const statusClass =
        q.status === "approved"
          ? "st-approved"
          : q.status === "rejected"
            ? "st-rejected"
            : "st-pending";
      const dateStr = q.created_at
        ? new Date(q.created_at).toLocaleDateString()
        : "";
      const sem = q.semester ? ` · Sem ${q.semester}` : "";
      const desc = q.description ? ` · ${esc(q.description)}` : "";
      return `<div class="row-item uv-reveal"><div class="row-main"><strong>${esc(q.course_code)}${q.course_title ? " — " + esc(q.course_title) : ""}</strong><span>${esc(q.department)} · ${q.year}${sem}${desc}</span></div><div class="row-meta"><span style="color:var(--mut)">${esc(dateStr)}</span><span class="${statusClass}">${statusLabel}</span></div></div>`;
    })
    .join("");
  window.uvRevealObserve?.(listEl);
}

if ($("#dashFilter")) {
  $("#dashFilter").onclick = (e) => {
    const st = e.target?.dataset?.st;
    if (!st) return;
    dashStatus = st;
    document
      .querySelectorAll("#dashFilter button")
      .forEach((b) => b.classList.toggle("on", b.dataset.st === st));
    renderDashboard();
  };
}

function formatPriceGhs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "30";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function updatePricingAndQuotaUi(remainingOverride) {
  const price = Number(appSettings.price_ghs);
  const effectivePrice = Number.isFinite(price) && price > 0 ? price : 30;
  C.PRICE_GHS = effectivePrice;
  const priceLabel = formatPriceGhs(effectivePrice);

  const freeLimit = Math.max(0, Math.floor(Number(appSettings.free_ai_limit ?? 5)));
  let remaining;
  if (typeof remainingOverride === "number" && Number.isFinite(remainingOverride)) {
    remaining = Math.max(0, remainingOverride);
    P.ai_uses = Math.max(0, freeLimit - remaining);
  } else {
    remaining = Math.max(0, freeLimit - Number(P.ai_uses || 0));
  }

  if ($("#badge")) {
    $("#badge").textContent = P.on
      ? "Premium until " + new Date(P.premium_until).toLocaleDateString()
      : isAdminUser
        ? "Admin"
        : freeLimit > 0
          ? `Free · ${remaining} AI left`
          : "Free";
  }

  if ($("#priceDisplay")) {
    $("#priceDisplay").innerHTML = `GH₵ ${esc(priceLabel)} <small>/ month</small>`;
  }
  if ($("#priceDesc")) {
    $("#priceDesc").textContent =
      freeLimit > 0
        ? `Read every past question and enjoy unlimited AI tutor, predictions and quizzes. Free accounts include ${freeLimit} AI tutor use${freeLimit === 1 ? "" : "s"} before upgrading.`
        : "Read every past question and enjoy unlimited AI tutor, predictions and quizzes.";
  }

  const quotaEl = $("#aiQuotaLabel");
  if (quotaEl) {
    if (P.on) {
      quotaEl.textContent = "Unlimited AI access (Premium active)";
    } else if (isAdminUser) {
      quotaEl.textContent = "Unlimited AI access (Admin)";
    } else if (freeLimit === 0) {
      quotaEl.textContent = `Free AI trial is currently disabled. Upgrade to Premium (GH₵${priceLabel}/month) to use AI Tutor.`;
    } else if (remaining > 0) {
      quotaEl.textContent = `Free trial: ${remaining} of ${freeLimit} free AI use${freeLimit === 1 ? "" : "s"} remaining before Premium (GH₵${priceLabel}/month).`;
    } else {
      quotaEl.textContent = `Free AI trial used (${freeLimit}/${freeLimit}). Upgrade to Premium (GH₵${priceLabel}/month) for unlimited AI.`;
    }
  }
}

async function refresh() {
  const [{ data }, settingsRes, adminRes] = await Promise.all([
    sb.from("profiles").select("*").single(),
    sb.from("app_settings").select("price_ghs,free_ai_limit").eq("id", 1).maybeSingle(),
    sb.from("admins").select("user_id").eq("user_id", user.id).maybeSingle(),
  ]);
  P = data || {};
  P.on = P.premium_until && new Date(P.premium_until) > new Date();
  isAdminUser = Boolean(adminRes?.data);
  if (settingsRes?.data) {
    appSettings = {
      price_ghs: Number(settingsRes.data.price_ghs) || 30,
      free_ai_limit:
        settingsRes.data.free_ai_limit !== null && settingsRes.data.free_ai_limit !== undefined
          ? Number(settingsRes.data.free_ai_limit)
          : 5,
    };
  }
  updatePricingAndQuotaUi();
  $("#bal").textContent = fmt(P.balance || 0);

  const { data: po } = await sb
    .from("payouts")
    .select("*")
    .order("created_at", { ascending: false });
  myPayouts = po || [];
  $("#pays").innerHTML = myPayouts
    .map((p) => `<p>${fmt(p.amount)} · ${esc(p.status)}</p>`)
    .join("");

  const { data: m } = await sb
    .from("questions")
    .select("*")
    .eq("uploader", user.id)
    .order("created_at", { ascending: false });
  myUploads = m || [];
  $("#mine").innerHTML = myUploads
    .map((q) => `<p>${esc(q.course_code)} ${q.year} · ${esc(q.status)}</p>`)
    .join("");

  renderDashboard();
}

async function load() {
  const { data } = await sb
    .from("questions")
    .select("*")
    .eq("status", "approved")
    .order("year", { ascending: false });
  Q = data || [];
  const deps = [...new Set(Q.map((q) => q.department))].sort();
  const codes = [...new Set(Q.map((q) => q.course_code))].sort();
  if ($("#homeStatPapers")) $("#homeStatPapers").textContent = String(Q.length);
  if ($("#homeStatCourses")) $("#homeStatCourses").textContent = String(codes.length);
  if ($("#homeStatDepts")) $("#homeStatDepts").textContent = String(deps.length);
  $("#dep").innerHTML =
    '<option value="">All departments</option>' +
    deps.map((d) => `<option>${esc(d)}</option>`).join("");
  const initDep = initialParams.get("dep");
  const initQ = initialParams.get("q");
  if (initDep && deps.includes(initDep)) $("#dep").value = initDep;
  if (initQ && !$("#search").value) $("#search").value = initQ;
  document
    .querySelectorAll(".courses")
    .forEach((s) => {
      const opts = codes.map((c) => `<option>${esc(c)}</option>`).join("");
      s.innerHTML =
        s.id === "chatCourse"
          ? opts + '<option value="">General (any course)</option>'
          : opts || '<option value="">General (any course)</option>';
    });
  render(false);
}

function render(syncUrl = true) {
  const d = $("#dep").value,
    raw = $("#search").value.trim(),
    t = raw.toLowerCase(),
    by = {};
  $("#clearSearch").hidden = !d && !raw;
  if (syncUrl) {
    syncUrlParams({ dep: d || null, q: raw || null });
  }
  const filtered = Q.filter(
    (q) =>
      (!d || q.department === d) &&
      (!t ||
        `${q.course_code} ${q.course_title || ""} ${q.department || ""} ${q.description || ""} ${q.year}`
          .toLowerCase()
          .includes(t))
  );
  filtered.forEach(
    (q) =>
      (by[q.course_code] ??= { t: q.course_title, d: q.department, desc: q.description, i: [] }).i.push(q)
  );
  const courses = Object.entries(by);
  $("#browseMeta").textContent = Q.length
    ? `Showing ${courses.length} course${courses.length === 1 ? "" : "s"} · ${filtered.length} paper${filtered.length === 1 ? "" : "s"}`
    : "No approved questions published yet.";
  $("#list").innerHTML =
    courses
      .map(
        ([c, v]) =>
          `<article class="card archive-card uv-reveal"><div><div class="card-meta"><span>${esc(v.d)}</span><span class="card-count">${v.i.length} paper${v.i.length === 1 ? "" : "s"}</span></div><h3>${esc(c)}<span>${esc(v.t || "Past Examination Papers")}</span></h3>${v.desc ? `<p class="card-note">${esc(v.desc)}</p>` : ""}</div><div class="chips">${v.i
            .map(
              (q) =>
                `<button data-id="${q.id}">${q.year}${q.semester ? " · S" + q.semester : ""}</button>`
            )
            .join("")}</div></article>`
      )
      .join("") ||
    `<div class="card"><p style="color:var(--mut)">${Q.length ? "No approved past papers match your search." : "No approved questions yet."}</p></div>`;
  window.uvRevealObserve?.($("#list"));
}

$("#dep").onchange = $("#search").oninput = () => render(true);
$("#clearSearch").onclick = () => {
  $("#dep").value = "";
  $("#search").value = "";
  render(true);
  $("#search").focus();
};

async function openPaperById(id) {
  const found = Q.find((q) => q.id === id);
  if (!found) return;
  cur = found;
  syncUrlParams({ paper: id, view: null });
  $("#rt").textContent = `${cur.course_code} · ${cur.year}${cur.semester ? " Sem " + cur.semester : ""}`;
  const { data } = await sb
    .from("question_content")
    .select("content")
    .eq("question_id", id)
    .maybeSingle();
  cur.content = data?.content;
  $("#rb").textContent = data
    ? data.content
    : `Subscribe for GH₵${formatPriceGhs(C.PRICE_GHS)}/month to read this paper.`;
  $("#solve").hidden = !data;
  if (!$("#reader").open) $("#reader").showModal();
  if (!data) {
    $("#reader").close();
    show("pricing");
  }
}

$("#list").onclick = (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  openPaperById(id);
};

if ($("#reader")) {
  $("#reader").addEventListener("close", () => {
    syncUrlParams({ paper: null });
  });
}

$("#solve").onclick = () => {
  $("#reader").close();
  $("#chatCourse").value = cur.course_code;
  $("#msg").value = "Solve step by step:\n" + cur.content;
  show("chat");
};

if ($("#explainPaper")) {
  $("#explainPaper").onclick = () => {
    const paperTitle = `${cur.course_code} (${cur.year}${cur.semester ? " Sem " + cur.semester : ""})`;
    const content = cur.content || "";
    $("#reader").close();
    $("#chatCourse").value = cur.course_code;
    show("chat");
    requestDetailedExplanation(
      `Provide a detailed step-by-step explanation for ${paperTitle}`,
      content
    );
  };
}

function normSpaces(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function normCourseCode(v) {
  const cleaned = normSpaces(v).toUpperCase().replace(/[-_]+/g, " ");
  const compact = cleaned.replace(/[^A-Z0-9]/g, "");
  const m = compact.match(/^([A-Z]+)(\d+[A-Z]*)$/);
  return { canonical: m ? `${m[1]} ${m[2]}` : cleaned, key: compact };
}

function normBodyKey(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localDuplicateCheck(courseCode, year, semester, bodyText) {
  const { key: ckey } = normCourseCode(courseCode);
  const y = Number(year) || 0;
  const s = Number(semester) || 0;
  const pool = [...Q, ...myUploads.filter((x) => x.status !== "rejected")];

  if (ckey && y) {
    const match = pool.find(
      (q) =>
        normCourseCode(q.course_code).key === ckey &&
        Number(q.year) === y &&
        (!s || !q.semester || Number(q.semester) === s)
    );
    if (match) {
      return {
        duplicate: true,
        reason: `Duplicate past question detected: ${match.course_code} (${match.year}${match.semester ? " Sem " + match.semester : ""}) already exists in UniVault (${match.status}).`,
      };
    }
  }

  const nb = normBodyKey(bodyText);
  if (nb.length >= 60) {
    for (const q of pool) {
      const candidate = q.question_content?.content || "";
      const nc = normBodyKey(candidate);
      if (nc.length >= 60 && nc === nb) {
        return {
          duplicate: true,
          reason: `Duplicate content detected under ${q.course_code} (${q.year}).`,
        };
      }
    }
  }

  return { duplicate: false };
}

function showDupBanner(result) {
  const banner = $("#dupAlert");
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

async function runDuplicateCheck(courseCode, year, semester, bodyText, showClear = false) {
  const local = localDuplicateCheck(courseCode, year, semester, bodyText);
  if (local.duplicate) {
    showDupBanner(local);
    return local;
  }
  try {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session?.access_token) return local;
    const res = await fetch("/api/check-duplicate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        department: $("#ud")?.value || "",
        courseCode,
        year: year ? Number(year) : null,
        semester: semester ? Number(semester) : null,
        bodyText,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.duplicate) {
        showDupBanner(data);
        return data;
      }
      if (showClear && (normCourseCode(courseCode).key || String(bodyText || "").trim().length >= 50)) {
        showDupBanner({
          duplicate: false,
          verifiedMessage: `Normalized check passed (${data.normalizedCode || "ready"}): no duplicate past question found.`,
        });
      } else {
        showDupBanner(null);
      }
      return data;
    }
  } catch {}
  if (showClear) showDupBanner(null);
  return local;
}

async function processFileWithGemini(file, onStatus) {
  if (window.uvFileTools?.processFile) {
    return window.uvFileTools.processFile(file, onStatus);
  }
  throw new Error("File processor script failed to load.");
}

function setActiveAttachment(data) {
  activeAttachment = data;
  const bar = $("#chatAttachmentBar");
  if (!bar) return;
  if (!data) {
    bar.hidden = true;
    if ($("#chatDetectedQ")) {
      $("#chatDetectedQ").hidden = true;
      $("#chatDetectedQ").innerHTML = "";
    }
    return;
  }
  bar.hidden = false;
  $("#chatAttachmentName").textContent = `${data.fileName} (${data.mediaType === "audio" ? "Audio Transcript" : data.mediaType === "video" ? "Video Transcript & Frames" : "Written Document"})`;
  $("#chatAttachmentInfo").textContent =
    data.summary || "Loaded into AI Tutor context. Ask any question or request a detailed explanation.";

  const qSel = $("#chatDetectedQ");
  if (qSel) {
    const qs = Array.isArray(data.questionsDetected) ? data.questionsDetected : [];
    if (qs.length > 0) {
      qSel.hidden = false;
      qSel.innerHTML =
        '<option value="">Explain full material / overview</option>' +
        qs.map((q, i) => `<option value="${esc(q)}">Q${i + 1}: ${esc(q.slice(0, 75))}${q.length > 75 ? "..." : ""}</option>`).join("");
    } else {
      qSel.hidden = true;
      qSel.innerHTML = "";
    }
  }
}

function setAiBusy(busy) {
  ["#send", "#predict", "#explainBtn", "#explainAttachedBtn"].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = Boolean(busy);
  });
}

async function getValidAccessToken(forceRefresh = false) {
  if (forceRefresh && sb?.auth?.refreshSession) {
    try {
      const { data } = await sb.auth.refreshSession();
      if (data?.session?.access_token) return data.session.access_token;
    } catch {}
  }
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (session?.access_token) return session.access_token;
  if (sb?.auth?.refreshSession) {
    try {
      const { data } = await sb.auth.refreshSession();
      if (data?.session?.access_token) return data.session.access_token;
    } catch {}
  }
  return "";
}

async function ai(body, onChunk) {
  if (!isValidSupabaseUrl) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.");
  }

  const syncQuotaFromResponse = (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (typeof payload.freeLimit === "number") {
      appSettings.free_ai_limit = payload.freeLimit;
    }
    if (typeof payload.freeRemaining === "number") {
      updatePricingAndQuotaUi(payload.freeRemaining);
    }
  };

  let token = await getValidAccessToken(false);
  if (!token) {
    throw new Error("Please sign in first.");
  }

  const wantsStream = typeof onChunk === "function" && body.mode !== "quiz";

  const callLocalApi = async (accessToken, ctrl) =>
    fetch("/api/ai-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: wantsStream ? "text/event-stream, application/json" : "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(wantsStream ? { ...body, stream: true } : body),
      signal: ctrl?.signal,
    });

  let apiError = "";
  let shouldTryEdgeFallback = false;
  let gotServerResponse = false;

  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = ctrl ? setTimeout(() => ctrl.abort(), 35000) : null;
  const resetTimer = (ms = 35000) => {
    if (!ctrl) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ms);
  };

  try {
    let apiRes = await callLocalApi(token, ctrl);
    if (apiRes.status === 401) {
      const refreshedToken = await getValidAccessToken(true);
      if (refreshedToken && refreshedToken !== token) {
        token = refreshedToken;
        resetTimer(35000);
        apiRes = await callLocalApi(token, ctrl);
      }
    }

    const contentType = apiRes.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") && apiRes.body?.getReader) {
      gotServerResponse = true;
      const reader = apiRes.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = "";
      let accumulated = "";
      let finalText = "";

      const handleLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const payloadText = line.slice(5).trim();
        if (!payloadText) return;
        let ev;
        try {
          ev = JSON.parse(payloadText);
        } catch {
          return;
        }
        if (ev.error) {
          const err = new Error(ev.error);
          if (typeof ev.status === "number") err.status = ev.status;
          throw err;
        }
        if (ev.type === "meta") {
          syncQuotaFromResponse(ev);
          return;
        }
        if (ev.type === "delta" && typeof ev.delta === "string") {
          accumulated += ev.delta;
          onChunk(accumulated);
          return;
        }
        if (ev.type === "done") {
          syncQuotaFromResponse(ev);
          if (typeof ev.text === "string" && ev.text) {
            finalText = ev.text;
          }
        }
      };

      while (true) {
        resetTimer(35000);
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split(/\r?\n/);
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      }
      sseBuffer += decoder.decode();
      if (sseBuffer.trim()) {
        for (const line of sseBuffer.split(/\r?\n/)) {
          handleLine(line);
        }
      }

      const resolved = (finalText || accumulated).trim();
      if (!resolved) {
        throw new Error("No response returned from AI Tutor. Please try again.");
      }
      return resolved;
    }

    if (contentType.includes("application/json")) {
      gotServerResponse = true;
      const apiData = await apiRes.json();
      syncQuotaFromResponse(apiData);
      if (apiRes.ok) {
        return apiData.text;
      }
      apiError = apiData?.error || `AI request failed (${apiRes.status}).`;
      const err = new Error(apiError);
      err.status = apiRes.status;
      throw err;
    }

    if (apiRes.status === 404 || apiRes.status === 405) {
      shouldTryEdgeFallback = true;
      apiError = `AI route returned ${apiRes.status}.`;
    } else {
      gotServerResponse = true;
      const rawText = (await apiRes.text().catch(() => "")).replace(/<[^>]+>/g, " ").trim();
      throw new Error(
        rawText ? `AI server error (${apiRes.status}): ${rawText.slice(0, 140)}` : `AI server error (${apiRes.status}).`
      );
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("AI Tutor timed out while waiting for a response. Please try again.");
    }
    if (!shouldTryEdgeFallback) {
      if (gotServerResponse || typeof err?.status === "number" || apiError) {
        throw err;
      }
      // Network error reaching /api/ai-chat: try Supabase Edge Function as fallback
      shouldTryEdgeFallback = true;
      apiError = err?.message || "Could not reach /api/ai-chat.";
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const hasRichPayload = Boolean(body.attachmentContext) || body.mode === "explain";
  if (shouldTryEdgeFallback && !hasRichPayload) {
    const { data, error } = await sb.functions.invoke("ai-chat", { body });
    if (!error && data?.text) {
      syncQuotaFromResponse(data);
      return data.text;
    }
    let edgeErr = error?.message || "";
    try {
      const jsonErr = await error?.context?.json?.();
      syncQuotaFromResponse(jsonErr);
      if (jsonErr?.error) edgeErr = jsonErr.error;
    } catch {}
    if (/premium|trial limit/i.test(edgeErr)) {
      const err = new Error(edgeErr);
      err.status = 402;
      throw err;
    }
    throw new Error(apiError || edgeErr || "Could not reach AI Tutor service.");
  }

  throw new Error(apiError || "Could not reach AI Tutor service.");
}

function bub(t, c) {
  const d = document.createElement("div");
  d.className = "m " + c;
  d.textContent = t;
  $("#log").append(d);
  $("#log").scrollTop = 1e9;
  return d;
}

function showAiErrorInBubble(bubbleEl, err) {
  const msg = err?.message || "Could not get a response from AI Tutor.";
  bubbleEl.textContent = msg;
  if (err?.status === 402 || /premium|trial limit/i.test(msg)) {
    const wrap = document.createElement("div");
    wrap.style.marginTop = "10px";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Upgrade to Premium";
    btn.onclick = () => show("pricing");
    wrap.append(btn);
    bubbleEl.append(wrap);
  }
  $("#log").scrollTop = 1e9;
}

function buildAttachmentContext() {
  if (!activeAttachment) return "";
  const parts = [`File: ${activeAttachment.fileName} (${activeAttachment.mediaType})`];
  if (activeAttachment.transcript && activeAttachment.transcript !== activeAttachment.extractedText) {
    parts.push(`Verbatim Transcript:\n${activeAttachment.transcript}`);
  }
  if (activeAttachment.extractedText) {
    parts.push(`Extracted Content:\n${activeAttachment.extractedText}`);
  }
  return parts.join("\n\n");
}

async function ask(text) {
  if ($("#send")?.disabled) return;
  bub(text, "u");
  hist.push({ role: "user", content: text });
  const w = bub("Thinking...", "a");
  setAiBusy(true);
  try {
    const r = await ai(
      {
        mode: "chat",
        course: $("#chatCourse")?.value || "",
        messages: hist,
        attachmentContext: buildAttachmentContext(),
      },
      (partial) => {
        if (!partial) return;
        w.textContent = partial;
        const logEl = $("#log");
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      }
    );
    const clean = String(r || "").trim();
    if (!clean) {
      w.textContent = "No response returned. Please try again.";
      hist.pop();
      return;
    }
    w.textContent = clean;
    hist.push({ role: "assistant", content: clean });
    const logEl = $("#log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  } catch (e) {
    showAiErrorInBubble(w, e);
    hist.pop();
  } finally {
    setAiBusy(false);
  }
}

async function requestDetailedExplanation(targetQuestion, inlineContext = "") {
  if ($("#send")?.disabled) return;
  const userLabel = targetQuestion
    ? `Detailed explanation requested:\n${targetQuestion}`
    : "Provide a detailed explanation of the uploaded material.";
  bub(userLabel, "u");
  const w = bub("Preparing detailed explanation...", "a");
  setAiBusy(true);
  try {
    const context = inlineContext || buildAttachmentContext();
    const r = await ai(
      {
        mode: "explain",
        course: $("#chatCourse")?.value || "",
        targetQuestion,
        attachmentContext: context,
      },
      (partial) => {
        if (!partial) return;
        w.textContent = partial;
        const logEl = $("#log");
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      }
    );
    const clean = String(r || "").trim();
    if (!clean) {
      w.textContent = "No explanation returned. Please try again.";
      return;
    }
    w.textContent = clean;
    hist.push({ role: "user", content: userLabel });
    hist.push({ role: "assistant", content: clean });
    const logEl = $("#log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  } catch (e) {
    showAiErrorInBubble(w, e);
  } finally {
    setAiBusy(false);
  }
}

const SpeechRecognitionApi =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let activeRecognition = null;
let isVoiceRecording = false;

function setMicStatus(text, isError = false) {
  const st = $("#micStatus");
  if (!st) return;
  if (!text) {
    st.hidden = true;
    st.textContent = "";
    st.className = "mic-status";
    return;
  }
  st.hidden = false;
  st.textContent = text;
  st.className = isError ? "mic-status is-err" : "mic-status";
}

function setMicButtonState(recording) {
  isVoiceRecording = recording;
  const btn = $("#micBtn");
  const lbl = $("#micBtnLabel");
  if (btn) {
    btn.classList.toggle("is-recording", recording);
    btn.setAttribute("aria-pressed", String(recording));
    btn.setAttribute(
      "aria-label",
      recording ? "Stop voice recording" : "Record question with microphone"
    );
  }
  if (lbl) lbl.textContent = recording ? "Stop" : "Voice";
}

function stopVoiceInput() {
  if (activeRecognition && isVoiceRecording) {
    try {
      activeRecognition.stop();
    } catch {}
  }
  setMicButtonState(false);
}

if ($("#micBtn")) {
  if (!SpeechRecognitionApi) {
    $("#micBtn").title =
      "Voice dictation is not supported in this browser. Try Chrome, Edge, or Safari, or upload an MP3 audio recording.";
  }

  $("#micBtn").onclick = () => {
    if (!SpeechRecognitionApi) {
      setMicStatus(
        "Voice dictation is not supported in this browser. Use Chrome, Edge, or Safari, or tap Upload File / Image / Audio / Video.",
        true
      );
      return;
    }

    if (isVoiceRecording && activeRecognition) {
      stopVoiceInput();
      return;
    }

    try {
      const rec = new SpeechRecognitionApi();
      activeRecognition = rec;
      rec.lang = navigator.language || "en-US";
      rec.continuous = true;
      rec.interimResults = true;

      const baseText = $("#msg")?.value.trim() || "";
      let finalTranscript = "";
      let hadError = false;

      rec.onstart = () => {
        setMicButtonState(true);
        setMicStatus("Listening... speak your question clearly, then tap Stop or Send.");
      };

      rec.onresult = (event) => {
        let interim = "";
        let finalized = "";
        for (let i = 0; i < event.results.length; i++) {
          const piece = event.results[i][0]?.transcript || "";
          if (event.results[i].isFinal) {
            finalized += (finalized ? " " : "") + piece.trim();
          } else {
            interim += (interim ? " " : "") + piece.trim();
          }
        }
        finalTranscript = finalized;
        const combined = [baseText, finalTranscript, interim]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if ($("#msg")) $("#msg").value = combined;
      };

      rec.onerror = (event) => {
        hadError = true;
        const code = event?.error || "";
        let msg = "Microphone recording stopped.";
        if (code === "not-allowed" || code === "service-not-allowed") {
          msg =
            "Microphone permission denied. Allow microphone access in your browser settings and try again.";
        } else if (code === "audio-capture") {
          msg = "No microphone detected on this device.";
        } else if (code === "no-speech") {
          msg = "No speech detected. Tap Voice and speak closer to your microphone.";
        } else if (code === "network") {
          msg = "Speech recognition requires an active network connection in this browser.";
        }
        setMicStatus(msg, true);
        setMicButtonState(false);
        activeRecognition = null;
      };

      rec.onend = () => {
        setMicButtonState(false);
        activeRecognition = null;
        if (!hadError) {
          const hasText = Boolean($("#msg")?.value.trim());
          setMicStatus(
            hasText
              ? "Voice captured — review or tap Send to ask the AI Tutor."
              : "Listening stopped."
          );
          if (hasText) $("#msg")?.focus();
        }
      };

      rec.start();
    } catch (err) {
      setMicButtonState(false);
      activeRecognition = null;
      setMicStatus(err?.message || "Could not start microphone recording.", true);
    }
  };
}

$("#send").onclick = () => {
  if (isVoiceRecording) stopVoiceInput();
  const t = $("#msg").value.trim();
  if (!t) {
    $("#msg").focus();
    return;
  }
  if (!$("#send").disabled) {
    $("#msg").value = "";
    setMicStatus("");
    ask(t);
  }
};

$("#msg").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#send").click();
  }
};

$("#predict").onclick = () =>
  ask(
    "Based on the past questions, predict how this lecturer sets questions: recurring topics, question types, mark distribution, and the most likely topics next exam."
  );

if ($("#explainBtn")) {
  $("#explainBtn").onclick = () => {
    if (isVoiceRecording) stopVoiceInput();
    const typed = $("#msg").value.trim();
    const selectedQ = $("#chatDetectedQ")?.value || "";
    const target = typed || selectedQ;
    if (!target && !activeAttachment) {
      $("#msg").focus();
      bub("Type or paste a specific question (or upload a PDF/DOCX/PPT/MP3/MP4) to get a detailed explanation.", "a");
      return;
    }
    if (typed) $("#msg").value = "";
    setMicStatus("");
    requestDetailedExplanation(target);
  };
}

if ($("#explainAttachedBtn")) {
  $("#explainAttachedBtn").onclick = () => {
    const selectedQ = $("#chatDetectedQ")?.value || "";
    requestDetailedExplanation(
      selectedQ || "Explain all key questions and concepts from the uploaded file in detail."
    );
  };
}

if ($("#chatFileBtn") && $("#chatFile")) {
  $("#chatFileBtn").onclick = () => $("#chatFile").click();
  $("#chatFile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("#chatFileBtn").disabled = true;
    const statusBub = bub(`Reading "${file.name}"...`, "a");
    try {
      const data = await processFileWithGemini(file, (msg) => {
        statusBub.textContent = msg;
      });
      setActiveAttachment(data);
      const actionLabel =
        data.mediaType === "written"
          ? data.ocrUsed
            ? "OCR-scanned & extracted"
            : "Extracted"
          : "Transcribed";
      statusBub.textContent =
        `${actionLabel} "${data.fileName}".\n\nSummary: ${data.summary || "Ready."}\n\n` +
        (data.questionsDetected?.length
          ? `Detected ${data.questionsDetected.length} question(s). Pick one above or ask me for a detailed explanation!`
          : "Ask me any question about this file or click Detailed explanation.");
    } catch (err) {
      statusBub.textContent = err.message || "Could not process file.";
    } finally {
      $("#chatFileBtn").disabled = false;
      $("#chatFile").value = "";
    }
  };
}

if ($("#clearChatFile")) {
  $("#clearChatFile").onclick = () => setActiveAttachment(null);
}

$("#gen").onclick = async () => {
  const o = $("#quizOut");
  o.textContent = "Generating...";
  try {
    quiz = JSON.parse(
      (
        await ai({
          mode: "quiz",
          course: $("#quizCourse").value,
          count: +$("#count").value,
          instructions: $("#instr").value,
        })
      )
        .replace(/```json|```/g, "")
        .trim()
    );
    o.innerHTML =
      quiz
        .map(
          (q, i) =>
            `<div class="qq glass"><b>${i + 1}. ${esc(q.q)}</b>${q.options
              .map(
                (x, j) =>
                  `<label data-q="${i}"><input type="radio" name="q${i}" value="${j}"> ${esc(x)}</label>`
              )
              .join("")}<small hidden>${esc(q.explain)}</small></div>`
        )
        .join("") + '<button id="grade">Submit</button><p id="score"></p>';
    $("#grade").onclick = () => {
      let s = 0;
      quiz.forEach((q, i) => {
        const p = document.querySelector(`input[name=q${i}]:checked`);
        if (p && +p.value === q.answer) s++;
        const L = document.querySelectorAll(`label[data-q="${i}"]`);
        L[q.answer].classList.add("ok");
        if (p && +p.value !== q.answer) p.parentElement.classList.add("no");
        L[0].parentElement.querySelector("small").hidden = false;
      });
      $("#score").textContent = `Score: ${s}/${quiz.length}`;
    };
  } catch (e) {
    o.textContent = e.message;
  }
};

function scheduleUploadDupCheck() {
  if (dupCheckTimer) clearTimeout(dupCheckTimer);
  dupCheckTimer = setTimeout(() => {
    runDuplicateCheck($("#uc").value, $("#uy").value, $("#us").value, $("#ub").value, false);
  }, 450);
}

["#uc", "#uy", "#us", "#ub"].forEach((sel) => {
  const node = $(sel);
  if (node) {
    node.addEventListener("input", scheduleUploadDupCheck);
    node.addEventListener("change", scheduleUploadDupCheck);
  }
});

function clearUploadPreview(resetExtractedBody = true) {
  if ($("#uploadFile")) $("#uploadFile").value = "";
  window.uvFileTools?.renderUploadPreview($("#uploadPreview"), null);
  if ($("#uploadFileStatus")) {
    $("#uploadFileStatus").textContent =
      "Client-side PDF & Image OCR + Gemini AI extraction & duplicate normalization check.";
  }
  if (resetExtractedBody && lastUploadBody && $("#ub")?.value === lastUploadBody) {
    $("#ub").value = "";
  }
  lastUploadBody = "";
  setActiveAttachment(null);
  showDupBanner(null);
}

if ($("#uploadFile")) {
  $("#uploadFile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const stEl = $("#uploadFileStatus");
    if (stEl) {
      stEl.textContent = `Starting client-side file reader for "${file.name}"...`;
    }
    window.uvFileTools?.renderUploadPreview($("#uploadPreview"), null);
    showDupBanner(null);
    try {
      const data = await processFileWithGemini(file, (msg) => {
        if (stEl) stEl.textContent = msg;
      });
      const formattedBody =
        data.transcript && data.transcript !== data.extractedText
          ? `${data.extractedText}\n\n[Transcript]\n${data.transcript}`
          : data.extractedText || data.transcript || "";
      if (formattedBody) {
        $("#ub").value = formattedBody;
        lastUploadBody = formattedBody;
      }

      const meta = data.metadata || {};
      if (meta.department && !$("#ud").value.trim()) $("#ud").value = meta.department;
      if (meta.course_code && !$("#uc").value.trim()) $("#uc").value = meta.course_code;
      if (meta.course_title && !$("#ut").value.trim()) $("#ut").value = meta.course_title;
      if (meta.year && !$("#uy").value.trim()) $("#uy").value = String(meta.year);
      if ((meta.semester === 1 || meta.semester === 2) && $("#us")) $("#us").value = String(meta.semester);
      if (meta.description && $("#udescr") && !$("#udescr").value.trim()) {
        $("#udescr").value = meta.description;
      }

      setActiveAttachment(data);
      window.uvFileTools?.renderUploadPreview($("#uploadPreview"), data, () =>
        clearUploadPreview(true)
      );
      if (stEl) {
        stEl.textContent =
          data.mediaType === "written"
            ? `${data.ocrUsed ? "Client OCR + Gemini AI extracted" : "Extracted"} "${file.name}". Review preview & metadata, then submit.`
            : `Transcribed ${data.mediaType} recording "${file.name}". Review preview & submit below.`;
      }

      const dup = await runDuplicateCheck(
        $("#uc").value,
        $("#uy").value,
        $("#us").value,
        $("#ub").value,
        true
      );
      if (data.duplicateCheck?.duplicate && !dup.duplicate) {
        showDupBanner(data.duplicateCheck);
      }
    } catch (err) {
      if (stEl) stEl.textContent = err.message || "Could not process uploaded file.";
    } finally {
      $("#uploadFile").value = "";
    }
  };
}

if ($("#explainUploadBtn")) {
  $("#explainUploadBtn").onclick = () => {
    const bodyText = $("#ub").value.trim();
    if (!bodyText && !activeAttachment) {
      showDupBanner({
        duplicate: true,
        reason: "Upload a file (PDF, DOCX, PPT, MP3, MP4) or paste a question first to get an explanation.",
      });
      return;
    }
    const courseVal = normCourseCode($("#uc").value).canonical;
    if (courseVal && $("#chatCourse")) {
      const opt = [...$("#chatCourse").options].find((o) => o.value === courseVal);
      if (opt) $("#chatCourse").value = courseVal;
    }
    show("chat");
    requestDetailedExplanation(
      activeAttachment?.questionsDetected?.[0] ||
        `Give a detailed explanation for this uploaded ${courseVal || "course"} material.`,
      bodyText || buildAttachmentContext()
    );
  };
}

$("#usub").onclick = async () => {
  const cleanCode = normCourseCode($("#uc").value).canonical;
  const cleanDep = normSpaces($("#ud").value);
  const cleanTitle = normSpaces($("#ut").value);
  const cleanBody = $("#ub").value.trim();
  $("#ud").value = cleanDep;
  $("#uc").value = cleanCode;
  $("#ut").value = cleanTitle;

  const payload = {
    d: cleanDep,
    c: cleanCode,
    t: cleanTitle,
    y: +$("#uy").value,
    s: +$("#us").value,
    body: cleanBody,
  };
  if (!payload.d || !payload.c || !payload.y) {
    showDupBanner({
      duplicate: true,
      reason: "Please fill in Department, Course code, and Year before submitting.",
    });
    return;
  }

  $("#usub").disabled = true;
  try {
    const dup = await runDuplicateCheck(cleanCode, payload.y, payload.s, cleanBody, false);
    if (dup.duplicate) {
      showDupBanner(dup);
      return;
    }

    const descr = $("#udescr") ? $("#udescr").value.trim() : "";
    let { error } = await sb.rpc("submit_question", descr ? { ...payload, descr } : payload);
    if (error && descr && /submit_question/i.test(error.message)) {
      ({ error } = await sb.rpc("submit_question", payload));
    }
    if (error) {
      showDupBanner({ duplicate: true, reason: error.message });
      return;
    }
    clearUploadPreview(false);
    showDupBanner({
      duplicate: false,
      verifiedMessage: "Submitted for review! You will earn GH₵3 once approved.",
    });
    $("#ub").value = "";
    if ($("#udescr")) $("#udescr").value = "";
    await refresh();
  } finally {
    $("#usub").disabled = false;
  }
};

$("#wd").onclick = async () => {
  const { error } = await sb.rpc("request_payout", {
    nm: $("#wn").value,
    momo: $("#wm").value,
    net: $("#wk").value,
  });
  error ? alert(error.message) : (alert("Withdrawal requested"), refresh());
};

$("#pay").onclick = () => {
  if (typeof PaystackPop === "undefined") {
    return alert("Paystack checkout script failed to load.");
  }
  PaystackPop.setup({
    key: C.PAYSTACK_PUBLIC_KEY,
    email: user.email,
    amount: Math.round(Number(C.PRICE_GHS || 30) * 100),
    currency: "GHS",
    callback: (r) => {
      sb.functions
        .invoke("paystack-verify", { body: { reference: r.reference } })
        .then(async ({ data }) => {
          alert(
            data?.ok
              ? "Premium active for 30 days!"
              : "Could not verify. Keep ref " + r.reference
          );
          await refresh();
        });
    },
  }).openIframe();
};
