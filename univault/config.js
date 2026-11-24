const C = {
  SUPABASE_URL: "YOUR_SUPABASE_URL",
  SUPABASE_ANON_KEY: "YOUR_ANON_KEY",
  PAYSTACK_PUBLIC_KEY: "pk_test_xxxx",
  PRICE_GHS: 30,
};

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
const fmt = (p) => "GH₵" + (p / 100).toFixed(2);

const isValidSupabaseUrl =
  typeof C.SUPABASE_URL === "string" &&
  /^https?:\/\/[^/]+/i.test(C.SUPABASE_URL) &&
  C.SUPABASE_URL !== "YOUR_SUPABASE_URL";

const unconfiguredError = {
  message:
    "Supabase is not configured yet. Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js.",
};

function createFallbackQuery() {
  const result = { data: null, error: unconfiguredError };
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

const fallbackSb = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    signUp: async () => ({ data: { user: null, session: null }, error: unconfiguredError }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: unconfiguredError }),
    signOut: async () => ({ error: null }),
  },
  from: () => createFallbackQuery(),
  rpc: async () => ({ data: null, error: unconfiguredError }),
  functions: {
    invoke: async () => ({ data: null, error: unconfiguredError }),
  },
};

function isInvalidRefreshTokenError(err) {
  if (!err) return false;
  const code = String(err?.code || "").toLowerCase();
  const msg = String(err?.message || err?.error_description || err || "");
  return (
    code === "refresh_token_not_found" ||
    /invalid refresh token|refresh token not found|refresh_token_not_found/i.test(msg)
  );
}

let isClearingStaleAuth = false;
function clearStaleSupabaseAuthStorage(client = null) {
  if (isClearingStaleAuth) return;
  isClearingStaleAuth = true;
  try {
    const cleanStore = (store) => {
      if (!store) return;
      const keysToRemove = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && /^sb-.*-auth-token/.test(key)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => {
        try {
          store.removeItem(k);
        } catch {}
      });
    };
    try {
      cleanStore(window.localStorage);
    } catch {}
    try {
      cleanStore(window.sessionStorage);
    } catch {}

    const target = client || (typeof sb !== "undefined" ? sb : null);
    const signOutFn = target?.auth?._uvOrigSignOut || target?.auth?.signOut;
    if (typeof signOutFn === "function") {
      Promise.resolve(signOutFn({ scope: "local" })).catch(() => {});
    }
  } finally {
    setTimeout(() => {
      isClearingStaleAuth = false;
    }, 250);
  }
}

function sanitizeStoredSupabaseSession() {
  try {
    const store = window.localStorage;
    if (!store) return;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const raw = store.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const sessionObj = parsed?.currentSession || parsed?.session || parsed;
        const hasTokens =
          sessionObj &&
          typeof sessionObj === "object" &&
          typeof sessionObj.access_token === "string" &&
          sessionObj.access_token.length > 0 &&
          typeof sessionObj.refresh_token === "string" &&
          sessionObj.refresh_token.length > 0;
        if (!hasTokens) {
          store.removeItem(key);
        }
      } catch {
        store.removeItem(key);
      }
    }
  } catch {}
}

window.addEventListener("unhandledrejection", (event) => {
  if (isInvalidRefreshTokenError(event?.reason)) {
    event.preventDefault();
    clearStaleSupabaseAuthStorage();
  }
});

