// Story card factory runner: turns one set of mockups (factory/stories/<set>/mockups/*.png) into story cards
// for the build factory, through pinned stations like src/factory/run.ts.
//   reader (vision: screens.md) → splitter (cards/<slug>/story.md) ⇄ [tools/lint.mjs] → critic (vision) ⇄ splitter … → gate
//
//   npx tsx src/cards/run.ts --repo ~/cards --story <set>
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
const STORY = arg("story")!;
const BUDGET = Number(arg("budget", "25"));
const S = `factory/stories/${STORY}`;
const RUN_DIR = join(import.meta.dirname, "..", "..", "runs", STORY);
mkdirSync(RUN_DIR, { recursive: true });
const AUDIT = join(RUN_DIR, "audit.md");


// ─── Lanes ───────────────────────────────────────────────────────────────────

const LANES: Record<string, { allow: string[]; deny?: string[] }> = {
	reader: { allow: [`${S}/screens.md`] },
	splitter: { allow: [`${S}/cards/**`] },
	critic: { allow: [`${S}/reviews/**`] },
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
const run = withStaff(runOnce, { repo: REPO, story: STORY, lanes: LANES }); // + HR's roles (factory/staff.json)


// ─── Pipeline ────────────────────────────────────────────────────────────────

const ROUNDS = Number(arg("rounds", "3"));
const VERDICT = `${S}/reviews/critic.json`;
const mockups = readdirSync(join(REPO, S, "mockups")).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => join(REPO, S, "mockups", f));
if (!mockups.length) {
	console.error(`No mockups in ${S}/mockups/ (png, jpg or webp).`);
	process.exit(1);
}
const images = `Mockups (read each image):\n${mockups.map((p) => `- ${p}`).join("\n")}`;
const LINT = `node tools/lint.mjs ${STORY}`;
const cardFiles = () => (existsSync(join(REPO, S, "cards")) ? readdirSync(join(REPO, S, "cards")).map((s) => `${S}/cards/${s}/story.md`) : []);

writeFileSync(AUDIT, `# Card run: ${STORY}\n\nRepo ${REPO} at ${sh("git rev-parse --short HEAD").trim()}, ${new Date().toISOString()}, model ${MODEL_ID}, budget ${BUDGET} tool calls/step, ${mockups.length} mockups.\n`);
if (!shOk(`git rev-parse -q --verify refs/tags/start/${STORY}`).ok) sh(`git tag start/${STORY}`);

await run({
	key: "read", station: "reader", prompt: "reader",
	task: `Write ${S}/screens.md, the inventory of these mockups.${read(`${S}/notes.md`) ? " Notes from the founders are in your inputs." : ""}\n\n${images}`,
	inputs: [`${S}/notes.md`],
	outputs: [`${S}/screens.md`],
	budget: 30,
});

let feedback: string | undefined;
let approved = false;
let linted = { ok: false, out: "" };
for (let round = 0; round < ROUNDS; round++) {
	const split = await run(
		{
			key: `split${round ? `#${round}` : ""}`, station: "splitter", prompt: "splitter",
			task: `Write the story cards for set \`${STORY}\` as ${S}/cards/<slug>/story.md. Mockup lines name files from: ${mockups.map((p) => p.split("/").pop()).join(", ")}.`,
			inputs: [`${S}/screens.md`, `${S}/notes.md`, ...cardFiles()],
			outputs: [],
			check: LINT,
			budget: 40,
		},
		feedback,
	);
	linted = split.check!;
	if (!linted.ok) {
		feedback = `\`${LINT}\` failed. Fix every FAIL line:\n\`\`\`\n${tail(linted.out, 2500)}\n\`\`\``;
		continue;
	}
	await run({
		key: `critic${round ? `#${round}` : ""}`, station: "critic", prompt: "critic",
		task: `Check the cards against the mockups. Write the verdict to ${VERDICT}.\n\n${images}\n\nLint:\n\`\`\`\n${tail(linted.out, 1200)}\n\`\`\``,
		inputs: [`${S}/screens.md`, ...cardFiles()],
		outputs: [VERDICT],
	});
	const verdict = readJson(VERDICT);
	if (verdict?.verdict === "approve") {
		approved = true;
		break;
	}
	feedback = `The critic requested changes: ${verdict?.issue ?? "no valid verdict; recheck the cards against the mockups"}`;
}

linted = shOk(LINT);
log(`\n## Gate\n- lint: ${linted.ok ? "pass" : "FAIL"}\n- critic: ${approved ? "approve" : "not approved"}\n- gate: ${linted.ok && approved ? "pass" : "FAIL"}\n\n\`\`\`\n${tail(linted.out, 1500)}\n\`\`\``);
await harness.close(context);
process.exit(0);
