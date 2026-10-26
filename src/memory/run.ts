// Memory factory: context in, routed into a tree of stores; questions routed down the same tree and answered by
// the stores' keepers, then combined on the way up. Every station is one model call that sees only its own level
// and replies in JSON; this file does all reading and writing.
//
//   store/            router node (one subdirectory per child)
//     <child>/about.md         its charter: what belongs there (written once by the router that made it)
//     <child>/holds.md         what it holds now (rewritten by its keeper after each store; used for recall)
//     <child>/memories.jsonl   a keeper's store: {"id", "text", "source"} per line
//
//   npx tsx src/memory/run.ts --repo ~/memory store posts/*.md
//   npx tsx src/memory/run.ts --repo ~/memory recall "question"
//   npx tsx src/memory/run.ts --repo ~/memory quiz           # quiz.json → runs/memory/quiz-<n>.md
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv.splice(i, 2)[1]! : fallback;
};
const REPO = resolve(opt("repo", "~/memory").replace(/^~/, process.env.HOME!));
const FANOUT = Number(opt("fanout", "2")); // children a recall router may follow
const MAX_CHILDREN = Number(opt("max-children", "8"));
const EFFORT = opt("effort", "low");
const SPLIT_AT = Number(opt("split-at", "50")); // a keeper this big becomes a router over 2–4 new keepers
const [cmd, ...rest] = argv;
const ROOT = join(REPO, "store");
const RUN_DIR = join(import.meta.dirname, "..", "..", "runs", "memory");
mkdirSync(RUN_DIR, { recursive: true });
mkdirSync(ROOT, { recursive: true });
const LOG = join(RUN_DIR, "calls.jsonl");

// ─── Model ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:18888/v1";
const station = (name: string) => readFileSync(join(REPO, "stations", `${name}.md`), "utf8");
let calls = 0;
async function ask(name: string, message: string): Promise<any> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const t0 = Date.now();
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			signal: AbortSignal.timeout(600_000),
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "Qwen3.8-Flash-Next",
				reasoning_effort: EFFORT,
				max_tokens: 4000,
				messages: [
					{ role: "system", content: station(name) },
					{ role: "user", content: message },
				],
			}),
		}).catch((e) => e as Error);
		if (res instanceof Error) {
			console.log(`  ! ${name}: ${res.message}; retrying`);
			continue;
		}
		const text: string = ((await res.json().catch(() => ({}))) as any).choices?.[0]?.message?.content ?? "";
		calls++;
		appendFileSync(LOG, `${JSON.stringify({ station: name, ms: Date.now() - t0, message, reply: text })}\n`);
		const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
		try {
			return JSON.parse(json);
		} catch {}
	}
	throw new Error(`${name}: no valid JSON after 3 tries`);
}

// ─── Tree ────────────────────────────────────────────────────────────────────

type Memory = { id: string; text: string; source: string };
const rel = (dir: string) => dir.slice(ROOT.length + 1);
const children = (dir: string) =>
	readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => ({ name: e.name, dir: join(dir, e.name), about: readFileSync(join(dir, e.name, "about.md"), "utf8").trim(), holds: readOr(join(dir, e.name, "holds.md")) }));
