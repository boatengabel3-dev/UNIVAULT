import type { IncomingMessage, ServerResponse } from 'node:http';
import { prepareAiChat, runAiChat, streamAiChat } from './_lib/univault-ai.js';

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

  let headersSentForStream = false;
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
    const wantStream = Boolean(body.stream) && mode !== 'quiz';
    const input = {
      apiKey: geminiKey,
      supabaseUrl,
      supabaseAnonKey,
      token,
      userId: user.id,
      mode,
      course: String(body.course || ''),
      messages: body.messages,
      count: Number(body.count) || 5,
      instructions: String(body.instructions || ''),
      attachmentContext: String(body.attachmentContext || ''),
      targetQuestion: String(body.targetQuestion || ''),
    };

    if (!wantStream) {
      const result = await runAiChat(input);
      res.status(200).json(result);
      return;
    }

    const prep = await prepareAiChat(input);
    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    headersSentForStream = true;

    for await (const ev of streamAiChat(prep, () => closed || res.writableEnded)) {
      if (closed || res.writableEnded) break;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err: unknown) {
    const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
    const status = typeof errObj.status === 'number' ? errObj.status : 500;
    const message = err instanceof Error ? err.message : 'AI service error';
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
}
