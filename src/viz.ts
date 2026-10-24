// Read-only live view of the pool: opens pool.sqlite read-only (safe while the pool runs; SQLite WAL allows readers)
// and serves a dashboard on http://localhost:8787 that polls /api/state.
//
//   npm run viz [-- --port 8787]
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { CHIBI } from "./viz-chibi.ts";

const flag = (name: string) => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1]! : null);
// --run <dir>: one factory run (run.sqlite + steps.json). --runs <dir>: every run under dir, picked with ?run=<name>.
const RUNS = flag("--runs");
const ONE_RUN = flag("--run");
const runDir = (run: string | null) => (RUNS ? (run ? join(RUNS, run.replace(/[^\w.-]/g, "")) : null) : ONE_RUN);
const dbOf = (run: string | null) => (runDir(run) ? join(runDir(run)!, "run.sqlite") : join(import.meta.dirname, "..", "pool.sqlite"));
const portFlag = process.argv.indexOf("--port");
const PORT = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 8787;
const LLM = (process.env.LOCAL_LLM_BASE_URL ?? "http://192.168.1.69:8888/v1").replace(/\/v1\/?$/, "");
const SLOTS = ["w1", "w2", "w3", "w4"];

type Json = any;
const parse = (s: string | null): Json => (s == null ? null : JSON.parse(s));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const textOf = (content: Json): string =>
	typeof content === "string" ? content : (content ?? []).flatMap((c: Json) => (c.type === "text" ? [c.text] : [])).join("");
function argSummary(name: string, args: Json): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return String(args.command ?? "");
	if (name === "pool") return [args.action, args.slot, args.message && clip(String(args.message), 60)].filter(Boolean).join(" ");
	return String(args.path ?? args.file_path ?? JSON.stringify(args));
}

async function health(): Promise<Json> {
	try {
		const r = await fetch(`${LLM}/health`, { signal: AbortSignal.timeout(1500) });
		return await r.json();
	} catch (e) {
		return { error: String((e as Error).message) };
	}
}

