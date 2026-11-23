import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  checkDuplicateQuestion,
  formatAiError,
  prepareAiChat,
  processUploadedMaterial,
  runAiChat,
  streamAiChat,
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
    signal: AbortSignal.timeout(8000),
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
    const {
      fileName = 'upload',
      mimeType = '',
      dataBase64 = '',
      preprocessedText = '',
      ocrUsed = false,
    } = req.body || {};

    if ((!dataBase64 || typeof dataBase64 !== 'string') && !String(preprocessedText || '').trim()) {
      res.status(400).json({ error: 'No file data or extracted text was provided.' });
      return;
    }

    const result = await processUploadedMaterial({
      apiKey: geminiKey,
      fileName: String(fileName),
      mimeType: String(mimeType),
      dataBase64: String(dataBase64 || ''),
      preprocessedText: String(preprocessedText || ''),
      ocrUsed: Boolean(ocrUsed),
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
    const formatted = formatAiError(err);
    const explicit =
      err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 0;
    const status = explicit || (formatted.status >= 500 ? formatted.status : 400);
    res.status(status).json({ error: formatted.message });
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
  let headersSentForStream = false;
  try {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    if (!geminiKey) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Secrets.' });
      return;
    }

    const { token, userId, supabaseUrl, supabaseAnonKey } = await authenticateSupabaseUser(req);
    const body = req.body || {};
    const wantStream = Boolean(body.stream) && String(body.mode || 'chat') !== 'quiz';

    const input = {
      apiKey: geminiKey,
      supabaseUrl,
      supabaseAnonKey,
      token,
      userId,
      mode: body.mode,
      course: body.course,
      programme: body.programme,
      messages: body.messages,
      count: body.count,
      instructions: body.instructions,
      attachmentContext: body.attachmentContext,
      targetQuestion: body.targetQuestion,
    };

    if (!wantStream) {
      const result = await runAiChat(input);
      res.json(result);
      return;
    }

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    headersSentForStream = true;

    const keepalive = setInterval(() => {
      if (!closed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
      }
    }, 4000);

    try {
      const prep = await prepareAiChat(input);
      for await (const ev of streamAiChat(prep, () => closed || res.writableEnded)) {
        if (closed || res.writableEnded) break;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      if (!res.writableEnded) {
        res.end();
      }
    } finally {
      clearInterval(keepalive);
    }
  } catch (err: unknown) {
    const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
    const formatted = formatAiError(err);
    const status = formatted.status;
    const message = formatted.message;
    if (status >= 500) {
      console.error('[api/ai-chat]', message);
    }
    if (headersSentForStream || res.headersSent) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: message, status })}\n\n`);
        res.end();
      }
      return;
    }
    res.status(status).json({
      error: message,
      ...(typeof errObj.freeRemaining === 'number' ? { freeRemaining: errObj.freeRemaining } : {}),
      ...(typeof errObj.freeLimit === 'number' ? { freeLimit: errObj.freeLimit } : {}),
    });
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

app.get('/sw.js', (_req, res) => {
  const swPath = path.join(staticDir, 'sw.js');
  if (!fs.existsSync(swPath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(swPath);
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
