import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenAI, Type } from "npm:@google/genai";

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
    const [{ data: p }, { data: adm }] = await Promise.all([
      sb.from("profiles").select("*").eq("id", user.id).single(),
      sb.from("admins").select("user_id").eq("user_id", user.id).maybeSingle(),
    ]);
    const premium = p?.premium_until && new Date(p.premium_until) > new Date();
    const hasUploadedSource = Boolean(cleanAttachment) && (mode === "chat" || mode === "explain");
    if (!premium && !adm && !hasUploadedSource) {
      return json({ error: "Premium required. Upgrade to continue." }, 402);
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return json(
        { error: "GEMINI_API_KEY secret is not configured in Supabase Edge Function secrets." },
        500
      );
    }

    let qs: any[] = [];
    if (course && (premium || adm)) {
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
      .map((q) => `[${q.year} S${q.semester ?? "-"}]\n${q.question_content?.content ?? ""}`)
      .join("\n\n")
      .slice(0, 40000);

    const attachedBlock = cleanAttachment
      ? `\n\nUser-uploaded study material / transcript:\n${cleanAttachment}\n`
      : "";

    let systemInstruction = `You are a KNUST exam tutor.${course ? ` Selected course: ${course}.` : ""}${bank ? `\nPast questions on file:\n\n${bank}` : ""}${attachedBlock}\n`;
    const ai = new GoogleGenAI({ apiKey });

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
      return json({ text: (response.text ?? "[]").trim() });
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
      return json({ text: response.text ?? "" });
    }

    systemInstruction += `Solve questions step by step with clear working, and provide deep explanations whenever asked about a specific question or uploaded document/recording. When asked to predict, analyse repeated topics, question formats, mark weighting and lecturer habits across years, and say which topics are most likely; label predictions as estimates, never guarantees.`;

    const contents = (Array.isArray(messages) ? messages : [])
      .filter((m: any) => m && typeof m.content === "string" && m.content.trim())
      .map((m: any) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const response = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: contents.length ? contents : "Hello",
      config: { systemInstruction },
    });

    return json({ text: response.text ?? "" });
  } catch (err: any) {
    return json({ error: err?.message || "Unexpected Edge Function error" }, 500);
  }
});