const readOr = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
const isKeeper = (dir: string) => existsSync(join(dir, "memories.jsonl"));
const memories = (dir: string): Memory[] =>
	readFileSync(join(dir, "memories.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
const saveMemories = (dir: string, ms: Memory[]) => writeFileSync(join(dir, "memories.jsonl"), ms.map((m) => JSON.stringify(m)).join("\n") + (ms.length ? "\n" : ""));
const listing = (cs: { name: string; about: string; holds?: string }[], withHolds = false) =>
	cs.map((c) => `- ${c.name}: ${c.about}${withHolds && c.holds ? `\n  Holds: ${c.holds}` : ""}`).join("\n") || "(no children yet)";
// Stations see a store's memories as [1], [2], …; code maps the numbers back to ids.
const shown = (ms: Memory[]) => ms.map((m, i) => `- [${i + 1}] ${m.text}`).join("\n");
const byNum = (ms: Memory[], n: unknown) => ms[Number(String(n).replace(/\D/g, "")) - 1];
const numbered = (texts: string[]) => texts.map((t, i) => `${i + 1}. ${t}`).join("\n");

// ─── Store ───────────────────────────────────────────────────────────────────

// Routes a batch of memories one level down, then recurses per child. Returns keeper dir → memories.
async function route(dir: string, texts: string[]): Promise<Map<string, string[]>> {
	if (isKeeper(dir)) return new Map([[dir, texts]]);
	const cs = children(dir);
	const canAdd = cs.length < MAX_CHILDREN;
	const r = await ask("router-store", `## Memories\n${numbered(texts)}\n\n## Your children\n${listing(cs)}\n\nYou ${canAdd ? "may" : "may NOT"} make new children.`);
	const groups = new Map<string, string[]>();
	texts.forEach((text, i) => {
		const route = (r.routes ?? []).find((x: any) => Number(x.n) === i + 1) ?? {};
		let name = String(route.child ?? route.new?.name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
		if (!existsSync(join(dir, name, "about.md")) || !name) {
			if (!name || children(dir).length >= MAX_CHILDREN) name = cs[0]?.name ?? "general";
			if (!existsSync(join(dir, name, "about.md"))) {
				mkdirSync(join(dir, name), { recursive: true });
				writeFileSync(join(dir, name, "about.md"), `${route.new?.about ?? name}\n`);
				writeFileSync(join(dir, name, "memories.jsonl"), "");
				console.log(`  + store ${rel(join(dir, name))}: ${route.new?.about ?? name}`);
			}
		}
		groups.set(name, [...(groups.get(name) ?? []), text]);
	});
	const out = new Map<string, string[]>();
	for (const sub of await Promise.all([...groups].map(([name, ts]) => route(join(dir, name), ts))))
		for (const [k, v] of sub) out.set(k, [...(out.get(k) ?? []), ...v]);
	return out;
}

async function keep(dir: string, texts: string[], source: string) {
	const ms = memories(dir);
	const r = ms.length
		? await ask("keeper-store", `## New memories\n${numbered(texts)}\n\n## Your store\n${shown(ms)}`).catch((e) => {
				console.log(`  ! ${rel(dir)}: ${e.message}; adding all ${texts.length} as new`);
				return { actions: [] };
			})
		: { actions: [] };
	const tally: Record<string, number> = {};
	let n = ms.reduce((max, m) => Math.max(max, Number(m.id.split("/").pop())), 0);
	texts.forEach((text, i) => {
		const act = (r.actions ?? []).find((x: any) => Number(x.n) === i + 1) ?? { action: "add" };
		const target = byNum(ms, act.id);
		let action = "add";
		if (act.action === "merge" && target && act.text) {
			target.text = act.text;
			target.source = [...new Set([...target.source.split(", "), source])].join(", ");
			action = "merge";
		} else if (act.action === "skip" && target) action = "skip";
		else ms.push({ id: `${rel(dir)}/${++n}`, text, source });
		tally[action] = (tally[action] ?? 0) + 1;
	});
	saveMemories(dir, ms);
	return tally;
}

// Organizer: turns an oversized keeper into a router with 2–4 child keepers. Memory ids move with the memories.
async function split(dir: string) {
	const ms = memories(dir);
	const parent = join(dir, "..");
	const siblings = children(parent).filter((c) => c.dir !== dir);
	let message = `## Your charter\n${readOr(join(dir, "about.md"))}\n\n## Sibling stores (don't overlap these)\n${listing(siblings)}\n\n## Your store (${ms.length} memories)\n${shown(ms)}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await ask("organizer", message);
		const kids: { name: string; about: string }[] = (r.children ?? [])
			.map((c: any) => ({ name: String(c.name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, ""), about: String(c.about ?? "") }))
			.filter((c: any) => c.name);
		const groups = new Map<string, Memory[]>(kids.map((c) => [c.name, []]));
		const problems: string[] = [];
		ms.forEach((m, i) => {
			const to = r.assign?.[String(i + 1)] ?? r.assign?.[`[${i + 1}]`];
			if (groups.has(to)) groups.get(to)!.push(m);
			else problems.push(`memory ${i + 1} is assigned to ${JSON.stringify(to ?? null)}, which is not one of your children`);
		});
		if (kids.length < 2) problems.unshift(`you gave ${kids.length} children; give 2–4`);
		for (const [name, g] of groups) if (!g.length) problems.push(`child ${name} has no memories; drop it or assign memories to it`);
		if (problems.length) {
			console.log(`  ! organizer for ${rel(dir)}: ${problems.length} problems${attempt ? "; not split" : "; retrying"}`);
			message += `\n\n## Your last reply had problems; fix all of them\n${problems.slice(0, 20).map((p) => `- ${p}`).join("\n")}`;
			continue;
		}
		for (const c of kids) {
			const child = join(dir, c.name);
			mkdirSync(child);
			writeFileSync(join(child, "about.md"), `${c.about}\n`);
			saveMemories(child, groups.get(c.name)!.map((m, i) => ({ ...m, id: `${rel(child)}/${i + 1}` })));
		}
		rmSync(join(dir, "memories.jsonl"));
		rmSync(join(dir, "holds.md"), { force: true });
		console.log(`  ⑂ split ${rel(dir)} (${ms.length}) → ${kids.map((c) => `${c.name} ${groups.get(c.name)!.length}`).join(", ")}`);
		await Promise.all(kids.map((c) => describe(join(dir, c.name))));
		return;
	}
	await describe(dir);
}

async function describe(dir: string) {
	const ms = memories(dir);
	const r = await ask("keeper-holds", `## Your charter\n${readOr(join(dir, "about.md"))}\n\n## Your store (${ms.length} memories)\n${ms.map((m) => `- ${m.text}`).join("\n")}`);
	if (r.holds) writeFileSync(join(dir, "holds.md"), `${r.holds}\n`);
}

async function store(files: string[]) {
	const t0 = Date.now();
	for (const file of files) {
		const source = basename(file);
		const { memories: parts } = await ask("splitter", `## Context (source: ${source})\n${readFileSync(resolve(REPO, file), "utf8")}`);
		const routed = await route(ROOT, parts as string[]);
		const tallies = await Promise.all([...routed].map(([dir, ts]) => keep(dir, ts, source)));
		await Promise.all([...routed.keys()].map((d) => (memories(d).length >= SPLIT_AT ? split(d) : describe(d))));
		const tally: Record<string, number> = {};
		for (const t of tallies) for (const [k, v] of Object.entries(t)) tally[k] = (tally[k] ?? 0) + v;
		console.log(`${source}: ${parts.length} memories → ${[...routed].map(([d, ts]) => `${rel(d)} ${ts.length}`).join(", ")} ${JSON.stringify(tally)}`);
	}
	console.log(`stored ${files.length} files in ${Math.round((Date.now() - t0) / 1000)}s, ${calls} calls`);
}

// ─── Recall ──────────────────────────────────────────────────────────────────

type Answer = { answer: string | null; ids: string[]; path: string[] };
const allIds = (dir: string): Set<string> =>
	isKeeper(dir) ? new Set(memories(dir).map((m) => m.id)) : new Set(children(dir).flatMap((c) => [...allIds(c.dir)]));

async function recall(dir: string, q: string): Promise<Answer> {
	if (isKeeper(dir)) {
		const ms = memories(dir);
		const r = await ask("keeper-recall", `## Question\n${q}\n\n## Your store\n${shown(ms)}`);
		const ids = (r.ids ?? []).map((n: unknown) => byNum(ms, n)?.id).filter(Boolean);
		return { answer: r.answer ?? null, ids, path: [rel(dir)] };
	}
	const cs = children(dir);
	const r = await ask("router-recall", `## Question\n${q}\n\n## Your children\n${listing(cs, true)}\n\nPick at most ${FANOUT}.`);
	const picked = cs.filter((c) => (r.children ?? []).includes(c.name)).slice(0, FANOUT);
	const answers = (await Promise.all(picked.map((c) => recall(c.dir, q)))).filter((a) => a.answer);
	const path = picked.map((c) => rel(c.dir));
	if (!answers.length) return { answer: null, ids: [], path };
	if (answers.length === 1) return { ...answers[0]!, path };
	const c = await ask("combiner", `## Question\n${q}\n\n## Answers from your children\n${answers.map((a) => `- ${a.answer} (ids: ${a.ids.join(", ")})`).join("\n")}`);
	const valid = new Set(answers.flatMap((a) => a.ids));
	return { answer: c.answer ?? null, ids: (c.ids ?? []).filter((id: string) => valid.has(id)), path };
}

// ─── Quiz ────────────────────────────────────────────────────────────────────

type Q = { q: string; all?: string[]; any?: string[]; none?: boolean };
const score = (item: Q, a: Answer) => {
	const text = (a.answer ?? "").toLowerCase();
	if (item.none) return !a.answer;
	return (item.all ?? []).every((k) => text.includes(k)) && (!item.any || item.any.some((k) => text.includes(k)));
};

async function quiz() {
	const items: Q[] = JSON.parse(readFileSync(join(REPO, "quiz.json"), "utf8"));
	const t0 = Date.now();
	const results: { item: Q; a: Answer; ok: boolean }[] = [];
	for (let i = 0; i < items.length; i += 4) {
		const batch = await Promise.all(items.slice(i, i + 4).map(async (item) => {
			const a = await recall(ROOT, item.q);
			return { item, a, ok: score(item, a) };
		}));
		results.push(...batch);
		for (const r of batch) console.log(`${r.ok ? "✓" : "✗"} ${r.item.q}\n    → ${r.a.answer ?? "(no answer)"}  [${r.a.path.join(", ")}]`);
	}
	const passed = results.filter((r) => r.ok).length;
	const n = readdirSync(RUN_DIR).filter((f) => f.startsWith("quiz-")).length + 1;
	const report = join(RUN_DIR, `quiz-${n}.md`);
	writeFileSync(
		report,
		`# Quiz ${n}: ${passed}/${results.length}\n\nStores: ${[...allIds(ROOT)].length} memories in ${storeList().join(", ")}\n\n` +
			results
				.map((r) => `## ${r.ok ? "✓" : "✗"} ${r.item.q}\n- expected: ${r.item.none ? "no answer" : [...(r.item.all ?? []), ...(r.item.any ? [`one of ${r.item.any.join("/")}`] : [])].join(", ")}\n- path: ${r.a.path.join(", ")}\n- ids: ${r.a.ids.join(", ")}\n\n> ${r.a.answer ?? "(no answer)"}`)
				.join("\n\n") +
			"\n",
	);
	console.log(`\n${passed}/${results.length} in ${Math.round((Date.now() - t0) / 1000)}s, ${calls} calls → ${report}`);
}
const storeList = (dir = ROOT): string[] =>
	isKeeper(dir) ? [`${rel(dir)} (${memories(dir).length})`] : children(dir).flatMap((c) => storeList(c.dir));

if (cmd === "store") await store(rest);
else if (cmd === "recall") console.log(JSON.stringify(await recall(ROOT, rest.join(" ")), null, 1));
else if (cmd === "quiz") await quiz();
else console.log("usage: run.ts --repo <dir> store <files…> | recall <question> | quiz");
