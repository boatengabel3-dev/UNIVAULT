import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractGeminiText(response: unknown): string {
  const resp = response as {
    text?: string;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
    candidates?: Array<{
      finishReason?: string;
      finishMessage?: string;
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    }>;
  } | null;

  const direct = typeof resp?.text === 'string' ? resp.text.trim() : '';
  if (direct) return direct;

  const parts = resp?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const joined = parts
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
    if (joined) return joined;
  }

  const blockReason = resp?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(
      resp?.promptFeedback?.blockReasonMessage ||
        `Gemini blocked this request (${blockReason}). Try rephrasing your question.`
    );
  }

  const finishReason = resp?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    throw new Error(
      resp?.candidates?.[0]?.finishMessage ||
        `Gemini stopped before generating a reply (${finishReason}). Please try again.`
    );
  }

  throw new Error('Gemini returned an empty response. Please try again.');
}

function normalizeChatMessages(
  messages: unknown
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const raw = Array.isArray(messages) ? messages : [];
  const cleaned: Array<{ role: 'user' | 'model'; text: string }> = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as { role?: unknown; content?: unknown };
    if (typeof msg.content !== 'string' || !msg.content.trim()) continue;
    const role: 'user' | 'model' = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
    const text = msg.content.trim();
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === role) {
      prev.text += `\n\n${text}`;
    } else {
      cleaned.push({ role, text });
    }
  }

  if (cleaned.length > 10) {
    cleaned.splice(0, cleaned.length - 10);
  }

  for (let i = 0; i < cleaned.length - 1; i++) {
    if (cleaned[i].text.length > 2500) {
      cleaned[i].text = cleaned[i].text.slice(0, 2500) + '...';
    }
  }

  while (cleaned.length > 0 && cleaned[0].role === 'model') {
    cleaned.shift();
  }

  if (cleaned.length === 0) {
    return [{ role: 'user', parts: [{ text: 'Hello' }] }];
  }

  return cleaned.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));
}

const PRIMARY_TEXT_MODEL = 'gemini-4-hydrogen';
const BACKUP_TEXT_MODEL = 'gemini-3.1-flash-lite';
const TEXT_MODELS = [PRIMARY_TEXT_MODEL, BACKUP_TEXT_MODEL];

function thinkingConfigFor(model: string) {
  return {
    thinkingLevel: model === BACKUP_TEXT_MODEL ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
  };
}

function extractNestedErrorDetails(raw: string): { code?: number; status?: string; message?: string } {
  let current = String(raw || '').trim();
  let code: number | undefined;
  let status: string | undefined;

  for (let depth = 0; depth < 4; depth++) {
    if (!current.startsWith('{')) break;
    try {
      const parsed = JSON.parse(current) as Record<string, unknown>;
      const inner =
        parsed.error && typeof parsed.error === 'object'
          ? (parsed.error as Record<string, unknown>)
          : parsed;
      if (typeof inner.code === 'number') code = inner.code;
      if (typeof inner.status === 'string') status = inner.status;
      if (typeof inner.message === 'string' && inner.message.trim()) {
        current = inner.message.trim();
        continue;
      }
      break;
    } catch {
      break;
    }
  }

  return { code, status, message: current };
}

export function formatAiError(err: unknown): { message: string; status: number } {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const explicitStatus = typeof errObj.status === 'number' ? errObj.status : 0;
  const rawMsg = err instanceof Error ? err.message : String(err || 'AI service error');
  const nested = extractNestedErrorDetails(rawMsg);
  const status = explicitStatus || nested.code || 500;
  const text = (nested.message || rawMsg || '').trim();

  if (
    status === 503 ||
    nested.code === 503 ||
    nested.status === 'UNAVAILABLE' ||
    /high demand|service unavailable|overloaded|unavailable/i.test(text)
  ) {
    return {
      status: 503,
      message:
        'AI Tutor is experiencing temporary high demand right now. Please wait a few seconds and tap Retry.',
    };
  }

  if (status === 429 || nested.code === 429 || nested.status === 'RESOURCE_EXHAUSTED' || /quota|rate limit|resource_exhausted/i.test(text)) {
    return {
      status: 429,
      message:
        'AI Tutor is temporarily rate-limited due to high traffic. Please wait a moment and tap Retry.',
    };
  }

  if (status === 403 || status === 400 && /api key|permission_denied|api_key_invalid/i.test(text)) {
    return {
      status,
      message:
        'Gemini API key configuration error. Please check GEMINI_API_KEY in Settings > Secrets.',
    };
  }

  if (status === 504 || /timed out|timeout|ETIMEDOUT/i.test(text)) {
    return {
      status: 504,
      message: 'AI Tutor timed out while waiting for the model. Please tap Retry.',
    };
  }

  return {
    status: status >= 400 && status <= 599 ? status : 500,
    message: text || 'AI service error. Please try again.',
  };
}

function isRetryableGeminiError(err: unknown): boolean {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const explicitStatus = typeof errObj.status === 'number' ? errObj.status : 0;
  const rawMsg = err instanceof Error ? err.message : String(err || '');
  const nested = extractNestedErrorDetails(rawMsg);
  const code = explicitStatus || nested.code || 0;
  const combined = `${rawMsg} ${nested.message || ''} ${nested.status || ''}`;

  return (
    code === 429 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|unavailable|RESOURCE_EXHAUSTED|high demand|overloaded|try again later/i.test(
      combined
    )
  );
}

