// Whimsical "telephone game" view of a factory run: one chibi per station along a village path. The working
// station thinks out loud in a bubble; when a step finishes, its chibi walks the scroll to the next station.
export const CHIBI = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telephone Village</title>
<style>
:root{--sky:#e9f5ff;--grass:#d9f2d0;--grass2:#c6e8bb;--path:#f3e3c3;--ink:#2b2a33;--ink2:#6b6875;--card:#ffffffee;--line:#e2dccf;--shadow:rgba(40,30,20,.18);--skin:#ffe0c7;--cheek:#ff9eae;--bubble:#ffffff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--sky:#1b2233;--grass:#1f3324;--grass2:#1a2b1e;--path:#4a4030;--ink:#f1eee6;--ink2:#b7b2a6;--card:#262632ee;--line:#3b3a46;--shadow:rgba(0,0,0,.45);--skin:#f2cfb3;--cheek:#e4788c;--bubble:#30303c}}
:root[data-theme=dark]{--sky:#1b2233;--grass:#1f3324;--grass2:#1a2b1e;--path:#4a4030;--ink:#f1eee6;--ink2:#b7b2a6;--card:#262632ee;--line:#3b3a46;--shadow:rgba(0,0,0,.45);--skin:#f2cfb3;--cheek:#e4788c;--bubble:#30303c}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:linear-gradient(var(--sky) 0 18%,var(--grass) 18% 100%);color:var(--ink);font:14px/1.4 "Comic Sans MS","Chalkboard SE","Marker Felt",ui-rounded,system-ui,sans-serif;overflow-x:hidden}
header{display:flex;gap:14px;align-items:center;padding:12px 16px;flex-wrap:wrap}
h1{margin:0;font-size:20px}.sub{color:var(--ink2);font-size:13px}
.chip{background:var(--card);border:2px solid var(--line);border-radius:99px;padding:2px 10px;font-size:12px}
.link{color:var(--ink2);font-size:12px;margin-left:auto}
#stage{position:relative;margin:0 auto;width:min(1180px,100vw - 16px);aspect-ratio:1180/780}
#stage svg.paths{position:absolute;inset:0;width:100%;height:100%}
.st{position:absolute;width:9.5%;transform:translate(-50%,-78%);text-align:center;transition:filter .4s}
.st .who{display:inline-block;background:var(--card);border:2px solid var(--line);border-radius:10px;padding:1px 8px;font-size:12px;margin-top:-4px;white-space:nowrap}
.st .count{font-size:11px;color:var(--ink2)}
.st.idle svg.kid{filter:saturate(.55) brightness(.97)}
.st.idle .zz{display:block}
.zz{display:none;position:absolute;right:12%;top:8%;font-size:14px;color:var(--ink2);animation:zz 2.4s ease-in-out infinite}
@keyframes zz{0%{opacity:0;transform:translate(0,6px)}50%{opacity:1}100%{opacity:0;transform:translate(8px,-10px)}}
.st.working svg.kid{animation:bob .9s ease-in-out infinite}
@keyframes bob{50%{transform:translateY(-6%)}}
.st.done-flash svg.kid{animation:hop .5s ease-out 2}
@keyframes hop{40%{transform:translateY(-14%) rotate(-4deg)}}
svg.kid{width:100%;display:block;overflow:visible;filter:drop-shadow(0 4px 3px var(--shadow))}
.bubble{position:absolute;left:50%;bottom:96%;transform:translateX(-30%);width:min(300px,26vw);background:var(--bubble);border:2px solid var(--line);border-radius:18px;padding:8px 11px;font-size:12.5px;text-align:left;box-shadow:0 6px 16px var(--shadow);z-index:5}
.bubble:after,.bubble:before{content:"";position:absolute;background:var(--bubble);border:2px solid var(--line);border-radius:50%}
.bubble:after{width:14px;height:14px;left:22%;bottom:-18px}.bubble:before{width:8px;height:8px;left:17%;bottom:-30px}
.bubble .kind{font-size:11px;color:var(--ink2);margin-bottom:2px}
.bubble .txt{max-height:7.2em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;word-break:break-word}
.bubble .tool{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#c0541f;word-break:break-all}
.walker{position:absolute;width:9%;transform:translate(-50%,-80%);z-index:6;pointer-events:none}
.walker svg.kid{animation:walk .35s ease-in-out infinite}
@keyframes walk{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-7%) rotate(3deg)}}
.walker .scroll{position:absolute;right:-8%;top:44%;font-size:22px;animation:none}
.pop{position:absolute;transform:translate(-50%,-150%);font-size:26px;z-index:7;animation:pop 1.2s ease-out forwards;pointer-events:none}
@keyframes pop{0%{opacity:0;transform:translate(-50%,-120%) scale(.4)}25%{opacity:1;transform:translate(-50%,-170%) scale(1.15)}100%{opacity:0;transform:translate(-50%,-210%) scale(1)}}
#log{width:min(1180px,100vw - 16px);margin:6px auto 24px;background:var(--card);border:2px solid var(--line);border-radius:14px;padding:10px 14px;max-height:220px;overflow:auto}
#log h2{font-size:13px;margin:0 0 6px;color:var(--ink2)}
#log div{font-size:13px;padding:2px 0;border-bottom:1px dashed var(--line)}#log div:last-child{border:0}
.ok{color:#178a3b}.bad{color:#c43c3c}
</style></head><body>
<header><h1>🏘️ Telephone Village</h1><span class="sub" id="story"></span><span class="chip" id="slots"></span><span class="chip" id="progress"></span><a class="link" href="/classic">classic dashboard →</a></header>
<div id="stage"><svg class="paths" id="paths" viewBox="0 0 1180 780" preserveAspectRatio="none"></svg></div>
<div id="log"><h2>📜 Scrolls passed along</h2><div class="sub">Waiting for the first scroll…</div></div>
<script>
// Each station: name, color, hat, prop.
const CAST={
 designer:{c:"#ff8fb8",hat:"beret",prop:"🎨",nick:"Pip the Designer"},
 mockup:{c:"#ffb3d9",hat:"pencil",prop:"🖼️",nick:"Mo the Mocker"},
 "design-critique":{c:"#ff6fa3",hat:"star",prop:"👁️",nick:"Critic Cleo"},
 "ux-inventory":{c:"#57c7b8",hat:"glasses",prop:"📋",nick:"Tally the Inventorist"},
 "ux-spec":{c:"#7fb6ff",hat:"pencil",prop:"📐",nick:"Spec the Scribe"},
 "ux-dev":{c:"#ffa14d",hat:"hardhat",prop:"🔨",nick:"Bolt the Builder"},
 "ux-review":{c:"#a98bff",hat:"glasses",prop:"🔍",nick:"Iris the Inspector"},
 architect:{c:"#4f6bd8",hat:"tophat",prop:"🗺️",nick:"Archie the Architect"},
 security:{c:"#8a93a6",hat:"helmet",prop:"🛡️",nick:"Sir Lockalot"},
 tester:{c:"#5fcf6a",hat:"goggles",prop:"🧪",nick:"Dr. Fizz the Tester"},
 migration:{c:"#b0805a",hat:"miner",prop:"⛏️",nick:"Dig the Migrator"},
 model:{c:"#f2c14e",hat:"crown",prop:"🧱",nick:"Queen Model"},
 controller:{c:"#ff6b6b",hat:"cone",prop:"🚦",nick:"Router Rex"},
 view:{c:"#e05fd0",hat:"beret",prop:"🖌️",nick:"Vee the Painter"},
 "code-review":{c:"#3e9e76",hat:"monocle",prop:"🧐",nick:"Lord Diffington"},
 qa:{c:"#c9a36b",hat:"detective",prop:"🕵️",nick:"Inspector Q"},
 "visual-review":{c:"#ffcf3f",hat:"star",prop:"✨",nick:"Starla the Spotter"},
 triage:{c:"#f4f4f4",hat:"nurse",prop:"🩺",nick:"Nurse Fix"},
};
// Stations appear in the order a run first uses them; one without a costume above gets a generated one, so any
// factory's stations (planner, implementer, AIR's new roles…) show up.
const ORDER=[];
const HATS=["beret","glasses","pencil","hardhat","tophat","helmet","goggles","miner","crown","cone","monocle","detective","star","nurse"];
const hash=t=>[...t].reduce((a,ch)=>(a*31+ch.charCodeAt(0))>>>0,7);
function cast(st){return CAST[st]||(CAST[st]={c:"hsl("+hash(st)%360+" 65% 62%)",hat:HATS[hash(st)%HATS.length],prop:"⚙️",
 nick:st.split("-").map(w=>w[0].toUpperCase()+w.slice(1)).join(" ")})}
// Positions along a winding path (viewBox 1180x640): three rows, snaking.
const POS=[[80,200],[225,185],[370,200],[515,185],[660,200],[805,185],[950,200],[1095,290],
 [985,470],[840,455],[695,470],[550,455],[405,470],[260,455],[110,560],
 [270,700],[560,715],[850,700]];
const posOf=st=>POS[Math.max(0,ORDER.indexOf(st))%POS.length];
const pct=([x,y])=>({left:x/1180*100+"%",top:y/780*100+"%"});
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function hatSvg(h,c){switch(h){
 case"beret":return '<ellipse cx="50" cy="24" rx="30" ry="10" fill="'+c+'"/><circle cx="50" cy="14" r="4" fill="'+c+'"/>';
 case"glasses":return '<g fill="none" stroke="#333" stroke-width="2.5"><circle cx="40" cy="47" r="7"/><circle cx="60" cy="47" r="7"/><path d="M47 47h6"/></g>';
 case"pencil":return '<rect x="66" y="10" width="7" height="26" rx="2" fill="#ffd24a" transform="rotate(30 70 22)"/><path d="M73 33l4 7-7-2z" fill="#333" transform="rotate(30 70 22)"/>';
 case"hardhat":return '<path d="M22 30a28 22 0 0 1 56 0z" fill="#ffd400"/><rect x="18" y="28" width="64" height="6" rx="3" fill="#f0b800"/>';
 case"tophat":return '<rect x="34" y="2" width="32" height="24" rx="3" fill="#2b2a33"/><rect x="24" y="24" width="52" height="6" rx="3" fill="#2b2a33"/><rect x="34" y="18" width="32" height="5" fill="'+c+'"/>';
 case"helmet":return '<path d="M20 40a30 30 0 0 1 60 0v4H20z" fill="#b9c0cc"/><rect x="46" y="12" width="8" height="30" fill="#9aa3b2"/><path d="M50 4c10 0 14 8 14 8l-14 2z" fill="#ff5a5a"/>';
 case"goggles":return '<rect x="22" y="36" width="56" height="6" fill="#444"/><circle cx="40" cy="40" r="8" fill="#9be7ff" stroke="#444" stroke-width="3"/><circle cx="60" cy="40" r="8" fill="#9be7ff" stroke="#444" stroke-width="3"/>';
 case"miner":return '<path d="M22 30a28 20 0 0 1 56 0z" fill="#e2a23b"/><circle cx="50" cy="20" r="6" fill="#fff6b0" stroke="#c98a2a" stroke-width="2"/>';
 case"crown":return '<path d="M28 28l4-18 9 10 9-14 9 14 9-10 4 18z" fill="#ffd34d" stroke="#d9a520" stroke-width="2"/>';
 case"cone":return '<path d="M50 0l16 30H34z" fill="#ff7a1a"/><rect x="40" y="12" width="20" height="5" fill="#fff"/><rect x="30" y="28" width="40" height="5" rx="2" fill="#ff7a1a"/>';
 case"monocle":return '<circle cx="60" cy="47" r="8" fill="none" stroke="#c9a227" stroke-width="3"/><path d="M66 53l6 18" stroke="#c9a227" stroke-width="2"/><rect x="30" y="8" width="40" height="18" rx="4" fill="#2b2a33"/><rect x="24" y="24" width="52" height="5" rx="2" fill="#2b2a33"/>';
 case"detective":return '<path d="M22 30c4-20 52-20 56 0z" fill="#a07a48"/><rect x="16" y="28" width="68" height="6" rx="3" fill="#8a6639"/>';
 case"star":return '<g fill="#ffcf3f" stroke="#e0a800" stroke-width="1.5"><path d="M40 40l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z"/><path d="M60 40l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z"/></g>';
 case"nurse":return '<path d="M30 28l4-14h32l4 14z" fill="#fff" stroke="#ddd" stroke-width="2"/><path d="M47 16h6v4h4v6h-4v4h-6v-4h-4v-6h4z" fill="#ff4d4d"/>';
 default:return"";}}
function kid(st){const k=cast(st);return '<svg class="kid" viewBox="0 0 100 130">'
 +'<ellipse cx="50" cy="126" rx="26" ry="4" fill="var(--shadow)"/>'
 +'<rect x="36" y="104" width="10" height="18" rx="5" fill="#5b5966"/><rect x="54" y="104" width="10" height="18" rx="5" fill="#5b5966"/>'
 +'<path d="M28 112c0-26 8-38 22-38s22 12 22 38z" fill="'+k.c+'"/>'
 +'<circle cx="24" cy="94" r="7" fill="var(--skin)"/><circle cx="76" cy="94" r="7" fill="var(--skin)"/>'
 +'<circle cx="50" cy="48" r="30" fill="var(--skin)"/>'
 +'<path d="M20 44c2-20 18-28 30-28s28 8 30 28c-8-8-18-10-30-10s-22 2-30 10z" fill="#6b4a3a"/>'
 +'<ellipse cx="40" cy="50" rx="3.2" ry="4.2" fill="#2b2a33"/><ellipse cx="60" cy="50" rx="3.2" ry="4.2" fill="#2b2a33"/>'
 +'<circle cx="41" cy="48.5" r="1.1" fill="#fff"/><circle cx="61" cy="48.5" r="1.1" fill="#fff"/>'
 +'<ellipse cx="33" cy="59" rx="5" ry="3" fill="var(--cheek)" opacity=".7"/><ellipse cx="67" cy="59" rx="5" ry="3" fill="var(--cheek)" opacity=".7"/>'
 +'<path d="M45 61q5 5 10 0" stroke="#2b2a33" stroke-width="2" fill="none" stroke-linecap="round"/>'
 +hatSvg(k.hat,k.c)
 +'<text x="80" y="104" font-size="20">'+k.prop+'</text></svg>'}

const stage=document.getElementById("stage");
// The path runs through the stations this run uses; nodes are added as stations first appear.
function drawPaths(){const pts=POS.slice(0,Math.max(2,ORDER.length));
 document.getElementById("paths").innerHTML='<polyline points="'+pts.map(p=>p.join(",")).join(" ")+'" fill="none" stroke="var(--path)" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>'
 +'<polyline points="'+pts.map(p=>p.join(",")).join(" ")+'" fill="none" stroke="var(--line)" stroke-width="3" stroke-dasharray="2 12" stroke-linecap="round"/>'
 +pts.map(([x,y])=>'<ellipse cx="'+x+'" cy="'+(y+2)+'" rx="52" ry="14" fill="var(--grass2)"/>').join("")}
const nodes={};
function ensure(st){if(nodes[st])return nodes[st];ORDER.push(st);const d=document.createElement("div");d.className="st idle";Object.assign(d.style,pct(posOf(st)));
 d.innerHTML='<div class="zz">z z</div>'+kid(st)+'<div class="who">'+esc(cast(st).nick)+'</div><div class="count"></div>';stage.appendChild(d);nodes[st]=d;drawPaths();return d}
drawPaths();

let S=null,seen=new Map(),firstLoad=true,walking=0,LIVE=null,activeConv=null;
function stationOf(l){return(l.name.match(/^\\d+\\.\\s*(.+)$/)||[])[1]||l.name}
function pop(st,ch){const p=document.createElement("div");p.className="pop";p.textContent=ch;Object.assign(p.style,pct(posOf(st)));stage.appendChild(p);setTimeout(()=>p.remove(),1300)}
function walk(from,to,label){ // the finishing chibi carries the scroll to the next station and walks home
 if(!nodes[from]||!nodes[to]||from===to){pop(to,"📜");return}
 walking++;const w=document.createElement("div");w.className="walker";w.innerHTML=kid(from)+'<div class="scroll">📜</div>';
 const a=posOf(from),b=posOf(to);Object.assign(w.style,pct(a));stage.appendChild(w);nodes[from].style.visibility="hidden";
 const dist=Math.hypot(b[0]-a[0],b[1]-a[1]),ms=Math.min(4200,Math.max(1200,dist*4.2));
 w.animate([pct(a),pct(b)],{duration:ms,easing:"ease-in-out",fill:"forwards"}).onfinish=()=>{
  pop(to,"📜");w.querySelector(".scroll").remove();
  w.animate([pct(b),pct(a)],{duration:ms*.8,easing:"ease-in-out",fill:"forwards"}).onfinish=()=>{w.remove();nodes[from].style.visibility="";walking--}}}
function logLine(html){const log=document.getElementById("log");if(log.querySelector(".sub"))log.querySelector(".sub").remove();const d=document.createElement("div");d.innerHTML=html;log.insertBefore(d,log.children[1]||null)}

function render(){
 const lanes=S.lanes||[];document.getElementById("story").textContent=(S.title||"").replace(/^Factory · /,"story: ");
 const h=S.server||{};document.getElementById("slots").textContent="🧠 "+(h.live?.connections??0)+"/"+(h.max_batch_size??5)+" brains busy";
 const done=lanes.filter(l=>l.status==="ok"||l.status==="failed").length;document.getElementById("progress").textContent="📦 "+done+"/"+lanes.length+" steps";
 const counts={},act=new Set();lanes.forEach(l=>{const st=stationOf(l);ensure(st);counts[st]=(counts[st]||0)+1;if(l.status==="running")act.add(st)});
 ORDER.forEach(st=>{const n=nodes[st];n.classList.toggle("working",act.has(st));n.classList.toggle("idle",!act.has(st));
  n.querySelector(".count").textContent=counts[st]?counts[st]+" job"+(counts[st]>1?"s":""):"";});
 // Transitions: a step finished → its chibi walks to the station of the next step.
 lanes.forEach((l,i)=>{const prev=seen.get(l.id);seen.set(l.id,l.status);if(firstLoad||prev===l.status)return;
  if(l.status==="ok"||l.status==="failed"){const st=stationOf(l);const nx=lanes[i+1];nodes[st].classList.add("done-flash");setTimeout(()=>nodes[st].classList.remove("done-flash"),1100);
   if(l.status==="failed")pop(st,"💥");
   logLine('<b>'+esc(cast(st).nick)+'</b> finished <i>'+esc(l.task)+'</i> '+(l.status==="ok"?'<span class="ok">✓</span>':'<span class="bad">✗</span>')+(nx?' → passes the scroll to <b>'+esc(cast(stationOf(nx)).nick)+'</b>':'')+' <span class="sub">'+esc(l.detail||"")+'</span>');
   if(nx)walk(st,stationOf(nx),l.task)}});
 if(firstLoad){lanes.filter(l=>l.status!=="running").slice(-8).reverse().forEach(l=>logLine('<b>'+esc(cast(stationOf(l)).nick)+'</b> finished <i>'+esc(l.task)+'</i> '+(l.status==="ok"?'<span class="ok">✓</span>':'<span class="bad">✗</span>')+' <span class="sub">'+esc(l.detail||"")+'</span>'))}
 firstLoad=false;
 const running=lanes.filter(l=>l.status==="running").pop();activeConv=running?running.conv:null;renderBubble(running)}
function renderBubble(running){document.querySelectorAll(".bubble").forEach(b=>b.remove());if(!running)return;const st=stationOf(running);const n=nodes[st];if(!n)return;
 const L=LIVE&&LIVE.conv===running.conv?LIVE:null;let kind="💭 thinking about "+running.task,body="",tool="";
 if(L){if(L.tools&&L.tools.length){const t=L.tools[L.tools.length-1];kind="🔧 using "+(t.name||"a tool");tool=(t.output||"").slice(-160)}
  else if(L.calls&&L.calls.length){const c=L.calls[L.calls.length-1];kind="✍️ about to "+c.name;tool=c.args.slice(0,160)}
  else if(L.text){kind="🗣️ reporting";body=L.text.slice(-260)}
  else if(L.thinking){body=L.thinking.slice(-260)}
  else body="hmm…"}
 const b=document.createElement("div");b.className="bubble";b.innerHTML='<div class="kind">'+esc(kind)+'</div>'+(body?'<div class="txt">'+esc(body)+'</div>':"")+(tool?'<div class="tool">'+esc(tool)+'</div>':"");n.appendChild(b)}
async function tick(){try{const r=await fetch("/api/state");S=await r.json();if(!S.error)render()}catch{}setTimeout(tick,1000)}
async function liveTick(){try{if(activeConv!=null){const r=await fetch("/api/live?conv="+activeConv);LIVE={...(await r.json()),conv:activeConv};const running=(S?.lanes||[]).filter(l=>l.status==="running").pop();renderBubble(running)}}catch{}setTimeout(liveTick,700)}
tick();liveTick();
</script></body></html>`;
