import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,"Content-Type":"application/json"}});
const ps=(path:string,body:unknown)=>fetch("https://api.paystack.co"+path,{method:"POST",headers:{Authorization:`Bearer ${Deno.env.get("PAYSTACK_SECRET_KEY")}`,"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const {data:{user}}=await sb.auth.getUser((req.headers.get("Authorization")||"").replace("Bearer ",""));
  const {data:adm}=user?await sb.from("admins").select("user_id").eq("user_id",user.id).maybeSingle():{data:null};
  if(!adm)return json({error:"forbidden"},403);
  const {id}=await req.json();
  const {data:po}=await sb.from("payouts").update({status:"processing"}).eq("id",id).eq("status","pending").select().single();
  if(!po)return json({error:"Not pending"},400);
  const rc=await ps("/transferrecipient",{type:"mobile_money",name:po.account_name,account_number:po.momo,bank_code:po.network,currency:"GHS"});
  const tr=rc.status?await ps("/transfer",{source:"balance",amount:po.amount,recipient:rc.data.recipient_code,reason:"UniVault upload earnings",reference:po.id.replace(/-/g,"")}):rc;
  if(tr.status){await sb.from("payouts").update({status:"paid"}).eq("id",id);return json({ok:true});}
  const {data:pr}=await sb.from("profiles").select("balance").eq("id",po.user_id).single();
  await sb.from("profiles").update({balance:(pr?.balance??0)+po.amount}).eq("id",po.user_id);
  await sb.from("payouts").update({status:"failed"}).eq("id",id);
  return json({error:tr.message||"Transfer failed; balance refunded"},400);
});
