let mode="up";
$("#tgl").onclick=e=>{e.preventDefault();mode=mode==="up"?"in":"up";$("#ttl").textContent=mode==="up"?"Create your vault":"Welcome back";$("#name").hidden=mode==="in";$("#go").textContent=mode==="up"?"Sign up":"Sign in";$("#tgl").textContent=mode==="up"?"Have an account? Sign in":"New here? Sign up"};
$("#f").onsubmit=async e=>{e.preventDefault();$("#msg").textContent="";const email=$("#em").value,password=$("#pw").value;
 const r=mode==="up"?await sb.auth.signUp({email,password,options:{data:{full_name:$("#name").value}}}):await sb.auth.signInWithPassword({email,password});
 if(r.error)return $("#msg").textContent=r.error.message;
 r.data.session?location.href="app.html":$("#msg").textContent="Check your email to confirm, then sign in."};
document.onmousemove=e=>{const x=e.clientX/innerWidth-.5,y=e.clientY/innerHeight-.5;const tilt=$(".tilt");if(tilt)tilt.style.transform=`rotateY(${x*18}deg) rotateX(${-y*18}deg)`;document.querySelectorAll(".cube").forEach((c,i)=>c.style.translate=`${x*(30+i*25)}px ${y*(30+i*25)}px`)};
sb.auth.getSession().then(({data})=>data?.session&&location.replace("app.html"));
