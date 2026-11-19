import { Type } from '@google/genai';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGeminiClient } from './_lib/univault-ai.js';

type VercelRequest = IncomingMessage & {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
};

type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

async function readJsonBody(req: VercelRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') {
    return req.body as Record<string, unknown>;
  }
  if (typeof req.body === 'string') {
    return JSON.parse(req.body || '{}') as Record<string, unknown>;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

    if (!geminiKey) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not configured in environment variables.' });
      return;
    }
    if (!supabaseUrl || !supabaseAnonKey) {
      res.status(500).json({ error: 'Supabase configuration is missing on the server.' });
      return;
    }

    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      res.status(401).json({ error: 'Please sign in first.' });
      return;
    }

    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) {
      res.status(401).json({ error: 'Please sign in first.' });
      return;
    }
    const user = (await userRes.json()) as { id?: string };
    if (!user?.id) {
      res.status(401).json({ error: 'Please sign in first.' });
      return;
    }

    const body = await readJsonBody(req);
    const mode = String(body.mode || 'chat');
    const course = String(body.course || '');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const count = Number(body.count) || 5;
    const instructions = String(body.instructions || '');
    const attachmentContext = String(body.attachmentContext || '').trim().slice(0, 45000);
    const targetQuestion = String(body.targetQuestion || '').trim();

    const [profRes, admRes] = await Promise.all([
      fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=premium_until`,
        { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` } }
      ),
      fetch(
        `${supabaseUrl}/rest/v1/admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
        { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` } }
      ),
    ]);
    const profRows = profRes.ok
      ? ((await profRes.json()) as Array<{ premium_until?: string | null }>)
      : [];
    const admRows = admRes.ok ? ((await admRes.json()) as Array<{ user_id?: string }>) : [];
    const premiumUntil = profRows[0]?.premium_until;
    const isAdmin = admRows.length > 0;
    const isPremium = Boolean(premiumUntil && new Date(premiumUntil) > new Date());
    const hasUploadedSource = Boolean(attachmentContext) && (mode === 'chat' || mode === 'explain');

    if (!isPremium && !isAdmin && !hasUploadedSource) {
      res.status(402).json({ error: 'Premium required. Upgrade to continue.' });
      return;
    }

    let qs: Array<{ year?: number; semester?: number; question_content?: { content?: string } }> = [];
    if (course && (isPremium || isAdmin)) {
      const qRes = await fetch(
        `${supabaseUrl}/rest/v1/questions?course_code=eq.${encodeURIComponent(course)}&status=eq.approved&select=year,semester,question_content(content)&order=year.desc&limit=15`,
        { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` } }
      );
      if (qRes.ok) qs = (await qRes.json()) as typeof qs;
    }

    const bank = qs
      .map((q) => `[${q.year} S${q.semester ?? '-'}]\n${q.question_content?.content ?? ''}`)
      .join('\n\n')
      .slice(0, 40000);

    const ai = createGeminiClient(geminiKey);
    const attachedBlock = attachmentContext
      ? `\n\nUser-uploaded study material / transcript:\n${attachmentContext}\n`
      : '';

    let systemInstruction = `You are a KNUST exam tutor.${course ? ` Selected course: ${course}.` : ''}${bank ? `\nPast questions on file:\n\n${bank}` : ''}${attachedBlock}\n`;

    if (mode === 'quiz') {
      systemInstruction += `Write ${count} multiple-choice questions in the style of these materials. Extra instructions: ${instructions || 'none'}.`;
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Generate ${count} multiple-choice questions.`,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
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
              required: ['q', 'options', 'answer', 'explain'],
            },
          },
        },
      });
      res.status(200).json({ text: (response.text ?? '[]').trim() });
      return;
    }

    if (mode === 'explain') {
      systemInstruction +=
        'Provide a thorough, detailed academic explanation. Structure your answer clearly with: (1) Core Concept & Definitions, (2) Step-by-Step Solution / Working with clear formulas and units, (3) Why each step works, and (4) Examiner Tips & Common Mistakes to avoid.';
      const prompt = targetQuestion
        ? `Give a detailed explanation for this specific question or topic:\n\n${targetQuestion}`
        : 'Provide a detailed, step-by-step explanation covering the key questions and concepts in the provided material.';
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: { systemInstruction },
      });
      res.status(200).json({ text: response.text ?? '' });
      return;
    }

    systemInstruction +=
      'Solve questions step by step with clear working, and provide deep explanations whenever asked about a specific question or uploaded document/recording. When asked to predict, analyse repeated topics, question formats, mark weighting and lecturer habits across years, and say which topics are most likely; label predictions as estimates, never guarantees.';

    const contents = messages
      .filter(
        (m): m is { role?: string; content: string } =>
          Boolean(m && typeof m === 'object' && typeof (m as { content?: unknown }).content === 'string')
      )
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: contents.length ? contents : 'Hello',
      config: { systemInstruction },
    });

    res.status(200).json({ text: response.text ?? '' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'AI service error';
    res.status(500).json({ error: message });
  }
}