let sb = fallbackSb;
if (isValidSupabaseUrl && typeof supabase !== "undefined") {
  try {
    sanitizeStoredSupabaseSession();
    sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
    if (sb?.auth) {
      const origGetSession = sb.auth.getSession.bind(sb.auth);
      const origRefreshSession =
        typeof sb.auth.refreshSession === "function"
          ? sb.auth.refreshSession.bind(sb.auth)
          : null;
      const origSignOut =
        typeof sb.auth.signOut === "function" ? sb.auth.signOut.bind(sb.auth) : null;
      sb.auth._uvOrigSignOut = origSignOut;

      sb.auth.getSession = async (...args) => {
        try {
          const res = await origGetSession(...args);
          if (res?.error && isInvalidRefreshTokenError(res.error)) {
            clearStaleSupabaseAuthStorage(sb);
            return { data: { session: null }, error: null };
          }
          return res;
        } catch (err) {
          if (isInvalidRefreshTokenError(err)) {
            clearStaleSupabaseAuthStorage(sb);
            return { data: { session: null }, error: null };
          }
          throw err;
        }
      };

      if (origRefreshSession) {
        sb.auth.refreshSession = async (...args) => {
          try {
            const res = await origRefreshSession(...args);
            if (res?.error && isInvalidRefreshTokenError(res.error)) {
              clearStaleSupabaseAuthStorage(sb);
              return { data: { session: null, user: null }, error: null };
            }
            return res;
          } catch (err) {
            if (isInvalidRefreshTokenError(err)) {
              clearStaleSupabaseAuthStorage(sb);
              return { data: { session: null, user: null }, error: null };
            }
            throw err;
          }
        };
      }
    }
  } catch (err) {
    console.warn("Failed to initialize Supabase client:", err);
  }
}

const uvTransition = (() => {
  const NAV_KEY = "uv_nav_pending";
  const preload = new Image();
  preload.src = "assets/knust-crest.png";

  let el = null;
  let txt = null;
  let busy = null;
  let safety = null;

  const prefersReduced = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const hasAsyncView = () => document.body?.dataset?.asyncView === "true";

  function clearPending() {
    try {
      sessionStorage.removeItem(NAV_KEY);
    } catch {}
  }

  function setPending(label) {
    try {
      sessionStorage.setItem(
        NAV_KEY,
        JSON.stringify({ label: label || "Loading...", ts: Date.now() })
      );
    } catch {}
  }

  function getPending() {
    try {
      const raw = sessionStorage.getItem(NAV_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.ts > 5000) {
        clearPending();
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function ensure() {
    if (el || !document.body) return el;
    el = document.createElement("div");
    el.id = "uvLoader";
    el.className = "uv-loader";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML =
      '<div class="uv-loader-box"><div class="uv-crest-ring"><img src="assets/knust-crest.png" alt=""></div><span class="uv-loader-text">UniVault</span></div>';
    document.body.appendChild(el);
    txt = el.querySelector(".uv-loader-text");
    return el;
  }

  function show(label, immediate = false) {
    const node = ensure();
    if (!node) return;
    if (txt) txt.textContent = label || "UniVault";
    node.setAttribute("aria-hidden", "false");
    if (immediate) {
      node.classList.add("is-on");
    } else {
      requestAnimationFrame(() => node.classList.add("is-on"));
    }
    if (safety) clearTimeout(safety);
    safety = setTimeout(() => {
      clearPending();
      hide();
    }, 2800);
  }

  function hide() {
    if (busy) {
      clearTimeout(busy);
      busy = null;
    }
    if (safety) {
      clearTimeout(safety);
      safety = null;
    }
    if (!el) return;
    el.classList.remove("is-on");
    el.setAttribute("aria-hidden", "true");
  }

  function settleHide() {
    clearPending();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => hide());
    });
  }

  function go(url, label) {
    if (!url) return;
    if (prefersReduced()) {
      location.href = url;
      return;
    }
    const text = label || "Loading...";
    setPending(text);
    window.dispatchEvent(new CustomEvent("uv:navigate", { detail: { label: text, url } }));
    if (busy) clearTimeout(busy);
    busy = setTimeout(() => {
      location.href = url;
    }, 170);
  }

  function tab(fn, label) {
    if (prefersReduced()) {
      fn();
      return;
    }
    if (busy) clearTimeout(busy);
    const text = label || "Loading view...";
    window.dispatchEvent(new CustomEvent("uv:navigate", { detail: { label: text, type: "tab" } }));
    busy = setTimeout(() => {
      fn();
      window.dispatchEvent(new CustomEvent("uv:rendered"));
    }, 140);
  }

  // Global navigation & render event listeners
  window.addEventListener("uv:navigate", (e) => {
    if (prefersReduced()) return;
    show(e.detail?.label || "Loading...");
  });

  window.addEventListener("uv:rendered", () => {
    settleHide();
  });

  document.addEventListener("DOMContentLoaded", () => {
    const pending = getPending();
    if (pending && !prefersReduced()) {
      show(pending.label, true);
      if (!hasAsyncView()) {
        settleHide();
      }
    }
  });

  window.addEventListener("load", () => {
    if (!hasAsyncView()) {
      settleHide();
    }
  });

  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      clearPending();
      hide();
    } else if (!hasAsyncView()) {
      settleHide();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (!prefersReduced() && !getPending()) {
      setPending("Loading...");
      show("Loading...");
    }
  });

  window.addEventListener("popstate", () => {
    if (prefersReduced()) return;
    show("Loading...");
    settleHide();
  });

  window.addEventListener("hashchange", () => {
    if (prefersReduced()) return;
    show("Navigating...");
    settleHide();
  });

  document.addEventListener("click", (e) => {
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    const a = e.target?.closest?.("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const rawHref = a.getAttribute("href") || "";
    if (
      !rawHref ||
      rawHref.startsWith("#") ||
      rawHref.startsWith("mailto:") ||
      rawHref.startsWith("tel:")
    ) {
      return;
    }
    try {
      const target = new URL(a.href, location.href);
      if (target.origin !== location.origin) return;
      e.preventDefault();
      go(target.href, "Loading...");
    } catch {}
  });

  return { show, hide, go, tab };
})();

