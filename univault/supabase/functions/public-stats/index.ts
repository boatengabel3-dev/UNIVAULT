import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json({ error: "Missing Supabase environment configuration." }, 500);
    }

    const sb = createClient(supabaseUrl, serviceKey);
    const { data, error } = await sb
      .from("questions")
      .select("department, course_code, course_title, year, semester")
      .eq("status", "approved")
      .order("year", { ascending: false });

    if (error) {
      return json({ error: error.message }, 500);
    }

    const rows = data ?? [];
    const departments = [...new Set(rows.map((r) => r.department).filter(Boolean))].sort();
    const byCourse = new Map<
      string,
      { course_code: string; course_title: string; department: string; papers: Array<{ year: number; semester: number | null }> }
    >();

    for (const row of rows) {
      if (!row.course_code) continue;
      const existing = byCourse.get(row.course_code);
      if (existing) {
        existing.papers.push({ year: row.year, semester: row.semester ?? null });
      } else {
        byCourse.set(row.course_code, {
          course_code: row.course_code,
          course_title: row.course_title ?? "",
          department: row.department ?? "",
          papers: [{ year: row.year, semester: row.semester ?? null }],
        });
      }
    }

    const courses = [...byCourse.values()].sort((a, b) =>
      a.course_code.localeCompare(b.course_code)
    );

    return json({
      totalQuestions: rows.length,
      totalCourses: courses.length,
      totalDepartments: departments.length,
      departments,
      courses,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return json({ error: message }, 500);
  }
});
