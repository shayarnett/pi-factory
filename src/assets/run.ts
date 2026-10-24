// Asset factory runner: builds one 3D asset story (a .glb) through pinned stations, like src/factory/run.ts.
//   art-director (brief) → modeler (Blender build.py) ⇄ [tools/check.sh: build, glTF validator, measurements vs brief]
//                        → renders → art-critique (vision) ⇄ modeler … → gate
// The checks and renders are fixed tools in the target repo, so a station can't grade its own work.
//
//   npx tsx src/assets/run.ts --repo ~/props --story <slug>
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { localModels, MODEL_ID, PROVIDER } from "../local-model.ts";

const context = BACKGROUND_CONTEXT;
const arg = (name: string, fallback?: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1]! : fallback;
};
const REPO = resolve(arg("repo")!.replace(/^~/, process.env.HOME!));
const STORY = arg("story")!;
const BUDGET = Number(arg("budget", "25"));
const S = `factory/stories/${STORY}`;
const RUN_DIR = join(import.meta.dirname, "..", "..", "runs", STORY);
mkdirSync(RUN_DIR, { recursive: true });
const AUDIT = join(RUN_DIR, "audit.md");


// ─── Lanes ───────────────────────────────────────────────────────────────────

const A = `assets/${STORY}`;
const LANES: Record<string, { allow: string[]; deny?: string[] }> = {
	"art-director": { allow: [`${S}/brief.md`, `${S}/brief.json`] },
	modeler: { allow: [`${A}/**`] },
	"art-critique": { allow: [`${S}/reviews/**`] },
};
const globRe = (g: string) =>
	new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
const inLane = (station: string, path: string) => {
	const lane = LANES[station]!;
	return lane.allow.some((g) => globRe(g).test(path)) && !(lane.deny ?? []).some((g) => globRe(g).test(path));
};

// ─── Tools: lane-guarded writes, budgeted everything ─────────────────────────

