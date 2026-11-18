let Q=[],user=null,P={},hist=[],cur=null,quiz=[];
function show(v){document.querySelectorAll("main>section").forEach(s=>s.hidden=s.id!==v);document.querySelectorAll("nav button").forEach(b=>b.classList.toggle("on",b.dataset.v===v))}
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>show(b.dataset.v));
(async()=>{const{data:{session}}=await sb.auth.getSession();if(!session)return location.replace("signup.html");user=session.user;await refresh();await load()})();
$("#out").onclick=async()=>{await sb.auth.signOut();location.href="index.html"};
async function refresh(){const{data}=await sb.from("profiles").select("*").single();P=data||{};P.on=P.premium_until&&new Date(P.premium_until)>new Date();
 $("#badge").textContent=P.on?"Premium until "+new Date(P.premium_until).toLocaleDateString():"Free";$("#bal").textContent=fmt(P.balance||0);
 const{data:adm}=await sb.from("admins").select("user_id").eq("user_id",user.id).maybeSingle();if($("#adminLink"))$("#adminLink").hidden=!adm;
 const{data:po}=await sb.from("payouts").select("*").order("created_at",{ascending:false});$("#pays").innerHTML=(po||[]).map(p=>`<p>${fmt(p.amount)} · ${esc(p.status)}</p>`).join("");
 const{data:m}=await sb.from("questions").select("*").eq("uploader",user.id).order("created_at",{ascending:false});$("#mine").innerHTML=(m||[]).map(q=>`<p>${esc(q.course_code)} ${q.year} · ${esc(q.status)}</p>`).join("")}
async function load(){const{data}=await sb.from("questions").select("*").eq("status","approved").order("year",{ascending:false});Q=data||[];
 $("#dep").innerHTML='<option value="">All departments</option>'+[...new Set(Q.map(q=>q.department))].sort().map(d=>`<option>${esc(d)}</option>`).join("");
 const codes=[...new Set(Q.map(q=>q.course_code))].sort();document.querySelectorAll(".courses").forEach(s=>s.innerHTML=codes.map(c=>`<option>${esc(c)}</option>`).join(""));render()}
function render(){const d=$("#dep").value,raw=$("#search").value.trim(),t=raw.toLowerCase(),by={};
 $("#clearSearch").hidden=!d&&!raw;
 const filtered=Q.filter(q=>(!d||q.department===d)&&(!t||`${q.course_code} ${q.course_title||""} ${q.department||""} ${q.year}`.toLowerCase().includes(t)));
 filtered.forEach(q=>(by[q.course_code]??={t:q.course_title,d:q.department,i:[]}).i.push(q));
 const courses=Object.entries(by);
 $("#browseMeta").textContent=Q.length?`Showing ${courses.length} course${courses.length===1?"":"s"} (${filtered.length} paper${filtered.length===1?"":"s"})`:"";
 $("#list").innerHTML=courses.map(([c,v])=>`<article class="card"><small>${esc(v.d)}</small><h3>${esc(c)}<span>${esc(v.t)}</span></h3><div class="chips">${v.i.map(q=>`<button data-id="${q.id}">${q.year}${q.semester?" S"+q.semester:""}</button>`).join("")}</div></article>`).join("")||`<p>${Q.length?"No approved past papers match your search.":"No approved questions yet."}</p>`}
$("#dep").onchange=$("#search").oninput=render;
$("#clearSearch").onclick=()=>{$("#dep").value="";$("#search").value="";render();$("#search").focus()};
$("#list").onclick=async e=>{const id=e.target.dataset.id;if(!id)return;cur=Q.find(q=>q.id===id);$("#rt").textContent=`${cur.course_code} · ${cur.year}${cur.semester?" Sem "+cur.semester:""}`;
 const{data}=await sb.from("question_content").select("content").eq("question_id",id).maybeSingle();cur.content=data?.content;
 $("#rb").textContent=data?data.content:"Subscribe for GH₵30/month to read this paper.";$("#solve").hidden=!data;$("#reader").showModal();if(!data)show("pricing")};
$("#solve").onclick=()=>{$("#reader").close();$("#chatCourse").value=cur.course_code;$("#msg").value="Solve step by step:\n"+cur.content;show("chat")};
async function ai(body){const{data,error}=await sb.functions.invoke("ai-chat",{body});
 if(error){let m=error.message;try{m=(await error.context.json()).error||m}catch{}if(/premium/i.test(m))show("pricing");throw new Error(m)}return data.text}
function bub(t,c){const d=document.createElement("div");d.className="m "+c;d.textContent=t;$("#log").append(d);$("#log").scrollTop=1e9;return d}
async function ask(text){bub(text,"u");hist.push({role:"user",content:text});const w=bub("Thinking...","a");
 try{const r=await ai({mode:"chat",course:$("#chatCourse").value,messages:hist});w.textContent=r;hist.push({role:"assistant",content:r})}catch(e){w.textContent=e.message;hist.pop()}}
$("#send").onclick=()=>{const t=$("#msg").value.trim();if(t){$("#msg").value="";ask(t)}};
$("#predict").onclick=()=>ask("Based on the past questions, predict how this lecturer sets questions: recurring topics, question types, mark distribution, and the most likely topics next exam.");
$("#gen").onclick=async()=>{const o=$("#quizOut");o.textContent="Generating...";
 try{quiz=JSON.parse((await ai({mode:"quiz",course:$("#quizCourse").value,count:+$("#count").value,instructions:$("#instr").value})).replace(/```json|```/g,"").trim());
 o.innerHTML=quiz.map((q,i)=>`<div class="qq glass"><b>${i+1}. ${esc(q.q)}</b>${q.options.map((x,j)=>`<label data-q="${i}"><input type="radio" name="q${i}" value="${j}"> ${esc(x)}</label>`).join("")}<small hidden>${esc(q.explain)}</small></div>`).join("")+'<button id="grade">Submit</button><p id="score"></p>';
 $("#grade").onclick=()=>{let s=0;quiz.forEach((q,i)=>{const p=document.querySelector(`input[name=q${i}]:checked`);if(p&&+p.value===q.answer)s++;const L=document.querySelectorAll(`label[data-q="${i}"]`);L[q.answer].classList.add("ok");if(p&&+p.value!==q.answer)p.parentElement.classList.add("no");L[0].parentElement.querySelector("small").hidden=false});$("#score").textContent=`Score: ${s}/${quiz.length}`}}
 catch(e){o.textContent=e.message}};
$("#usub").onclick=async()=>{const{error}=await sb.rpc("submit_question",{d:$("#ud").value,c:$("#uc").value,t:$("#ut").value,y:+$("#uy").value,s:+$("#us").value,body:$("#ub").value});
 if(error)return alert(error.message);alert("Submitted for review!");$("#ub").value="";refresh()};
$("#wd").onclick=async()=>{const{error}=await sb.rpc("request_payout",{nm:$("#wn").value,momo:$("#wm").value,net:$("#wk").value});error?alert(error.message):(alert("Withdrawal requested"),refresh())};
$("#pay").onclick=()=>{if(typeof PaystackPop==="undefined")return alert("Paystack checkout script failed to load.");PaystackPop.setup({key:C.PAYSTACK_PUBLIC_KEY,email:user.email,amount:C.PRICE_GHS*100,currency:"GHS",callback:r=>{sb.functions.invoke("paystack-verify",{body:{reference:r.reference}}).then(async({data})=>{alert(data?.ok?"Premium active for 30 days!":"Could not verify. Keep ref "+r.reference);await refresh()})}}).openIframe()};
