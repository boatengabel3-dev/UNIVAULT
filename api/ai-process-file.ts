import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkDuplicateQuestion, processUploadedMaterial } from './_lib/univault-ai.js';

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
      res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Secrets.' });
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
    const fileName = String(body.fileName || 'upload');
    const mimeType = String(body.mimeType || '');
    const dataBase64 = String(body.dataBase64 || '');
    const preprocessedText = String(body.preprocessedText || '');
    const ocrUsed = Boolean(body.ocrUsed);

    if (!dataBase64 && !preprocessedText.trim()) {
      res.status(400).json({ error: 'No file data or extracted text was provided.' });
      return;
    }

    const result = await processUploadedMaterial({
      apiKey: geminiKey,
      fileName,
      mimeType,
      dataBase64,
      preprocessedText,
      ocrUsed,
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

    res.status(200).json({
      ...result,
      duplicateCheck: dup,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to process uploaded file.';
    res.status(400).json({ error: message });
  }
}
