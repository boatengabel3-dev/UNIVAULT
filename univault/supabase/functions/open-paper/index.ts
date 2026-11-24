import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceKey;
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ error: "Missing Supabase configuration." }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return json({ error: "Please sign in first." }, 401);
    }

    const authSb = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const {
      data: { user },
      error: userErr,
    } = await authSb.auth.getUser(token);
    if (userErr || !user) {
      return json({ error: "Please sign in first." }, 401);
    }

    const { qid } = await req.json();
    const cleanQid = String(qid || "").trim();
    if (!cleanQid) {
      return json({ allowed: false, not_found: true, limit: 3, remaining: 0, used: 0 });
    }

    const sb = createClient(supabaseUrl, serviceKey);
    const [settingsRes, questionRes, adminRes, profileRes] = await Promise.all([
      sb.from("app_settings").select("free_questions_limit").eq("id", 1).maybeSingle(),
      sb
        .from("questions")
        .select("id,status,uploader,question_content(content)")
        .eq("id", cleanQid)
        .maybeSingle(),
      sb.from("admins").select("user_id").eq("user_id", user.id).maybeSingle(),
      sb.from("profiles").select("id,premium_until,free_question_ids").eq("id", user.id).maybeSingle(),
    ]);

    const limit =
      typeof settingsRes.data?.free_questions_limit === "number"
        ? Math.max(0, Math.floor(settingsRes.data.free_questions_limit))
        : 3;

    const q = questionRes.data;
    if (!q) {
      return json({ allowed: false, not_found: true, limit, remaining: 0, used: 0 });
    }

    const isAdmin = Boolean(adminRes.data);
    const isUploader = Boolean(q.uploader && q.uploader === user.id);
    if (q.status !== "approved" && !isAdmin && !isUploader) {
      return json({ allowed: false, limit, remaining: 0, used: 0 });
    }

    const qcRaw = Array.isArray(q.question_content) ? q.question_content[0] : q.question_content;
    const content = typeof qcRaw?.content === "string" ? qcRaw.content : "";

    if (isAdmin || isUploader) {
      return json({ allowed: true, unlimited: true, content, remaining: 9999, limit, used: 0 });
    }

    const prof = profileRes.data;
    const isPro = Boolean(prof?.premium_until && new Date(prof.premium_until) > new Date());
    const unlocked = Array.isArray(prof?.free_question_ids)
      ? prof.free_question_ids.map((v: unknown) => String(v))
      : [];

    if (isPro) {
      return json({
        allowed: true,
        unlimited: true,
        content,
        remaining: 9999,
        limit,
        used: unlocked.length,
      });
    }

    if (unlocked.includes(cleanQid)) {
      return json({
        allowed: true,
        unlimited: false,
        already_unlocked: true,
        content,
        used: unlocked.length,
        remaining: Math.max(limit - unlocked.length, 0),
        limit,
        free_question_ids: unlocked,
      });
    }

    if (unlocked.length >= limit) {
      return json({
        allowed: false,
        unlimited: false,
        used: unlocked.length,
        remaining: 0,
        limit,
        free_question_ids: unlocked,
      });
    }

    const nextUnlocked = [...unlocked, cleanQid];
    await sb.from("profiles").update({ free_question_ids: nextUnlocked }).eq("id", user.id);

    return json({
      allowed: true,
      unlimited: false,
      already_unlocked: false,
      content,
      used: nextUnlocked.length,
      remaining: Math.max(limit - nextUnlocked.length, 0),
      limit,
      free_question_ids: nextUnlocked,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not open past paper.";
    return json({ error: message }, 500);
  }
});
