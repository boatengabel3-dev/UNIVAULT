let Q = [], user = null, P = {}, hist = [], cur = null, quiz = [], myUploads = [], myPayouts = [], dashStatus = "all", activeAttachment = null, dupCheckTimer = null;

function setMenuOpen(open) {
  const menu = $("#navMenu"), btn = $("#menuBtn");
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}

function show(v) {
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
    window.uvRevealObserve?.(targetSection);
  };

  setMenuOpen(false);
  if (alreadyVisible || typeof uvTransition === "undefined") {
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

(async () => {
  try {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session) return location.replace("signup.html");
    user = session.user;
    await refresh();
    await load();
  } finally {
    window.dispatchEvent(new CustomEvent("uv:rendered"));
  }
})();

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

async function refresh() {
  const { data } = await sb.from("profiles").select("*").single();
  P = data || {};
  P.on = P.premium_until && new Date(P.premium_until) > new Date();
  $("#badge").textContent = P.on
    ? "Premium until " + new Date(P.premium_until).toLocaleDateString()
    : "Free";
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
  document
    .querySelectorAll(".courses")
    .forEach((s) => (s.innerHTML = codes.map((c) => `<option>${esc(c)}</option>`).join("")));
  render();
}

function render() {
  const d = $("#dep").value,
    raw = $("#search").value.trim(),
    t = raw.toLowerCase(),
    by = {};
  $("#clearSearch").hidden = !d && !raw;
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

$("#dep").onchange = $("#search").oninput = render;
$("#clearSearch").onclick = () => {
  $("#dep").value = "";
  $("#search").value = "";
  render();
  $("#search").focus();
};

$("#list").onclick = async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  cur = Q.find((q) => q.id === id);
  $("#rt").textContent = `${cur.course_code} · ${cur.year}${cur.semester ? " Sem " + cur.semester : ""}`;
  const { data } = await sb
    .from("question_content")
    .select("content")
    .eq("question_id", id)
    .maybeSingle();
  cur.content = data?.content;
  $("#rb").textContent = data
    ? data.content
    : "Subscribe for GH₵30/month to read this paper.";
  $("#solve").hidden = !data;
  $("#reader").showModal();
  if (!data) show("pricing");
};

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

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("No file selected."));
    if (file.size > 20 * 1024 * 1024) {
      return reject(new Error("File is larger than 20 MB. Please upload a smaller file."));
    }
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const idx = res.indexOf(",");
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

async function processFileWithGemini(file) {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session?.access_token) {
    throw new Error("Please sign in first.");
  }
  const dataBase64 = await readFileAsBase64(file);
  const res = await fetch("/api/ai-process-file", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      dataBase64,
    }),
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    if (res.status === 413) {
      throw new Error("File exceeds the hosted upload limit (~4 MB). Please upload a smaller or compressed file.");
    }
    throw new Error(`Upload failed (${res.status}).`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to process file.");
  return data;
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

async function ai(body) {
  if (!isValidSupabaseUrl) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.");
  }

  // Always call /api/ai-chat directly when attachmentContext or explain mode is used, or fallback automatically
  const hasRichPayload = Boolean(body.attachmentContext) || body.mode === "explain";
  let m = "Edge Function request failed.";

  if (!hasRichPayload) {
    const { data, error } = await sb.functions.invoke("ai-chat", { body });
    if (!error) return data.text;
    m = error.message || m;
    try {
      const jsonErr = await error.context?.json?.();
      if (jsonErr?.error) m = jsonErr.error;
    } catch {}
  }

  if (hasRichPayload || !/sign in|premium/i.test(m)) {
    try {
      const {
        data: { session },
      } = await sb.auth.getSession();
      const apiRes = await fetch("/api/ai-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      const contentType = apiRes.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const apiData = await apiRes.json();
        if (apiRes.ok) return apiData.text;
        m = apiData.error || m;
        if (/premium/i.test(m)) show("pricing");
        throw new Error(m);
      }
    } catch (fallbackErr) {
      if (fallbackErr instanceof Error && fallbackErr.message !== m) {
        if (/premium/i.test(fallbackErr.message)) show("pricing");
        throw fallbackErr;
      }
    }
    if (/Failed to send a request to the Edge Function/i.test(m)) {
      m =
        "Could not reach the ai-chat Edge Function or /api/ai-chat. Check SUPABASE_URL, SUPABASE_ANON_KEY, and GEMINI_API_KEY.";
    }
  }

  if (/premium/i.test(m)) show("pricing");
  throw new Error(m);
}