const active = new Map<number, { station: string; calls: number; refused: string[]; budget: number; outputs: string[] }>();
const rel = (p: string) => (p.startsWith(REPO) ? p.slice(REPO.length + 1) : p.replace(/^\.\//, ""));
function guarded(tool: any, pathOf?: (args: any) => string) {
	return {
		...tool,
		execute: async (args: any, api: any, ctx: any) => {
			const step = active.get(api.conversationId);
			if (step) {
				step.calls++;
				const path = pathOf ? rel(pathOf(args)) : null;
				// Over budget, only writes to the step's own output files still go through.
				if (step.calls > step.budget && !(path && step.outputs.includes(path)))
					throw new Error(`Tool budget exhausted. Write your output file(s) (${step.outputs.join(", ") || "none"}) now if you haven't, then stop and report.`);
				if (path) {
					if (!inLane(step.station, path)) {
						step.refused.push(path);
						throw new Error(`Refused: ${path} is outside your lane (${LANES[step.station]!.allow.join(", ")}). Do only your own step.`);
					}
				}
			}
			return tool.execute(args, api, ctx);
		},
	};
}
const mise = `eval "$(mise env -C ${REPO} -s bash)"`;
const Tools = defineExtension({
	name: "factory-tools",
	tools: [
		guarded(createReadTool()),
		guarded(createWriteTool(), (a) => a.path),
		guarded(createEditTool(), (a) => a.path),
		guarded(createBashTool({ commandPrefix: mise })),
	],
	sections: [section("cwd", (input) => input.env?.cwd)],
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const registry = createRegistry();
registry.install(Tools);
const harness = await Harness.open(
	await openNodeSqliteStorage(join(RUN_DIR, "run.sqlite")),
	{ models: localModels(), registry, env: ({ cwd = REPO }) => new NodeExecutionEnv({ cwd }) },
	context,
);

const sh = (cmd: string) => execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const shOk = (cmd: string) => {
	try {
		return { ok: true, out: sh(`${mise}; ${cmd} 2>&1`) };
	} catch (e: any) {
		return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
	}
};
const read = (p: string) => (existsSync(join(REPO, p)) && statSync(join(REPO, p)).isFile() ? readFileSync(join(REPO, p), "utf8") : null);
const readJson = (p: string) => {
	try {
		return JSON.parse(read(p) ?? "null");
	} catch {
		return null;
	}
};
const stationPrompt = (name: string) =>
	`${read("factory/stations/_rules.md")}\n\n${read(`factory/stations/${name}.md`)}`;
const textOf = (m?: AssistantMessage) => (m?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
const tail = (s: string, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s);
const log = (s: string) => {
	appendFileSync(AUDIT, `${s}\n`);
	console.log(s);
};

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step = {
	key: string;
	station: string; // lane + who commits
	prompt: string; // station prompt file
	task: string;
	inputs: string[]; // files inlined into the message
	outputs: string[]; // files that must exist afterwards
	check?: string; // runner-run command
	budget?: number; // tool calls (default --budget)
};
type Result = { ok: boolean; report: string; changed: string[]; reverted: string[]; refused: string[]; calls: number; check?: { ok: boolean; out: string } };

// Step index for the visualizer (npm run viz -- --run runs/<story>).
const STEPS_FILE = join(RUN_DIR, "steps.json");
const steps: { key: string; station: string; conv: number; status: string; start: number; end?: number; calls?: number }[] = [];
const saveSteps = () => writeFileSync(STEPS_FILE, JSON.stringify({ story: STORY, steps }, null, 1));

let stepNo = 0;
async function run(step: Step, feedback?: string): Promise<Result> {
	stepNo++;
	const started = Date.now();
	const allow = LANES[step.station]!.allow.join(", ") + (LANES[step.station]!.deny ? ` (except ${LANES[step.station]!.deny!.join(", ")})` : "");
	const inputs = ["factory/stack.md", ...step.inputs.filter((p) => p !== "factory/stack.md")]
		.map((p) => [p, read(p)] as const)
		.map(([p, c]) => `### ${p}\n${c === null ? "(does not exist yet)" : `\`\`\`\n${c.slice(0, 20000)}\n\`\`\``}`)
		.join("\n\n");
	const message = [
		`# Step ${step.key} (station: ${step.prompt})`,
		`Story: ${STORY}. Repo root: ${REPO}.`,
		`You may write ONLY: ${allow}`,
		`Your output: ${step.outputs.join(", ") || "(see task)"}`,
		step.check ? `Your check (the runner will also run it): \`${step.check}\`` : "",
		"",
		"## Task",
		step.task,
		feedback ? `\n## Fix requested by the reviewer\n${feedback}\nFix exactly this, nothing else.` : "",
		"",
		"## Inputs",
		inputs || "(none)",
	].join("\n");

	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: { provider: PROVIDER, modelId: MODEL_ID }, thinkingLevel: "low", cwd: REPO, instructions: stationPrompt(step.prompt) },
		},
		context,
	);
	const state = { station: step.station, calls: 0, refused: [] as string[], budget: step.budget ?? BUDGET, outputs: step.outputs };
	active.set(conversation.id, state);
	const entry = { key: step.key + (feedback ? " (fix)" : ""), station: step.station, conv: conversation.id, status: "running", start: started };
	steps.push(entry);
	saveSteps();
	console.log(`\n▶ ${step.key} [${step.station}] conversation #${conversation.id}`);
	const submission = await conversation.submit({ type: "input", content: message, requestId: `${step.key}:${feedback ?? ""}` }, context);
	const settled = await submission.wait(context);
	active.delete(conversation.id);
	let report = "";
	if (settled.status === "done" && settled.type === "input") {
		report = textOf((await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context))?.model?.[0] as AssistantMessage);
	} else report = `UNANSWERED: ${settled.status === "unanswered" ? settled.reason : "?"}`;

	// Enforce the lane on disk (bash can write anywhere): revert anything outside it.
	const changed = sh("git status --porcelain --untracked-files=all")
		.split("\n")
		.filter(Boolean)
		.map((l) => l.slice(3).replace(/^.* -> /, ""));
	const reverted = changed.filter((p) => !inLane(step.station, p));
	for (const p of reverted) {
		try {
			sh(`git cat-file -e HEAD:'${p}' 2>/dev/null && git checkout HEAD -- '${p}' || (git rm -q --cached -- '${p}' 2>/dev/null; rm -rf -- '${p}')`);
		} catch {
			rmSync(join(REPO, p), { recursive: true, force: true });
		}
	}
	const kept = changed.filter((p) => !reverted.includes(p));
	const check = step.check ? shOk(step.check) : undefined;
	const missing = step.outputs.filter((p) => read(p) === null);
	const ok = missing.length === 0 && (check?.ok ?? true) && !report.startsWith("UNANSWERED");
	Object.assign(entry, { status: ok ? "ok" : "failed", end: Date.now(), calls: state.calls });
	saveSteps();
	if (kept.length) sh(`git add -A && git -c user.name='${step.station}' -c user.email='${step.station}@factory.local' commit -qm '[${step.station}] ${step.key}${feedback ? " (fix)" : ""}'`);

	log(
		[
			`\n## ${stepNo}. ${step.key} — ${step.station}${feedback ? " (fix round)" : ""} — ${ok ? "OK" : "FAILED"}`,
			`- conversation #${conversation.id}, ${state.calls} tool calls, ${Math.round((Date.now() - started) / 1000)}s`,
			`- wrote: ${kept.join(", ") || "nothing"}`,
			reverted.length ? `- **reverted (outside lane): ${reverted.join(", ")}**` : "",
			state.refused.length ? `- refused writes: ${[...new Set(state.refused)].join(", ")}` : "",
			missing.length ? `- **missing outputs: ${missing.join(", ")}**` : "",
			check ? `- check \`${step.check}\`: ${check.ok ? "pass" : "FAIL"}\n\n\`\`\`\n${tail(check.out, 800)}\n\`\`\`` : "",
			`- report:\n\n> ${report.trim().replace(/\n/g, "\n> ")}`,
		]
			.filter(Boolean)
			.join("\n"),
	);
	return { ok, report, changed: kept, reverted, refused: state.refused, calls: state.calls, check };
}