async function callGeminiWithRetry<T>(
  fn: (model: string) => Promise<T>,
  models: string[] = TEXT_MODELS
): Promise<T> {
  const delays = [350];
  let lastErr: unknown;

  for (let mIdx = 0; mIdx < models.length; mIdx++) {
    const model = models[mIdx];
    const maxRetries = mIdx === 0 ? delays.length : 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(model);
      } catch (err) {
        lastErr = err;
        if (!isRetryableGeminiError(err)) {
          throw err;
        }
        if (attempt < maxRetries) {
          const base = delays[Math.min(attempt, delays.length - 1)];
          const jitter = Math.floor(Math.random() * 150);
          await new Promise((r) => setTimeout(r, base + jitter));
        }
      }
    }
  }

  throw lastErr;
}

export interface AiChatInput {
  apiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  token: string;
  userId: string;
  mode?: string;
  course?: string;
  programme?: string;
  messages?: unknown;
  count?: number;
  instructions?: string;
  attachmentContext?: string;
  targetQuestion?: string;
}

export interface PreparedAiChat {
  ai: GoogleGenAI;
  mode: string;
  count: number;
  instructions: string;
  targetQuestion: string;
  systemInstruction: string;
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  freeRemaining: number | null;
  freeLimit: number;
}

const COURSE_BANK_CACHE_TTL_MS = 5 * 60 * 1000;
const courseBankCache = new Map<string, { text: string; expiresAt: number }>();

async function fetchCourseBank(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  token: string;
  course: string;
  maxChars?: number;
}): Promise<string> {
  if (!opts.course) return '';
  const maxChars = opts.maxChars ?? 6500;
  const cacheKey = `${opts.supabaseUrl}::${opts.course}`;
  const cached = courseBankCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.text.slice(0, maxChars);
  }
  try {
    const qRes = await fetch(
      `${opts.supabaseUrl}/rest/v1/questions?course_code=eq.${encodeURIComponent(opts.course)}&status=eq.approved&select=year,semester,question_content(content)&order=year.desc&limit=5`,
      {
        headers: {
          apikey: opts.supabaseAnonKey,
          Authorization: `Bearer ${opts.token}`,
        },
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!qRes.ok) return '';
    const parsed = (await qRes.json()) as Array<{
      year?: number;
      semester?: number;
      question_content?: { content?: string } | Array<{ content?: string }> | null;
    }>;
    if (!Array.isArray(parsed)) return '';
    const fullText = parsed
      .map((q) => {
        const qc = Array.isArray(q.question_content)
          ? q.question_content[0]?.content
          : q.question_content?.content;
        return qc ? `[${q.year} S${q.semester ?? '-'}]\n${qc}` : '';
      })
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 10000);
    if (courseBankCache.size >= 100) {
      const oldestKey = courseBankCache.keys().next().value;
      if (oldestKey) courseBankCache.delete(oldestKey);
    }
    courseBankCache.set(cacheKey, {
      text: fullText,
      expiresAt: Date.now() + COURSE_BANK_CACHE_TTL_MS,
    });
    return fullText.slice(0, maxChars);
  } catch {
    return '';
  }
}