function snapshot(run: string | null): Json {
	const RUN = runDir(run);
	const db = new DatabaseSync(dbOf(run), { readOnly: true });
	try {
		const tasks = db
			.prepare("select record from tasks")
			.all()
			.map((r: Json): Json => {
				const t = parse(r.record);
				return {
					id: t.id,
					conv: t.conversationId,
					kind: t.kind,
					status: t.state?.status,
					outcome: t.state?.outcome?.status,
					owner: t.owner ?? null,
					background: !!t.background,
					start: t.startedAt ?? null,
					end: t.endedAt ?? null,
					input: t.input,
					phase: t.state?.checkpoint?.phase,
				};
			});

		// Roles: conversation 1 is the orchestrator; a worker's conversation is named by the reporters that feed it.
		const role = new Map<number, string>([[1, "orch"]]);
		const slotConv: Record<string, number | null> = Object.fromEntries(SLOTS.map((s) => [s, null]));
		const slotTask: Record<string, string> = {};
		for (const t of tasks.filter((t: Json) => t.kind === "app.pool-reporter").sort((a: Json, b: Json) => a.id - b.id)) {
			role.set(t.input.conversationId, t.input.slot);
			slotConv[t.input.slot] = t.input.conversationId;
			slotTask[t.input.slot] = t.input.message;
		}

		// Entries, summarized; tool-call names are looked up from assistant entries for the timeline.
		const callName = new Map<string, { name: string; args: string }>();
		const entriesByConv = new Map<number, Json[]>();
		for (const r of db.prepare("select id, conversation_id c, record from entries order by id").all() as Json[]) {
			const e = parse(r.record);
			const m = e.model?.[0];
			if (!m) continue;
			const item: Json = { id: r.id, role: m.role };
			if (m.role === "assistant") {
				item.text = textOf(m.content);
				item.thinking = (m.content ?? []).filter((c: Json) => c.type === "thinking").map((c: Json) => c.thinking).join("");
				item.calls = (m.content ?? [])
					.filter((c: Json) => c.type === "toolCall")
					.map((c: Json) => {
						const s = { name: c.name, args: argSummary(c.name, c.arguments) };
						callName.set(c.id, s);
						return s;
					});
				item.error = m.stopReason === "error" ? m.errorMessage ?? "error" : undefined;
				item.tokens = m.usage?.totalTokens;
			} else if (m.role === "toolResult") {
				item.tool = m.toolName;
				item.text = textOf(m.content);
				item.isError = !!m.isError;
			} else if (m.role === "user") {
				item.text = textOf(m.content);
			} else continue; // system prompt entries
			const list = entriesByConv.get(r.c) ?? [];
			list.push(item);
			entriesByConv.set(r.c, list);
		}
		for (const t of tasks) {
			if (t.kind === "pi.tool" && t.input?.callId) {
				const c = callName.get(t.input.callId);
				t.label = c ? `${c.name} ${clip(c.args, 80)}` : "tool";
				t.tool = c?.name;
			} else if (t.kind === "pi.generation") t.label = "model turn";
			else if (t.kind === "app.pool-reporter") t.label = `deliver → ${t.input.slot}, report back`;
			else if (t.kind === "app.pool-anchor") t.label = "anchor (owns worker)";
			delete t.input;
		}

		// Latest base revision of each conversation's usage document.
		const usage = new Map<number, Json>();
		for (const r of db
			.prepare(
				`select d.owner_id c, r.content from documents d join document_revisions r on r.document_id = d.id
				 where d.kind = '"pi.usage"' and r.kind = 'base' order by r.seq`,
			)
			.all() as Json[]) {
			const u = parse(r.content);
			const m = Object.values(u?.models ?? {})[0] as Json;
			if (m) usage.set(r.c, { input: m.input, output: m.output, cacheRead: m.cacheRead, reasoning: m.reasoning, total: m.totalTokens });
		}

		const conversations: Json[] = (db.prepare("select id, owner_task_id ownerTask from conversations").all() as Json[]).map((c): Json => {
			const live = tasks.filter((t: Json) => t.conv === c.id && t.status !== "terminal" && (t.kind === "pi.generation" || t.kind === "pi.tool"));
			const tool = live.find((t: Json) => t.kind === "pi.tool");
			const gen = live.find((t: Json) => t.kind === "pi.generation");
			const entries = entriesByConv.get(c.id) ?? [];
			return {
				id: c.id,
				ownerTask: c.ownerTask,
				role: role.get(c.id) ?? null,
				state: tool ? "tool" : gen ? (gen.status === "sleeping" ? "retrying" : "thinking") : "idle",
				activity: tool?.label ?? (gen ? (gen.status === "sleeping" ? `retry #${gen.phase}` : "generating") : ""),
				since: (tool ?? gen)?.start ?? null,
				usage: usage.get(c.id) ?? null,
				entryCount: entries.length,
				entries: entries.slice(-60).map((e) => ({
					...e,
					text: e.text && clip(e.text, 4000),
					thinking: e.thinking && clip(e.thinking, 1500),
				})),
			};
		});
		// Lanes: factory steps (one per step) or the pool's orchestrator + slots.
		let lanes: Json[];
		let title = "Pool";
		if (RUN) {
			const file = join(RUN, "steps.json");
			const index = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { story: "?", steps: [] };
			title = `Factory · ${index.story}`;
			lanes = index.steps.map((st: Json, i: number) => ({
				id: `s${st.conv}`, name: `${i + 1}. ${st.station}`, conv: st.conv, task: st.key, status: st.status,
				detail: `${st.key}${st.calls != null ? ` · ${st.calls} tool calls` : ""}${st.end ? ` · ${Math.round((st.end - st.start) / 1000)}s` : ""}`,
			}));
		} else {
			lanes = [
				{ id: "orch", name: "Orchestrator", conv: 1, task: "talks to you, dispatches workers" },
				...SLOTS.map((s) => ({ id: s, name: s, conv: slotConv[s], task: slotTask[s] ?? "no task yet" })),
			];
		}
		for (const c of conversations) c.lane = lanes.find((l) => l.conv === c.id)?.id ?? (role.get(c.id) && !RUN ? role.get(c.id) : null);
		return { now: Date.now(), title, lanes, slots: SLOTS.map((s) => ({ slot: s, conv: slotConv[s], task: slotTask[s] ?? null })), conversations, tasks };
	} finally {
		db.close();
	}
}

