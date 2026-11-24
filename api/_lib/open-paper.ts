export interface OpenPaperInput {
  supabaseUrl: string;
  serviceRoleKey: string;
  userId: string;
  questionId: string;
}

export interface OpenPaperResult {
  allowed: boolean;
  unlimited?: boolean;
  not_found?: boolean;
  already_unlocked?: boolean;
  content?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  free_question_ids?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function openPastQuestionWithServiceKey(
  input: OpenPaperInput
): Promise<OpenPaperResult> {
  const qid = String(input.questionId || '').trim();
  if (!UUID_RE.test(qid)) {
    return { allowed: false, not_found: true, limit: 3, remaining: 0, used: 0 };
  }

  const base = input.supabaseUrl.replace(/\/$/, '');
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  const [settingsRes, questionRes, adminRes] = await Promise.all([
    fetch(`${base}/rest/v1/app_settings?id=eq.1&select=free_questions_limit&limit=1`, { headers }),
    fetch(
      `${base}/rest/v1/questions?id=eq.${encodeURIComponent(qid)}&select=id,status,uploader,question_content(content)&limit=1`,
      { headers }
    ),
    fetch(`${base}/rest/v1/admins?user_id=eq.${encodeURIComponent(input.userId)}&select=user_id&limit=1`, {
      headers,
    }),
  ]);

  let limit = 3;
  if (settingsRes.ok) {
    const sRows = (await settingsRes.json()) as Array<{ free_questions_limit?: number | null }>;
    const rawLim = sRows?.[0]?.free_questions_limit;
    if (typeof rawLim === 'number' && Number.isFinite(rawLim)) {
      limit = Math.max(0, Math.floor(rawLim));
    }
  }

  if (!questionRes.ok) {
    throw new Error('Could not query past paper from database.');
  }
  const qRows = (await questionRes.json()) as Array<{
    id: string;
    status?: string;
    uploader?: string | null;
    question_content?: { content?: string | null } | Array<{ content?: string | null }> | null;
  }>;
  const qRow = qRows?.[0];
  if (!qRow) {
    return { allowed: false, not_found: true, limit, remaining: 0, used: 0 };
  }

  const isAdmin =
    adminRes.ok && ((await adminRes.json()) as Array<{ user_id?: string }>).length > 0;
  const isUploader = Boolean(qRow.uploader && qRow.uploader === input.userId);

  if (qRow.status !== 'approved' && !isAdmin && !isUploader) {
    return { allowed: false, limit, remaining: 0, used: 0 };
  }

  const qcRaw = Array.isArray(qRow.question_content)
    ? qRow.question_content[0]
    : qRow.question_content;
  const content = typeof qcRaw?.content === 'string' ? qcRaw.content : '';

  if (isAdmin || isUploader) {
    return {
      allowed: true,
      unlimited: true,
      content,
      remaining: 9999,
      limit,
      used: 0,
    };
  }

  let profileRes = await fetch(
    `${base}/rest/v1/profiles?id=eq.${encodeURIComponent(input.userId)}&select=id,premium_until,free_question_ids&limit=1`,
    { headers }
  );
  let hasFreeIdsColumn = true;
  if (!profileRes.ok) {
    hasFreeIdsColumn = false;
    profileRes = await fetch(
      `${base}/rest/v1/profiles?id=eq.${encodeURIComponent(input.userId)}&select=id,premium_until&limit=1`,
      { headers }
    );
  }

  const pRows = profileRes.ok
    ? ((await profileRes.json()) as Array<{
        id: string;
        premium_until?: string | null;
        free_question_ids?: string[] | null;
      }>)
    : [];
  const prof = pRows?.[0];

  const isPro = Boolean(prof?.premium_until && new Date(prof.premium_until) > new Date());
  const unlocked = Array.isArray(prof?.free_question_ids)
    ? prof.free_question_ids.map((v) => String(v))
    : [];

  if (isPro) {
    return {
      allowed: true,
      unlimited: true,
      content,
      remaining: 9999,
      limit,
      used: unlocked.length,
    };
  }

  if (unlocked.includes(qid)) {
    return {
      allowed: true,
      unlimited: false,
      already_unlocked: true,
      content,
      used: unlocked.length,
      remaining: Math.max(limit - unlocked.length, 0),
      limit,
      free_question_ids: unlocked,
    };
  }

  if (unlocked.length >= limit) {
    return {
      allowed: false,
      unlimited: false,
      used: unlocked.length,
      remaining: 0,
      limit,
      free_question_ids: unlocked,
    };
  }

  const nextUnlocked = [...unlocked, qid];
  if (hasFreeIdsColumn) {
    await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(input.userId)}`, {
      method: 'PATCH',
      headers: {
        ...headers,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ free_question_ids: nextUnlocked }),
    }).catch(() => {});
  }

  return {
    allowed: true,
    unlimited: false,
    already_unlocked: false,
    content,
    used: nextUnlocked.length,
    remaining: Math.max(limit - nextUnlocked.length, 0),
    limit,
    free_question_ids: nextUnlocked,
  };
}