export async function prepareAiChat(opts: AiChatInput): Promise<PreparedAiChat> {
  const mode = String(opts.mode || 'chat');
  const course = String(opts.course || '').trim();
  const programme = String(opts.programme || '').trim();
  const count = Math.min(20, Math.max(1, Number(opts.count) || 5));
  const instructions = String(opts.instructions || '').trim();
  const cleanAttachment = String(opts.attachmentContext || '').trim().slice(0, 18000);
  const targetQuestion = String(opts.targetQuestion || '').trim();
  const contents = normalizeChatMessages(opts.messages);
  const lastUserMsg = contents[contents.length - 1]?.parts?.[0]?.text || '';
  const needsDeepBank =
    mode === 'quiz' || /predict|past\s*paper|exam|recurring|trend|lecturer/i.test(lastUserMsg);
  const bankLimitChars =
    mode === 'explain' && targetQuestion ? 2500 : needsDeepBank ? 9500 : 5500;

  const [quota, bank] = await Promise.all([
    checkAndConsumeAiQuota({
      supabaseUrl: opts.supabaseUrl,
      supabaseAnonKey: opts.supabaseAnonKey,
      token: opts.token,
      userId: opts.userId,
    }),
    fetchCourseBank({
      supabaseUrl: opts.supabaseUrl,
      supabaseAnonKey: opts.supabaseAnonKey,
      token: opts.token,
      course,
      maxChars: bankLimitChars,
    }),
  ]);

  if (!quota.allowed) {
    throw Object.assign(
      new Error(quota.error || 'Free AI trial limit reached. Upgrade to Premium to continue.'),
      {
        status: 402,
        freeRemaining: 0,
        freeLimit: quota.freeLimit,
      }
    );
  }

  const ai = createGeminiClient(opts.apiKey);
  const attachedBlock = cleanAttachment
    ? `\n\nUploaded material:\n${cleanAttachment}\n`
    : '';

  const contextBits = [
    programme ? `Programme: ${programme}.` : '',
    course ? `Course: ${course}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  let systemInstruction = `You are a sharp, down-to-earth KNUST senior student and TA helping a coursemate prep for exams.${contextBits ? ` ${contextBits}` : ''}${bank ? `\nPast questions:\n${bank}` : ''}${attachedBlock}\n`;

  const voiceRules = [
    "Write naturally like explaining notes at a library table—use contractions (don't, it's, you'll) and speak directly to the student.",
    'Start straight with the answer (no "Certainly!", "Sure!", "Great question!", or "In conclusion" / "Hope this helps!" sign-offs).',
    'Prefer flowing paragraphs first; use short numbered steps or plain bullets only for worked calculations or distinct exam traps.',
    'Avoid stiff AI buzzwords ("delve", "crucial", "pivotal", "comprehensive", "moreover", "furthermore") and emojis. Write math with plain symbols (×, ÷, √, ±, ^2, a / b) instead of LaTeX.',
  ].join('\n- ');

  if (mode === 'quiz') {
    systemInstruction += `Write ${count} multiple-choice questions matching these materials. Keep explanations crisp (1-2 direct sentences). Extra instructions: ${instructions || 'none'}.`;
  } else if (mode === 'explain') {
    systemInstruction +=
      `Style:\n- ${voiceRules}\nGive the main idea in plain language, work through steps cleanly with units/formulas, explain tricky steps, and call out exam traps.`;
  } else {
    systemInstruction +=
      `Style:\n- ${voiceRules}\nBe concise for quick questions, show clear worked steps for calculations, and base exam predictions on recurring topics and mark patterns (noting they are estimates).`;
  }

  return {
    ai,
    mode,
    count,
    instructions,
    targetQuestion,
    systemInstruction,
    contents,
    freeRemaining: quota.freeRemaining,
    freeLimit: quota.freeLimit,
  };
}

export async function runAiChat(opts: AiChatInput): Promise<{
  text: string;
  freeRemaining: number | null;
  freeLimit: number;
}> {
  const prep = await prepareAiChat(opts);

  if (prep.mode === 'quiz') {
    const response = await callGeminiWithRetry((model) =>
      prep.ai.models.generateContent({
        model,
        contents: `Generate ${prep.count} multiple-choice questions.`,
        config: {
          systemInstruction: prep.systemInstruction,
          thinkingConfig: thinkingConfigFor(model),
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
      })
    );
    return {
      text: extractGeminiText(response),
      freeRemaining: prep.freeRemaining,
      freeLimit: prep.freeLimit,
    };
  }

  if (prep.mode === 'explain') {
    const prompt = prep.targetQuestion
      ? `Walk me through this question or topic clearly:\n\n${prep.targetQuestion}`
      : 'Break down the key questions and concepts in the provided material step by step.';
    const response = await callGeminiWithRetry((model) =>
      prep.ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: prep.systemInstruction,
          thinkingConfig: thinkingConfigFor(model),
        },
      })
    );
    return {
      text: extractGeminiText(response),
      freeRemaining: prep.freeRemaining,
      freeLimit: prep.freeLimit,
    };
  }

  const response = await callGeminiWithRetry((model) =>
    prep.ai.models.generateContent({
      model,
      contents: prep.contents,
      config: {
        systemInstruction: prep.systemInstruction,
        thinkingConfig: thinkingConfigFor(model),
      },
    })
  );

  return {
    text: extractGeminiText(response),
    freeRemaining: prep.freeRemaining,
    freeLimit: prep.freeLimit,
  };
}

export type AiChatStreamEvent =
  | { type: 'meta'; freeRemaining: number | null; freeLimit: number }
  | { type: 'ping' }
  | { type: 'delta'; delta: string }
  | { type: 'done'; text: string; freeRemaining: number | null; freeLimit: number };

export async function* streamAiChat(
  prep: PreparedAiChat,
  isAborted?: () => boolean
): AsyncGenerator<AiChatStreamEvent> {
  yield {
    type: 'meta',
    freeRemaining: prep.freeRemaining,
    freeLimit: prep.freeLimit,
  };

  const contents =
    prep.mode === 'explain'
      ? prep.targetQuestion
        ? `Walk me through this question or topic clearly:\n\n${prep.targetQuestion}`
        : 'Break down the key questions and concepts in the provided material step by step.'
      : prep.contents;

  let fullText = '';
  let lastFinishReason = '';
  let blockReason = '';
  let lastErr: unknown;

  for (let mIdx = 0; mIdx < TEXT_MODELS.length; mIdx++) {
    const model = TEXT_MODELS[mIdx];
    const maxAttempts = mIdx === 0 ? 1 : 0;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (isAborted?.()) return;
      try {
        const stream = await prep.ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction: prep.systemInstruction,
            thinkingConfig: thinkingConfigFor(model),
          },
        });

        for await (const chunk of stream) {
          if (isAborted?.()) return;
          const c = chunk as {
            text?: string;
            promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
            candidates?: Array<{ finishReason?: string }>;
          };
          if (c?.promptFeedback?.blockReason) {
            blockReason = c.promptFeedback.blockReasonMessage || c.promptFeedback.blockReason;
          }
          if (c?.candidates?.[0]?.finishReason) {
            lastFinishReason = c.candidates[0].finishReason;
          }
          const piece = typeof c?.text === 'string' ? c.text : '';
          if (piece) {
            fullText += piece;
            yield { type: 'delta', delta: piece };
          } else {
            yield { type: 'ping' };
          }
        }

        if (fullText.trim()) {
          yield {
            type: 'done',
            text: fullText.trim(),
            freeRemaining: prep.freeRemaining,
            freeLimit: prep.freeLimit,
          };
          return;
        }
        break;
      } catch (err) {
        lastErr = err;
        // If partial answer already started streaming or error isn't transient, don't retry silently
        if (fullText.trim() || !isRetryableGeminiError(err)) {
          throw err;
        }
        yield { type: 'ping' };
        if (attempt < maxAttempts) {
          const waitMs = 350 + Math.floor(Math.random() * 150);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
  }

  if (blockReason) {
    throw new Error(`Gemini blocked this request (${blockReason}). Try rephrasing your question.`);
  }
  if (lastFinishReason && lastFinishReason !== 'STOP') {
    throw new Error(`Gemini stopped before generating a reply (${lastFinishReason}). Please try again.`);
  }
  if (lastErr) {
    throw lastErr;
  }
  throw new Error('Gemini returned an empty response. Please try again.');
}

const memoryFreeAiUsage = new Map<string, number>();
let consumeRpcAvailable: boolean | null = null;

export async function checkAndConsumeAiQuota(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  token: string;
  userId: string;
}): Promise<{
  allowed: boolean;
  unlimited: boolean;
  freeRemaining: number | null;
  freeLimit: number;
  error?: string;
}> {
  const headers = {
    apikey: opts.supabaseAnonKey,
    Authorization: `Bearer ${opts.token}`,
  };

  // Try atomic DB RPC first (enforces admin/premium + consumes free trial quota across devices)
  if (consumeRpcAvailable !== false) {
    try {
      const rpcRes = await fetch(`${opts.supabaseUrl}/rest/v1/rpc/consume_free_ai`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      if (rpcRes.status === 404) {
        consumeRpcAvailable = false;
      } else if (rpcRes.ok) {
        consumeRpcAvailable = true;
        const rpc = (await rpcRes.json()) as {
          allowed?: boolean;
          unlimited?: boolean;
          remaining?: number;
          limit?: number;
        } | null;
        if (rpc && typeof rpc.allowed === 'boolean') {
          const limit = Number(rpc.limit ?? 5);
          const remaining = rpc.unlimited ? null : Number(rpc.remaining ?? 0);
          return {
            allowed: rpc.allowed,
            unlimited: Boolean(rpc.unlimited),
            freeRemaining: remaining,
            freeLimit: limit,
            error: rpc.allowed
              ? undefined
              : `Free AI trial limit reached (${limit} uses). Upgrade to Premium to continue.`,
          };
        }
      }
    } catch {}
  }

  // Fallback when consume_free_ai RPC is not yet installed in Supabase SQL Editor
  const [profRes, admRes, setRes] = await Promise.all([
    fetch(
      `${opts.supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(opts.userId)}&select=*&limit=1`,
      { headers, signal: AbortSignal.timeout(7000) }
    ),
    fetch(
      `${opts.supabaseUrl}/rest/v1/admins?user_id=eq.${encodeURIComponent(opts.userId)}&select=user_id`,
      { headers, signal: AbortSignal.timeout(7000) }
    ),
    fetch(`${opts.supabaseUrl}/rest/v1/app_settings?id=eq.1&select=free_ai_limit`, {
      headers,
      signal: AbortSignal.timeout(7000),
    }).catch(() => null),
  ]);

  const profRows = profRes.ok
    ? ((await profRes.json()) as Array<{ premium_expires_at?: string | null; premium_until?: string | null }>)
    : [];
  const admRows = admRes.ok ? ((await admRes.json()) as Array<{ user_id?: string }>) : [];
  const setRows =
    setRes && setRes.ok ? ((await setRes.json()) as Array<{ free_ai_limit?: number }>) : [];

  const premiumUntil = profRows[0]?.premium_expires_at || profRows[0]?.premium_until;
  const isAdmin = admRows.length > 0;
  const isPremium = Boolean(premiumUntil && new Date(premiumUntil) > new Date());
  const freeLimit = Math.max(0, Number(setRows[0]?.free_ai_limit ?? 5));

  if (isPremium || isAdmin) {
    return { allowed: true, unlimited: true, freeRemaining: null, freeLimit };
  }

  const used = memoryFreeAiUsage.get(opts.userId) ?? 0;
  if (used >= freeLimit) {
    return {
      allowed: false,
      unlimited: false,
      freeRemaining: 0,
      freeLimit,
      error: `Free AI trial limit reached (${freeLimit} uses). Upgrade to Premium to continue.`,
    };
  }
  const nextUsed = used + 1;
  memoryFreeAiUsage.set(opts.userId, nextUsed);
  return {
    allowed: true,
    unlimited: false,
    freeRemaining: Math.max(freeLimit - nextUsed, 0),
    freeLimit,
  };
}

export function normalizeSpaces(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeCourseCode(value: string): { canonical: string; key: string } {
  const cleaned = normalizeSpaces(value).toUpperCase().replace(/[-_]+/g, ' ');
  const compact = cleaned.replace(/[^A-Z0-9]/g, '');
  const match = compact.match(/^([A-Z]+)(\d+[A-Z]*)$/);
  const canonical = match ? `${match[1]} ${match[2]}` : cleaned;
  return { canonical, key: compact };
}

export function normalizeQuestionText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeContentHash(value: string): string {
  const normalized = normalizeQuestionText(value);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function textSimilarity(a: string, b: string): number {
  const na = normalizeQuestionText(a);
  const nb = normalizeQuestionText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length > 60 && nb.length > 60 && (na.includes(nb) || nb.includes(na))) {
    const minLen = Math.min(na.length, nb.length);
    const maxLen = Math.max(na.length, nb.length);
    if (minLen / maxLen >= 0.72) return 0.92;
  }

  const tokensA = new Set(na.split(' ').filter((w) => w.length > 2));
  const tokensB = new Set(nb.split(' ').filter((w) => w.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateCheckResult {
  duplicate: boolean;
  normalizedCode: string;
  normalizedDepartment: string;
  contentHash: string;
  reason?: string;
  match?: {
    id?: string;
    course_code?: string;
    year?: number;
    semester?: number | null;
    status?: string;
    matchType: 'course_year_semester' | 'exact_content' | 'similar_content';
    similarity?: number;
  };
}

export async function checkDuplicateQuestion(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  token: string;
  department?: string;
  courseCode?: string;
  year?: number | null;
  semester?: number | null;
  bodyText?: string;
}): Promise<DuplicateCheckResult> {
  const { canonical, key: codeKey } = normalizeCourseCode(opts.courseCode || '');
  const normalizedDepartment = normalizeSpaces(opts.department || '');
  const bodyText = String(opts.bodyText || '').trim();
  const contentHash = bodyText ? computeContentHash(bodyText) : '';
  const yearNum = opts.year ? Number(opts.year) : null;
  const semNum = opts.semester ? Number(opts.semester) : null;

  // First try DB-level RPC (checks across all archive papers safely via security definer)
  if (codeKey || bodyText.length >= 20) {
    try {
      const rpcRes = await fetch(`${opts.supabaseUrl}/rest/v1/rpc/check_question_duplicate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: opts.supabaseAnonKey,
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({
          c: canonical || codeKey,
          y: yearNum || 0,
          s: semNum || 0,
          body: bodyText,
        }),
      });
      if (rpcRes.ok) {
        const rpcData = (await rpcRes.json()) as {
          duplicate?: boolean;
          reason?: string;
          match_id?: string;
          course_code?: string;
          year?: number;
          semester?: number | null;
          status?: string;
          match_type?: 'course_year_semester' | 'exact_content' | 'similar_content';
        } | null;
        if (rpcData?.duplicate) {
          return {
            duplicate: true,
            normalizedCode: canonical,
            normalizedDepartment,
            contentHash,
            reason:
              rpcData.reason ||
              `This past question already exists (${rpcData.course_code || canonical} ${rpcData.year || ''}).`,
            match: {
              id: rpcData.match_id,
              course_code: rpcData.course_code,
              year: rpcData.year,
              semester: rpcData.semester,
              status: rpcData.status,
              matchType: rpcData.match_type || 'course_year_semester',
            },
          };
        }
      }
    } catch {
      // Continue to REST-based normalization fallback if RPC isn't deployed yet
    }
  }

  // Fallback REST check against visible questions + accessible question_content
  const qRes = await fetch(
    `${opts.supabaseUrl}/rest/v1/questions?select=id,department,course_code,course_title,year,semester,status,question_content(content)&status=neq.rejected&limit=300`,
    {
      headers: {
        apikey: opts.supabaseAnonKey,
        Authorization: `Bearer ${opts.token}`,
      },
    }
  );

  if (qRes.ok) {
    const rows = (await qRes.json()) as Array<{
      id: string;
      department?: string;
      course_code?: string;
      course_title?: string;
      year?: number;
      semester?: number | null;
      status?: string;
      question_content?: { content?: string } | null;
    }>;

    for (const row of rows) {
      const rowCodeKey = normalizeCourseCode(row.course_code || '').key;
      if (
        codeKey &&
        rowCodeKey === codeKey &&
        yearNum &&
        row.year === yearNum &&
        (!semNum || !row.semester || row.semester === semNum)
      ) {
        const semTxt = row.semester ? ` Semester ${row.semester}` : '';
        return {
          duplicate: true,
          normalizedCode: canonical,
          normalizedDepartment,
          contentHash,
          reason: `Duplicate past question detected: ${row.course_code} (${row.year}${semTxt}) already exists in UniVault (${row.status}).`,
          match: {
            id: row.id,
            course_code: row.course_code,
            year: row.year,
            semester: row.semester,
            status: row.status,
            matchType: 'course_year_semester',
          },
        };
      }

      const existingBody = row.question_content?.content || '';
      if (bodyText.length >= 40 && existingBody.length >= 40) {
        const existingHash = computeContentHash(existingBody);
        if (contentHash && existingHash === contentHash) {
          return {
            duplicate: true,
            normalizedCode: canonical,
            normalizedDepartment,
            contentHash,
            reason: `Duplicate content detected: This exact past question is already stored under ${row.course_code} (${row.year}${row.semester ? ' S' + row.semester : ''}).`,
            match: {
              id: row.id,
              course_code: row.course_code,
              year: row.year,
              semester: row.semester,
              status: row.status,
              matchType: 'exact_content',
              similarity: 1,
            },
          };
        }

        const sim = textSimilarity(bodyText, existingBody);
        if (sim >= 0.8) {
          return {
            duplicate: true,
            normalizedCode: canonical,
            normalizedDepartment,
            contentHash,
            reason: `Near-duplicate past question (${Math.round(sim * 100)}% text match) already exists under ${row.course_code} (${row.year}${row.semester ? ' S' + row.semester : ''}).`,
            match: {
              id: row.id,
              course_code: row.course_code,
              year: row.year,
              semester: row.semester,
              status: row.status,
              matchType: 'similar_content',
              similarity: Number(sim.toFixed(2)),
            },
          };
        }
      }
    }
  }

  return {
    duplicate: false,
    normalizedCode: canonical,
    normalizedDepartment,
    contentHash,
  };
}