function bub(t, c) {
  const d = document.createElement("div");
  d.className = "m " + c;
  d.textContent = t;
  $("#log").append(d);
  $("#log").scrollTop = 1e9;
  return d;
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
  bub(text, "u");
  hist.push({ role: "user", content: text });
  const w = bub("Thinking...", "a");
  if ($("#send")) $("#send").disabled = true;
  try {
    const r = await ai({
      mode: "chat",
      course: $("#chatCourse").value,
      messages: hist,
      attachmentContext: buildAttachmentContext(),
    });
    w.textContent = r || "No response returned.";
    hist.push({ role: "assistant", content: r });
  } catch (e) {
    w.textContent = e.message;
    hist.pop();
  } finally {
    if ($("#send")) $("#send").disabled = false;
  }
}

async function requestDetailedExplanation(targetQuestion, inlineContext = "") {
  const userLabel = targetQuestion
    ? `Detailed explanation requested:\n${targetQuestion}`
    : "Provide a detailed explanation of the uploaded material.";
  bub(userLabel, "u");
  const w = bub("Preparing detailed explanation...", "a");
  if ($("#send")) $("#send").disabled = true;
  try {
    const context = inlineContext || buildAttachmentContext();
    const r = await ai({
      mode: "explain",
      course: $("#chatCourse").value,
      targetQuestion,
      attachmentContext: context,
    });
    w.textContent = r || "No explanation returned.";
    hist.push({ role: "user", content: userLabel });
    hist.push({ role: "assistant", content: r || "" });
  } catch (e) {
    w.textContent = e.message;
  } finally {
    if ($("#send")) $("#send").disabled = false;
  }
}

$("#send").onclick = () => {
  const t = $("#msg").value.trim();
  if (t && !$("#send").disabled) {
    $("#msg").value = "";
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
    const typed = $("#msg").value.trim();
    const selectedQ = $("#chatDetectedQ")?.value || "";
    const target = typed || selectedQ;
    if (!target && !activeAttachment) {
      $("#msg").focus();
      bub("Type or paste a specific question (or upload a PDF/DOCX/PPT/MP3/MP4) to get a detailed explanation.", "a");
      return;
    }
    if (typed) $("#msg").value = "";
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
    const statusBub = bub(`Processing "${file.name}" with Gemini AI...`, "a");
    try {
      const data = await processFileWithGemini(file);
      setActiveAttachment(data);
      const actionLabel = data.mediaType === "written" ? "Extracted" : "Transcribed";
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

if ($("#uploadFile")) {
  $("#uploadFile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const stEl = $("#uploadFileStatus");
    if (stEl) {
      stEl.textContent = `Processing "${file.name}" with Gemini AI (extracting text / transcribing media)...`;
    }
    showDupBanner(null);
    try {
      const data = await processFileWithGemini(file);
      const formattedBody =
        data.transcript && data.transcript !== data.extractedText
          ? `${data.extractedText}\n\n[Transcript]\n${data.transcript}`
          : data.extractedText || data.transcript || "";
      if (formattedBody) $("#ub").value = formattedBody;

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
      if (stEl) {
        stEl.textContent =
          data.mediaType === "written"
            ? `Extracted written content from "${file.name}". Review metadata and submit below.`
            : `Transcribed ${data.mediaType} recording "${file.name}". Review and submit below.`;
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
    amount: C.PRICE_GHS * 100,
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
