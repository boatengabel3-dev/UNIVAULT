import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const {data:{user}}=await sb.auth.getUser((req.headers.get("Authorization")||"").replace("Bearer ",""));
  if(!user)return json({error:"Please sign in first."},401);
  const {mode,course,messages=[],count=5,instructions=""}=await req.json();
  const {data:p}=await sb.from("profiles").select("*").eq("id",user.id).single();
  const premium=p?.premium_until&&new Date(p.premium_until)>new Date();
  if(!premium)return json({error:"Premium required. Upgrade to continue."},402);
  let qs:any[]=[];
  if(course){const r=await sb.from("questions").select("year,semester,question_content(content)").eq("course_code",course).eq("status","approved").order("year",{ascending:false}).limit(15);qs=r.data||[];}
  const bank=qs.map(q=>`[${q.year} S${q.semester??"-"}]\n${q.question_content?.content??""}`).join("\n\n").slice(0,40000);
  let system=`You are a KNUST exam tutor. Past questions for ${course||"the course"}:\n\n${bank||"(none on file)"}\n\n`;
  if(mode==="quiz")system+=`Write ${count} multiple-choice questions in the style of these past questions. Extra instructions: ${instructions||"none"}. Reply with ONLY a JSON array: [{"q":"","options":["","","",""],"answer":0,"explain":""}]`;
  else system+=`Solve questions step by step with clear working. When asked to predict, analyse repeated topics, question formats, mark weighting and lecturer habits across years, and say which topics are most likely; label predictions as estimates, never guarantees.`;
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":Deno.env.get("ANTHROPIC_API_KEY")!,"anthropic-version":"2023-06-01","content-type":"application/json"},
    body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:2000,system,messages:mode==="quiz"?[{role:"user",content:"Generate the quiz."}]:messages})});
  const d=await r.json();
  if(!r.ok)return json({error:d.error?.message||"AI error"},500);
  return json({text:d.content.map((c:any)=>c.text||"").join("")});
});
