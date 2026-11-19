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

let sb = fallbackSb;
if (isValidSupabaseUrl && typeof supabase !== "undefined") {
  try {
    sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
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

  let observer = null;

  function observeReveals(root = document) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    const nodes = scope.querySelectorAll(".uv-reveal");
    if (!nodes.length) return;

    if (prefersReduced() || typeof IntersectionObserver === "undefined") {
      nodes.forEach((n) => n.classList.add("uv-revealed"));
      return;
    }

    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("uv-revealed");
            observer.unobserve(entry.target);
          });
        },
        { threshold: 0.08, rootMargin: "0px 0px -30px 0px" }
      );
    }

    let idx = 0;
    nodes.forEach((n) => {
      if (n.classList.contains("uv-revealed")) return;
      if (!n.style.getPropertyValue("--uv-delay")) {
        n.style.setProperty("--uv-delay", `${Math.min(idx * 55, 280)}ms`);
        idx++;
      }
      observer.observe(n);
    });
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
  return { observeReveals };
})();

