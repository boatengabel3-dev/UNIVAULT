// Hidden page: no links point here. Real protection is server-side (RLS, RPCs, edge function all check the admins table).
(async()=>{const{data:{session}}=await sb.auth.getSession();if(!session)return location.replace("index.html");
 const{data:a}=await sb.from("admins").select("user_id").eq("user_id",session.user.id).maybeSingle();if(!a)return location.replace("app.html");document.body.hidden=false;load()})();
async function load(){
 const{data:q}=await sb.from("questions").select("*,question_content(content)").eq("status","pending").order("created_at");
 $("#pend").innerHTML=(q||[]).map(x=>`<article class="card"><small>${esc(x.department)} · ${x.year} S${x.semester||"-"}</small><h3>${esc(x.course_code)}<span>${esc(x.course_title)}</span></h3><pre>${esc(x.question_content?.content)}</pre><div class="chips"><button data-a="approve_question" data-id="${x.id}">Approve (+GH₵3)</button><button class="ghost" data-a="reject_question" data-id="${x.id}">Reject</button></div></article>`).join("")||"<p>Nothing pending.</p>";
 const{data:p}=await sb.from("payouts").select("*").eq("status","pending");
 $("#po").innerHTML=(p||[]).map(x=>`<article class="card"><h3>${fmt(x.amount)}</h3><p>${esc(x.account_name)} · ${esc(x.momo)} · ${esc(x.network)}</p><button data-pay="${x.id}">Send via Paystack</button></article>`).join("")||"<p>No payout requests.</p>"}
document.onclick=async e=>{const t=e.target;let r;
 if(t.dataset.a)r=await sb.rpc(t.dataset.a,{qid:t.dataset.id});
 else if(t.dataset.pay){t.disabled=true;const{error}=await sb.functions.invoke("admin-payout",{body:{id:t.dataset.pay}});r={error}}
 else return;if(r.error)alert(r.error.message||"Failed");load()};
