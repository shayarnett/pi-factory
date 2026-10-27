// Spec-driven code runner: builds one story in a repo whose acceptance suite drives the work (e.g. liquid-rs with
// Shopify's liquid-spec). implementer ⇄ [tools/check.sh <story>: build, lint, no regressions, target level]
//   → code-review ⇄ implementer … → gate. --plan: the planner writes the next stories (graph.sh CURATE hook).
//
//   npx tsx src/spec/run.ts --repo ~/liquid-rs --story 001-variables
//   npx tsx src/spec/run.ts --repo ~/liquid-rs --plan 3
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
import { withStaff } from "../factory/staff.ts";

const context = BACKGROUND_CONTEXT;
const arg = (name: string, fallback?: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1]! : fallback;
};
const REPO = resolve(arg("repo")!.replace(/^~/, process.env.HOME!));
const PLAN = arg("plan"); // number of new stories
const STORY = PLAN ? `plan-${Date.now()}` : arg("story")!;
const BUDGET = Number(arg("budget", "25"));
const S = `factory/stories/${STORY}`;
const RUN_DIR = join(import.meta.dirname, "..", "..", "runs", STORY);
mkdirSync(RUN_DIR, { recursive: true });
const AUDIT = join(RUN_DIR, "audit.md");


// ─── Lanes ───────────────────────────────────────────────────────────────────

const LANES: Record<string, { allow: string[]; deny?: string[] }> = {
	planner: { allow: ["factory/stories/*/story.md"] },
	implementer: { allow: ["crates/**", "ext/**", "lib/**", "specs/adapter.rb", "Cargo.toml", "Cargo.lock"] },
	"code-review": { allow: [`${S}/reviews/**`] },
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
async function runOnce(step: Step, feedback?: string): Promise<Result> {
	stepNo++;
	const started = Date.now();
	const allow = LANES[step.station]!.allow.join(", ") + (LANES[step.station]!.deny ? ` (except ${LANES[step.station]!.deny!.join(", ")})` : "");
	const inputs = ["factory/cards.md", ...step.inputs.filter((p) => p !== "factory/cards.md")]
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
const run = withStaff(runOnce, { repo: REPO, story: STORY, lanes: LANES }); // + AIR's roles (factory/staff.json)


// ─── Pipeline ────────────────────────────────────────────────────────────────

const STACK = "factory/stack.md";
writeFileSync(AUDIT, `# Spec run: ${STORY}\n\nRepo ${REPO} at ${sh("git rev-parse --short HEAD").trim()}, ${new Date().toISOString()}, model ${MODEL_ID}, budget ${BUDGET} tool calls/step.\n`);

if (PLAN) {
	// The planner gets the spec state handed to it (exploring it burned its whole budget): every suite's level, and
	// the lowest failures of the earliest suite not yet at 1000.
	const SUITES = ["basics", "liquid_ruby", "parser_errors", "partials", "liquid_ruby_lax", "shopify_theme_dawn", "shopify_production_recordings"];
	const spec = (suite: string, extra = "") => shOk(`eval "$(mise env -s bash)" && tools/liquid-spec run specs/adapter.rb -s ${suite} ${extra} 2>&1`).out;
	const levels = SUITES.map((s) => [s, spec(s).match(/Complexity level cleared: (\d+) of 1000.*/)?.[0] ?? "not run (adapter opts out)"] as const);
	const next = levels.find(([, l]) => !l.startsWith("Complexity level cleared: 1000"))?.[0] ?? "basics";
	const stories = sh("ls factory/stories 2>/dev/null").split("\n").filter(Boolean);
	await run({
		key: "plan", station: "planner", prompt: "planner",
		task: [
			`Write the next ${PLAN} stories for suite \`${next}\`. Everything you need is below; write the story files first, then stop.`,
			`Existing stories (released or in progress): ${stories.join(", ") || "(none)"}.`,
			"", "## Suite levels on main", ...levels.map(([s, l]) => `- ${s}: ${l}`),
			"", `## Lowest failures in ${next}`, "```", tail(spec(next, "--max-failures 25"), 14000), "```",
		].join("\n"),
		inputs: [STACK, ...stories.slice(-5).map((s) => `factory/stories/${s}/story.md`)],
		outputs: [],
		budget: 15,
	});
	log(`\n## Planned\n${sh("git diff --name-only HEAD~1 HEAD -- factory/stories 2>/dev/null")}`);
	await harness.close(context);
	process.exit(0);
}

if (!shOk(`git rev-parse -q --verify refs/tags/start/${STORY}`).ok) sh(`git tag start/${STORY}`);
const ROUNDS = Number(arg("rounds", "4"));
const VERDICT = `${S}/reviews/code-review.json`;
const CHECK = `tools/check.sh ${STORY}`;
let feedback: string | undefined;
let approved = false;
let checked = { ok: false, out: "" };
let outages = 0;
for (let round = 0; round < ROUNDS; round++) {
	const built = await run(
		{
			key: `implement${round ? `#${round}` : ""}`, station: "implementer", prompt: "implementer",
			task: `Build story \`${STORY}\` (in your inputs) until \`${CHECK}\` passes.`,
			inputs: [STACK, `${S}/story.md`],
			outputs: [],
			check: CHECK,
			budget: Number(arg("impl-budget", "80")),
		},
		feedback,
	);
	if (built.report.startsWith("UNANSWERED") && /model_error|NoRoom|network|timeout/i.test(built.report) && outages < 6) {
		// the model server is down or full: wait and redo this round instead of spending it
		outages++;
		log(`- model unavailable (${built.report.slice(0, 80)}); waiting 5 min, then retrying this round (${outages}/6)`);
		await new Promise((r) => setTimeout(r, 300_000));
		round--;
		continue;
	}
	checked = built.check!;
	if (!checked.ok) {
		feedback = `\`${CHECK}\` failed. Fix every FAIL line:\n\`\`\`\n${tail(checked.out, 3000)}\n\`\`\``;
		continue;
	}
	await run({
		key: `code-review${round ? `#${round}` : ""}`, station: "code-review", prompt: "code-review",
		task: `Review story \`${STORY}\`'s diff (\`git diff start/${STORY} HEAD -- crates ext lib specs\`). Write the verdict to ${VERDICT}.\n\nCheck output:\n\`\`\`\n${tail(checked.out, 1500)}\n\`\`\``,
		inputs: [STACK, `${S}/story.md`],
		outputs: [VERDICT],
	});
	const verdict = readJson(VERDICT);
	if (verdict?.verdict === "approve") {
		approved = true;
		break;
	}
	feedback = `The code reviewer requested changes: ${verdict?.issue ?? "no valid verdict; recheck the diff against factory/stack.md"}`;
}

checked = shOk(CHECK);
log(`\n## Gate\n- check: ${checked.ok ? "pass" : "FAIL"}\n- code review: ${approved ? "approve" : "not approved"}\n- gate: ${checked.ok && approved ? "pass" : "FAIL"}\n\n\`\`\`\n${tail(checked.out, 1500)}\n\`\`\``);
await harness.close(context);
process.exit(0);
