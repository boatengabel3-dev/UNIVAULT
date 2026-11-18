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
    eq: () => chain,
    order: () => chain,
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
