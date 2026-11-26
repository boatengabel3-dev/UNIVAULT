import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  const {
    data: { user },
  } = token ? await sb.auth.getUser(token) : { data: { user: null } };
  if (!user) return json({ error: "Sign in" }, 401);

  const body = await req.json().catch(() => ({}));
  const reference = String(body?.reference || "").trim();
  if (!reference) return json({ error: "Missing transaction reference" }, 400);

  const { data: used } = await sb
    .from("payments")
    .select("reference,user_id")
    .eq("reference", reference)
    .maybeSingle();

  if (used) {
    if (used.user_id === user.id) {
      const { data: prof } = await sb
        .from("profiles")
        .select("plan,premium_started_at,premium_expires_at,premium_until")
        .eq("id", user.id)
        .maybeSingle();
      return json({
        ok: true,
        duplicate: true,
        plan: prof?.plan || "premium",
        premium_started_at: prof?.premium_started_at || null,
        premium_expires_at: prof?.premium_expires_at || prof?.premium_until || null,
        premium_until: prof?.premium_expires_at || prof?.premium_until || null,
      });
    }
    return json({ error: "Reference already used" }, 400);
  }

  const { data: settings } = await sb
    .from("app_settings")
    .select("price_ghs")
    .eq("id", 1)
    .maybeSingle();
  const minPesewas = Math.max(100, Math.round(Number(settings?.price_ghs ?? 30) * 100));

  const r = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${Deno.env.get("PAYSTACK_SECRET_KEY")}` },
    }
  );
  const verifyPayload = await r.json().catch(() => null);
  const data = verifyPayload?.data;
  if (
    !r.ok ||
    data?.status !== "success" ||
    data.currency !== "GHS" ||
    Number(data.amount || 0) < minPesewas ||
    String(data.customer?.email || "").toLowerCase() !== String(user.email || "").toLowerCase()
  ) {
    return json({ ok: false }, 400);
  }

  const { error: insErr } = await sb
    .from("payments")
    .insert({ reference, user_id: user.id, amount: Number(data.amount) });

  if (insErr) {
    if (insErr.code === "23505") {
      const { data: prof } = await sb
        .from("profiles")
        .select("plan,premium_started_at,premium_expires_at,premium_until")
        .eq("id", user.id)
        .maybeSingle();
      return json({
        ok: true,
        duplicate: true,
        plan: prof?.plan || "premium",
        premium_started_at: prof?.premium_started_at || null,
        premium_expires_at: prof?.premium_expires_at || prof?.premium_until || null,
        premium_until: prof?.premium_expires_at || prof?.premium_until || null,
      });
    }
    return json({ error: insErr.message }, 500);
  }

  const { data: p } = await sb
    .from("profiles")
    .select("plan,premium_started_at,premium_expires_at,premium_until")
    .eq("id", user.id)
    .maybeSingle();

  const now = new Date();
  const existingRaw = p?.premium_expires_at || p?.premium_until || null;
  const existingExp = existingRaw ? new Date(existingRaw) : null;
  const isActive = Boolean(existingExp && !Number.isNaN(existingExp.getTime()) && existingExp > now);

  const startedAt = isActive && p?.premium_started_at ? p.premium_started_at : now.toISOString();
  const base = isActive && existingExp ? new Date(existingExp.getTime()) : new Date(now.getTime());
  base.setDate(base.getDate() + 30);
  const expiresAt = base.toISOString();

  await sb.from("profiles").upsert(
    {
      id: user.id,
      plan: "premium",
      premium_started_at: startedAt,
      premium_expires_at: expiresAt,
      premium_until: expiresAt,
    },
    { onConflict: "id" }
  );

  return json({
    ok: true,
    plan: "premium",
    premium_started_at: startedAt,
    premium_expires_at: expiresAt,
    premium_until: expiresAt,
  });
});
