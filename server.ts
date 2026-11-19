import 'dotenv/config';
import { Type } from '@google/genai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  checkDuplicateQuestion,
  createGeminiClient,
  processUploadedMaterial,
} from './api/_lib/univault-ai.ts';

const app = express();
const port = Number(process.env.PORT) || 3000;

const univaultDir = path.resolve(process.cwd(), 'univault');
const distDir = path.resolve(process.cwd(), 'dist');
const staticDir = fs.existsSync(univaultDir) ? univaultDir : distDir;

app.use(express.json({ limit: '35mb' }));

async function authenticateSupabaseUser(req: express.Request): Promise<{
  token: string;
  userId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw Object.assign(new Error('Supabase configuration is missing on the server.'), { status: 500 });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw Object.assign(new Error('Please sign in first.'), { status: 401 });
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    throw Object.assign(new Error('Please sign in first.'), { status: 401 });
  }
  const user = (await userRes.json()) as { id?: string };
  if (!user?.id) {
    throw Object.assign(new Error('Please sign in first.'), { status: 401 });
  }

  return { token, userId: user.id, supabaseUrl, supabaseAnonKey };
}

app.post('/api/ai-process-file', async (req, res) => {
  try {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    if (!geminiKey) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Secrets.' });
      return;
    }

    const { token, supabaseUrl, supabaseAnonKey } = await authenticateSupabaseUser(req);
    const { fileName = 'upload', mimeType = '', dataBase64 = '' } = req.body || {};

    if (!dataBase64 || typeof dataBase64 !== 'string') {
      res.status(400).json({ error: 'No file data was provided.' });
      return;
    }

    const result = await processUploadedMaterial({
      apiKey: geminiKey,
      fileName: String(fileName),
      mimeType: String(mimeType),
      dataBase64,
    });

    const dup = await checkDuplicateQuestion({
      supabaseUrl,
      supabaseAnonKey,
      token,
      department: result.metadata.department,
      courseCode: result.metadata.course_code,
      year: result.metadata.year,
      semester: result.metadata.semester,
      bodyText: result.extractedText,
    });

    res.json({
      ...result,
      duplicateCheck: dup,
    });
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 400;
    const message = err instanceof Error ? err.message : 'Failed to process uploaded file.';
    res.status(status).json({ error: message });
  }
});

app.post('/api/check-duplicate', async (req, res) => {
  try {
    const { token, supabaseUrl, supabaseAnonKey } = await authenticateSupabaseUser(req);
    const { department = '', courseCode = '', year = null, semester = null, bodyText = '' } =
      req.body || {};

    const result = await checkDuplicateQuestion({
      supabaseUrl,
      supabaseAnonKey,
      token,
      department: String(department),
      courseCode: String(courseCode),
      year: year ? Number(year) : null,
      semester: semester ? Number(semester) : null,
      bodyText: String(bodyText),
    });

    res.json(result);
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    const message = err instanceof Error ? err.message : 'Duplicate check failed.';
    res.status(status).json({ error: message });
  }
});

