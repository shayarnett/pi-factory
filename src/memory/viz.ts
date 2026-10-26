// Live view of a memory tree: stores with charters, holds and memories, plus the model calls as they happen.
//   npx tsx src/memory/viz.ts --repo ~/memory     # http://localhost:8791
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const i = process.argv.indexOf("--repo");
const REPO = resolve((i >= 0 ? process.argv[i + 1]! : "~/memory").replace(/^~/, process.env.HOME!));
const ROOT = join(REPO, "store");
const CALLS = join(import.meta.dirname, "..", "..", "runs", "memory", "calls.jsonl");
const PORT = 8791;

const readOr = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
type Node = { name: string; about: string; holds: string; memories?: { id: string; text: string; source: string }[]; children?: Node[] };
function tree(dir: string, name = "root"): Node {
	const node: Node = { name, about: readOr(join(dir, "about.md")), holds: readOr(join(dir, "holds.md")) };
	if (existsSync(join(dir, "memories.jsonl")))
		node.memories = readOr(join(dir, "memories.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
	else
		node.children = existsSync(dir)
			? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => tree(join(dir, e.name), e.name))
			: [];
	return node;
}
function calls(after: number) {
	const lines = readOr(CALLS).split("\n").filter(Boolean);
	return { total: lines.length, calls: lines.slice(Math.max(after, lines.length - 200)).map((l, k) => ({ n: Math.max(after, lines.length - 200) + k + 1, ...JSON.parse(l) })) };
}

const PAGE = `<!doctype html><meta charset=utf-8><title>Memory tree</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1b;--mut:#6b6a66;--card:#fff;--line:#dcd9d2;--acc:#2f6f4f;--tag:#e8efe9}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#e8e6e1;--mut:#9a978f;--card:#1f1f1d;--line:#34332f;--acc:#7fc79f;--tag:#23302a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,sans-serif;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);height:100vh}
main,aside{overflow:auto;padding:16px}aside{border-left:1px solid var(--line)}
h1{font-size:16px;margin:0 0 12px}h1 small{color:var(--mut);font-weight:400}
details{border-left:2px solid var(--line);margin:4px 0 4px 6px;padding-left:10px}details.keeper{border-color:var(--acc)}
summary{cursor:pointer;padding:3px 0}summary b{font-weight:600}.n{background:var(--tag);color:var(--acc);border-radius:9px;padding:0 7px;font-size:12px;margin-left:6px}
.about{color:var(--mut);font-size:13px}.holds{font-size:12px;color:var(--mut);font-style:italic;margin:2px 0 4px}
.mem{font-size:13px;padding:3px 0;border-top:1px dashed var(--line)}.mem code{color:var(--acc);font-size:11px}.src{color:var(--mut);font-size:11px}
.call{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin:0 0 6px}
.call .st{font-weight:600;color:var(--acc)}.call pre{white-space:pre-wrap;margin:4px 0 0;font-size:12px;max-height:9em;overflow:auto;color:var(--mut)}
.flash{animation:f 1.5s}@keyframes f{from{background:var(--tag)}}
@media (max-width:800px){body{grid-template-columns:1fr;height:auto}aside{border:0}}
</style>
<main><h1>Memory tree <small id=sum></small></h1><div id=tree></div></main>
<aside><h1>Calls <small id=ct></small></h1><div id=calls></div></aside>
<script>
const open=new Set(JSON.parse(localStorage.open||'["root"]'));let last="",seen=0;
const esc=s=>String(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const count=n=>n.memories?n.memories.length:n.children.reduce((a,c)=>a+count(c),0);
function render(n,path){const k=n.memories,id=path;
 return '<details data-p="'+id+'" class="'+(k?'keeper':'')+'"'+(open.has(id)?' open':'')+'><summary><b>'+esc(n.name)+'</b><span class=n>'+count(n)+'</span> <span class=about>'+esc(n.about)+'</span></summary>'+
 (n.holds?'<div class=holds>holds: '+esc(n.holds)+'</div>':'')+
 (k?n.memories.map(m=>'<div class=mem><code>'+esc(m.id)+'</code> '+esc(m.text)+' <span class=src>'+esc(m.source)+'</span></div>').join(''):n.children.map(c=>render(c,path+'/'+c.name)).join(''))+'</details>'}
document.addEventListener('toggle',e=>{const p=e.target.dataset?.p;if(!p)return;e.target.open?open.add(p):open.delete(p);try{localStorage.open=JSON.stringify([...open])}catch{}},true);
async function tick(){
 const t=await (await fetch('/api/tree')).json(),s=JSON.stringify(t);
 if(s!==last){last=s;const stores=[];(function w(n){n.memories?stores.push(n):n.children.forEach(w)})(t);
  document.getElementById('sum').textContent=count(t)+' memories in '+stores.length+' stores';
  document.getElementById('tree').innerHTML=render(t,'root');}
 const c=await (await fetch('/api/calls?after='+seen)).json();document.getElementById('ct').textContent=c.total;
 const box=document.getElementById('calls');
 for(const x of c.calls){if(x.n<=seen)continue;seen=x.n;const d=document.createElement('div');d.className='call flash';
  d.innerHTML='<span class=st>#'+x.n+' '+esc(x.station)+(x.ms?' · '+Math.round(x.ms/1000)+'s':'')+'</span><pre>'+esc(x.message.slice(0,600))+'</pre><pre>→ '+esc(x.reply.slice(0,600))+'</pre>';box.prepend(d)}
 while(box.children.length>80)box.lastChild.remove();
}
tick();setInterval(tick,2000);
</script>`;

createServer((req, res) => {
	const url = new URL(req.url!, "http://x");
	if (url.pathname === "/api/tree") return res.end(JSON.stringify(tree(ROOT)));
	if (url.pathname === "/api/calls") return res.end(JSON.stringify(calls(Number(url.searchParams.get("after") ?? 0))));
	res.setHeader("content-type", "text/html");
	res.end(PAGE);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
