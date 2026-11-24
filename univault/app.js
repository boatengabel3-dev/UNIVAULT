let ALL_Q = [], Q = [], user = null, userProgramme = null, P = {}, hist = [], cur = null, quiz = [], myUploads = [], myPayouts = [], dashStatus = "all", activeAttachment = null, dupCheckTimer = null, isAdminUser = false, lastUploadBody = "", isUsingOfflineCache = false, appSettings = { price_ghs: Number(C.PRICE_GHS || 30), free_ai_limit: 5, free_questions_limit: 3 };

function getOfflineKey(kind) {
  const uid = user?.id || "anon";
  return `uv_offline_${kind}_${uid}`;
}

function readOfflineJson(kind, fallback = null) {
  try {
    const raw = localStorage.getItem(getOfflineKey(kind));
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeOfflineJson(kind, value) {
  try {
    localStorage.setItem(getOfflineKey(kind), JSON.stringify(value));
  } catch {}
}

function getOfflinePapersMap() {
  const data = readOfflineJson("papers", {});
  return data && typeof data === "object" ? data : {};
}

function saveOfflinePaper(paper, content) {
  if (!paper?.id || !content) return;
  const map = getOfflinePapersMap();
  map[paper.id] = {
    id: paper.id,
    course_code: paper.course_code,
    year: paper.year,
    semester: paper.semester || null,
    content,
    savedAt: Date.now(),
  };
  const entries = Object.entries(map);
  if (entries.length > 80) {
    entries.sort((a, b) => Number(a[1]?.savedAt || 0) - Number(b[1]?.savedAt || 0));
    while (entries.length > 80) entries.shift();
  }
  writeOfflineJson("papers", Object.fromEntries(entries));
}

function getOfflinePaper(id) {
  if (!id) return null;
  const map = getOfflinePapersMap();
  return map[id] || null;
}

function clearUserOfflineData() {
  try {
    ["q", "meta", "papers"].forEach((k) => localStorage.removeItem(getOfflineKey(k)));
  } catch {}
  window.uvPwa?.clearUserCache?.();
}

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
      renderWelcomeChatMessage();
    }
    if (!alreadyVisible) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    window.uvRevealReset?.(targetSection);
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
    userProgramme = resolveUserProgramme();
    await Promise.allSettled([refresh(), load()]);
    if (!userProgramme) {
      userProgramme = resolveUserProgramme();
    }
    if (userProgramme) {
      saveUserProgramme(userProgramme);
      if (P?.id && !P.programme_id && typeof sb?.from === "function") {
        sb.from("profiles")
          .update({ programme_id: userProgramme.id, programme: userProgramme.name })
          .eq("id", user.id)
          .then(() => {})
          .catch(() => {});
      }
    }
    updateProgrammeUi();

    if (!isAdminUser && !userProgramme && window.uvKnustCourses) {
      openProgrammeDialog(false);
    }

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
  } catch (err) {
    if (typeof isInvalidRefreshTokenError === "function" && isInvalidRefreshTokenError(err)) {
      clearStaleSupabaseAuthStorage?.(sb);
    }
    const nextDest = location.pathname + location.search;
    location.replace("signup.html?next=" + encodeURIComponent(nextDest));
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
  clearUserOfflineData();
  try {
    await sb.auth.signOut();
  } catch {}
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

function updatePricingAndQuotaUi(remainingAiOverride, remainingQuestionsOverride) {
  const price = Number(appSettings.price_ghs);
  const effectivePrice = Number.isFinite(price) && price > 0 ? price : 30;
  C.PRICE_GHS = effectivePrice;
  const priceLabel = formatPriceGhs(effectivePrice);

  const freeLimit = Math.max(0, Math.floor(Number(appSettings.free_ai_limit ?? 5)));
  const freeQuestionsLimit = Math.max(0, Math.floor(Number(appSettings.free_questions_limit ?? 3)));
  let remaining;
  if (typeof remainingAiOverride === "number" && Number.isFinite(remainingAiOverride)) {
    remaining = Math.max(0, remainingAiOverride);
    P.ai_uses = Math.max(0, freeLimit - remaining);
  } else {
    remaining = Math.max(0, freeLimit - Number(P.ai_uses || 0));
  }

  const unlockedCount = Array.isArray(P.free_question_ids) ? P.free_question_ids.length : 0;
  let remainingQuestions;
  if (typeof remainingQuestionsOverride === "number" && Number.isFinite(remainingQuestionsOverride)) {
    remainingQuestions = Math.max(0, remainingQuestionsOverride);
  } else {
    remainingQuestions = Math.max(0, freeQuestionsLimit - unlockedCount);
  }

  if ($("#headerProBadge")) {
    const isPro = Boolean(P.on);
    $("#headerProBadge").hidden = !isPro;
    if (isPro && P.premium_until) {
      const until = new Date(P.premium_until).toLocaleDateString();
      $("#headerProBadge").title = `Pro active until ${until}`;
      $("#headerProBadge").setAttribute("aria-label", `Pro active until ${until}`);
    }
  }

  if ($("#badge")) {
    $("#badge").textContent = P.on
      ? "Pro until " + new Date(P.premium_until).toLocaleDateString()
      : isAdminUser
        ? "Admin"
        : freeQuestionsLimit > 0 || freeLimit > 0
          ? `Free · ${remainingQuestions} Q · ${remaining} AI left`
          : "Free";
  }

  if ($("#priceDisplay")) {
    $("#priceDisplay").innerHTML = `GH₵ ${esc(priceLabel)} <small>/ month</small>`;
  }
  if ($("#priceDesc")) {
    const parts = [];
    if (freeQuestionsLimit > 0) {
      parts.push(`${freeQuestionsLimit} free past question${freeQuestionsLimit === 1 ? "" : "s"}`);
    }
    if (freeLimit > 0) {
      parts.push(`${freeLimit} free AI tutor use${freeLimit === 1 ? "" : "s"}`);
    }
    $("#priceDesc").textContent = parts.length
      ? `Read every past question and enjoy unlimited AI tutor, predictions and quizzes. Free accounts include ${parts.join(" and ")} before upgrading to Pro.`
      : "Read every past question and enjoy unlimited AI tutor, predictions and quizzes.";
  }

  const qQuotaEl = $("#questionsQuotaLabel");
  if (qQuotaEl) {
    if (P.on || isAdminUser) {
      qQuotaEl.hidden = true;
      qQuotaEl.textContent = "";
    } else if (freeQuestionsLimit === 0) {
      qQuotaEl.hidden = false;
      qQuotaEl.textContent = `Free past paper reading is off — upgrade to Pro (GH₵${priceLabel}/month) to read full papers.`;
    } else if (remainingQuestions > 0) {
      qQuotaEl.hidden = false;
      qQuotaEl.textContent = `Free tier: ${remainingQuestions} of ${freeQuestionsLimit} free past question${freeQuestionsLimit === 1 ? "" : "s"} left before Pro (already opened papers stay accessible).`;
    } else {
      qQuotaEl.hidden = false;
      qQuotaEl.textContent = `Free past question limit reached (${freeQuestionsLimit}/${freeQuestionsLimit}). Upgrade to Pro (GH₵${priceLabel}/month) to read more papers.`;
    }
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
  try {
    const [profRes, adminRes] = await Promise.all([
      sb.from("profiles").select("*").single(),
      sb.from("admins").select("user_id").eq("user_id", user.id).maybeSingle(),
    ]);
    let settingsRes = await sb
      .from("app_settings")
      .select("price_ghs,free_ai_limit,free_questions_limit")
      .eq("id", 1)
      .maybeSingle();
    if (settingsRes?.error && /free_questions_limit/i.test(settingsRes.error.message || "")) {
      settingsRes = await sb.from("app_settings").select("price_ghs,free_ai_limit").eq("id", 1).maybeSingle();
    }
    if (profRes.error && !profRes.data) throw profRes.error;
    P = profRes.data || {};
    P.on = P.premium_until && new Date(P.premium_until) > new Date();
    isAdminUser = Boolean(adminRes?.data);
    if (settingsRes?.data) {
      appSettings = {
        price_ghs: Number(settingsRes.data.price_ghs) || 30,
        free_ai_limit:
          settingsRes.data.free_ai_limit !== null && settingsRes.data.free_ai_limit !== undefined
            ? Number(settingsRes.data.free_ai_limit)
            : 5,
        free_questions_limit:
          settingsRes.data.free_questions_limit !== null && settingsRes.data.free_questions_limit !== undefined
            ? Number(settingsRes.data.free_questions_limit)
            : 3,
      };
    }

    const [poRes, mRes] = await Promise.all([
      sb.from("payouts").select("*").order("created_at", { ascending: false }),
      sb.from("questions").select("*").eq("uploader", user.id).order("created_at", { ascending: false }),
    ]);
    myPayouts = poRes.data || [];
    myUploads = mRes.data || [];
    writeOfflineJson("meta", { P, isAdminUser, appSettings, myPayouts, myUploads });
  } catch {
    const cached = readOfflineJson("meta");
    if (cached && typeof cached === "object") {
      P = cached.P || {};
      P.on = P.premium_until && new Date(P.premium_until) > new Date();
      isAdminUser = Boolean(cached.isAdminUser);
      if (cached.appSettings) appSettings = cached.appSettings;
      myPayouts = Array.isArray(cached.myPayouts) ? cached.myPayouts : [];
      myUploads = Array.isArray(cached.myUploads) ? cached.myUploads : [];
    }
  }

  updatePricingAndQuotaUi();
  if ($("#bal")) $("#bal").textContent = fmt(P.balance || 0);
  if ($("#pays")) {
    $("#pays").innerHTML = myPayouts
      .map((p) => `<p>${fmt(p.amount)} · ${esc(p.status)}</p>`)
      .join("");
  }
  if ($("#mine")) {
    $("#mine").innerHTML = myUploads
      .map((q) => `<p>${esc(q.course_code)} ${q.year} · ${esc(q.status)}</p>`)
      .join("");
  }
  renderDashboard();
}

function resolveUserProgramme() {
  const api = window.uvKnustCourses;
  if (!api) return null;
  const meta = user?.user_metadata || {};
  const fromMeta = api.findProgramme(meta.programme_id || meta.programme);
  if (fromMeta) return fromMeta;

  const fromProfile = api.findProgramme(P?.programme_id || P?.programme);
  if (fromProfile) return fromProfile;

  try {
    if (user?.id) {
      const raw = localStorage.getItem(`uv_user_programme_${user.id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        const found = api.findProgramme(parsed?.id || parsed?.name);
        if (found) return found;
      }
    }
    const cleanEmail = String(user?.email || "").trim().toLowerCase();
    if (cleanEmail) {
      const byEmailRaw = localStorage.getItem("uv_prog_by_email");
      const byEmail = byEmailRaw ? JSON.parse(byEmailRaw) : {};
      if (byEmail?.[cleanEmail]) {
        const found = api.findProgramme(byEmail[cleanEmail]);
        if (found) return found;
      }
    }
    const lastProgId = localStorage.getItem("uv_last_programme_id");
    if (lastProgId) {
      const found = api.findProgramme(lastProgId);
      if (found) return found;
    }
  } catch {}
  return null;
}

function saveUserProgramme(prog) {
  if (!prog?.id) return;
  userProgramme = prog;
  try {
    if (user?.id) {
      localStorage.setItem(
        `uv_user_programme_${user.id}`,
        JSON.stringify({ id: prog.id, name: prog.name, college: prog.college, updatedAt: Date.now() })
      );
    }
    localStorage.setItem("uv_last_programme_id", prog.id);
    const cleanEmail = String(user?.email || "").trim().toLowerCase();
    if (cleanEmail) {
      const raw = localStorage.getItem("uv_prog_by_email");
      const map = raw ? JSON.parse(raw) : {};
      map[cleanEmail] = prog.id;
      localStorage.setItem("uv_prog_by_email", JSON.stringify(map));
    }
  } catch {}
}

function updateProgrammeUi() {
  const banner = $("#activeProgrammeBanner");
  const drawerProg = $("#drawerProg");

  if (banner) {
    if (isAdminUser) {
      banner.hidden = false;
      banner.textContent = "Admin access: viewing all KNUST departments and uploaded papers.";
    } else if (userProgramme) {
      banner.hidden = false;
      banner.innerHTML = `Programme: <strong>${esc(userProgramme.name)}</strong> (${esc(userProgramme.college)})`;
    } else {
      banner.hidden = true;
      banner.textContent = "";
    }
  }

  if (drawerProg) {
    if (userProgramme && !isAdminUser) {
      drawerProg.hidden = false;
      drawerProg.textContent = userProgramme.name;
    } else {
      drawerProg.hidden = true;
      drawerProg.textContent = "";
    }
  }
}

function populateModalProgrammeOptions(query = "", preferredId = "") {
  const sel = $("#modalProgSelect");
  const countEl = $("#modalProgCount");
  const hintEl = $("#modalProgHint");
  const api = window.uvKnustCourses;
  if (!sel || !api) return;

  const currentVal = preferredId || sel.value || "";
  const matches = api.searchProgrammes(query);
  const total = api.COURSES.length;

  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = matches.length
    ? query.trim()
      ? `Select matching KNUST course (${matches.length} found)...`
      : `Select your KNUST course offering (${total} courses)...`
    : "No matching KNUST courses — clear search";
  sel.append(def);

  api.COLLEGES.forEach((college) => {
    const items = matches.filter((c) => c.college === college);
    if (!items.length) return;
    const og = document.createElement("optgroup");
    og.label = college;
    items.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      og.append(opt);
    });
    sel.append(og);
  });

  sel.value = currentVal && matches.some((c) => c.id === currentVal) ? currentVal : "";
  if (countEl) {
    countEl.textContent = query.trim() ? `${matches.length} of ${total} programmes` : `${total} programmes`;
  }
  if (hintEl) {
    const picked = api.findProgramme(sel.value);
    hintEl.textContent = picked
      ? `${picked.college} · Questions and AI Tutor will filter for ${picked.name}.`
      : "Determines which KNUST past examination papers unlock in your vault.";
  }
}

function openProgrammeDialog(allowCancel = false) {
  if (userProgramme) return;
  const dlg = $("#programmeDialog");
  if (!dlg || !window.uvKnustCourses) return;
  if ($("#modalProgSearch")) $("#modalProgSearch").value = "";
  if ($("#modalProgMsg")) {
    $("#modalProgMsg").hidden = true;
    $("#modalProgMsg").textContent = "";
  }
  populateModalProgrammeOptions("", "");
  if ($("#modalProgCancel")) $("#modalProgCancel").hidden = !allowCancel;
  dlg.dataset.required = allowCancel ? "0" : "1";
  if (!dlg.open) dlg.showModal();
}

if ($("#modalProgCancel")) {
  $("#modalProgCancel").onclick = () => {
    const dlg = $("#programmeDialog");
    if (dlg?.open) dlg.close();
  };
}

if ($("#modalProgSearch")) {
  $("#modalProgSearch").addEventListener("input", (e) => {
    populateModalProgrammeOptions(e.target.value, $("#modalProgSelect")?.value || "");
  });
}

if ($("#modalProgSelect")) {
  $("#modalProgSelect").addEventListener("change", () => {
    const picked = window.uvKnustCourses?.findProgramme($("#modalProgSelect").value);
    if ($("#modalProgHint")) {
      $("#modalProgHint").textContent = picked
        ? `${picked.college} · Questions and AI Tutor will filter for ${picked.name}.`
        : "Determines which KNUST past examination papers unlock in your vault.";
    }
  });
}

if ($("#programmeDialog")) {
  $("#programmeDialog").addEventListener("cancel", (e) => {
    if ($("#programmeDialog").dataset.required === "1") {
      e.preventDefault();
    }
  });
}

if ($("#programmeDialogForm")) {
  $("#programmeDialogForm").onsubmit = async (e) => {
    e.preventDefault();
    if (userProgramme) {
      if ($("#programmeDialog")?.open) $("#programmeDialog").close();
      return;
    }
    const msgEl = $("#modalProgMsg");
    const saveBtn = $("#modalProgSave");
    const picked = window.uvKnustCourses?.findProgramme($("#modalProgSelect")?.value || "");
    if (!picked) {
      if (msgEl) {
        msgEl.hidden = false;
        msgEl.textContent = "Please choose your KNUST course offering from the list.";
      }
      return;
    }

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
    }
    try {
      saveUserProgramme(picked);
      if (typeof sb?.auth?.updateUser === "function") {
        await sb.auth
          .updateUser({
            data: {
              programme: picked.name,
              programme_id: picked.id,
              programme_college: picked.college,
            },
          })
          .catch(() => {});
      }
      if (user?.id && typeof sb?.from === "function") {
        await sb
          .from("profiles")
          .update({ programme_id: picked.id, programme: picked.name })
          .eq("id", user.id)
          .catch(() => {});
      }
      updateProgrammeUi();
      applyProgrammeAccessFilter();
      if ($("#programmeDialog")?.open) $("#programmeDialog").close();
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Programme";
      }
    }
  };
}

function applyProgrammeAccessFilter() {
  const api = window.uvKnustCourses;
  if (!isAdminUser && userProgramme && api) {
    Q = api.filterQuestionsForProgramme(ALL_Q, userProgramme);
  } else {
    Q = ALL_Q.slice();
  }

  const deps = [...new Set(Q.map((q) => q.department))].sort();
  const codes = [...new Set(Q.map((q) => q.course_code))].sort();
  if ($("#homeStatPapers")) $("#homeStatPapers").textContent = String(Q.length);
  if ($("#homeStatCourses")) $("#homeStatCourses").textContent = String(codes.length);
  if ($("#homeStatDepts")) $("#homeStatDepts").textContent = String(deps.length);

  const prevDep = $("#dep").value || initialParams.get("dep") || "";
  $("#dep").innerHTML =
    '<option value="">All accessible departments</option>' +
    deps.map((d) => `<option>${esc(d)}</option>`).join("");
  if (prevDep && deps.includes(prevDep)) $("#dep").value = prevDep;

  const initQ = initialParams.get("q");
  if (initQ && !$("#search").value) $("#search").value = initQ;

  document.querySelectorAll(".courses").forEach((s) => {
    const prevCourse = s.value;
    const opts = codes.map((c) => `<option>${esc(c)}</option>`).join("");
    s.innerHTML =
      s.id === "chatCourse"
        ? opts + '<option value="">General (any course in programme)</option>'
        : opts || '<option value="">General (programme focus)</option>';
    if (prevCourse && codes.includes(prevCourse)) s.value = prevCourse;
  });

  render(false);
}

async function load() {
  isUsingOfflineCache = false;
  try {
    const { data, error } = await sb
      .from("questions")
      .select("*")
      .eq("status", "approved")
      .order("year", { ascending: false });
    if (error || !Array.isArray(data)) {
      throw error || new Error("Could not fetch past papers.");
    }
    ALL_Q = data;
    writeOfflineJson("q", { items: ALL_Q, savedAt: Date.now() });
  } catch {
    const cached = readOfflineJson("q");
    if (cached && Array.isArray(cached.items)) {
      ALL_Q = cached.items;
      isUsingOfflineCache = true;
    } else {
      ALL_Q = [];
    }
  }

  updateProgrammeUi();
  applyProgrammeAccessFilter();
}

function render(syncUrl = true) {
  const d = $("#dep").value,
    raw = $("#search").value.trim(),
    t = raw.toLowerCase(),
    by = {};
  const offlinePapers = getOfflinePapersMap();
  const offlineCount = Q.filter((q) => Boolean(offlinePapers[q.id]?.content)).length;
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
  const offlineSuffix =
    offlineCount > 0 ? ` · ${offlineCount} paper${offlineCount === 1 ? "" : "s"} saved offline` : "";
  const cacheModeSuffix = isUsingOfflineCache ? " · Offline cache" : "";
  const scopeLabel = !isAdminUser && userProgramme ? ` for ${userProgramme.name}` : "";
  $("#browseMeta").textContent = Q.length
    ? `Showing ${courses.length} course${courses.length === 1 ? "" : "s"} · ${filtered.length} paper${filtered.length === 1 ? "" : "s"}${scopeLabel}${offlineSuffix}${cacheModeSuffix}`
    : isUsingOfflineCache
      ? "Offline mode — no previously cached questions found for this programme yet."
      : ALL_Q.length && !isAdminUser && userProgramme
        ? `No uploaded past papers match ${userProgramme.name} yet.`
        : "No approved questions published yet.";
  $("#list").innerHTML =
    courses
      .map(
        ([c, v]) =>
          `<article class="card archive-card uv-reveal"><div><div class="card-meta"><span>${esc(v.d)}</span><span class="card-count">${v.i.length} paper${v.i.length === 1 ? "" : "s"}</span></div><h3>${esc(c)}<span>${esc(v.t || "Past Examination Papers")}</span></h3>${v.desc ? `<p class="card-note">${esc(v.desc)}</p>` : ""}</div><div class="chips">${v.i
            .map((q) => {
              const saved = Boolean(offlinePapers[q.id]?.content);
              return `<button type="button" data-id="${q.id}"${saved ? ' data-cached="1" title="Available offline"' : ""}>${q.year}${q.semester ? " · S" + q.semester : ""}</button>`;
            })
            .join("")}</div></article>`
      )
      .join("") ||
    `<div class="card"><p style="color:var(--mut)">${Q.length ? "No accessible past papers match your search." : ALL_Q.length && !isAdminUser && userProgramme ? `No uploaded past papers match ${esc(userProgramme.name)} yet. You can upload one under Upload &amp; Earn.` : "No approved questions yet."}</p></div>`;
  window.uvRevealObserve?.($("#list"), { fresh: Boolean(syncUrl) });
}

function debounceSearch(fn, wait = 260) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
const debouncedArchiveRender = debounceSearch(() => render(true), 260);
$("#dep").onchange = () => {
  debouncedArchiveRender.cancel();
  render(true);
};
$("#search").oninput = () => {
  $("#clearSearch").hidden = !$("#dep").value && !$("#search").value.trim();
  debouncedArchiveRender();
};
$("#search").onkeydown = (e) => {
  if (e.key === "Enter") {
    debouncedArchiveRender.cancel();
    render(true);
  }
};
$("#clearSearch").onclick = () => {
  debouncedArchiveRender.cancel();
  $("#dep").value = "";
  $("#search").value = "";
  render(true);
  $("#search").focus();
};

let readerMathLoadBound = false;

function typesetMathInReader(el) {
  if (!el) return;
  if (typeof window.renderMathInElement === "function") {
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
        strict: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      });
    } catch {}
    return;
  }
  if (!readerMathLoadBound) {
    readerMathLoadBound = true;
    window.addEventListener(
      "load",
      () => {
        const rb = $("#rb");
        if (rb && $("#readerSheet")?.dataset?.state === "paper") {
          typesetMathInReader(rb);
        }
      },
      { once: true }
    );
  }
}

function splitDenseExamLines(segment) {
  let s = String(segment || "");
  // 1. Break inline "Question N:" / "Q.N." onto its own line
  s = s.replace(/([^\n])\s+((?:Question|Q\.?)\s*\d+[A-Za-z]?\s*[:.)\-])/gi, "$1\n$2");
  s = s.replace(/([.?!;])\s*((?:Question|Q\.?)\s*\d+[A-Za-z]?\s*[:.)\-])/gi, "$1\n$2");
  // 2. Break inline "Answer:" / "Solution:" onto its own line
  s = s.replace(/([^\n])\s+((?:Correct\s+)?Answer|Ans|Solution|Explanation)\s*:/gi, "$1\n$2:");
  // 3. Break inline numbered questions after sentence endings (e.g. "... 2. Find ...")
  s = s.replace(/([.?!])\s+(\d{1,2}\.\s+(?=[A-Z][a-z]{2,}))/g, "$1\n$2");
  // 4. Break inline MCQ options (A. ... B. ... C. ... D. ...) onto separate lines
  s = s
    .split("\n")
    .map((line) => {
      if (/^(?:Correct\s+)?(?:Answer|Ans|Solution|Explanation)\s*:/i.test(line.trim())) {
        return line;
      }
      if (/(?:^|[\s?:.)])A\.\s+[\s\S]*\sB\.\s+/.test(line) || /\sB\.\s+[\s\S]*\sC\.\s+/.test(line)) {
        return line.replace(/\s+([A-E]\.)\s+/g, "\n$1 ");
      }
      if (/(?:^|[\s?:.)])\(A\)\s+[\s\S]*\s\(B\)\s+/.test(line) || /\s\(B\)\s+[\s\S]*\s\(C\)\s+/.test(line)) {
        return line.replace(/\s+(\([A-E]\))\s+/g, "\n$1 ");
      }
      return line;
    })
    .join("\n");
  return s;
}

function autoDelimitBareLatex(segment) {
  let out = String(segment || "");
  const cmdWith2Args = /\\(?:frac|dfrac|tfrac|cfrac|binom)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
  const cmdWith1Arg = /\\(?:sqrt(?:\[[^\]]*\])?|bar|overline|underline|hat|vec|widetilde|widehat|mathbf|mathrm|mathit|mathcal|text)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g;
  const bigOp = /\\(?:int|iint|iiint|oint|sum|prod|lim|bigcup|bigcap)(?:\s*_(?:\{[^{}]*\}|[A-Za-z0-9\\]+))?(?:\s*\^(?:\{[^{}]*\}|[A-Za-z0-9\\]+))?/g;
  const mathSymbols = /\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|infty|partial|nabla|pm|mp|times|div|cdot|leq|le|geq|ge|neq|ne|approx|equiv|propto|forall|exists|in|notin|subset|subseteq|cup|cap|rightarrow|to|leftarrow|Rightarrow|Leftrightarrow|degree)\b/g;

  const wrapInline = (m) => `$${m}$`;
  const stash = [];
  const pushStash = (tex) => {
    const idx = stash.length;
    stash.push(tex);
    return `\u0000LTX${idx}\u0000`;
  };
  const stashWrap = (rx) => {
    out = out.replace(rx, (m) => pushStash(m));
  };

  stashWrap(cmdWith2Args);
  stashWrap(cmdWith1Arg);
  stashWrap(bigOp);
  stashWrap(mathSymbols);

  // Plain sqrt(...) -> \sqrt{...}
  out = out.replace(/\bsqrt\s*\(([^()\n]+)\)/gi, (_m, inner) => pushStash(`\\sqrt{${inner.trim()}}`));

  // Plain limit expressions: "lim(n->oo)", "lim un", "lim a_n"
  out = out.replace(
    /\blim\s*\(?\s*([a-zA-Z])\s*(?:->|→)\s*(infinity|infty|inf|oo|∞|-?\d+|[a-zA-Z])\s*\)?/g,
    (_m, v, tgt) => {
      const cleanTgt = /^(infinity|infty|inf|oo|∞)$/i.test(tgt) ? "\\infty" : tgt;
      return pushStash(`\\lim_{${v} \\to ${cleanTgt}}`);
    }
  );
  out = out.replace(/\blim\s+([a-zA-Z])([nmk])\b/g, (_m, a, b) => pushStash(`\\lim ${a}_{${b}}`));
  out = out.replace(/\blim\s+([a-zA-Z]_[A-Za-z0-9{}]+)/g, (_m, sub) => pushStash(`\\lim ${sub}`));

  // Plain numeric fractions (e.g. 26/3, 1/2, -3/4) avoiding dates (12/05/2024)
  out = out.replace(
    /(^|[\s=(+\-*,:;\[{])(-?\d{1,4})\/(\d{1,4})(?=$|[\s)=+\-*,.;:!?\]{}])/g,
    (_m, pre, num, den) => {
      const neg = num.startsWith("-") ? "-" : "";
      const absNum = neg ? num.slice(1) : num;
      return `${pre}${pushStash(`${neg}\\frac{${absNum}}{${den}}`)}`;
    }
  );

  // Plain calculus/algebraic fractions (e.g. dy/dx, 1/n^p, x^2/2, 1/x)
  out = out.replace(
    /(^|[\s=(+\-*,])(d\^?\d?[a-zA-Z]|\d+|[a-zA-Z](?:\^[A-Za-z0-9{}]+)?)\/([a-zA-Z]\^[A-Za-z0-9{}]+|d[a-zA-Z]\^?\d?|[a-zA-Z]\d*)(?=$|[\s)=+\-*,.;:!?])/g,
    (m, pre, num, den) => {
      const looksMath = /\d|\^|^d[a-zA-Z]/.test(num) || /\d|\^|^d[a-zA-Z]/.test(den);
      if (!looksMath) return m;
      return `${pre}${pushStash(`\\frac{${num}}{${den}}`)}`;
    }
  );

  // Algebraic powers/subscripts like x^2, (a+b)^{n}, n^p, x_1, a_{ij}
  out = out.replace(
    /(^|[^A-Za-z0-9_\\])(\([^()\n]{1,24}\)|[A-Za-z0-9])((?:\^(?:\{[^{}\n]+\}|-?[A-Za-z0-9]+)|_(?:\{[^{}\n]+\}|\d{1,3}))+)/g,
    (_m, pre, base, exp) => `${pre}${pushStash(base + exp)}`
  );

  // Clean relational expressions like "p > 1", "p <= 0", "n >= 1", "x != 0"
  out = out.replace(
    /(^|[\s(,;:])([a-zA-Z])\s*(<=|>=|!=|=|<|>)\s*(-?\d+(?:\.\d+)?|\u0000LTX\d+\u0000|[a-zA-Z])(?=$|[\s).,;:!?])/g,
    (_m, pre, lhs, op, rhs) => {
      const opMap = { "<=": "\\le", ">=": "\\ge", "!=": "\\neq" };
      const cleanOp = opMap[op] || op;
      const expandedRhs = rhs.replace(/\u0000LTX(\d+)\u0000/g, (_x, i) => stash[Number(i)]);
      return `${pre}${pushStash(`${lhs} ${cleanOp} ${expandedRhs}`)}`;
    }
  );

  // Merge adjacent math chunks separated by operators or trailing numbers (e.g. "lim u_n = 0", "lim u_n = 1/2")
  out = out.replace(
    /\u0000LTX(\d+)\u0000(?:\s*(?:<=|>=|!=|->|[=+\-*/^_,;()<>|]|&|ln|sin|cos|tan|log|dx|dy|dt|dz)\s*(?:\u0000LTX(\d+)\u0000|-?\d+(?:\.\d+)?|[a-zA-Z](?![a-zA-Z])))+/g,
    (seq) => {
      const expanded = seq
        .replace(/\u0000LTX(\d+)\u0000/g, (_m, i) => stash[Number(i)])
        .replace(/<=/g, "\\le")
        .replace(/>=/g, "\\ge")
        .replace(/!=/g, "\\neq")
        .replace(/->/g, "\\to");
      return pushStash(expanded);
    }
  );

  return out.replace(/\u0000LTX(\d+)\u0000/g, (_m, i) => wrapInline(stash[Number(i)]));
}

function tokenizeExamMath(rawText) {
  const tokens = [];
  const displaySet = new Set();
  const pushToken = (tex, isDisplay) => {
    const idx = tokens.length;
    tokens.push(tex);
    if (isDisplay) displaySet.add(idx);
    return `@@UVMATH_${idx}@@`;
  };

  let text = String(rawText || "").replace(/\r\n?/g, "\n");

  // 1. Display math $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (m) => pushToken(m, true));
  // 2. Display math \[...\]
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (m) => pushToken(m, true));
  // 3. Bare LaTeX block environments (\begin{align}...\end{align}, cases, matrix, etc.)
  text = text.replace(
    /\\begin\{(equation\*?|align\*?|aligned|gather\*?|cases|pmatrix|bmatrix|vmatrix|matrix|array)\}[\s\S]*?\\end\{\1\}/g,
    (m) => pushToken(`$$${m}$$`, true)
  );
  // 4. Inline math \(...\)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (m) => pushToken(m, false));
  // 5. Inline math $...$ (guarding currency ranges like "$20 and $30")
  text = text.replace(/\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$/g, (m, inner) => {
    if (/^\d/.test(inner) && /\s[a-z]{3,}\s/i.test(inner)) return m;
    return pushToken(m, false);
  });

  // 6. Split dense inline questions/options/answers & auto-delimit bare math ONLY outside existing math tokens
  text = text
    .split(/(@@UVMATH_\d+@@)/g)
    .map((part) => {
      if (!part || /^@@UVMATH_\d+@@$/.test(part)) return part;
      const splitPart = splitDenseExamLines(part);
      const delimited = autoDelimitBareLatex(splitPart);
      return delimited.replace(/\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$/g, (m) => pushToken(m, false));
    })
    .join("");

  return { text, tokens, displaySet };
}

function formatInlineExamHtml(rawLine, tokens) {
  let html = esc(rawLine);
  // Strong/italic markdown emphasis produced by OCR/AI cleanup
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|\s)\*([^*\n]+?)\*(?=\s|[.,;:!?)]|$)/g, "$1<em>$2</em>");
  // Highlight exam mark allocations like [10 marks], (5 marks), [4 mks]
  html = html.replace(
    /(\[\s*\d+(?:\.\d+)?\s*(?:marks?|mks?|pts?|points?|%)\s*\]|\(\s*\d+(?:\.\d+)?\s*(?:marks?|mks?|pts?|points?)\s*\))/gi,
    '<span class="exam-marks">$1</span>'
  );
  // Restore tokenized math cleanly inside HTML-escaped text nodes for KaTeX
  html = html.replace(/@@UVMATH_(\d+)@@/g, (_m, i) => esc(tokens[Number(i)] || ""));
  return html;
}

function formatExamPaperHtml(rawText) {
  const { text, tokens, displaySet } = tokenizeExamMath(rawText);
  const lines = text.split("\n");
  const blocks = [];
  let mcqBuffer = [];

  const flushMcq = () => {
    if (!mcqBuffer.length) return;
    blocks.push(`<div class="exam-mcq-list">${mcqBuffer.join("")}</div>`);
    mcqBuffer = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flushMcq();
      continue;
    }

    // Multiple-choice option lines: "A. ...", "(A) ..." (uppercase A-E)
    const mcqMatch = t.match(/^(?:([A-E])\.|\(([A-E])\))\s+(.*)$/);
    if (mcqMatch) {
      const key = `${mcqMatch[1] || mcqMatch[2]}.`;
      const val = mcqMatch[3] || "";
      mcqBuffer.push(
        `<div class="exam-mcq-opt"><span class="exam-mcq-key">${esc(key)}</span><div class="exam-mcq-val">${formatInlineExamHtml(val, tokens)}</div></div>`
      );
      continue;
    }

    flushMcq();

    // Horizontal rule dividers
    if (/^([-=_*])\1{2,}$/.test(t)) {
      blocks.push('<hr class="exam-hr">');
      continue;
    }

    // Standalone display-math line
    const soleMath = t.match(/^@@UVMATH_(\d+)@@$/);
    if (soleMath && displaySet.has(Number(soleMath[1]))) {
      blocks.push(`<div class="exam-math-block">${esc(tokens[Number(soleMath[1])] || "")}</div>`);
      continue;
    }

    // Markdown headings
    const mdHead = t.match(/^#{1,4}\s+(.+)$/);
    if (mdHead) {
      blocks.push(`<h5 class="exam-sec-head">${formatInlineExamHtml(mdHead[1], tokens)}</h5>`);
      continue;
    }

    // Formal exam section / instruction headings
    if (
      /^(?:SECTION|PART)\s+[A-Z0-9]+\b/i.test(t) ||
      /^(?:INSTRUCTIONS?(?:\s+TO\s+CANDIDATES)?|GENERAL\s+INSTRUCTIONS?|ANSWER\s+ALL\b|TIME\s+ALLOWED\b)/i.test(t)
    ) {
      blocks.push(`<h5 class="exam-sec-head">${formatInlineExamHtml(t, tokens)}</h5>`);
      continue;
    }

    // Answer / Solution key line
    const ansMatch = t.match(/^((?:Correct\s+)?Answer|Ans|Solution|Explanation)\s*:\s*(.*)$/i);
    if (ansMatch) {
      blocks.push(
        `<div class="exam-answer-line"><span class="exam-answer-tag">${esc(ansMatch[1])}</span><span>${formatInlineExamHtml(ansMatch[2], tokens)}</span></div>`
      );
      continue;
    }

    // Numbered main questions: "Question 1 ...", "Q1.", "1. ..."
    const qMatch = t.match(/^(?:(?:Question|Q\.?)\s*(\d+[A-Za-z]?)\s*[:.)\-]?\s*|(\d{1,2})\.\s+)(.*)$/i);
    if (qMatch) {
      const label = qMatch[1] ? `Question ${qMatch[1]}.` : `${qMatch[2]}.`;
      const rest = qMatch[3] || "";
      blocks.push(
        `<div class="exam-q-head"><span class="exam-q-num">${esc(label)}</span><div class="exam-q-text">${formatInlineExamHtml(rest, tokens)}</div></div>`
      );
      continue;
    }

    // Sub-questions: "(a) ...", "(ii) ...", "a) ..."
    const subMatch = t.match(/^(?:\(([a-z]|[ivx]{1,5})\)|([a-z]|[ivx]{1,5})\))\s+(.*)$/i);
    if (subMatch) {
      const subLbl = `(${subMatch[1] || subMatch[2]})`;
      const rest = subMatch[3] || "";
      blocks.push(
        `<div class="exam-subq"><span class="exam-subq-label">${esc(subLbl)}</span><div class="exam-subq-body">${formatInlineExamHtml(rest, tokens)}</div></div>`
      );
      continue;
    }

    // Bullet items
    const bulletMatch = t.match(/^(?:[-•*])\s+(.*)$/);
    if (bulletMatch) {
      blocks.push(
        `<div class="exam-bullet"><span class="exam-bullet-dot" aria-hidden="true">•</span><div>${formatInlineExamHtml(bulletMatch[1], tokens)}</div></div>`
      );
      continue;
    }

    blocks.push(`<p class="exam-p">${formatInlineExamHtml(t, tokens)}</p>`);
  }

  flushMcq();
  return blocks.join("");
}

function setReaderView({ title, body = "", paper = null, isPaper = false, isLoading = false }) {
  if ($("#rt")) $("#rt").textContent = title || "Past Question";
  const sheet = $("#readerSheet");
  const masthead = $("#readerMasthead");
  const rb = $("#rb");
  const printBtn = $("#printPaperBtn");
  const downloadBtn = $("#downloadPaperBtn");

  if (sheet) {
    sheet.dataset.state = isPaper ? "paper" : "status";
  }

  if (masthead && paper && (isPaper || isLoading)) {
    masthead.hidden = false;
    if ($("#readerDept")) {
      $("#readerDept").textContent = paper.department || "Academic Examination Archive";
    }
    if ($("#readerCourseLine")) {
      const code = paper.course_code || "";
      const ctitle = paper.course_title || "";
      $("#readerCourseLine").textContent = ctitle ? `${code} — ${ctitle}` : code;
    }
    if ($("#readerTermLine")) {
      const termParts = [];
      if (paper.year) termParts.push(String(paper.year));
      if (paper.semester) termParts.push(`Semester ${paper.semester}`);
      $("#readerTermLine").textContent = termParts.join(" · ");
    }
    if ($("#readerNotes")) {
      if (isPaper && paper.description) {
        $("#readerNotes").textContent = paper.description;
        $("#readerNotes").hidden = false;
      } else {
        $("#readerNotes").textContent = "";
        $("#readerNotes").hidden = true;
      }
    }
  } else if (masthead) {
    masthead.hidden = true;
  }

  if (rb) {
    if (isPaper) {
      rb.innerHTML = formatExamPaperHtml(body);
      typesetMathInReader(rb);
    } else {
      rb.innerHTML = `<div class="pdf-status-note${isLoading ? " is-loading" : ""}">${esc(body)}</div>`;
    }
  }

  if (printBtn) {
    printBtn.hidden = !isPaper;
  }
  if (downloadBtn) {
    downloadBtn.hidden = !isPaper;
  }
  if (isPaper) {
    setTimeout(() => ensureHtml2PdfLoaded().catch(() => {}), 400);
  }

  const stage = $("#reader .pdf-stage");
  if (stage) stage.scrollTop = 0;
}

let html2pdfLoaderPromise = null;

function ensureHtml2PdfLoaded() {
  if (typeof window.html2pdf === "function") {
    return Promise.resolve(window.html2pdf);
  }
  if (html2pdfLoaderPromise) return html2pdfLoaderPromise;

  html2pdfLoaderPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-uv-html2pdf="1"]');
    if (existing) {
      existing.addEventListener("load", () =>
        typeof window.html2pdf === "function" ? resolve(window.html2pdf) : reject(new Error("html2pdf unavailable"))
      );
      existing.addEventListener("error", () => {
        html2pdfLoaderPromise = null;
        reject(new Error("Failed to load PDF generator"));
      });
      return;
    }

    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js";
    s.crossOrigin = "anonymous";
    s.async = true;
    s.dataset.uvHtml2pdf = "1";

    const timer = setTimeout(() => {
      html2pdfLoaderPromise = null;
      reject(new Error("PDF generator load timed out"));
    }, 15000);

    s.onload = () => {
      clearTimeout(timer);
      if (typeof window.html2pdf === "function") {
        resolve(window.html2pdf);
      } else {
        html2pdfLoaderPromise = null;
        reject(new Error("html2pdf unavailable"));
      }
    };
    s.onerror = () => {
      clearTimeout(timer);
      html2pdfLoaderPromise = null;
      reject(new Error("Failed to load PDF generator"));
    };
    document.head.appendChild(s);
  });

  return html2pdfLoaderPromise;
}

function buildSafePaperFilename(paper) {
  const parts = [
    paper?.course_code || "KNUST-Exam-Paper",
    paper?.year || "",
    paper?.semester ? `Sem-${paper.semester}` : "",
  ].filter(Boolean);
  return (
    parts
      .join("-")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "UniVault-Exam-Paper"
  );
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
}

function downloadStandaloneExamHtml(paper, sheetEl) {
  const clone = sheetEl.cloneNode(true);
  clone.querySelectorAll("img").forEach((img) => {
    try {
      const c = document.createElement("canvas");
      if (img.naturalWidth && img.naturalHeight) {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d")?.drawImage(img, 0, 0);
        img.src = c.toDataURL("image/png");
      }
    } catch {}
  });
  const docTitle = buildSafePaperFilename(paper);
  const htmlDoc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(docTitle)} — KNUST UniVault</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" crossorigin="anonymous">
<style>
  body { margin: 0; padding: 28px 16px; background: #e2e8f0; color: #111827; font-family: Georgia, "Times New Roman", serif; }
  .pdf-sheet { max-width: 760px; margin: 0 auto; background: #ffffff; padding: 44px 48px; border: 1px solid #cbd5e1; font-size: 16.5px; line-height: 1.72; }
  .pdf-masthead { text-align: center; padding-bottom: 16px; margin-bottom: 22px; border-bottom: 2px solid #0f172a; }
  .pdf-crest { width: 44px; height: auto; display: block; margin: 0 auto 8px; }
  .pdf-uni { margin: 0; font-size: 0.92rem; font-weight: 700; letter-spacing: 0.06em; color: #0f172a; }
  .pdf-dept, .pdf-term-line { margin: 3px 0 0; font-size: 0.9rem; font-weight: 600; color: #334155; }
  .pdf-course-line { margin: 12px 0 2px; font-size: 1.08rem; font-weight: 700; color: #0f172a; }
  .pdf-notes-line { margin: 8px auto 0; font-size: 0.9rem; font-style: italic; color: #475569; }
  .exam-sec-head { margin: 22px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #cbd5e1; font-size: 0.98rem; font-weight: 700; text-transform: uppercase; color: #0f172a; }
  .exam-q-head { display: grid; grid-template-columns: auto 1fr; gap: 10px; margin: 18px 0 8px; }
  .exam-q-head:not(:first-child) { padding-top: 14px; border-top: 1px solid #e2e8f0; }
  .exam-q-num, .exam-mcq-key { font-weight: 700; color: #0f172a; white-space: nowrap; }
  .exam-subq, .exam-bullet { display: grid; grid-template-columns: auto 1fr; gap: 10px; margin: 8px 0 8px 24px; }
  .exam-mcq-list { display: grid; gap: 7px; margin: 10px 0 10px 24px; }
  .exam-mcq-opt { display: grid; grid-template-columns: 28px 1fr; gap: 8px; }
  .exam-answer-line { margin: 8px 0 6px 24px; padding: 6px 11px; background: #f8fafc; border-left: 3px solid #1d4ed8; font-size: 0.94em; }
  .exam-answer-tag { font-weight: 700; text-transform: uppercase; color: #1e40af; margin-right: 6px; }
  .exam-marks { font-size: 0.82em; font-weight: 600; color: #334155; }
  .exam-hr { border: 0; border-top: 1px solid #cbd5e1; margin: 18px 0; }
  @media print { body { background: #fff; padding: 0; } .pdf-sheet { border: 0; padding: 0; max-width: none; } }
</style>
</head>
<body>${clone.outerHTML}</body>
</html>`;
  triggerBlobDownload(new Blob([htmlDoc], { type: "text/html;charset=utf-8" }), `${docTitle}.html`);
}

async function downloadCurrentPaper() {
  const sheet = $("#readerSheet");
  const btn = $("#downloadPaperBtn");
  if (!sheet || sheet.dataset.state !== "paper" || !cur?.content) return;

  const labelEl = btn?.querySelector("span");
  const prevLabel = labelEl ? labelEl.textContent : "";
  if (btn) btn.disabled = true;
  if (labelEl) labelEl.textContent = "Preparing PDF...";

  let host = null;
  try {
    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    }
    const html2pdfFn = await ensureHtml2PdfLoaded();
    const baseName = buildSafePaperFilename(cur);

    host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:740px;background:#ffffff;z-index:-1;pointer-events:none;";

    const exportSheet = sheet.cloneNode(true);
    exportSheet.removeAttribute("id");
    exportSheet.style.cssText =
      "max-width:none;width:740px;margin:0;padding:32px 38px;border:0;border-radius:0;box-shadow:none;background:#ffffff;color:#111827;";
    // Remove hidden MathML duplicates so html2canvas renders crisp KaTeX glyphs only once
    exportSheet.querySelectorAll(".katex-mathml").forEach((el) => el.remove());

    host.appendChild(exportSheet);
    document.body.appendChild(host);

    await html2pdfFn()
      .set({
        margin: [12, 12, 14, 12],
        filename: `${baseName}.pdf`,
        image: { type: "jpeg", quality: 0.96 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
          scrollX: 0,
          scrollY: 0,
          windowWidth: 740,
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: {
          mode: ["css", "legacy"],
          avoid: [".exam-q-head", ".exam-subq", ".exam-mcq-opt", ".exam-answer-line", ".pdf-masthead"],
        },
      })
      .from(exportSheet)
      .save();
  } catch (err) {
    console.warn("PDF export failed, falling back to printable sheet HTML:", err);
    downloadStandaloneExamHtml(cur, sheet);
  } finally {
    if (host) host.remove();
    if (btn) btn.disabled = false;
    if (labelEl) labelEl.textContent = prevLabel || "Download PDF";
  }
}

if ($("#downloadPaperBtn")) {
  $("#downloadPaperBtn").onclick = () => {
    downloadCurrentPaper();
  };
}

if ($("#printPaperBtn")) {
  $("#printPaperBtn").onclick = () => {
    window.print();
  };
}

function openReaderModal() {
  const dlg = $("#reader");
  if (!dlg) return;
  if (!dlg.open) {
    try {
      dlg.showModal();
    } catch {
      dlg.setAttribute("open", "");
    }
  }
}

async function openPaperById(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return;

  const found = Q.find((q) => String(q.id) === id);
  if (!found) {
    const outOfScope = ALL_Q.find((q) => String(q.id) === id);
    if (outOfScope && !isAdminUser && userProgramme) {
      setReaderView({
        title: `${outOfScope.course_code} · Outside ${userProgramme.name}`,
        body: `This paper (${outOfScope.department || outOfScope.course_code}) is outside your registered KNUST programme (${userProgramme.name}).`,
      });
    } else {
      setReaderView({
        title: "Past Question Unavailable",
        body: "This past question could not be found in your current archive view, or it has not been approved yet.",
      });
    }
    $("#solve").hidden = true;
    if ($("#explainPaper")) $("#explainPaper").hidden = true;
    if ($("#upgradeFromReader")) $("#upgradeFromReader").hidden = true;
    openReaderModal();
    return;
  }

  cur = found;
  syncUrlParams({ paper: id, view: null });
  const paperHeaderTitle = `${cur.course_code} · ${cur.year}${cur.semester ? " Sem " + cur.semester : ""}`;
  setReaderView({
    title: paperHeaderTitle,
    body: "Formatting past paper for reading...",
    paper: cur,
    isLoading: true,
  });
  $("#solve").hidden = true;
  if ($("#explainPaper")) $("#explainPaper").hidden = true;
  if ($("#upgradeFromReader")) $("#upgradeFromReader").hidden = true;
  openReaderModal();

  const isSchemaOrRpcError = (err) => {
    if (!err) return false;
    const code = String(err.code || "");
    const msg = String(err.message || err.details || err.hint || "");
    return (
      /^(42883|42703|42P01|42501|PGRST\d+)$/i.test(code) ||
      /could not find|does not exist|schema cache|open_past_question|free_question|permission denied|pgrst/i.test(msg)
    );
  };
  const isNetworkFailure = (err) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    const msg = String(err?.message || err || "");
    return /failed to fetch|networkerror|load failed|network request failed|err_internet|timed out/i.test(msg);
  };

  let content = "";
  let hasAccess = false;
  let networkFailed = false;
  let schemaNeedsMigration = false;
  let blockedReason = "";
  let lastErrorMessage = "";

  const applyRpcPayload = (rpcData) => {
    if (!rpcData || typeof rpcData !== "object") return false;
    if (typeof rpcData.limit === "number") {
      appSettings.free_questions_limit = rpcData.limit;
    }
    if (Array.isArray(rpcData.free_question_ids)) {
      P.free_question_ids = rpcData.free_question_ids;
    }
    if (rpcData.allowed) {
      hasAccess = true;
      content = typeof rpcData.content === "string" ? rpcData.content : "";
      if (
        !rpcData.unlimited &&
        (!Array.isArray(P.free_question_ids) || !P.free_question_ids.includes(id))
      ) {
        P.free_question_ids = [...(Array.isArray(P.free_question_ids) ? P.free_question_ids : []), id];
      }
      if (content) {
        saveOfflinePaper(cur, content);
      }
      updatePricingAndQuotaUi(undefined, rpcData.unlimited ? undefined : rpcData.remaining);
      writeOfflineJson("meta", { P, isAdminUser, appSettings, myPayouts, myUploads });
      render(false);
    } else if (rpcData.not_found) {
      blockedReason = "This past question could not be found in the database.";
    } else {
      const lim = Number(rpcData.limit ?? appSettings.free_questions_limit ?? 3);
      const used = Number(rpcData.used ?? lim);
      updatePricingAndQuotaUi(undefined, 0);
      blockedReason =
        lim === 0
          ? `Subscribe to Pro (GH₵${formatPriceGhs(C.PRICE_GHS)}/month) to read full past papers.`
          : `You have reached your free limit of ${used} of ${lim} past question${lim === 1 ? "" : "s"}. Upgrade to Pro (GH₵${formatPriceGhs(C.PRICE_GHS)}/month) for unlimited access.`;
    }
    return true;
  };

  try {
    const { data: rpcData, error: rpcErr } = await sb.rpc("open_past_question", { qid: id });
    if (!rpcErr && applyRpcPayload(rpcData)) {
      // handled cleanly by open_past_question RPC
    } else if (rpcErr && isNetworkFailure(rpcErr)) {
      networkFailed = true;
    } else {
      if (rpcErr) {
        schemaNeedsMigration = isSchemaOrRpcError(rpcErr);
        lastErrorMessage = String(rpcErr.message || "");
      }

      let resolvedViaFallbackEndpoint = false;
      try {
        const {
          data: { session },
        } = await sb.auth.getSession();
        const token = session?.access_token;
        if (token) {
          const apiRes = await fetch("/api/open-paper", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ qid: id }),
          });
          if (apiRes.ok) {
            const apiJson = await apiRes.json().catch(() => null);
            resolvedViaFallbackEndpoint = applyRpcPayload(apiJson);
          }
        }
      } catch {}

      if (!resolvedViaFallbackEndpoint && typeof sb?.functions?.invoke === "function") {
        try {
          const { data: fnData, error: fnErr } = await sb.functions.invoke("open-paper", {
            body: { qid: id },
          });
          if (!fnErr && applyRpcPayload(fnData)) {
            resolvedViaFallbackEndpoint = true;
          }
        } catch {}
      }

      if (!resolvedViaFallbackEndpoint) {
        const { data, error } = await sb
          .from("question_content")
          .select("content")
          .eq("question_id", id)
          .maybeSingle();
        if (error) {
          if (isNetworkFailure(error)) {
            networkFailed = true;
          } else {
            lastErrorMessage = String(error.message || lastErrorMessage || "");
          }
        } else if (data !== null && data !== undefined) {
          hasAccess = true;
          content = typeof data.content === "string" ? data.content : "";
          if (content) {
            saveOfflinePaper(cur, content);
            render(false);
          }
        }
      }
    }
  } catch (err) {
    if (isNetworkFailure(err)) {
      networkFailed = true;
    } else {
      lastErrorMessage = String(err?.message || "Could not open this paper right now.");
    }
  }

  if (!hasAccess && !blockedReason) {
    const cachedPaper = getOfflinePaper(id);
    if (
      cachedPaper?.content &&
      (networkFailed || navigator.onLine === false || P.on || isAdminUser)
    ) {
      hasAccess = true;
      content = cachedPaper.content;
    }
  }

  cur.content = content;
  if (hasAccess) {
    if ($("#pricingNotice")) $("#pricingNotice").hidden = true;
    if ($("#upgradeFromReader")) $("#upgradeFromReader").hidden = true;
    if (content.trim()) {
      setReaderView({
        title: paperHeaderTitle,
        body: content,
        paper: cur,
        isPaper: true,
      });
      $("#solve").hidden = false;
      if ($("#explainPaper")) $("#explainPaper").hidden = false;
    } else {
      setReaderView({
        title: paperHeaderTitle,
        body: "This paper is unlocked for your account, but no question text was uploaded for it yet.",
        paper: cur,
        isPaper: false,
      });
      $("#solve").hidden = true;
      if ($("#explainPaper")) $("#explainPaper").hidden = true;
    }
    openReaderModal();
    return;
  }

  if (networkFailed || navigator.onLine === false) {
    setReaderView({
      title: paperHeaderTitle,
      body: "You are offline and this paper has not been loaded on this device yet. Reconnect to load it once and save it for offline study.",
      paper: cur,
      isPaper: false,
    });
    $("#solve").hidden = true;
    if ($("#explainPaper")) $("#explainPaper").hidden = true;
    if ($("#upgradeFromReader")) $("#upgradeFromReader").hidden = true;
    openReaderModal();
    return;
  }

  const freeLim = Number(appSettings.free_questions_limit ?? 3);
  const priceTxt = formatPriceGhs(C.PRICE_GHS);
  const noticeText =
    blockedReason ||
    (schemaNeedsMigration && !P.on && !isAdminUser && freeLim > 0
      ? `Free past-question reading (${freeLim} free papers) is awaiting database setup by the site admin. Upgrade to Pro (GH₵${priceTxt}/month) for immediate unlimited access.`
      : lastErrorMessage
        ? `Unable to open this paper right now.${!P.on && !isAdminUser ? ` Upgrade to Pro (GH₵${priceTxt}/month) or ask an admin to verify paper permissions.` : ""}`
        : `Subscribe to Pro (GH₵${priceTxt}/month) to read this past question.`);

  if ($("#pricingNotice")) {
    $("#pricingNotice").textContent = noticeText;
    $("#pricingNotice").hidden = false;
  }
  setReaderView({
    title: paperHeaderTitle,
    body: noticeText,
    paper: cur,
    isPaper: false,
  });
  $("#solve").hidden = true;
  if ($("#explainPaper")) $("#explainPaper").hidden = true;
  if ($("#upgradeFromReader")) {
    $("#upgradeFromReader").hidden = Boolean(P.on || isAdminUser);
  }
  openReaderModal();
}

if ($("#upgradeFromReader")) {
  $("#upgradeFromReader").onclick = () => {
    if ($("#reader")?.open) $("#reader").close();
    syncUrlParams({ paper: null });
    show("pricing");
  };
}

$("#list").onclick = (e) => {
  const btn = e.target?.closest?.("[data-id]");
  const id = btn?.dataset?.id;
  if (!id) return;
  openPaperById(id);
};

if ($("#reader")) {
  $("#reader").addEventListener("close", () => {
    syncUrlParams({ paper: null });
  });
  $("#reader").addEventListener("click", (e) => {
    if (e.target === $("#reader")) $("#reader").close();
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
  const isBusy = Boolean(busy);
  ["#send", "#predict", "#explainBtn", "#explainAttachedBtn", "#clearChatBtn"].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = isBusy;
  });
  document.querySelectorAll(".chat-prompt-btn").forEach((btn) => {
    btn.disabled = isBusy;
  });
}

async function getValidAccessToken(forceRefresh = false) {
  if (forceRefresh && sb?.auth?.refreshSession) {
    try {
      const { data } = await sb.auth.refreshSession();
      if (data?.session?.access_token) return data.session.access_token;
    } catch {}
  }
  try {
    const res = await sb.auth.getSession();
    const session = res?.data?.session;
    if (session?.access_token) return session.access_token;
  } catch {}
  if (sb?.auth?.refreshSession) {
    try {
      const { data } = await sb.auth.refreshSession();
      if (data?.session?.access_token) return data.session.access_token;
    } catch {}
  }
  return "";
}

async function ai(body, onChunk, onStatus) {
  if (!isValidSupabaseUrl) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.");
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error(
      "You are currently offline. Reconnect to use AI Tutor — previously loaded past papers remain available under Questions."
    );
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

  const callLocalApi = async (accessToken, ctrl, useStream) =>
    fetch("/api/ai-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: useStream ? "text/event-stream, application/json" : "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(useStream ? { ...body, stream: true } : { ...body, stream: false }),
      signal: ctrl?.signal,
    });

  let apiError = "";
  let shouldTryEdgeFallback = false;
  let gotServerResponse = false;

  const FIRST_TOKEN_TIMEOUT_MS = 75000;
  const CHUNK_TIMEOUT_MS = 35000;
  const startedAt = Date.now();
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = ctrl ? setTimeout(() => ctrl.abort(), FIRST_TOKEN_TIMEOUT_MS) : null;
  const resetTimer = (ms = FIRST_TOKEN_TIMEOUT_MS) => {
    if (!ctrl) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ms);
  };

  try {
    let apiRes = await callLocalApi(token, ctrl, wantsStream);
    if (apiRes.status === 401) {
      const refreshedToken = await getValidAccessToken(true);
      if (refreshedToken && refreshedToken !== token) {
        token = refreshedToken;
        resetTimer(FIRST_TOKEN_TIMEOUT_MS);
        apiRes = await callLocalApi(token, ctrl, wantsStream);
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
      let hasDelta = false;
      let slowNotified = false;

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
        if (ev.type === "ping") {
          if (!hasDelta && !slowNotified && Date.now() - startedAt > 3500) {
            slowNotified = true;
            onStatus?.("Analyzing course notes and formulating your answer...");
          }
          return;
        }
        if (ev.type === "meta") {
          syncQuotaFromResponse(ev);
          return;
        }
        if (ev.type === "delta" && typeof ev.delta === "string") {
          hasDelta = true;
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
        resetTimer(hasDelta ? CHUNK_TIMEOUT_MS : Math.max(15000, FIRST_TOKEN_TIMEOUT_MS - (Date.now() - startedAt)));
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
      if (resolved) {
        return resolved;
      }

      // If stream closed with zero output, attempt one clean non-streaming request
      resetTimer(45000);
      const fallbackRes = await callLocalApi(token, ctrl, false);
      const fbCt = fallbackRes.headers.get("content-type") || "";
      if (fbCt.includes("application/json")) {
        const fbData = await fallbackRes.json();
        syncQuotaFromResponse(fbData);
        if (fallbackRes.ok && fbData?.text) {
          return fbData.text;
        }
        if (fbData?.error) {
          const err = new Error(fbData.error);
          err.status = fallbackRes.status;
          throw err;
        }
      }
      throw new Error("No response returned from AI Tutor. Please try again.");
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
      throw new Error(
        "AI Tutor took too long to respond on this connection. Try asking a more specific question or retry."
      );
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

const COPY_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

async function copyTextToClipboard(text) {
  const clean = String(text || "");
  if (!clean) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(clean);
      return true;
    } catch {}
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = clean;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, clean.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function formatInlineAiHtml(raw) {
  const inlineCode = [];
  let s = String(raw || "").replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${esc(code)}</code>`);
    return `@@UVIC_${idx}@@`;
  });
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(
    /(^|[\s(>])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=[\s.,;:!?)]|$)/g,
    "$1<em>$2</em>"
  );
  s = s.replace(/@@UVIC_(\d+)@@/g, (_, i) => inlineCode[Number(i)] || "");
  return s;
}

function formatAiMessageHtml(text) {
  const codeBlocks = [];
  let src = String(text || "").replace(/\r\n/g, "\n");
  src = src.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\n@@UVCB_${idx}@@\n`;
  });

  const lines = src.split("\n");
  const out = [];
  let pLines = [];
  let listType = null;
  let listItems = [];

  const flushPara = () => {
    if (!pLines.length) return;
    out.push(`<p>${pLines.map(formatInlineAiHtml).join("<br>")}</p>`);
    pLines = [];
  };

  const flushList = () => {
    if (!listItems.length || !listType) return;
    const tag = listType === "ol" ? "ol" : "ul";
    out.push(`<${tag}>${listItems.map((it) => `<li>${formatInlineAiHtml(it)}</li>`).join("")}</${tag}>`);
    listItems = [];
    listType = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const cbMatch = /^@@UVCB_(\d+)@@$/.exec(trimmed);
    if (cbMatch) {
      flushPara();
      flushList();
      out.push(codeBlocks[Number(cbMatch[1])] || "");
      continue;
    }
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    if (/^(?:-{3,}|\*{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      out.push("<hr>");
      continue;
    }
    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      flushPara();
      flushList();
      const tag = hMatch[1].length <= 2 ? "h3" : "h4";
      out.push(`<${tag}>${formatInlineAiHtml(hMatch[2])}</${tag}>`);
      continue;
    }
    const ulMatch = /^\s*[-*•]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushPara();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }
    const olMatch = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (olMatch) {
      flushPara();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(olMatch[1]);
      continue;
    }
    flushList();
    pLines.push(line);
  }
  flushPara();
  flushList();

  return out.join("") || `<p>${esc(text)}</p>`;
}

function stripAiMarkdownForCopy(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

function setBubbleText(bubbleEl, text, opts = {}) {
  if (!bubbleEl) return;
  const val = String(text || "");
  bubbleEl._rawText = val;
  if (bubbleEl._body) {
    if (
      val &&
      !opts.raw &&
      bubbleEl.classList.contains("a") &&
      !bubbleEl.classList.contains("is-err")
    ) {
      bubbleEl._body.innerHTML = formatAiMessageHtml(val);
    } else {
      bubbleEl._body.textContent = val;
    }
    bubbleEl._body.hidden = !val;
  } else {
    bubbleEl.textContent = val;
  }
}

function setBubbleTyping(bubbleEl, typing, label = "Thinking...") {
  if (!bubbleEl) return;
  const isTyping = Boolean(typing);
  bubbleEl.classList.toggle("is-typing", isTyping);
  if (bubbleEl._typing) {
    bubbleEl._typing.hidden = !isTyping;
    if (bubbleEl._typingLabel && label) {
      bubbleEl._typingLabel.textContent = label;
    }
  }
  if (bubbleEl._body && isTyping) {
    bubbleEl._rawText = "";
    bubbleEl._body.textContent = "";
    bubbleEl._body.hidden = true;
  }
}

function setBubbleCopyable(bubbleEl, copyable) {
  if (!bubbleEl?._copyBtn) return;
  const hasText = Boolean(bubbleEl._rawText?.trim() || bubbleEl._body?.textContent?.trim());
  bubbleEl._copyBtn.hidden = !(copyable && hasText);
}

function bub(t, c, opts = {}) {
  const d = document.createElement("div");
  d.className = "m " + c;

  const head = document.createElement("div");
  head.className = "m-head";
  const role = document.createElement("span");
  role.className = "m-role";
  role.textContent = c === "u" ? "You" : "UniVault AI";
  head.append(role);

  let copyBtn = null;
  if (c === "a") {
    copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "ghost m-copy";
    copyBtn.setAttribute("aria-label", "Copy AI response to clipboard");
    copyBtn.title = "Copy explanation or study notes";
    copyBtn.innerHTML = `${COPY_ICON_SVG}<span>Copy</span>`;
    let resetTimer = null;
    copyBtn.onclick = async () => {
      const content = d._rawText
        ? stripAiMarkdownForCopy(d._rawText)
        : d._body?.textContent?.trim() || "";
      if (!content) return;
      const ok = await copyTextToClipboard(content);
      if (resetTimer) clearTimeout(resetTimer);
      copyBtn.classList.toggle("is-copied", ok);
      copyBtn.innerHTML = ok
        ? `${CHECK_ICON_SVG}<span>Copied</span>`
        : `${COPY_ICON_SVG}<span>Copy failed</span>`;
      copyBtn.setAttribute("aria-label", ok ? "Copied to clipboard" : "Copy failed");
      resetTimer = setTimeout(() => {
        copyBtn.classList.remove("is-copied");
        copyBtn.innerHTML = `${COPY_ICON_SVG}<span>Copy</span>`;
        copyBtn.setAttribute("aria-label", "Copy AI response to clipboard");
      }, 1800);
    };
    head.append(copyBtn);
  }
  d.append(head);

  let typingEl = null;
  let typingLabelEl = null;
  if (c === "a") {
    typingEl = document.createElement("div");
    typingEl.className = "m-typing";
    typingEl.hidden = true;
    typingEl.setAttribute("role", "status");
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.setAttribute("aria-hidden", "true");
    dots.innerHTML = "<span></span><span></span><span></span>";
    typingLabelEl = document.createElement("span");
    typingLabelEl.className = "typing-label";
    typingLabelEl.textContent = opts.typingLabel || "Thinking...";
    typingEl.append(dots, typingLabelEl);
    d.append(typingEl);
  }

  const body = document.createElement("div");
  body.className = "m-body";
  d.append(body);

  const actions = document.createElement("div");
  actions.className = "m-actions";
  actions.hidden = true;
  d.append(actions);

  d._body = body;
  d._typing = typingEl;
  d._typingLabel = typingLabelEl;
  d._copyBtn = copyBtn;
  d._actions = actions;

  if (opts.typing) {
    setBubbleTyping(d, true, opts.typingLabel || "Thinking...");
    setBubbleCopyable(d, false);
  } else {
    setBubbleText(d, t);
    setBubbleCopyable(d, opts.copyable !== false && c === "a");
  }

  const logEl = $("#log");
  if (logEl) {
    logEl.append(d);
    logEl.scrollTop = logEl.scrollHeight;
  }
  return d;
}

function renderWelcomeChatMessage() {
  const logEl = $("#log");
  if (!logEl) return;
  logEl.innerHTML = "";
  bub(
    "AI Tutor is ready. Ask any KNUST exam question, pick a course above to use its past papers, tap a quick study prompt, or upload a PDF/image/audio/video.",
    "a",
    { copyable: false }
  );
}

function cleanAiErrorMessage(err) {
  let msg = String(err?.message || err || "Could not get a response from AI Tutor.").trim();
  let code = typeof err?.status === "number" ? err.status : 0;

  for (let depth = 0; depth < 4; depth++) {
    if (!msg.startsWith("{")) break;
    try {
      const parsed = JSON.parse(msg);
      const inner = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
      if (typeof inner?.code === "number") code = inner.code;
      if (typeof inner?.message === "string" && inner.message.trim()) {
        msg = inner.message.trim();
        continue;
      }
      break;
    } catch {
      break;
    }
  }

  if (code === 503 || /high demand|service unavailable|UNAVAILABLE|overloaded/i.test(msg)) {
    return "AI Tutor is experiencing temporary high demand right now. Please wait a few seconds and tap Retry.";
  }
  if (code === 429 || /rate[- ]?limit|quota|RESOURCE_EXHAUSTED/i.test(msg)) {
    return "AI Tutor is temporarily rate-limited due to high traffic. Please wait a moment and tap Retry.";
  }
  return msg;
}

function showAiErrorInBubble(bubbleEl, err, retryFn = null) {
  const msg = cleanAiErrorMessage(err);
  const isQuotaErr = err?.status === 402 || /premium|trial limit/i.test(msg);
  bubbleEl.classList.add("is-err");
  setBubbleTyping(bubbleEl, false);
  setBubbleText(bubbleEl, msg, { raw: true });
  setBubbleCopyable(bubbleEl, false);
  if (bubbleEl._actions) {
    bubbleEl._actions.innerHTML = "";
    bubbleEl._actions.hidden = true;
    if (isQuotaErr) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Upgrade to Premium";
      btn.onclick = () => show("pricing");
      bubbleEl._actions.append(btn);
      bubbleEl._actions.hidden = false;
    } else if (typeof retryFn === "function") {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "ghost";
      retryBtn.textContent = "Retry";
      retryBtn.onclick = () => {
        bubbleEl.remove();
        retryFn();
      };
      bubbleEl._actions.append(retryBtn);
      bubbleEl._actions.hidden = false;
    }
  }
  const logEl = $("#log");
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
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
  const w = bub("", "a", { typing: true, typingLabel: "Thinking..." });
  setAiBusy(true);
  let pendingPartial = "";
  let chunkRaf = 0;
  const flushPartial = () => {
    chunkRaf = 0;
    if (!pendingPartial) return;
    setBubbleTyping(w, false);
    setBubbleText(w, pendingPartial);
    const logEl = $("#log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  };
  try {
    const r = await ai(
      {
        mode: "chat",
        course: $("#chatCourse")?.value || "",
        programme: userProgramme?.name || "",
        messages: hist,
        attachmentContext: buildAttachmentContext(),
      },
      (partial) => {
        if (!partial) return;
        pendingPartial = partial;
        if (!chunkRaf && typeof requestAnimationFrame === "function") {
          chunkRaf = requestAnimationFrame(flushPartial);
        } else if (!chunkRaf) {
          flushPartial();
        }
      },
      (statusMsg) => {
        setBubbleTyping(w, true, statusMsg);
      }
    );
    if (chunkRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(chunkRaf);
      chunkRaf = 0;
    }
    const clean = String(r || "").trim();
    setBubbleTyping(w, false);
    if (!clean) {
      setBubbleText(w, "No response returned. Please try again.");
      setBubbleCopyable(w, false);
      hist.pop();
      return;
    }
    setBubbleText(w, clean);
    setBubbleCopyable(w, true);
    hist.push({ role: "assistant", content: clean });
    const logEl = $("#log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  } catch (e) {
    if (chunkRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(chunkRaf);
      chunkRaf = 0;
    }
    hist.pop();
    showAiErrorInBubble(w, e, () => ask(text));
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
  const w = bub("", "a", { typing: true, typingLabel: "Preparing detailed explanation..." });
  setAiBusy(true);
  let pendingPartial = "";
  let chunkRaf = 0;
  const flushPartial = () => {
    chunkRaf = 0;
    if (!pendingPartial) return;
    setBubbleTyping(w, false);
    setBubbleText(w, pendingPartial);
    const logEl = $("#log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  };
  try {
    const context = inlineContext || buildAttachmentContext();
    const r = await ai(
      {
        mode: "explain",
        course: $("#chatCourse")?.value || "",
        programme: userProgramme?.name || "",
        targetQuestion,
        attachmentContext: context,
      },
      (partial) => {
        if (!partial) return;
        pendingPartial = partial;
        if (!chunkRaf && typeof requestAnimationFrame === "function") {
          chunkRaf = requestAnimationFrame(flushPartial);
        } else if (!chunkRaf) {
          flushPartial();
        }
      },
      (statusMsg) => {
        setBubbleTyping(w, true, statusMsg);
      }
    );
    if (chunkRaf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(chunkRaf);
      chunkRaf = 0;
    }
    const clean = String(r || "").trim();
    setBubbleTyping(w, false);
    if (!clean) {
      setBubbleText(w, "No explanation returned. Please try again.");
      setBubbleCopyable(w, false);
      return;
    }
    setBubbleText(w, clean);
    setBubbleCopyable(w, true);
    hist.push({ role: "user", content: userLabel });
    hist.push({ role: "assistant", content: clean });
    const logEl = $("#log");
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  } catch (e) {
    showAiErrorInBubble(w, e, () => requestDetailedExplanation(targetQuestion, inlineContext));
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
      bub(
        "Type or paste a specific question (or upload a PDF/DOCX/PPT/MP3/MP4) to get a detailed explanation.",
        "a",
        { copyable: false }
      );
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

if ($("#clearChatBtn")) {
  $("#clearChatBtn").onclick = () => {
    if ($("#send")?.disabled) return;
    hist = [];
    renderWelcomeChatMessage();
    $("#msg")?.focus();
  };
}

document.querySelectorAll(".chat-prompt-btn").forEach((btn) => {
  btn.onclick = () => {
    const prompt = btn.dataset.prompt || "";
    if (!prompt || $("#send")?.disabled) return;
    if (isVoiceRecording) stopVoiceInput();
    setMicStatus("");
    ask(prompt);
  };
});

if ($("#chatFileBtn") && $("#chatFile")) {
  $("#chatFileBtn").onclick = () => $("#chatFile").click();
  $("#chatFile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("#chatFileBtn").disabled = true;
    const statusBub = bub("", "a", {
      typing: true,
      typingLabel: `Reading "${file.name}"...`,
      copyable: false,
    });
    try {
      const data = await processFileWithGemini(file, (msg) => {
        setBubbleTyping(statusBub, true, msg);
      });
      setActiveAttachment(data);
      const actionLabel =
        data.mediaType === "written"
          ? data.ocrUsed
            ? "OCR-scanned & extracted"
            : "Extracted"
          : "Transcribed";
      setBubbleTyping(statusBub, false);
      setBubbleText(
        statusBub,
        `${actionLabel} "${data.fileName}".\n\nSummary: ${data.summary || "Ready."}\n\n` +
          (data.questionsDetected?.length
            ? `Detected ${data.questionsDetected.length} question(s). Pick one above or ask me for a detailed explanation!`
            : "Ask me any question about this file or click Detailed explanation.")
      );
      setBubbleCopyable(statusBub, true);
    } catch (err) {
      showAiErrorInBubble(statusBub, err?.message ? err : { message: "Could not process file." });
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
    window.uvRevealObserve?.(o);
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
    let { error } = await sb.rpc("submit_question", {
      ...payload,
      descr: descr || null,
    });
    if (
      error &&
      !/could not choose/i.test(error.message || "") &&
      /could not find the function|pgrst202|descr/i.test(error.message || "")
    ) {
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