function decodeXmlEntities(xml: string): string {
  return xml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractXmlText(xml: string, paragraphTag: string): string {
  const withBreaks = xml
    .replace(new RegExp(`</${paragraphTag}>`, 'gi'), '\n')
    .replace(/<(?:w:br|a:br|w:cr)\b[^>]*\/?>/gi, '\n')
    .replace(/<w:tab\b[^>]*\/?>/gi, '\t');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return decodeXmlEntities(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: string[] = [];

  const docFiles = Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d*|footer\d*)\.xml$/i.test(name))
    .sort((a, b) => {
      if (a.includes('document')) return -1;
      if (b.includes('document')) return 1;
      return a.localeCompare(b);
    });

  for (const name of docFiles) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const txt = extractXmlText(xml, 'w:p');
    if (txt) parts.push(txt);
  }

  return parts.join('\n\n').trim();
}

export async function extractPptxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
      return na - nb;
    });

  const sections: string[] = [];
  for (const name of slideNames) {
    const num = name.match(/slide(\d+)\.xml/i)?.[1] || '?';
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async('string');
    const slideText = extractXmlText(xml, 'a:p');

    const notesFile = zip.file(`ppt/notesSlides/notesSlide${num}.xml`);
    let notesText = '';
    if (notesFile) {
      notesText = extractXmlText(await notesFile.async('string'), 'a:p');
    }

    if (slideText || notesText) {
      sections.push(
        `--- Slide ${num} ---\n${slideText}${notesText ? `\n[Speaker Notes]: ${notesText}` : ''}`
      );
    }
  }

  return sections.join('\n\n').trim();
}