const uvMotion = (() => {
  const prefersReduced = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasFinePointer = () =>
    window.matchMedia && window.matchMedia("(pointer: fine)").matches;

  const BOX_SELECTOR =
    ".uv-reveal, .card, .glass, .stat, .home-metric, .filter-panel, .home-hero, .dash-panel, .row-item, .welcome-banner, .auth-card, .auth-institution, .auth-pillars li, .qq";
  const GRID_CONTAINER_SELECTOR =
    ".grid, .tgrid, .stats, .home-metrics, .two-col, .auth-pillars, .dash-list, #mine, #pays, #quizOut";

  const DELAY_STEP_MS = 1500;
  let observer = null;
  let queueTailMs = 0;

  function isHiddenBranch(el) {
    return Boolean(el.closest("[hidden], dialog:not([open])"));
  }

  function applyDirectionHint(el, indexInGrid) {
    if (
      el.classList.contains("uv-fly-left") ||
      el.classList.contains("uv-fly-right") ||
      el.classList.contains("uv-fly-down") ||
      el.classList.contains("uv-fly-zoom")
    ) {
      return;
    }
    const mod = indexInGrid % 3;
    if (mod === 0) {
      el.classList.add("uv-fly-left");
    } else if (mod === 2) {
      el.classList.add("uv-fly-right");
    }
  }

  function sortVisualOrder(elements) {
    return [...elements].sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 24) {
        return ra.top - rb.top;
      }
      return ra.left - rb.left;
    });
  }

  function markSettledWhenDone(el, delayMs) {
    if (!el) return;
    if (el._uvSettleTimer) {
      clearTimeout(el._uvSettleTimer);
      el._uvSettleTimer = null;
    }
    const finish = () => {
      if (el._uvSettleTimer) {
        clearTimeout(el._uvSettleTimer);
        el._uvSettleTimer = null;
      }
      if (el.isConnected && el.classList.contains("uv-revealed")) {
        el.classList.add("uv-settled");
      }
    };
    const onEnd = (e) => {
      if (e.target !== el || (e.propertyName !== "translate" && e.propertyName !== "opacity")) return;
      el.removeEventListener("transitionend", onEnd);
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    el._uvSettleTimer = setTimeout(() => {
      el.removeEventListener("transitionend", onEnd);
      finish();
    }, delayMs + 1050);
  }

  function revealBatch(elements) {
    if (!elements || !elements.length) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    let cursor = Math.max(now, queueTailMs);

    elements.forEach((el) => {
      if (!el || el.classList.contains("uv-revealed") || el.dataset.uvQueued === "1") return;
      el.dataset.uvQueued = "1";
      const delayMs = Math.max(0, Math.round(cursor - now));
      el.style.setProperty("--uv-delay", `${delayMs}ms`);
      cursor += DELAY_STEP_MS;
      requestAnimationFrame(() => {
        el.classList.add("uv-revealed");
        delete el.dataset.uvQueued;
        markSettledWhenDone(el, delayMs);
      });
      if (observer) observer.unobserve(el);
    });

    queueTailMs = cursor;
  }

  function resetReveals(root = document) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    queueTailMs = 0;
    scope.querySelectorAll(".uv-reveal").forEach((el) => {
      if (isHiddenBranch(el)) return;
      if (el._uvSettleTimer) {
        clearTimeout(el._uvSettleTimer);
        el._uvSettleTimer = null;
      }
      delete el.dataset.uvQueued;
      el.classList.remove("uv-revealed", "uv-settled");
      el.style.removeProperty("--uv-delay");
      void el.offsetWidth;
    });
  }

  function observeReveals(root = document, opts = {}) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    if (opts && opts.fresh) {
      queueTailMs = 0;
    }
    const found = new Set(scope.querySelectorAll(BOX_SELECTOR));
    if (scope !== document && typeof scope.matches === "function" && scope.matches(BOX_SELECTOR)) {
      found.add(scope);
    }

    const nodes = [...found].filter((el) => !isHiddenBranch(el));
    if (!nodes.length) return;

    const gridCounters = new WeakMap();
    nodes.forEach((el) => {
      if (!el.classList.contains("uv-reveal")) {
        el.classList.add("uv-reveal");
      }
      const gridParent = el.parentElement?.closest?.(GRID_CONTAINER_SELECTOR) || el.parentElement;
      if (gridParent) {
        const count = gridCounters.get(gridParent) || 0;
        gridCounters.set(gridParent, count + 1);
        if (gridParent.matches?.(GRID_CONTAINER_SELECTOR)) {
          applyDirectionHint(el, count);
        }
      }
    });

    if (prefersReduced() || typeof IntersectionObserver === "undefined") {
      nodes.forEach((n) => n.classList.add("uv-revealed"));
      return;
    }

    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          const batch = sortVisualOrder(
            entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target)
          );
          revealBatch(batch);
        },
        { threshold: 0.04, rootMargin: "0px 0px -12px 0px" }
      );
    }

    if (
      scope === document &&
      queueTailMs === 0 &&
      window.scrollY < 80 &&
      document.querySelector(".hero")
    ) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      queueTailMs = now + DELAY_STEP_MS * 4;
    }

    const vh = window.innerHeight || 900;
    const immediateBatch = [];
    nodes.forEach((n) => {
      if (n.classList.contains("uv-revealed") || n.dataset.uvQueued === "1") return;
      const rect = n.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top < vh * 0.96 && rect.bottom > 0) {
        immediateBatch.push(n);
      } else {
        observer.observe(n);
      }
    });
    revealBatch(sortVisualOrder(immediateBatch));
  }

  function init3D() {
    if (prefersReduced() || !hasFinePointer()) return;

    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    const cubes = () => document.querySelectorAll(".scene .cube");
    const crest = () => document.querySelector(".hero .crest");

    function step() {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;

      cubes().forEach((c, i) => {
        const depth = 22 + i * 18;
        c.style.setProperty("--px", `${(cx * depth).toFixed(2)}px`);
        c.style.setProperty("--py", `${(cy * depth).toFixed(2)}px`);
      });

      const hCrest = crest();
      if (hCrest) {
        hCrest.style.setProperty("--hx", `${(cx * 16).toFixed(2)}px`);
        hCrest.style.setProperty("--hy", `${(cy * 12).toFixed(2)}px`);
      }

      if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) {
        raf = requestAnimationFrame(step);
      } else {
        raf = 0;
      }
    }

    window.addEventListener(
      "pointermove",
      (e) => {
        if (window.innerWidth < 860) return;
        tx = e.clientX / Math.max(window.innerWidth, 1) - 0.5;
        ty = e.clientY / Math.max(window.innerHeight, 1) - 0.5;
        if (!raf && (cubes().length || crest())) {
          raf = requestAnimationFrame(step);
        }
      },
      { passive: true }
    );

    const TILT_SEL = ".feat .card, .tcard, .archive-card, .stat";
    let activeCard = null;

    document.addEventListener(
      "pointermove",
      (e) => {
        if (window.innerWidth < 860) return;
        const card = e.target?.closest?.(TILT_SEL);
        if (activeCard && activeCard !== card) {
          activeCard.style.removeProperty("--rx");
          activeCard.style.removeProperty("--ry");
          activeCard = null;
        }
        if (!card) return;
        activeCard = card;
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        const maxDeg = 4.2;
        const ry = ((px - 0.5) * maxDeg * 2).toFixed(2);
        const rx = (((0.5 - py) * maxDeg * 2)).toFixed(2);
        card.style.setProperty("--rx", `${rx}deg`);
        card.style.setProperty("--ry", `${ry}deg`);
        card.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
        card.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
      },
      { passive: true }
    );

    document.addEventListener("pointerleave", () => {
      if (activeCard) {
        activeCard.style.removeProperty("--rx");
        activeCard.style.removeProperty("--ry");
        activeCard = null;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    observeReveals(document);
    init3D();
  });

  window.uvRevealObserve = observeReveals;
  window.uvRevealReset = resetReveals;
  return { observeReveals, resetReveals };
})();

