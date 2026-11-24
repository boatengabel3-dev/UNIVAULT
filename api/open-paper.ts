import type { IncomingMessage, ServerResponse } from 'node:http';
import { openPastQuestionWithServiceKey } from './_lib/open-paper.js';

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
    const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      res.status(500).json({ error: 'Supabase configuration is missing.' });
      return;
    }
    if (!serviceRoleKey) {
      res.status(501).json({ code: 'SERVICE_ROLE_MISSING', error: 'Service key not configured.' });
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
      signal: AbortSignal.timeout(8000),
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
    const result = await openPastQuestionWithServiceKey({
      supabaseUrl,
      serviceRoleKey,
      userId: user.id,
      questionId: String(body.qid || ''),
    });
    res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Could not open past paper.';
    res.status(500).json({ error: message });
  }
}
