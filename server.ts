import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const port = Number(process.env.PORT) || 3000;

const univaultDir = path.resolve(process.cwd(), 'univault');
const distDir = path.resolve(process.cwd(), 'dist');
const staticDir = fs.existsSync(univaultDir) ? univaultDir : distDir;

app.use(express.json({ limit: '1mb' }));

app.post('/api/ai-chat', async (req, res) => {
  try {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

    if (!geminiKey) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Secrets.' });
      return;
    }
    if (!supabaseUrl || !supabaseAnonKey) {
      res.status(500).json({ error: 'Supabase configuration is missing on the server.' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      res.status(401).json({ error: 'Please sign in first.' });
      return;
    }

    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
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

    const [profRes, admRes] = await Promise.all([
      fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=premium_until`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token}`,
          },
        }
      ),
      fetch(
        `${supabaseUrl}/rest/v1/admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token}`,
          },
        }
      ),
    ]);
    const profRows = profRes.ok ? ((await profRes.json()) as Array<{ premium_until?: string | null }>) : [];
    const admRows = admRes.ok ? ((await admRes.json()) as Array<{ user_id?: string }>) : [];
    const premiumUntil = profRows[0]?.premium_until;
    const isAdmin = admRows.length > 0;
    const isPremium = Boolean(premiumUntil && new Date(premiumUntil) > new Date());
    if (!isPremium && !isAdmin) {
      res.status(402).json({ error: 'Premium required. Upgrade to continue.' });
      return;
    }

    const { mode, course = '', messages = [], count = 5, instructions = '' } = req.body || {};

    let qs: Array<{ year?: number; semester?: number; question_content?: { content?: string } }> = [];
    if (course) {
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

    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    let systemInstruction = `You are a KNUST exam tutor. Past questions for ${course || 'the course'}:\n\n${bank || '(none on file)'}\n\n`;

    if (mode === 'quiz') {
      systemInstruction += `Write ${count} multiple-choice questions in the style of these past questions. Extra instructions: ${instructions || 'none'}.`;
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

    systemInstruction +=
      'Solve questions step by step with clear working. When asked to predict, analyse repeated topics, question formats, mark weighting and lecturer habits across years, and say which topics are most likely; label predictions as estimates, never guarantees.';

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
    const message = err instanceof Error ? err.message : 'AI service error';
    res.status(500).json({ error: message });
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