// pi.live is stored as a base snapshot plus Chord ops: ["s", path, value] sets, ["a", path, string] appends.
// Replay only new revisions per poll, cached per document.
const liveCache = new Map<string, { seq: number; value: Json }>();
function applyOp(root: Json, op: Json): Json {
	const [type, path, value] = op;
	if (path.length === 0) return type === "s" ? structuredClone(value) : root;
	let node = root;
	for (const key of path.slice(0, -1)) {
		if (node[key] == null) node[key] = typeof key === "number" ? [] : {};
		node = node[key];
	}
	const last = path[path.length - 1];
	if (type === "s") {
		if (value === undefined) Array.isArray(node) ? node.splice(last, 1) : delete node[last];
		else node[last] = value;
	} else if (type === "a") node[last] = (node[last] ?? "") + value;
	else if (type === "d") Array.isArray(node) ? node.splice(last, 1) : delete node[last];
	else throw new Error(`unknown op ${type}`);
	return root;
}
function liveDoc(run: string | null, conversationId: number): Json {
	const db = new DatabaseSync(dbOf(run), { readOnly: true });
	try {
		const doc = db.prepare(`select id from documents where kind = '"pi.live"' and owner_id = ?`).get(conversationId) as Json;
		if (!doc) return null;
		const base = db
			.prepare("select seq, content from document_revisions where document_id = ? and kind = 'base' order by seq desc limit 1")
			.get(doc.id) as Json;
		let cached = liveCache.get(`${run}:${doc.id}`);
		if (!cached || (base && base.seq > cached.seq)) cached = { seq: base?.seq ?? 0, value: base ? parse(base.content) : {} };
		const rows = db
			.prepare("select seq, kind, content from document_revisions where document_id = ? and seq > ? order by seq")
			.all(doc.id, cached.seq) as Json[];
		for (const r of rows) {
			try {
				cached.value = r.kind === "base" ? parse(r.content) : parse(r.content).reduce(applyOp, cached.value ?? {});
			} catch {
				liveCache.delete(`${run}:${doc.id}`); // resync from the next base
				return cached.value;
			}
			cached.seq = r.seq;
		}
		liveCache.set(`${run}:${doc.id}`, cached);
		return cached.value;
	} finally {
		db.close();
	}
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://x");
	const run = url.searchParams.get("run");
	if (url.pathname === "/api/live" && url.searchParams.get("conv")) {
		try {
			const live = liveDoc(run, Number(url.searchParams.get("conv"))) ?? {};
			const msg = live.generation?.message;
			const tools = Object.values(live.tools ?? {}).map((t: Json) => ({
				name: t.name ?? t.toolName,
				status: t.status,
				output: typeof t.output === "string" ? t.output.slice(-6000) : textOf(t.output ?? []).slice(-6000),
			}));
			const body = {
				running: !!live.run,
				generating: !!msg,
				attempt: live.generation?.attempt,
				thinking: (msg?.content ?? []).filter((c: Json) => c.type === "thinking").map((c: Json) => c.thinking).join(""),
				text: textOf(msg?.content ?? []),
				calls: (msg?.content ?? []).filter((c: Json) => c.type === "toolCall").map((c: Json) => ({ name: c.name, args: argSummary(c.name, c.arguments) })),
				tools,
			};
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
		} catch (e) {
			res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
		}
		return;
	}
	if (url.pathname === "/api/runs") {
		res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(activeRuns()));
		return;
	}
	if (url.pathname === "/api/state") {
		try {
			const body = JSON.stringify({ ...snapshot(run), server: await health() });
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
		} catch (e) {
			res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
		}
		return;
	}
	const page = RUNS && !run ? GRID : url.pathname.startsWith("/classic") ? PAGE : CHIBI;
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(withRun(page));
}).listen(PORT, "127.0.0.1", () => console.log(`pool viz → http://localhost:${PORT}  (reading ${RUNS ?? dbOf(null)})`));

