(() => {
  const STEPS = [
    {
      view: "browse",
      target: "#browse .filter-panel",
      title: "1. Search Verified Past Papers",
      body: "Filter KNUST exam papers by department or search by course code (e.g. MATH 151), title, or year. Click any year chip below to read the paper.",
    },
    {
      view: "chat",
      target: "#chat",
      title: "2. AI Tutor & Voice Questions",
      body: "Use Predict lecturer's style, Detailed explanation, Upload File/Audio/Video, or tap Voice at the bottom to speak your question on the go.",
    },
    {
      view: "quiz",
      target: "#quiz .form",
      title: "3. Custom Practice Quizzes",
      body: "Select a course, choose how many questions you want, add custom instructions, and test yourself with instant grading and explanations.",
    },
    {
      view: "upload",
      target: "#upload .form",
      title: "4. Upload & Earn GH₵3",
      body: "Upload PDFs, exam photos, DOCX, PPT, MP3, or MP4 files. Preview your file, run automatic duplicate checks, and submit to earn GH₵3.",
    },
    {
      view: "dashboard",
      target: "#dashboard .stats",
      title: "5. Contributor Dashboard",
      body: "Track every submitted paper, review approval status, and watch your accumulated GH₵3 rewards grow.",
    },
    {
      view: "wallet",
      target: "#wallet .form",
      title: "6. Mobile Money & Premium",
      body: "Withdraw earnings (min GH₵10) directly to MTN, Telecel, or AirtelTigo Mobile Money, or upgrade under Premium for full archive and unlimited AI access.",
    },
  ];

  let state = {
    userId: "",
    name: "Scholar",
    showView: null,
    stepIdx: 0,
    active: false,
    backdropEl: null,
    spotEl: null,
    cardEl: null,
    welcomeModalEl: null,
    resizeHandler: null,
  };

  function getTourKey(userId) {
    return userId ? `uv_tour_done_${userId}` : "uv_tour_done_anon";
  }

  function hasCompletedTour(userId) {
    try {
      return localStorage.getItem(getTourKey(userId)) === "1";
    } catch {
      return false;
    }
  }

  function markTourCompleted(userId) {
    try {
      localStorage.setItem(getTourKey(userId), "1");
    } catch {}
  }

  function clearJustSignedInParam() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.has("welcome")) {
        u.searchParams.delete("welcome");
        history.replaceState(null, "", u.pathname + u.search + u.hash);
      }
    } catch {}
  }

  function readWelcomeContext(user, profile) {
    let stored = null;
    try {
      const raw = sessionStorage.getItem("uv_just_signed_in");
      if (raw) {
        stored = JSON.parse(raw);
        sessionStorage.removeItem("uv_just_signed_in");
      }
    } catch {}

    let paramMode = "";
    try {
      paramMode = new URLSearchParams(location.search).get("welcome") || "";
    } catch {}
    clearJustSignedInParam();

    const rawName =
      profile?.full_name ||
      stored?.name ||
      user?.user_metadata?.full_name ||
      (user?.email ? user.email.split("@")[0] : "");
    const cleanName = String(rawName || "Scholar").trim() || "Scholar";
    const firstName = cleanName.split(/\s+/)[0] || cleanName;

    const recentStored = stored && Date.now() - Number(stored.ts || 0) < 120000;
    const justSignedIn = Boolean(recentStored || paramMode);
    const isNewUser =
      stored?.mode === "up" || paramMode === "new" || !hasCompletedTour(user?.id);

    return { cleanName, firstName, justSignedIn, isNewUser };
  }

  function renderWelcomeBanner(ctx) {
    const banner = document.getElementById("welcomeBanner");
    const kicker = document.querySelector("#browse .home-kicker");
    if (kicker && ctx.firstName) {
      kicker.textContent = `Welcome, ${ctx.firstName} · KNUST Examination Repository`;
    }
    if (!banner) return;

    if (!ctx.justSignedIn && hasCompletedTour(state.userId)) {
      banner.hidden = true;
      return;
    }

    const titleEl = document.getElementById("welcomeBannerTitle");
    const textEl = document.getElementById("welcomeBannerText");
    if (titleEl) {
      titleEl.textContent = ctx.isNewUser
        ? `Welcome to UniVault, ${ctx.firstName}!`
        : `Welcome back, ${ctx.firstName}!`;
    }
    if (textEl) {
      textEl.textContent = ctx.isNewUser
        ? "Your account is active. Take a quick 6-step guided tour to see how past papers, the AI Tutor, uploads, and Mobile Money payouts work."
        : "Good to have you back. Jump right into past questions, ask the AI Tutor, or replay the quick site tour anytime.";
    }
    banner.hidden = false;

    const tourBtn = document.getElementById("welcomeTourBtn");
    const dismissBtn = document.getElementById("welcomeDismissBtn");
    if (tourBtn) {
      tourBtn.onclick = () => {
        banner.hidden = true;
        startTour();
      };
    }
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        banner.hidden = true;
        markTourCompleted(state.userId);
      };
    }
  }

  function openWelcomeDialog(ctx) {
    if (state.welcomeModalEl) state.welcomeModalEl.remove();
    const dlg = document.createElement("dialog");
    dlg.id = "uvWelcomeModal";
    dlg.className = "welcome-dialog";
    dlg.setAttribute("aria-labelledby", "uvWelcomeTitle");
    dlg.innerHTML = `
      <div class="welcome-dlg-head">
        <img src="assets/knust-crest.png" alt="KNUST crest">
        <div>
          <p class="welcome-dlg-kicker">New Member Orientation</p>
          <h2 id="uvWelcomeTitle">Welcome to UniVault, ${esc(ctx.firstName)}!</h2>
        </div>
      </div>
      <p class="welcome-dlg-copy">Here is a quick gist of what you can do inside UniVault — or let us walk you through every section step by step.</p>
      <ul class="welcome-dlg-list">
        <li><strong>Past Paper Archive:</strong> Search verified KNUST exam papers by department, course code, and year.</li>
        <li><strong>AI Tutor + Voice:</strong> Get step-by-step explanations, predict lecturer exam patterns, upload files, or speak questions with Voice.</li>
        <li><strong>Upload &amp; Earn GH₵3:</strong> Submit PDFs, photos, DOCX, slides, audio, or video and withdraw rewards to Mobile Money.</li>
      </ul>
      <div class="welcome-dlg-actions">
        <button type="button" id="uvWelcomeSkip" class="ghost">Explore on my own</button>
        <button type="button" id="uvWelcomeStart">Take Guided Tour (6 steps)</button>
      </div>
    `;
    document.body.appendChild(dlg);
    state.welcomeModalEl = dlg;

    const closeAndRemember = () => {
      markTourCompleted(state.userId);
      if (dlg.open) dlg.close();
      dlg.remove();
      state.welcomeModalEl = null;
    };

    dlg.querySelector("#uvWelcomeSkip").onclick = closeAndRemember;
    dlg.querySelector("#uvWelcomeStart").onclick = () => {
      const banner = document.getElementById("welcomeBanner");
      if (banner) banner.hidden = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      state.welcomeModalEl = null;
      startTour();
    };
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeAndRemember();
    });
    dlg.showModal();
  }

  function ensureTourOverlay() {
    if (!state.backdropEl) {
      state.backdropEl = document.createElement("div");
      state.backdropEl.className = "uv-tour-backdrop";
      document.body.appendChild(state.backdropEl);
    }
    if (!state.spotEl) {
      state.spotEl = document.createElement("div");
      state.spotEl.className = "uv-tour-spot";
      document.body.appendChild(state.spotEl);
    }
    if (!state.cardEl) {
      state.cardEl = document.createElement("div");
      state.cardEl.className = "uv-tour-card";
      state.cardEl.setAttribute("role", "dialog");
      state.cardEl.setAttribute("aria-modal", "true");
      state.cardEl.setAttribute("aria-labelledby", "uvTourTitle");
      state.cardEl.innerHTML = `
        <div class="uv-tour-top">
          <span id="uvTourBadge" class="uv-tour-badge"></span>
          <button type="button" id="uvTourSkipTop" class="ghost uv-tour-x" aria-label="Close tour">✕</button>
        </div>
        <h3 id="uvTourTitle"></h3>
        <p id="uvTourBody"></p>
        <div class="uv-tour-actions">
          <button type="button" id="uvTourPrev" class="ghost">Back</button>
          <div style="display:flex;gap:8px;margin-left:auto">
            <button type="button" id="uvTourSkip" class="ghost">Skip</button>
            <button type="button" id="uvTourNext">Next</button>
          </div>
        </div>
      `;
      document.body.appendChild(state.cardEl);

      state.cardEl.querySelector("#uvTourPrev").onclick = () => {
        if (state.stepIdx > 0) goToStep(state.stepIdx - 1);
      };
      state.cardEl.querySelector("#uvTourNext").onclick = () => {
        if (state.stepIdx < STEPS.length - 1) {
          goToStep(state.stepIdx + 1);
        } else {
          endTour(true);
        }
      };
      state.cardEl.querySelector("#uvTourSkip").onclick = () => endTour(false);
      state.cardEl.querySelector("#uvTourSkipTop").onclick = () => endTour(false);
    }
  }

  function positionStep() {
    if (!state.active || !state.cardEl || !state.spotEl) return;
    const step = STEPS[state.stepIdx];
    const target = step ? document.querySelector(step.target) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const headerH = (document.querySelector("header")?.getBoundingClientRect().height || 64) + 8;

    if (target && target.offsetParent !== null) {
      const rect = target.getBoundingClientRect();
      const pad = 6;

      if (vw < 720) {
        state.cardEl.style.left = "12px";
        state.cardEl.style.right = "12px";
        state.cardEl.style.top = "auto";
        state.cardEl.style.bottom = "12px";
        state.cardEl.style.width = "auto";
        state.cardEl.style.transform = "none";

        const cardRect = state.cardEl.getBoundingClientRect();
        const maxBottom = Math.max(headerH + 60, cardRect.top - 12);
        const top = Math.max(headerH, rect.top - pad);
        const rawBottom = Math.min(maxBottom, rect.bottom + pad);
        const height = Math.max(44, rawBottom - top);
        const left = Math.max(8, rect.left - pad);
        const width = Math.min(vw - 16, rect.width + pad * 2);

        state.spotEl.hidden = false;
        state.spotEl.style.top = `${top}px`;
        state.spotEl.style.left = `${left}px`;
        state.spotEl.style.width = `${width}px`;
        state.spotEl.style.height = `${height}px`;
      } else {
        const cardW = Math.min(390, vw - 32);
        state.cardEl.style.width = `${cardW}px`;
        const cardH = state.cardEl.offsetHeight || 220;

        const top = Math.max(headerH, rect.top - pad);
        const left = Math.max(8, rect.left - pad);
        const width = Math.min(vw - 16, rect.width + pad * 2);
        const idealH = rect.height + pad * 2;
        const canFitBelow = top + idealH + 14 + cardH <= vh - 12;
        const canFitAbove = top - cardH - 14 >= headerH;

        let height = Math.max(44, Math.min(idealH, vh - top - 16));
        let cardLeft = Math.min(Math.max(16, left), vw - cardW - 16);
        let cardTop;

        if (canFitBelow) {
          height = idealH;
          cardTop = top + height + 14;
        } else if (canFitAbove) {
          cardTop = top - cardH - 14;
        } else {
          height = Math.max(160, Math.min(idealH, vh - top - cardH - 28));
          cardTop = Math.min(vh - cardH - 12, top + height + 14);
        }

        state.spotEl.hidden = false;
        state.spotEl.style.top = `${top}px`;
        state.spotEl.style.left = `${left}px`;
        state.spotEl.style.width = `${width}px`;
        state.spotEl.style.height = `${height}px`;

        state.cardEl.style.right = "auto";
        state.cardEl.style.bottom = "auto";
        state.cardEl.style.left = `${cardLeft}px`;
        state.cardEl.style.top = `${cardTop}px`;
        state.cardEl.style.transform = "none";
      }
    } else {
      state.spotEl.hidden = true;
      state.cardEl.style.width = vw < 720 ? "auto" : "400px";
      state.cardEl.style.left = vw < 720 ? "12px" : "50%";
      state.cardEl.style.right = vw < 720 ? "12px" : "auto";
      state.cardEl.style.top = vw < 720 ? "auto" : "50%";
      state.cardEl.style.bottom = vw < 720 ? "14px" : "auto";
      state.cardEl.style.transform = vw < 720 ? "none" : "translate(-50%, -50%)";
    }
  }

  function goToStep(idx) {
    state.stepIdx = idx;
    const step = STEPS[idx];
    if (!step) return endTour(true);

    if (typeof state.showView === "function") {
      state.showView(step.view, true);
    }

    ensureTourOverlay();
    state.cardEl.querySelector("#uvTourBadge").textContent = `Step ${idx + 1} of ${STEPS.length}`;
    state.cardEl.querySelector("#uvTourTitle").textContent = step.title;
    state.cardEl.querySelector("#uvTourBody").textContent = step.body;
    state.cardEl.querySelector("#uvTourPrev").hidden = idx === 0;
    state.cardEl.querySelector("#uvTourNext").textContent =
      idx === STEPS.length - 1 ? "Finish Tour" : "Next";

    const alignAfterPaint = () => {
      const target = document.querySelector(step.target);
      if (target) {
        const headerH = (document.querySelector("header")?.getBoundingClientRect().height || 64) + 12;
        const rect = target.getBoundingClientRect();
        const targetTop = Math.max(0, rect.top + window.scrollY - headerH);
        window.scrollTo({ top: targetTop, behavior: "auto" });
      }
      positionStep();
    };

    requestAnimationFrame(() => {
      alignAfterPaint();
      setTimeout(alignAfterPaint, 160);
    });
  }

  function endTour(returnToBrowse = false) {
    state.active = false;
    markTourCompleted(state.userId);
    if (state.backdropEl) {
      state.backdropEl.remove();
      state.backdropEl = null;
    }
    if (state.spotEl) {
      state.spotEl.remove();
      state.spotEl = null;
    }
    if (state.cardEl) {
      state.cardEl.remove();
      state.cardEl = null;
    }
    if (state.resizeHandler) {
      window.removeEventListener("resize", state.resizeHandler);
      window.removeEventListener("scroll", state.resizeHandler, true);
      state.resizeHandler = null;
    }
    if (returnToBrowse && typeof state.showView === "function") {
      state.showView("browse", true);
    }
  }

  function startTour() {
    state.active = true;
    ensureTourOverlay();
    if (!state.resizeHandler) {
      state.resizeHandler = () => positionStep();
      window.addEventListener("resize", state.resizeHandler);
      window.addEventListener("scroll", state.resizeHandler, true);
    }
    goToStep(0);
  }

  function init({ user, profile, showView }) {
    state.userId = user?.id || "";
    state.showView = showView;

    const ctx = readWelcomeContext(user, profile);
    state.name = ctx.firstName;
    renderWelcomeBanner(ctx);

    const firstTimeEver = !hasCompletedTour(state.userId);
    if (firstTimeEver) {
      setTimeout(() => {
        if (!state.active) openWelcomeDialog(ctx);
      }, 280);
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.active) {
      endTour(false);
    }
  });

  window.uvGuide = { init, startTour, endTour };
})();