app.post('/api/ai-chat', async (req, res) => {
  try {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    if (!geminiKey) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Secrets.' });
      return;
    }

    const { token, userId, supabaseUrl, supabaseAnonKey } = await authenticateSupabaseUser(req);

    const {
      mode = 'chat',
      course = '',
      messages = [],
      count = 5,
      instructions = '',
      attachmentContext = '',
      targetQuestion = '',
    } = req.body || {};

    const cleanAttachment = String(attachmentContext || '').trim().slice(0, 45000);

    const [profRes, admRes] = await Promise.all([
      fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=premium_until`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token}`,
          },
        }
      ),
      fetch(
        `${supabaseUrl}/rest/v1/admins?user_id=eq.${encodeURIComponent(userId)}&select=user_id`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token}`,
          },
        }
      ),
    ]);
    const profRows = profRes.ok
      ? ((await profRes.json()) as Array<{ premium_until?: string | null }>)
      : [];
    const admRows = admRes.ok ? ((await admRes.json()) as Array<{ user_id?: string }>) : [];
    const premiumUntil = profRows[0]?.premium_until;
    const isAdmin = admRows.length > 0;
    const isPremium = Boolean(premiumUntil && new Date(premiumUntil) > new Date());
    const hasUploadedSource = Boolean(cleanAttachment) && (mode === 'chat' || mode === 'explain');

    if (!isPremium && !isAdmin && !hasUploadedSource) {
      res.status(402).json({ error: 'Premium required. Upgrade to continue.' });
      return;
    }

    let qs: Array<{ year?: number; semester?: number; question_content?: { content?: string } }> = [];
    if (course && (isPremium || isAdmin)) {
      const qRes = await fetch(
        `${supabaseUrl}/rest/v1/questions?course_code=eq.${encodeURIComponent(course)}&status=eq.approved&select=year,semester,question_content(content)&order=year.desc&limit=15`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (qRes.ok) {
        qs = (await qRes.json()) as typeof qs;
      }
    }

    const bank = qs
      .map((q) => `[${q.year} S${q.semester ?? '-'}]\n${q.question_content?.content ?? ''}`)
      .join('\n\n')
      .slice(0, 40000);

    const ai = createGeminiClient(geminiKey);
    const attachedBlock = cleanAttachment
      ? `\n\nUser-uploaded study material / transcript:\n${cleanAttachment}\n`
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
      res.json({ text: (response.text ?? '[]').trim() });
      return;
    }

    if (mode === 'explain') {
      systemInstruction +=
        'Provide a thorough, detailed academic explanation. Structure your answer clearly with: (1) Core Concept & Definitions, (2) Step-by-Step Solution / Working with clear formulas and units, (3) Why each step works, and (4) Examiner Tips & Common Mistakes to avoid.';
      const prompt = targetQuestion
        ? `Give a detailed explanation for this specific question or topic:\n\n${String(targetQuestion)}`
        : 'Provide a detailed, step-by-step explanation covering the key questions and concepts in the provided material.';
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: { systemInstruction },
      });
      res.json({ text: response.text ?? '' });
      return;
    }

    systemInstruction +=
      'Solve questions step by step with clear working, and provide deep explanations whenever asked about a specific question or uploaded document/recording. When asked to predict, analyse repeated topics, question formats, mark weighting and lecturer habits across years, and say which topics are most likely; label predictions as estimates, never guarantees.';

    const contents = (Array.isArray(messages) ? messages : [])
      .filter((m: { content?: unknown }) => m && typeof m.content === 'string' && m.content.trim())
      .map((m: { role?: string; content: string }) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: contents.length ? contents : 'Hello',
      config: { systemInstruction },
    });

    res.json({ text: response.text ?? '' });
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    const message = err instanceof Error ? err.message : 'AI service error';
    res.status(status).json({ error: message });
  }
});

app.get('/config.js', (_req, res) => {
  const configPath = path.join(staticDir, 'config.js');
  if (!fs.existsSync(configPath)) {
    res.status(404).end();
    return;
  }

  let content = fs.readFileSync(configPath, 'utf8');
  const envUrl = process.env.SUPABASE_URL?.trim();
  const envAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const envPaystackKey = process.env.PAYSTACK_PUBLIC_KEY?.trim();

  const overrides: string[] = [];
  if (envUrl) overrides.push(`C.SUPABASE_URL = ${JSON.stringify(envUrl)};`);
  if (envAnonKey) overrides.push(`C.SUPABASE_ANON_KEY = ${JSON.stringify(envAnonKey)};`);
  if (envPaystackKey) overrides.push(`C.PAYSTACK_PUBLIC_KEY = ${JSON.stringify(envPaystackKey)};`);

  if (overrides.length > 0) {
    content = content.replace(
      'const isValidSupabaseUrl =',
      `${overrides.join('\n')}\nconst isValidSupabaseUrl =`
    );
  }

  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript').send(content);
});

app.use(express.static(staticDir));

app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    res.status(404).end();
    return;
  }
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`UniVault server listening on http://0.0.0.0:${port}`);
});