// Pages call the API with the page's own ?run=, so each panel of the grid follows its own run.
const withRun = (html: string) =>
	html.replaceAll('fetch("/api/state")', 'fetch("/api/state"+location.search)').replaceAll('fetch("/api/live?conv="+', 'fetch("/api/live?"+location.search.slice(1)+"&conv="+');

// Runs with a step still running, newest first; if none, the newest run.
function activeRuns() {
	if (!RUNS) return [];
	const all = readdirSync(RUNS)
		.filter((d) => existsSync(join(RUNS, d, "steps.json")))
		.map((d) => ({ name: d, mtime: statSync(join(RUNS, d, "steps.json")).mtimeMs, steps: JSON.parse(readFileSync(join(RUNS, d, "steps.json"), "utf8")).steps as Json[] }))
		.sort((a, b) => b.mtime - a.mtime);
	const live = all.filter((r) => r.steps.some((s) => s.status === "running"));
	return (live.length ? live : all.slice(0, 1)).map((r) => ({ name: r.name, step: r.steps.at(-1)?.key ?? "", steps: r.steps.length }));
}

const GRID = /* html */ `<!doctype html><meta charset="utf-8"><title>Factory runs</title>
<style>:root{color-scheme:light dark}body{margin:0;font:13px system-ui;background:Canvas;color:CanvasText;display:flex;flex-direction:column;height:100vh}
header{padding:6px 12px;display:flex;gap:12px;align-items:center}main{flex:1;display:grid;gap:4px;grid-auto-flow:column;grid-auto-columns:1fr}
section{display:flex;flex-direction:column;min-width:0}h2{margin:0;padding:4px 8px;font-size:13px;background:color-mix(in srgb,CanvasText 8%,Canvas)}iframe{flex:1;border:0;width:100%}</style>
<header><b>Factory runs</b><label><input type="checkbox" id="classic"> classic view</label><span id="n"></span></header><main id="m"></main>
<script>
let shown="";
async function tick(){try{const runs=await (await fetch("/api/runs")).json();const view=document.getElementById("classic").checked?"/classic":"/";
const key=view+runs.map(r=>r.name).join(",");document.getElementById("n").textContent=runs.map(r=>r.name+" · "+r.steps+" steps · "+r.step).join("   |   ");
if(key!==shown){shown=key;document.getElementById("m").innerHTML=runs.map(r=>'<section><h2>'+r.name+'</h2><iframe src="'+view+'?run='+encodeURIComponent(r.name)+'"></iframe></section>').join("")}}catch{}setTimeout(tick,3000)}
document.getElementById("classic").onchange=()=>{shown="";tick()};tick();
</script>`;

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pool Viz</title>
<style>
:root{--bg:#f4f4f2;--surface:#fcfcfb;--line:#e4e3df;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;
--gen:#2a78d6;--tool:#eb6834;--rep:#1baf7a;--good:#0ca30c;--warn:#fab219;--crit:#d03b3b;--code:#f0efec}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121211;--surface:#1a1a19;--line:#2c2c2a;--text:#f0efec;--text2:#c3c2b7;--muted:#86857e;
--gen:#3987e5;--tool:#d95926;--rep:#199e70;--code:#232321}}
:root[data-theme=dark]{--bg:#121211;--surface:#1a1a19;--line:#2c2c2a;--text:#f0efec;--text2:#c3c2b7;--muted:#86857e;--gen:#3987e5;--tool:#d95926;--rep:#199e70;--code:#232321}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--surface);position:sticky;top:0;z-index:2;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600}.sub{color:var(--text2)}
.meter{display:flex;gap:4px;align-items:center}.seat{width:18px;height:10px;border-radius:3px;background:var(--line)}.seat.on{background:var(--gen)}
main{padding:16px;display:grid;gap:16px;max-width:1500px;margin:0 auto}
.lanes{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;min-width:0}
.card.sel{outline:2px solid var(--gen);outline-offset:-1px}
.card h3{margin:0 0 4px;font-size:13px;display:flex;justify-content:space-between;gap:6px}
.pill{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--text2);white-space:nowrap}
.pill.thinking{border-color:var(--gen);color:var(--gen)}.pill.ok{border-color:var(--good);color:var(--good)}.pill.failed{border-color:var(--crit);color:var(--crit)}.pill.tool{border-color:var(--tool);color:var(--tool)}.pill.retrying{border-color:var(--crit);color:var(--crit)}
.act{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
.task{color:var(--muted);font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:4px}
.stats{color:var(--muted);font-size:11px;margin-top:6px}
section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
section h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);margin:0 0 8px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.legend{display:flex;gap:12px;text-transform:none;letter-spacing:0;font-weight:400}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.range button{font:inherit;font-size:11px;background:none;border:1px solid var(--line);color:var(--text2);border-radius:6px;padding:1px 7px;cursor:pointer}.range button.on{border-color:var(--text2);color:var(--text)}
#tl{width:100%;display:block}#tl text{fill:var(--text2);font-size:11px}#tl .grid{stroke:var(--line)}
.split{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:16px}@media (max-width:900px){.split{grid-template-columns:1fr}}
.tree{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;max-height:520px;overflow:auto}
.tree div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0}.tree .k{color:var(--muted)}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
.tx{max-height:520px;overflow:auto;display:flex;flex-direction:column;gap:8px}
.msg{border-left:3px solid var(--line);padding:2px 0 2px 10px}.msg .who{font-size:11px;color:var(--muted);margin-bottom:2px}
.msg.user{border-color:var(--text2)}.msg.assistant{border-color:var(--gen)}.msg.toolResult{border-color:var(--tool)}.msg.err{border-color:var(--crit)}
.msg pre{margin:0;white-space:pre-wrap;word-break:break-word;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:6px 8px;border-radius:6px;max-height:220px;overflow:auto}
.msg .body{white-space:pre-wrap;word-break:break-word}.call{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--tool)}
details summary{cursor:pointer;color:var(--muted);font-size:11px}
#tip{position:fixed;pointer-events:none;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.15);display:none;max-width:420px;z-index:5}
.err-banner{color:var(--crit)}
.livebox{border-left:3px dashed var(--gen);padding:2px 0 2px 10px}.livebox .who{font-size:11px;color:var(--gen);margin-bottom:2px}
.livebox .think{white-space:pre-wrap;word-break:break-word;color:var(--text2);font-size:12px;max-height:340px;overflow:auto;background:var(--code);border-radius:6px;padding:6px 8px}
.cursor{display:inline-block;width:7px;height:13px;background:var(--gen);vertical-align:-2px;animation:blink 1s steps(2) infinite}@keyframes blink{to{opacity:0}}
</style></head><body>
<header><h1>Pool</h1><span class="sub" id="model"></span><span class="meter" id="meter" title="model server: active connections of 5 slots"></span><span class="sub" id="tps"></span><span class="sub err-banner" id="err"></span></header>
<main>
<div class="lanes" id="lanes"></div>
<section><h2><span>Timeline · durable tasks per agent</span>
<span class="legend"><span><i style="background:var(--gen)"></i>model turn</span><span><i style="background:var(--tool)"></i>tool call</span><span><i style="background:var(--rep)"></i>reporter (deliver → wait → report)</span></span>
<span class="range" id="range"></span></h2><svg id="tl" height="200"></svg></section>
<div class="split">
<section><h2>Task tree · what owns what</h2><div class="tree" id="tree"></div></section>
<section><h2><span id="txTitle">Transcript</span><span class="pill thinking" id="liveTag" style="display:none">● live</span><span class="sub" id="txMeta" style="text-transform:none;letter-spacing:0"></span></h2><div class="tx" id="tx"></div></section>
</div></main><div id="tip"></div>
<script>
const $=id=>document.getElementById(id);
let LANES=[],NAME={},S=null,sel=null,windowMin=10,stick=true;
try{windowMin=+localStorage.getItem("win")||10}catch{}
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const dur=ms=>ms<1000?ms+"ms":ms<60000?(ms/1000).toFixed(1)+"s":Math.floor(ms/60000)+"m"+String(Math.floor(ms/1000)%60).padStart(2,"0")+"s";
const k=n=>n==null?"–":n>=1000?(n/1000).toFixed(1)+"k":n;
const color=t=>t.kind==="pi.generation"?"var(--gen)":t.kind==="pi.tool"?"var(--tool)":"var(--rep)";
function laneConvs(l){if(!S)return[];return S.conversations.filter(c=>c.lane===l)}
function lane(l){return S.lanes.find(x=>x.id===l)}
function current(l){const x=lane(l);return x&&S.conversations.find(c=>c.id===x.conv)}
function renderHeader(){const h=S.server||{};$("model").textContent=h.model?h.model:"";
$("err").textContent=h.error?"model server unreachable: "+h.error:"";
const n=h.live?.connections??0,max=h.max_batch_size??5;$("meter").innerHTML=Array.from({length:max},(_,i)=>'<span class="seat'+(i<n?' on':'')+'"></span>').join("")+'<span class="sub">&nbsp;'+n+'/'+max+' slots</span>';
$("tps").textContent=h.live?Math.round(h.live.decode_tokens_per_second)+" tok/s decode":""}
function renderLanes(){$("lanes").innerHTML=LANES.map(l=>{const c=current(l);const x=lane(l);const st=c?.state!=="idle"?c?.state:(x.status||"idle");const task=x.detail||x.task||"";
const all=laneConvs(l);const tot=all.reduce((a,c)=>a+(c.usage?.total||0),0);
return '<div class="card'+(sel===l?' sel':'')+'" data-l="'+l+'"><h3><span>'+NAME[l]+'</span><span class="pill '+st+'">'+st+(c?.since&&st!=="idle"?" · "+dur(S.now-c.since):"")+'</span></h3>'
+'<div class="act">'+esc(c?.activity||"—")+'</div><div class="task">'+esc(task.replace(/\\s+/g," "))+'</div>'
+'<div class="stats">'+(c?c.entryCount+" msgs · ":"")+k(tot)+" tokens"+(all.length>1?" · "+all.length+" runs":"")+'</div></div>'}).join("");
document.querySelectorAll(".card").forEach(e=>e.onclick=()=>{sel=e.dataset.l;try{localStorage.setItem("sel",sel)}catch{};stick=true;render()})}
function renderRange(){$("range").innerHTML=[2,10,30,120].map(m=>'<button class="'+(m===windowMin?"on":"")+'" data-m="'+m+'">'+(m<60?m+"m":m/60+"h")+'</button>').join("");
document.querySelectorAll("#range button").forEach(b=>b.onclick=()=>{windowMin=+b.dataset.m;try{localStorage.setItem("win",windowMin)}catch{};render()})}
function renderTimeline(){const svg=$("tl"),W=svg.clientWidth||1000,L=96,R=8,rowH=34,top=18,H=top+LANES.length*rowH+4;svg.setAttribute("height",H);
const t1=S.now,t0=t1-windowMin*60000,x=t=>L+(Math.max(t,t0)-t0)/(t1-t0)*(W-L-R);let g="";
for(let i=0;i<=4;i++){const t=t0+(t1-t0)*i/4,xx=x(t);g+='<line class="grid" x1="'+xx+'" x2="'+xx+'" y1="'+top+'" y2="'+(H-4)+'"/><text x="'+xx+'" y="12" text-anchor="'+(i===0?"start":i===4?"end":"middle")+'">'+(i===4?"now":"-"+dur(t1-t))+'</text>'}
const laneOf=new Map();S.conversations.forEach(c=>{if(c.lane)laneOf.set(c.id,c.lane)});
const marks=[];S.tasks.forEach(t=>{if(!t.start)return;const end=t.end||t1;if(end<t0)return;
let lane=t.kind==="app.pool-reporter"?(t.label.match(/→ (w\\d)/)||[])[1]:laneOf.get(t.conv);if(!lane||!["pi.generation","pi.tool","app.pool-reporter"].includes(t.kind))return;
const row=LANES.indexOf(lane),sub=t.kind==="app.pool-reporter"?2:t.kind==="pi.tool"?1:0;const y=top+row*rowH+4+sub*9,h=t.kind==="app.pool-reporter"?4:8;
const x0=x(t.start),x1=Math.max(x(end),x0+3);marks.push('<rect data-i="'+t.id+'" x="'+x0+'" y="'+y+'" width="'+(x1-x0)+'" height="'+h+'" rx="2" fill="'+color(t)+'"'+(t.end?'':' opacity=".85"')+'/>')});
LANES.forEach((l,i)=>{const y=top+i*rowH;g+='<text x="0" y="'+(y+16)+'" style="font-weight:'+(l===sel?600:400)+'">'+NAME[l]+'</text>'+(i?'<line class="grid" x1="'+L+'" x2="'+(W-R)+'" y1="'+(y)+'" y2="'+(y)+'" stroke-dasharray="2 3"/>':"")});
svg.innerHTML=g+marks.join("");const byId=new Map(S.tasks.map(t=>[String(t.id),t]));
svg.querySelectorAll("rect[data-i]").forEach(r=>{r.onmousemove=e=>{const t=byId.get(r.dataset.i);const tip=$("tip");tip.style.display="block";tip.style.left=Math.min(e.clientX+12,innerWidth-430)+"px";tip.style.top=(e.clientY+12)+"px";
tip.innerHTML='<b>'+esc(t.label)+'</b><br><span class="sub">task #'+t.id+' · '+t.kind+' · '+(t.status==="terminal"?(t.outcome||"done"):t.status)+' · '+dur((t.end||S.now)-t.start)+(t.background?" · background":"")+'</span>'};r.onmouseleave=()=>$("tip").style.display="none"})}
function renderTree(){const live=S.tasks.filter(t=>t.status!=="terminal");const kids=new Map();live.forEach(t=>{const key=t.owner?"t"+t.owner:"c"+t.conv;(kids.get(key)||kids.set(key,[]).get(key)).push(t)});
const convName=c=>c.lane&&NAME[c.lane]?NAME[c.lane]:"conversation";const out=[];
const conv=(c,d)=>{out.push('<div style="padding-left:'+d*14+'px"><b>'+convName(c)+'</b> <span class="k">conversation #'+c.id+(c.ownerTask?" · owned by task #"+c.ownerTask:"")+' · '+c.state+'</span></div>');(kids.get("c"+c.id)||[]).forEach(t=>task(t,d+1))};
const task=(t,d)=>{out.push('<div style="padding-left:'+d*14+'px"><span class="dot" style="background:'+color(t)+'"></span>'+esc(t.label)+' <span class="k">#'+t.id+' '+t.status+(t.phase?"/"+t.phase:"")+(t.background?" · bg":"")+'</span></div>');
(kids.get("t"+t.id)||[]).forEach(x=>task(x,d+1));S.conversations.filter(c=>c.ownerTask===t.id).forEach(c=>conv(c,d+1))};
const roots=S.conversations.filter(c=>c.lane&&!S.conversations.some(p=>S.tasks.some(t=>t.id===c.ownerTask&&t.conv===p.id&&p.id!==c.id)));
roots.forEach(c=>conv(c,0));
$("tree").innerHTML=out.join("")||'<div class="k">no tasks</div>'}
function renderTranscript(){const c=current(sel);$("txTitle").textContent="Transcript · "+NAME[sel];if(!c){$("tx").innerHTML='<div class="sub">No conversation yet.</div>';$("txMeta").textContent="";return}
$("txMeta").textContent="conversation #"+c.id+" · "+c.entryCount+" messages"+(c.usage?" · in "+k(c.usage.input)+" / out "+k(c.usage.output)+" / cached "+k(c.usage.cacheRead):"");
const box=$("tx"),atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<40;
box.innerHTML=c.entries.map(e=>{if(e.role==="user")return '<div class="msg user"><div class="who">'+(/^\\[worker /.test(e.text)?"worker report":c.lane==="orch"?"you":"step input")+'</div><div class="body">'+esc(e.text)+'</div></div>';
if(e.role==="assistant")return '<div class="msg assistant'+(e.error?" err":"")+'"><div class="who">'+NAME[c.role]+(e.tokens?" · "+k(e.tokens)+" tok":"")+'</div>'+(e.thinking?'<details><summary>thinking ('+e.thinking.length+' chars)</summary><div class="body sub">'+esc(e.thinking)+'</div></details>':"")
+(e.text?'<div class="body">'+esc(e.text)+'</div>':"")+e.calls.map(x=>'<div class="call">▸ '+esc(x.name)+' '+esc(x.args.slice(0,300))+'</div>').join("")+(e.error?'<div class="err-banner">'+esc(e.error)+'</div>':"")+'</div>';
return '<div class="msg toolResult'+(e.isError?" err":"")+'"><div class="who">'+esc(e.tool)+' result'+(e.isError?" · error":"")+'</div><pre>'+esc(e.text)+'</pre></div>'}).join("");
box.insertAdjacentHTML("beforeend",'<div id="live"></div>');renderLive();
if(atBottom||stick){box.scrollTop=box.scrollHeight;stick=false}}
let LIVE=null,liveConv=null;
function renderLive(){const el=$("live");if(!el)return;const L=LIVE;const on=L&&(L.generating||L.tools.length);$("liveTag").style.display=on?"":"none";if(!on){el.innerHTML="";return}
const who=NAME[sel]+(L.attempt>1?" · attempt "+L.attempt:"");let h='<div class="livebox"><div class="who">● '+who+' · streaming</div>';
if(L.thinking)h+='<div class="think" id="liveThink">'+esc(L.thinking.slice(-12000))+(L.text?"":'<span class="cursor"></span>')+'</div>';
if(L.text)h+='<div class="body">'+esc(L.text)+'<span class="cursor"></span></div>';
h+=L.calls.map(x=>'<div class="call">▸ '+esc(x.name)+' '+esc(x.args.slice(0,300))+'</div>').join("");
h+=L.tools.map(t=>'<div class="who" style="color:var(--tool)">'+esc(t.name||"tool")+' · '+esc(t.status)+'</div>'+(t.output?'<pre>'+esc(t.output)+'</pre>':"")).join("");
el.innerHTML=h+'</div>';const th=$("liveThink");if(th)th.scrollTop=th.scrollHeight}
async function liveTick(){try{const c=S&&current(sel);if(c){if(liveConv!==c.id){LIVE=null;liveConv=c.id}
const box=$("tx"),atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<60;const r=await fetch("/api/live?conv="+c.id);LIVE=await r.json();renderLive();if(atBottom)box.scrollTop=box.scrollHeight}}catch{}setTimeout(liveTick,350)}
liveTick();
function render(){if(!S)return;LANES=S.lanes.map(l=>l.id);NAME=Object.fromEntries(S.lanes.map(l=>[l.id,l.name]));
if(!sel||!LANES.includes(sel)){try{sel=localStorage.getItem("sel")}catch{};if(!LANES.includes(sel))sel=LANES[LANES.length-1]}
document.querySelector("h1").textContent=S.title;renderHeader();renderLanes();renderRange();renderTimeline();renderTree();renderTranscript()}
async function tick(){try{const r=await fetch("/api/state");const d=await r.json();if(d.error)throw new Error(d.error);S=d;render()}catch(e){$("err").textContent="viz: "+e.message}setTimeout(tick,1000)}
addEventListener("resize",()=>render());tick();
</script></body></html>`;