const uvTheme = (() => {
  const KEY = "uv_theme";
  const SUN_SVG =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
  const MOON_SVG =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

  function get() {
    try {
      return localStorage.getItem(KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  }

  function syncButtons(theme) {
    const isLight = theme === "light";
    const label = isLight ? "Dark" : "Light";
    const actionLabel = isLight ? "Switch to dark mode" : "Switch to light mode";
    const icon = isLight ? MOON_SVG : SUN_SVG;

    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      btn.setAttribute("aria-label", actionLabel);
      btn.setAttribute("title", actionLabel);
      btn.setAttribute("aria-pressed", isLight ? "true" : "false");
      btn.innerHTML = `${icon}<span class="theme-toggle-label">${label}</span>`;
    });
  }

  function apply(theme, persist = false) {
    const next = theme === "light" ? "light" : "dark";
    const root = document.documentElement;
    if (next === "light") {
      root.dataset.theme = "light";
    } else {
      delete root.dataset.theme;
    }
    root.style.colorScheme = next;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute("content", next === "light" ? "#f6f8fc" : "#09111e");
    const appleStatusMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (appleStatusMeta) {
      appleStatusMeta.setAttribute("content", next === "light" ? "default" : "black-translucent");
    }
    if (persist) {
      try {
        localStorage.setItem(KEY, next);
      } catch {}
    }
    syncButtons(next);
    return next;
  }

  function toggle() {
    return apply(get() === "light" ? "dark" : "light", true);
  }

  apply(get(), false);

  document.addEventListener("DOMContentLoaded", () => {
    syncButtons(get());
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      if (btn.dataset.themeBound === "1") return;
      btn.dataset.themeBound = "1";
      btn.addEventListener("click", () => toggle());
    });
  });

  window.addEventListener("storage", (e) => {
    if (e.key === KEY) apply(e.newValue === "light" ? "light" : "dark", false);
  });

  window.uvTheme = { get, apply, toggle };
  return { get, apply, toggle };
})();