// ─── Pipeline ────────────────────────────────────────────────────────────────

const ROUNDS = Number(arg("rounds", "5"));
const RENDERS = join(RUN_DIR, "renders");
const VERDICT = `${S}/reviews/art-critique.json`;
const REFERENCE = `${S}/reference.png`;
const VIEWS = ["three-quarter", "front", "side", "back-three-quarter", "top", "scale"];
const render = (round: number) => {
	const dir = join(RENDERS, `r${round}`);
	shOk(`blender -b --factory-startup --python tools/render.py -- ${A}/${STORY}.glb "${dir}"`);
	return VIEWS.map((v) => join(dir, `${v}.png`)).filter((p) => existsSync(p));
};

writeFileSync(AUDIT, `# Asset run: ${STORY}\n\nRepo ${REPO} at ${sh("git rev-parse --short HEAD").trim()}, ${new Date().toISOString()}, model ${MODEL_ID}, budget ${BUDGET} tool calls/step.\n`);
if (!shOk(`git rev-parse -q --verify refs/tags/start/${STORY}`).ok) sh(`git tag start/${STORY}`);
const hasRef = existsSync(join(REPO, REFERENCE));

await run({
	key: "brief", station: "art-director", prompt: "art-director",
	task: `Write the brief for this asset: ${S}/brief.md and ${S}/brief.json.${hasRef ? `\n\nReference image (read it): ${join(REPO, REFERENCE)}` : ""}`,
	inputs: [`${S}/story.md`, "factory/style.md"],
	outputs: [`${S}/brief.md`, `${S}/brief.json`],
});

let feedback: string | undefined;
let approved = false;
let checked = { ok: false, out: "" };
for (let round = 0; round < ROUNDS; round++) {
	const built = await run(
		{
			key: `model${round ? `#${round}` : ""}`, station: "modeler", prompt: "modeler",
			task: `Write ${A}/build.py, the Blender script that builds this asset to its brief. The runner then runs \`tools/check.sh ${STORY}\`.`,
			inputs: [`${S}/brief.md`, `${S}/brief.json`, "factory/style.md", "tools/kit.py", `${A}/build.py`],
			outputs: [`${A}/build.py`],
			check: `tools/check.sh ${STORY}`,
		},
		feedback,
	);
	checked = built.check!;
	if (!checked.ok) {
		feedback = `\`tools/check.sh ${STORY}\` failed. Fix every FAIL line:\n\`\`\`\n${tail(checked.out, 2500)}\n\`\`\``;
		continue;
	}
	const shots = render(round);
	log(`- renders: ${shots.length} views in ${join(RENDERS, `r${round}`)}`);
	await run({
		key: `art-critique${round ? `#${round}` : ""}`, station: "art-critique", prompt: "art-critique",
		task: `Critique the asset against its brief. Write the verdict to ${VERDICT}.\n\nRenders (read each):\n${shots.map((p) => `- ${p}`).join("\n")}${hasRef ? `\n\nReference image (read it): ${join(REPO, REFERENCE)}` : ""}\n\nMeasured by tools/check.sh:\n\`\`\`\n${tail(checked.out, 1200)}\n\`\`\``,
		inputs: [`${S}/brief.md`, `${S}/brief.json`, "factory/style.md"],
		outputs: [VERDICT],
	});
	const verdict = readJson(VERDICT);
	if (verdict?.verdict === "approve") {
		approved = true;
		break;
	}
	feedback = `The art critic requested changes: ${verdict?.issue ?? "no valid verdict; recheck the asset against the brief"}`;
}

checked = shOk(`tools/check.sh ${STORY}`);
log(`\n## Gate\n- check: ${checked.ok ? "pass" : "FAIL"}\n- art critique: ${approved ? "approve" : "not approved"}\n- gate: ${checked.ok && approved ? "pass" : "FAIL"}\n\n\`\`\`\n${tail(checked.out, 1500)}\n\`\`\``);
await harness.close(context);
process.exit(0);
