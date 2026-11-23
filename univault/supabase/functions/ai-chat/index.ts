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
      programme = "",
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
      ? `\n\nStudent-uploaded study material / transcript:\n${cleanAttachment}\n`
      : "";

    const contextBits = [
      programme ? `Student programme: ${String(programme).trim()}.` : "",
      course ? `Selected course: ${String(course).trim()}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    let systemInstruction = `You are a sharp, down-to-earth KNUST senior student and Teaching Assistant helping a coursemate prep for exams.${contextBits ? ` ${contextBits}` : ""}${bank ? `\nPast questions on file:\n\n${bank}` : ""}${attachedBlock}\n`;
    const voiceRules = [
      'Sound like a real person talking through study notes at a library table—natural, direct, and easy to follow.',
      'Use everyday contractions (don\'t, it\'s, you\'ll, won\'t) and vary sentence length. Talk to the student directly ("Look at what the question gives you...", "Here\'s the catch most people miss...", "Once you spot that...").',
      'Start straight with the answer or idea. Never open with filler like "Certainly!", "Sure!", "Of course!", "Great question!", "Here is a breakdown:", "Let\'s break this down:", or "Understanding X is crucial".',
      'Stop cleanly once you\'ve answered. Never add robotic sign-offs like "In conclusion,", "To summarize,", "Hope this helps!", "Feel free to ask!", or "Let me know if you need anything else!".',
      'Write in natural flowing paragraphs first instead of turning everything into ### headings and **Bold Label:** colon bullet lists. Only use short steps or plain bullets when working a calculation or listing a few distinct exam traps—and never prefix every bullet with a bolded label and colon.',
      'Avoid stiff AI vocabulary: never use "delve", "crucial", "pivotal", "comprehensive", "multifaceted", "nuanced", "landscape", "underscores", "testament", "leverage", "moreover", "furthermore", "additionally", or "it is important to note". Use plain words instead.',
      'Never use emojis, and write math cleanly with normal symbols (×, ÷, √, ±, ^2, a / b) rather than raw LaTeX ($...$, \\frac).',
      'Style check — avoid textbook stiffness like "### Core Concept\\n**Ohm\'s Law** is a fundamental principle that plays a crucial role...". Write naturally like: "Ohm\'s Law just means voltage and current move together proportionally when resistance stays constant (V = IR). In past papers here, the easy trap is forgetting to convert mA to A before multiplying."',
    ].join("\n- ");

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });

    if (mode === "quiz") {
      systemInstruction += `Write ${count} multiple-choice questions in the style of these materials. Keep explanations crisp and human (1–2 direct sentences). Extra instructions: ${instructions || "none"}.`;
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Generate ${count} multiple-choice questions.`,
        config: {
          systemInstruction,
          temperature: 0.65,
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
        `How to reply:\n- ${voiceRules}\nWalk through the question or material the way a good TA would: give the main idea in plain language, work through the steps cleanly with units and formulas, point out why a tricky step works as you go, and mention any real exam trap lecturers mark down.`;
      const prompt = targetQuestion
        ? `Walk me through this question or topic clearly:\n\n${String(targetQuestion)}`
        : "Break down the key questions and concepts in the provided material step by step.";
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: { systemInstruction, temperature: 0.75 },
      });
      return json({
        text: response.text ?? "",
        freeRemaining,
        freeLimit,
      });
    }

    systemInstruction += `How to reply:\n- ${voiceRules}\nAnswer concisely for quick questions, show clear worked steps for calculations or derivations, and dig deeper when asked about a past paper or uploaded file. When asked to predict exam questions, weigh recurring topics, mark weighting, question phrasing, and lecturer habits across years, and make clear these are informed estimates rather than guarantees.`;

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
      config: { systemInstruction, temperature: 0.75 },
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