const uvPwa = (() => {
  let deferredPrompt = null;
  let offlineEl = null;
  let iosDialog = null;

  const isStandalone = () =>
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;

  const isIPad = () => {
    const ua = navigator.userAgent || "";
    return (
      /iPad/i.test(ua) ||
      (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1)
    );
  };

  const isIOS = () => {
    const ua = navigator.userAgent || "";
    return /iPhone|iPod/i.test(ua) || isIPad();
  };

  function getIosBrowserContext() {
    const ua = navigator.userAgent || "";
    const inIframe = (() => {
      try {
        return window.self !== window.top;
      } catch {
        return true;
      }
    })();
    const isInApp =
      /FBAN|FBAV|Instagram|Line|MicroMessenger|Snapchat|TikTok|BytedanceWebview|WhatsApp|Twitter|GSA\//i.test(
        ua
      );
    const isChromeIOS = /CriOS/i.test(ua);
    const isThirdPartyIOS = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua);
    const isSafari = /Safari/i.test(ua) && !isThirdPartyIOS && !isInApp;
    return { inIframe, isInApp, isChromeIOS, isThirdPartyIOS, isSafari };
  }

  function syncInstallButtons() {
    const installed = isStandalone();
    const ios = isIOS();
    const canInstall = !installed && (Boolean(deferredPrompt) || ios);
    const defaultLabel = ios
      ? isIPad()
        ? "Install on iPad"
        : "Install on iPhone"
      : "Install App";

    document.querySelectorAll("[data-pwa-install]").forEach((btn) => {
      if (canInstall) {
        btn.hidden = false;
        btn.textContent = ios
          ? btn.dataset.iosLabel || defaultLabel
          : btn.dataset.installLabel || "Install App";
      } else {
        btn.hidden = true;
      }
    });
  }

  async function copyAppLink(btn) {
    const url = location.origin + "/";
    let ok = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch {}
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, url.length);
        ok = document.execCommand("copy");
        ta.remove();
      } catch {}
    }
    if (btn) {
      const prev = btn.dataset.origLabel || btn.textContent;
      btn.dataset.origLabel = prev;
      btn.textContent = ok ? "Link copied — open in Safari" : "Select & copy: " + url;
      setTimeout(() => {
        btn.textContent = prev;
      }, 2600);
    }
  }

  function showIosInstallGuide() {
    if (!document.body) return;
    if (!iosDialog) {
      iosDialog = document.createElement("dialog");
      iosDialog.id = "uvIosInstallDialog";
      iosDialog.className = "glass uv-ios-dialog";
      iosDialog.setAttribute("aria-labelledby", "uvIosTitle");
      iosDialog.addEventListener("click", (e) => {
        if (e.target === iosDialog) iosDialog.close();
      });
      document.body.appendChild(iosDialog);
    }

    const { inIframe, isInApp, isChromeIOS, isThirdPartyIOS } = getIosBrowserContext();
    const deviceWord = isIPad() ? "iPad" : "iPhone";
    const shareIcon =
      '<svg class="uv-ios-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
    const addIcon =
      '<svg class="uv-ios-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';

    let callout = "";
    if (inIframe) {
      callout =
        '<div class="uv-ios-callout">You are viewing UniVault inside an embedded frame. iOS will only install the app when opened directly in <strong>Safari</strong>. Copy the link below and open it in Safari first.</div>';
    } else if (isInApp || (isThirdPartyIOS && !isChromeIOS)) {
      callout =
        '<div class="uv-ios-callout">This in-app browser cannot add Home Screen apps directly. Tap <strong>Copy App Link</strong> below and open it in <strong>Safari</strong>.</div>';
    }

    const stepsHtml = isChromeIOS && !inIframe && !isInApp
      ? `<ol class="uv-ios-steps">
          <li><span>Tap the <strong>Share</strong> icon ${shareIcon} at the top-right of Chrome’s address bar (or open this link in <strong>Safari</strong>).</span></li>
          <li><span>Scroll down and tap <strong>Add to Home Screen</strong> ${addIcon}.</span></li>
          <li><span>Tap <strong>Add</strong> — UniVault will launch fullscreen from your ${deviceWord} Home Screen.</span></li>
        </ol>`
      : `<ol class="uv-ios-steps">
          <li><span>Open UniVault in <strong>Safari</strong>, then tap the <strong>Share</strong> button ${shareIcon} in the bottom toolbar.</span></li>
          <li><span>Scroll down the share sheet and tap <strong>Add to Home Screen</strong> ${addIcon}.</span></li>
          <li><span>Tap <strong>Add</strong> in the top-right corner to install UniVault on your ${deviceWord}.</span></li>
        </ol>`;

    iosDialog.innerHTML = `
      <div class="uv-ios-head">
        <img src="/assets/apple-touch-icon.png" alt="UniVault icon" class="uv-ios-appicon">
        <div>
          <h3 id="uvIosTitle">Install UniVault on ${deviceWord}</h3>
          <p>Launch fullscreen and keep saved papers offline.</p>
        </div>
      </div>
      ${callout}
      ${stepsHtml}
      <div class="uv-ios-actions">
        <button type="button" class="ghost" id="uvIosCopyLink">Copy App Link</button>
        <button type="button" id="uvIosClose">Done</button>
      </div>
    `;

    const copyBtn = iosDialog.querySelector("#uvIosCopyLink");
    const closeBtn = iosDialog.querySelector("#uvIosClose");
    if (copyBtn) copyBtn.onclick = () => copyAppLink(copyBtn);
    if (closeBtn) closeBtn.onclick = () => iosDialog.close();

    if (typeof iosDialog.showModal === "function") {
      if (!iosDialog.open) iosDialog.showModal();
    } else {
      iosDialog.setAttribute("open", "");
    }
  }

  async function triggerInstall() {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice?.outcome === "accepted") {
          deferredPrompt = null;
        }
      } catch {}
      syncInstallButtons();
      return;
    }
    if (isIOS() && !isStandalone()) {
      showIosInstallGuide();
    }
  }

  function ensureOfflineBar() {
    if (offlineEl || !document.body) return offlineEl;
    offlineEl = document.createElement("div");
    offlineEl.id = "uvOfflineBar";
    offlineEl.className = "uv-offline-bar";
    offlineEl.setAttribute("role", "status");
    offlineEl.setAttribute("aria-live", "polite");
    offlineEl.hidden = true;
    offlineEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>' +
      "<span>Offline mode — showing cached archive &amp; saved papers</span>";
    document.body.appendChild(offlineEl);
    return offlineEl;
  }

  function syncOnlineStatus() {
    const bar = ensureOfflineBar();
    if (!bar) return;
    const online = typeof navigator !== "undefined" ? navigator.onLine : true;
    bar.hidden = online;
    document.documentElement.dataset.offline = online ? "false" : "true";
  }

  function clearUserCache() {
    try {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "CLEAR_USER_DATA_CACHE" });
      }
    } catch {}
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    syncInstallButtons();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    syncInstallButtons();
  });

  window.addEventListener("online", syncOnlineStatus);
  window.addEventListener("offline", syncOnlineStatus);

  document.addEventListener("DOMContentLoaded", () => {
    syncOnlineStatus();
    syncInstallButtons();
    document.querySelectorAll("[data-pwa-install]").forEach((btn) => {
      if (btn.dataset.pwaBound === "1") return;
      btn.dataset.pwaBound = "1";
      btn.addEventListener("click", triggerInstall);
    });
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    });
  }

  window.uvPwa = {
    syncInstallButtons,
    syncOnlineStatus,
    clearUserCache,
    showIosInstallGuide,
  };
  return {
    syncInstallButtons,
    syncOnlineStatus,
    clearUserCache,
    showIosInstallGuide,
  };
})();

