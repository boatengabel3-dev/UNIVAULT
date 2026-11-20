import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenAI, Type } from "npm:@google/genai@^3.6.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    const {
      data: { user },
    } = token ? await sb.auth.getUser(token) : { data: { user: null } };
    if (!user) return json({ error: "Please sign in first." }, 401);

    const {
      mode = "chat",
      course = "",
      messages = [],
      count = 5,
      instructions = "",
      attachmentContext = "",
      targetQuestion = "",
    } = await req.json();

    const cleanAttachment = String(attachmentContext || "").trim().slice(0, 45000);
    const [{ data: p }, { data: adm }, { data: settings }] = await Promise.all([
      sb.from("profiles").select("*").eq("id", user.id).single(),
      sb.from("admins").select("user_id").eq("user_id", user.id).maybeSingle(),
      sb.from("app_settings").select("free_ai_limit").eq("id", 1).maybeSingle(),
    ]);
    const premium = Boolean(p?.premium_until && new Date(p.premium_until) > new Date());
    const freeLimit = Math.max(0, Number(settings?.free_ai_limit ?? 5));
    const currentUses = Number(p?.ai_uses ?? 0);
    let freeRemaining: number | null = null;

    if (!premium && !adm) {
      if (currentUses >= freeLimit) {
        return json(
          { error: `Free AI trial limit reached (${freeLimit} uses). Upgrade to Premium to continue.` },
          402
        );
      }
      freeRemaining = Math.max(freeLimit - (currentUses + 1), 0);
      await sb.from("profiles").update({ ai_uses: currentUses + 1 }).eq("id", user.id);
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return json(
        { error: "GEMINI_API_KEY secret is not configured in Supabase Edge Function secrets." },
        500
      );
    }

    let qs: any[] = [];
    if (course) {
      const r = await sb
        .from("questions")
        .select("year,semester,question_content(content)")
        .eq("course_code", course)
        .eq("status", "approved")
        .order("year", { ascending: false })
        .limit(15);
      qs = r.data || [];
    }

    const bank = qs
      .map((q) => {
        const qc = Array.isArray(q.question_content)
          ? q.question_content[0]?.content
          : q.question_content?.content;
        return qc ? `[${q.year} S${q.semester ?? "-"}]\n${qc}` : "";
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 40000);

    const attachedBlock = cleanAttachment
      ? `\n\nUser-uploaded study material / transcript:\n${cleanAttachment}\n`
      : "";

    let systemInstruction = `You are a KNUST exam tutor.${course ? ` Selected course: ${course}.` : ""}${bank ? `\nPast questions on file:\n\n${bank}` : ""}${attachedBlock}\n`;
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });

    if (mode === "quiz") {
      systemInstruction += `Write ${count} multiple-choice questions in the style of these materials. Extra instructions: ${instructions || "none"}.`;
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Generate ${count} multiple-choice questions.`,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                q: { type: Type.STRING },
                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                answer: { type: Type.INTEGER },
                explain: { type: Type.STRING },
              },
              required: ["q", "options", "answer", "explain"],
            },
          },
        },
      });
      return json({
        text: (response.text ?? "[]").trim(),
        freeRemaining,
        freeLimit,
      });
    }

    if (mode === "explain") {
      systemInstruction +=
        "Provide a thorough, detailed academic explanation. Structure your answer clearly with: (1) Core Concept & Definitions, (2) Step-by-Step Solution / Working with clear formulas and units, (3) Why each step works, and (4) Examiner Tips & Common Mistakes to avoid.";
      const prompt = targetQuestion
        ? `Give a detailed explanation for this specific question or topic:\n\n${String(targetQuestion)}`
        : "Provide a detailed, step-by-step explanation covering the key questions and concepts in the provided material.";
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: { systemInstruction },
      });
      return json({
        text: response.text ?? "",
        freeRemaining,
        freeLimit,
      });
    }

    systemInstruction += `Solve questions step by step with clear working, and provide deep explanations whenever asked about a specific question or uploaded document/recording. When asked to predict, analyse repeated topics, question formats, mark weighting and lecturer habits across years, and say which topics are most likely; label predictions as estimates, never guarantees.`;

    const cleaned: Array<{ role: "user" | "model"; text: string }> = [];
    for (const item of Array.isArray(messages) ? messages : []) {
      if (!item || typeof item.content !== "string" || !item.content.trim()) continue;
      const role = item.role === "assistant" || item.role === "model" ? "model" : "user";
      const text = item.content.trim();
      const prev = cleaned[cleaned.length - 1];
      if (prev && prev.role === role) {
        prev.text += `\n\n${text}`;
      } else {
        cleaned.push({ role, text });
      }
    }
    while (cleaned.length > 0 && cleaned[0].role === "model") {
      cleaned.shift();
    }
    const contents = cleaned.length
      ? cleaned.map((m) => ({ role: m.role, parts: [{ text: m.text }] }))
      : [{ role: "user", parts: [{ text: "Hello" }] }];

    const response = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents,
      config: { systemInstruction },
    });

    return json({
      text: response.text ?? "",
      freeRemaining,
      freeLimit,
    });
  } catch (err: any) {
    return json({ error: err?.message || "Unexpected Edge Function error" }, 500);
  }
});