function extractLegacyBinaryText(buffer: Buffer): string {
  const rawAscii = buffer.toString('latin1');
  if (rawAscii.startsWith('{\\rtf')) {
    return rawAscii
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
      .replace(/\\[a-z]+-?\d*\s?/g, '')
      .replace(/[{}]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const asciiMatches = rawAscii.match(/[A-Za-z0-9][A-Za-z0-9 ,.;:?!()[\]/%+\-='"&\n\r]{5,}/g) || [];
  const utf16Text = buffer.toString('utf16le');
  const utf16Matches = utf16Text.match(/[A-Za-z0-9][A-Za-z0-9 ,.;:?!()[\]/%+\-='"]{5,}/g) || [];

  const combined = [...utf16Matches, ...asciiMatches]
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /[a-zA-Z]{3,}/.test(s) && !/^(?:Microsoft|Root Entry|WordDocument|PowerPoint|SummaryInformation)/i.test(s));

  return [...new Set(combined)].join('\n').trim();
}

export type FileCategory = 'audio' | 'video' | 'pdf' | 'docx' | 'pptx' | 'legacy_doc' | 'legacy_ppt' | 'image' | 'text';

export function detectFileCategory(fileName: string, mimeType: string): {
  category: FileCategory;
  resolvedMime: string;
} {
  const ext = path.extname(fileName || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  if (ext === '.pdf' || mime === 'application/pdf') {
    return { category: 'pdf', resolvedMime: 'application/pdf' };
  }
  if (
    ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return {
      category: 'docx',
      resolvedMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  if (
    ext === '.pptx' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return {
      category: 'pptx',
      resolvedMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
  }
  if (ext === '.doc' || mime === 'application/msword') {
    return { category: 'legacy_doc', resolvedMime: 'application/msword' };
  }
  if (ext === '.ppt' || mime === 'application/vnd.ms-powerpoint') {
    return { category: 'legacy_ppt', resolvedMime: 'application/vnd.ms-powerpoint' };
  }
  if (
    ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext) ||
    mime.startsWith('audio/')
  ) {
    const audioMimeMap: Record<string, string> = {
      '.mp3': 'audio/mp3',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
    };
    return { category: 'audio', resolvedMime: audioMimeMap[ext] || (mime.startsWith('audio/') ? mime : 'audio/mp3') };
  }
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext) || mime.startsWith('video/')) {
    const videoMimeMap: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
    };
    return { category: 'video', resolvedMime: videoMimeMap[ext] || (mime.startsWith('video/') ? mime : 'video/mp4') };
  }
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || mime.startsWith('image/')) {
    const imgMime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { category: 'image', resolvedMime: mime.startsWith('image/') ? mime : imgMime };
  }
  if (['.txt', '.md', '.csv'].includes(ext) || mime.startsWith('text/')) {
    return { category: 'text', resolvedMime: 'text/plain' };
  }
  throw new Error(
    `Unsupported file format (${ext || mime || 'unknown'}). Upload PDF, DOCX, PPT/PPTX, MP3/WAV/M4A, MP4/WEBM, TXT, or an image.`
  );
}

export interface ProcessedMaterialResult {
  fileName: string;
  mediaType: 'written' | 'audio' | 'video';
  extractedText: string;
  transcript: string;
  summary: string;
  questionsDetected: string[];
  ocrUsed?: boolean;
  metadata: {
    department: string;
    course_code: string;
    course_title: string;
    year: number | null;
    semester: number | null;
    description: string;
  };
}

const STRUCTURED_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    cleanedText: {
      type: Type.STRING,
      description: 'Complete extracted past paper questions, study notes, or structured lecture content preserving numbering and formulas.',
    },
    summary: {
      type: Type.STRING,
      description: 'Concise 2-4 sentence academic summary of the uploaded material.',
    },
    questionsDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Individual questions or numbered sub-problems found in the file.',
    },
    department: { type: Type.STRING },
    course_code: { type: Type.STRING },
    course_title: { type: Type.STRING },
    year: { type: Type.INTEGER },
    semester: { type: Type.INTEGER },
    description: { type: Type.STRING },
  },
  required: ['cleanedText', 'summary', 'questionsDetected'],
};

async function uploadToGeminiFilesIfLarge(
  ai: GoogleGenAI,
  buffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<{ part: { fileData?: { fileUri: string; mimeType: string }; inlineData?: { data: string; mimeType: string } }; cleanup?: () => Promise<void> }> {
  // Use Files API above 4MB so large videos/PDFs/audio process cleanly without hitting inline payload limits
  if (buffer.byteLength <= 4 * 1024 * 1024) {
    return {
      part: {
        inlineData: {
          mimeType,
          data: buffer.toString('base64'),
        },
      },
    };
  }

  const ext = path.extname(fileName || '') || '.bin';
  const tmpPath = path.join(os.tmpdir(), `uv-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  await fs.writeFile(tmpPath, buffer);

  let uploadedName = '';
  try {
    const uploaded = await ai.files.upload({
      file: tmpPath,
      config: { mimeType, displayName: fileName },
    });
    uploadedName = uploaded.name || '';
    let state = uploaded.state;
    let fileUri = uploaded.uri || '';

    let attempts = 0;
    while (state === 'PROCESSING' && attempts < 25) {
      await new Promise((r) => setTimeout(r, 1500));
      const check = await ai.files.get({ name: uploadedName });
      state = check.state;
      fileUri = check.uri || fileUri;
      attempts++;
    }
    if (state === 'FAILED') {
      throw new Error('Gemini could not process the uploaded media file.');
    }

    return {
      part: {
        fileData: {
          fileUri,
          mimeType,
        },
      },
      cleanup: async () => {
        await fs.unlink(tmpPath).catch(() => {});
        if (uploadedName) {
          await ai.files.delete({ name: uploadedName }).catch(() => {});
        }
      },
    };
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    if (uploadedName) {
      await ai.files.delete({ name: uploadedName }).catch(() => {});
    }
    throw err;
  }
}

export async function processUploadedMaterial(opts: {
  apiKey: string;
  fileName: string;
  mimeType: string;
  dataBase64?: string;
  preprocessedText?: string;
  ocrUsed?: boolean;
}): Promise<ProcessedMaterialResult> {
  const ai = createGeminiClient(opts.apiKey);
  const { category, resolvedMime } = detectFileCategory(opts.fileName, opts.mimeType);
  const preprocessed = String(opts.preprocessedText || '').trim();
  const cleanB64 = String(opts.dataBase64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  const buffer = cleanB64 ? Buffer.from(cleanB64, 'base64') : Buffer.alloc(0);

  if (!buffer.byteLength && !preprocessed) {
    throw new Error('The uploaded file is empty.');
  }

  let transcript = '';
  let mediaType: 'written' | 'audio' | 'video' = 'written';
  let structuredRaw = '';

  if (category === 'audio') {
    mediaType = 'audio';
    const mediaHandle = await uploadToGeminiFilesIfLarge(ai, buffer, opts.fileName, resolvedMime);
    try {
      const transRes = await callGeminiWithRetry(
        (model) =>
          ai.models.generateContent({
            model,
            contents: {
              parts: [
                mediaHandle.part,
                {
                  text: 'Transcribe all spoken academic content, examination questions, formulas, and explanations accurately and verbatim.',
                },
              ],
            },
          }),
        ['gemini-3.5-transcribe']
      );
      transcript = (transRes.text ?? '').trim();
    } finally {
      await mediaHandle.cleanup?.();
    }

    if (!transcript) {
      throw new Error('No clear speech was detected in the audio file.');
    }

    const analyzeRes = await callGeminiWithRetry((model) =>
      ai.models.generateContent({
        model,
        contents: `Analyze this transcribed university lecture/past-question audio (${opts.fileName}):\n\n${transcript}`,
        config: {
          thinkingConfig: thinkingConfigFor(model),
          systemInstruction:
            'You are a KNUST academic archivist. Organize the spoken transcript into clean readable text (preserving all questions and formulas), summarize key points, list distinct questions detected, and extract metadata (department, course_code, course_title, year, semester, description) only if mentioned in the audio (otherwise leave empty/0).',
          responseMimeType: 'application/json',
          responseSchema: STRUCTURED_SCHEMA,
        },
      })
    );
    structuredRaw = analyzeRes.text ?? '{}';
  } else if (category === 'video') {
    mediaType = 'video';
    const mediaHandle = await uploadToGeminiFilesIfLarge(ai, buffer, opts.fileName, resolvedMime);
    try {
      const videoRes = await callGeminiWithRetry((model) =>
        ai.models.generateContent({
          model,
          contents: {
            parts: [
              mediaHandle.part,
              {
                text: `Analyze this uploaded academic video (${opts.fileName}).
1. Transcribe all spoken words verbatim in "transcript".
2. Also capture any visible board/slide text, equations, and past questions shown on screen, combining them cleanly into "cleanedText".
3. List every individual question or practice problem detected in "questionsDetected".
4. Infer KNUST metadata (department, course_code, course_title, year, semester, description) if shown or mentioned.`,
              },
            ],
          },
          config: {
            thinkingConfig: thinkingConfigFor(model),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                ...STRUCTURED_SCHEMA.properties,
                transcript: {
                  type: Type.STRING,
                  description: 'Full verbatim spoken transcript from the video audio.',
                },
              },
              required: ['cleanedText', 'transcript', 'summary', 'questionsDetected'],
            },
          },
        })
      );
      structuredRaw = videoRes.text ?? '{}';
    } finally {
      await mediaHandle.cleanup?.();
    }
  } else if (category === 'pdf' || category === 'image') {
    mediaType = 'written';
    if (buffer.byteLength > 0) {
      const fileHandle = await uploadToGeminiFilesIfLarge(ai, buffer, opts.fileName, resolvedMime);
      try {
        const ocrHint = preprocessed
          ? `\n\nPre-processed client-side OCR / PDF text extracted from the file (use the visual file to verify formulas, diagrams, and fix any OCR typos):\n${preprocessed.slice(0, 60000)}`
          : '';
        const docRes = await callGeminiWithRetry((model) =>
          ai.models.generateContent({
            model,
            contents: {
              parts: [
                fileHandle.part,
                {
                  text: `Extract ALL written questions, instructions, mark allocations, formulas, and study content verbatim from "${opts.fileName}". Organize cleanly in "cleanedText", list each distinct question in "questionsDetected", summarize in "summary", and extract course metadata (department, course_code, course_title, year, semester, description) if present.${ocrHint}`,
                },
              ],
            },
            config: {
              thinkingConfig: thinkingConfigFor(model),
              responseMimeType: 'application/json',
              responseSchema: STRUCTURED_SCHEMA,
            },
          })
        );
        structuredRaw = docRes.text ?? '{}';
      } finally {
        await fileHandle.cleanup?.();
      }
    } else {
      const docRes = await callGeminiWithRetry((model) =>
        ai.models.generateContent({
          model,
          contents: `Client-side extracted / OCR text from "${opts.fileName}":\n\n${preprocessed.slice(0, 80000)}`,
          config: {
            thinkingConfig: thinkingConfigFor(model),
            systemInstruction:
              'You are a KNUST academic archivist. Clean up any OCR line-break or spelling artifacts while keeping all examination questions, numbering, mark allocations, and equations intact in "cleanedText", list each distinct question in "questionsDetected", write a concise "summary", and extract metadata (department, course_code, course_title, year, semester, description) if present.',
            responseMimeType: 'application/json',
            responseSchema: STRUCTURED_SCHEMA,
          },
        })
      );
      structuredRaw = docRes.text ?? '{}';
    }
  } else {
    mediaType = 'written';
    let rawText = preprocessed;
    const isZipHeader = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;

    if (!rawText) {
      if (category === 'docx' || (category === 'legacy_doc' && isZipHeader)) {
        rawText = await extractDocxText(buffer);
      } else if (category === 'pptx' || (category === 'legacy_ppt' && isZipHeader)) {
        rawText = await extractPptxText(buffer);
      } else if (category === 'legacy_doc' || category === 'legacy_ppt') {
        rawText = extractLegacyBinaryText(buffer);
        if (rawText.length < 40) {
          throw new Error(
            `Legacy binary ${category === 'legacy_doc' ? '.doc' : '.ppt'} could not be parsed cleanly. Please save as ${category === 'legacy_doc' ? '.docx' : '.pptx'} or .pdf and upload again.`
          );
        }
      } else {
        rawText = buffer.toString('utf8').trim();
      }
    }

    if (!rawText) {
      throw new Error(`No readable text was found inside ${opts.fileName}.`);
    }

    const docRes = await callGeminiWithRetry((model) =>
      ai.models.generateContent({
        model,
        contents: `Extracted raw content from "${opts.fileName}":\n\n${rawText.slice(0, 80000)}`,
        config: {
          thinkingConfig: thinkingConfigFor(model),
          systemInstruction:
            'You are a KNUST academic archivist. Clean and format all questions, slides, and notes from the uploaded document into "cleanedText" without omitting questions or equations, extract individual questions into "questionsDetected", write a concise "summary", and extract metadata (department, course_code, course_title, year, semester, description) if present.',
          responseMimeType: 'application/json',
          responseSchema: STRUCTURED_SCHEMA,
        },
      })
    );
    structuredRaw = docRes.text ?? '{}';
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(structuredRaw) as Record<string, unknown>;
  } catch {
    parsed = { cleanedText: structuredRaw, summary: '', questionsDetected: [] };
  }

  const finalTranscript = String(parsed.transcript || transcript || '').trim();
  const extractedText = String(parsed.cleanedText || finalTranscript || '').trim();
  const summary = String(parsed.summary || '').trim();
  const questionsDetected = Array.isArray(parsed.questionsDetected)
    ? parsed.questionsDetected.map((q) => String(q).trim()).filter(Boolean)
    : [];

  const rawCode = String(parsed.course_code || '').trim();
  const normCode = rawCode ? normalizeCourseCode(rawCode).canonical : '';
  const yearVal = Number(parsed.year);
  const semVal = Number(parsed.semester);

  return {
    fileName: opts.fileName,
    mediaType,
    extractedText,
    transcript: finalTranscript,
    summary,
    questionsDetected,
    ocrUsed: Boolean(opts.ocrUsed),
    metadata: {
      department: normalizeSpaces(String(parsed.department || '')),
      course_code: normCode,
      course_title: normalizeSpaces(String(parsed.course_title || '')),
      year: yearVal >= 1990 && yearVal <= 2035 ? yearVal : null,
      semester: semVal === 1 || semVal === 2 ? semVal : null,
      description: normalizeSpaces(String(parsed.description || '')),
    },
  };
}
