import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-paystack-signature",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

async function verifyPaystackSignature(
  rawBody: string,
  signatureHeader: string,
  secretKey: string
): Promise<boolean> {
  if (!signatureHeader || !secretKey) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretKey),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expectedHex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const receivedHex = signatureHeader.trim().toLowerCase();
  if (expectedHex.length !== receivedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ receivedHex.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secretKey = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim() || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!secretKey || !supabaseUrl || !serviceKey) {
    return json({ error: "Server payment secrets not configured" }, 500);
  }

  const rawBody = await req.text();
  const sig = req.headers.get("x-paystack-signature") || "";
  const validSig = await verifyPaystackSignature(rawBody, sig, secretKey);
  if (!validSig) {
    return json({ error: "Invalid Paystack signature" }, 401);
  }

  let event: { event?: string; data?: Record<string, any> } = {};
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON payload" }, 400);
  }

  if (event?.event !== "charge.success") {
    return json({ ok: true, ignored: event?.event || "unknown" });
  }

  const reference = String(event?.data?.reference || "").trim();
  if (!reference) {
    return json({ error: "Missing transaction reference" }, 400);
  }

  const sb = createClient(supabaseUrl, serviceKey);

  const { data: alreadyRecorded } = await sb
    .from("payments")
    .select("reference")
    .eq("reference", reference)
    .maybeSingle();
  if (alreadyRecorded) {
    return json({ ok: true, duplicate: true });
  }

  const { data: settings } = await sb
    .from("app_settings")
    .select("price_ghs")
    .eq("id", 1)
    .maybeSingle();
  const minPesewas = Math.max(100, Math.round(Number(settings?.price_ghs ?? 30) * 100));

  // Verify transaction directly with Paystack API before mutating database
  const verifyRes = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${secretKey}` },
    }
  );
  const verifyJson = await verifyRes.json().catch(() => null);
  const tx = verifyJson?.data;
  if (
    !verifyRes.ok ||
    tx?.status !== "success" ||
    tx?.currency !== "GHS" ||
    Number(tx?.amount || 0) < minPesewas
  ) {
    return json({ ok: false, error: "Transaction verification failed" }, 400);
  }

  let targetUserId = String(tx?.metadata?.user_id || event?.data?.metadata?.user_id || "").trim();
  if (!targetUserId && tx?.customer?.email) {
    const emailLower = String(tx.customer.email).trim().toLowerCase();
    const { data: userList } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const match = (userList?.users || []).find(
      (u) => String(u.email || "").trim().toLowerCase() === emailLower
    );
    if (match?.id) targetUserId = match.id;
  }

  if (!targetUserId) {
    return json({ ok: false, error: "Could not resolve user for payment" }, 400);
  }

  const { error: insertErr } = await sb
    .from("payments")
    .insert({ reference, user_id: targetUserId, amount: Number(tx.amount) });
  if (insertErr) {
    if (insertErr.code === "23505") {
      return json({ ok: true, duplicate: true });
    }
    return json({ error: insertErr.message }, 500);
  }

  const { data: prof } = await sb
    .from("profiles")
    .select("plan,premium_started_at,premium_expires_at,premium_until")
    .eq("id", targetUserId)
    .maybeSingle();

  const now = new Date();
  const existingRaw = prof?.premium_expires_at || prof?.premium_until || null;
  const existingExp = existingRaw ? new Date(existingRaw) : null;
  const isActive = Boolean(existingExp && !Number.isNaN(existingExp.getTime()) && existingExp > now);

  const startedAt = isActive && prof?.premium_started_at ? prof.premium_started_at : now.toISOString();
  const nextExpiry = isActive && existingExp ? new Date(existingExp.getTime()) : new Date(now.getTime());
  nextExpiry.setDate(nextExpiry.getDate() + 30);
  const expiresAt = nextExpiry.toISOString();

  await sb
    .from("profiles")
    .upsert(
      {
        id: targetUserId,
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
  });
});
