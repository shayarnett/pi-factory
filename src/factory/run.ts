// Factory runner: builds one story in a repo through a fixed pipeline of pinned stations.
// Each step is a fresh pi-durable conversation that sees only its inputs, can only write its lane, and has a
// tool budget. After each step the runner reverts writes outside the lane, runs the step's check, and commits
// as the station, so `git log` is the audit trail of who did what.
//
//   npx tsx src/factory/run.ts --repo ~/acme --story user-signs-up
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
import { withStaff } from "./staff.ts";

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
	planner: { allow: [`${S}/plan.json`] },
	designer: { allow: [`${S}/design.md`] },
	mockup: { allow: [`${S}/mockups/**`] },
	"design-critique": { allow: [`${S}/reviews/**`] },
	"visual-review": { allow: [`${S}/reviews/**`] },
	"ux-inventory": { allow: [`${S}/gaps.json`] },
	"ux-spec": { allow: [`${S}/components/*.md`] },
	"ux-dev": {
		allow: ["app/views/components/**", "app/assets/stylesheets/components/**", "app/javascript/controllers/**", "test/views/components/**", "factory/components.md"],
	},
	architect: { allow: [`${S}/architecture.md`, `${S}/tasks.json`] },
	tester: { allow: ["test/system/**", "test/integration/**", "test/models/**", "test/controllers/**", "test/fixtures/**"] },
	migration: { allow: ["db/migrate/**", "db/schema.rb"] },
	model: { allow: ["app/models/**", "config/locales/**", "Gemfile", "Gemfile.lock"] },
	controller: { allow: ["app/controllers/**", "config/routes.rb"] },
	view: { allow: ["app/views/**", "app/assets/stylesheets/**", "app/javascript/controllers/**"], deny: ["app/views/components/**", "app/assets/stylesheets/components/**"] },
	"ux-review": { allow: [`${S}/reviews/**`] },
	security: { allow: [`${S}/reviews/**`] },
	"code-review": { allow: [`${S}/reviews/**`] },
	qa: { allow: [`${S}/reviews/**`, `${S}/qa.md`] },
	triage: { allow: [`${S}/reviews/**`] },
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
const run = withStaff(runOnce, { repo: REPO, story: STORY, lanes: LANES }); // + HR's roles (factory/staff.json)

/** Runs a build step, then its gate; on "changes" reruns the build step with the issue (up to `rounds`). */
async function gated(build: Step, review: (built: Result) => Step, rounds = 2) {
	let built = await run(build);
	for (let round = 0; ; round++) {
		const gate = review(built);
		if (built.check) gate.task += `\n\nThe task's check \`${build.check}\` ${built.check.ok ? "passed" : "FAILED"}:\n\`\`\`\n${tail(built.check.out, 2500)}\n\`\`\``;
		await run(gate);
		const verdict = readJson(gate.outputs[0]!);
		if (verdict?.verdict === "approve") return { built, approved: true };
		if (verdict?.verdict === "elsewhere") {
			log(`- **gate stopped: the problem is outside this task (${verdict.issue}); left to triage**`);
			return { built, approved: false };
		}
		if (round >= rounds) {
			log(`- **gate not passed after ${rounds} fix rounds: ${verdict?.issue ?? "no verdict"}**`);
			return { built, approved: false };
		}
		if (built.refused.length) {
			log(`- **gate stopped: ${build.station} needed files outside its lane (${[...new Set(built.refused)].join(", ")}); left to triage**`);
			return { built, approved: false };
		}
		built = await run(build, verdict?.issue ?? "The reviewer produced no valid verdict; recheck your output against the task.");
	}
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

const VERDICT = (name: string) => `${S}/reviews/${name}.json`;
const lastDiff = () => {
	try {
		return sh("git show --stat --patch HEAD").slice(0, 15000);
	} catch {
		return "(no diff)";
	}
};

// ─── Screenshots (runner-owned, outside the repo) ────────────────────────────

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = join(RUN_DIR, "shots");
const DESIGN_PNG = `${S}/design-input.png`;
const mockupFiles = () => {
	const dir = join(REPO, S, "mockups");
	return existsSync(dir) ? readdirSync(dir).filter((f) => /\.(html|css)$/.test(f)).sort().map((f) => `${S}/mockups/${f}`) : [];
};
const routeOf = (html: string) => read(html)?.match(/<meta\s+name="route"\s+content="([^"]+)"/)?.[1] ?? null;
function shoot(url: string, out: string) {
	mkdirSync(join(out, ".."), { recursive: true });
	try {
		execSync(`"${CHROME}" --headless=new --disable-gpu --hide-scrollbars --window-size=1300,900 --virtual-time-budget=2500 --screenshot="${out}" "${url}"`, { stdio: "ignore", timeout: 60000 });
	} catch {}
	return existsSync(out) ? out : null;
}
/** Screenshot every mockup HTML file; returns [{name, route, png}]. */
function shootMockups() {
	rmSync(join(SHOTS, "mockup"), { recursive: true, force: true });
	return mockupFiles()
		.filter((f) => f.endsWith(".html"))
		.map((f) => {
			const name = f.split("/").pop()!.replace(/\.html$/, "");
			return { name, route: routeOf(f), png: shoot(`file://${join(REPO, f)}`, join(SHOTS, "mockup", `${name}.png`)) };
		});
}
/** Run the story's system test with capture_screen on; pair each app shot with the mockup of the same name. */
async function shootApp(mockups: { name: string; route: string | null; png: string | null }[]) {
	const dir = join(SHOTS, "app");
	rmSync(dir, { recursive: true, force: true });
	shOk(`FACTORY_SHOTS="${dir}" bin/rails test test/system/${STORY.replace(/-/g, "_")}_test.rb`);
	return mockups
		.filter((m) => m.png)
		.map((m) => ({ name: m.name, route: m.route ?? "?", mockup: m.png!, app: existsSync(join(dir, `${m.name}.png`)) ? join(dir, `${m.name}.png`) : null }));
}

writeFileSync(AUDIT, `# Factory run: ${STORY}\n\nRepo ${REPO} at ${sh("git rev-parse --short HEAD").trim()}, ${new Date().toISOString()}, model ${MODEL_ID}, budget ${BUDGET} tool calls/step.\n`);
// reset.sh returns the repo here, so a rerun starts from the same code (earlier stories included).
if (!shOk(`git rev-parse -q --verify refs/tags/start/${STORY}`).ok) sh(`git tag start/${STORY}`);

// Planner: picks the optional stages. Architect, tester, developers, code review and QA always run.
const inventory = sh("git ls-files app config/routes.rb db/schema.rb test | grep -v '^test/fixtures/files'");
await run({
	key: "plan", station: "planner", prompt: "planner",
	task: `Decide which optional stages this story needs. Write ${S}/plan.json.\n\nFiles in the app:\n\`\`\`\n${inventory}\n\`\`\``,
	inputs: [`${S}/story.md`, "factory/components.md", "config/routes.rb", "db/schema.rb"],
	outputs: [`${S}/plan.json`],
});
const plan = { design: true, ux: true, security: true, ...readJson(`${S}/plan.json`) };
const expected = read("factory/backlog.md")?.split("\n").find((l) => l.includes(`\`${STORY}\``))?.split("|")[4]?.trim();
log(`\n**Plan:** design ${plan.design}, ux ${plan.ux}, security ${plan.security}. ${plan.reason ?? ""}\n**Backlog expected:** ${expected ?? "?"}`);

// Inputs describing the app's existing look, for stories without a founders' design input.
const existingStyle = ["app/views/layouts/application.html.erb", "app/assets/stylesheets/base.css", "factory/components.md"];
let mockups: ReturnType<typeof shootMockups> = [];
if (plan.design) {
await run({
	key: "design", station: "designer", prompt: "designer",
	task: `Write the design for this story's screens, starting from the founders' design input.\n\nExisting screens (views):\n\`\`\`\n${inventory.split("\n").filter((f) => f.startsWith("app/views/") && !f.includes("/components/") && !f.includes("/layouts/") && !f.includes("/pwa/")).join("\n")}\n\`\`\``,
	inputs: [`${S}/story.md`, `${S}/design-input.md`, "config/routes.rb", "app/views/home/index.html.erb", ...existingStyle],
	outputs: [`${S}/design.md`],
});

// Mockups ⇄ design critique (vision): static HTML of every screen state, judged against the design input.
for (let round = 0; ; round++) {
	await run(
		{
			key: "mockup", station: "mockup", prompt: "mockup",
			task: "Build static HTML mockups of every screen state in the design, plus mockups/base.css.",
			inputs: [`${S}/design.md`, `${S}/design-input.md`, ...existingStyle, ...mockupFiles()],
			outputs: [`${S}/mockups/base.css`],
		},
		round ? readJson(VERDICT("design-critique"))?.issue : undefined,
	);
	mockups = shootMockups();
	log(`- mockup screenshots: ${mockups.map((m) => `${m.name}${m.png ? "" : " (FAILED)"}`).join(", ")}`);
	const pngs = mockups.filter((m) => m.png).map((m) => `- ${m.name} (route ${m.route ?? "?"}): ${m.png}`).join("\n");
	await run({
		key: `design-critique${round ? `#${round}` : ""}`, station: "design-critique", prompt: "design-critique",
		task: `Critique the mockups. Write the verdict to ${VERDICT("design-critique")}.\n\nMockup screenshots (read each):\n${pngs}\n\n${read(DESIGN_PNG) !== null ? `Founders' design input image (read it): ${join(REPO, DESIGN_PNG)}` : "No design input image exists; compare against design-input.md (if any), design.md, and the existing app style (base.css, components)."}`,
		inputs: [`${S}/design-input.md`, `${S}/design.md`, ...existingStyle],
		outputs: [VERDICT("design-critique")],
	});
	if (readJson(VERDICT("design-critique"))?.verdict === "approve") break;
	if (round >= 2) {
		log(`- **design critique not passed after ${round} rounds: ${readJson(VERDICT("design-critique"))?.issue}**`);
		break;
	}
}

}

if (plan.ux) {
await run({
	key: "inventory", station: "ux-inventory", prompt: "ux-inventory",
	task: "List which components the design needs that the library does not have yet, and which existing ones must change.",
	inputs: [`${S}/design.md`, "factory/components.md", ...mockupFiles()],
	outputs: [`${S}/gaps.json`],
});

const g = readJson(`${S}/gaps.json`) ?? {};
const gaps: { name: string; purpose: string; kind: "new" | "change" }[] = [
	...(g.new ?? []).map((x: any) => ({ name: x.name, purpose: x.purpose, kind: "new" })),
	...(g.changed ?? []).map((x: any) => ({ name: x.name, purpose: x.change, kind: "change" })),
];
log(`\n**Components:** new ${(g.new ?? []).map((x: any) => x.name).join(", ") || "none"}; changed ${(g.changed ?? []).map((x: any) => x.name).join(", ") || "none"}`);
for (const gap of gaps) {
	const spec = `${S}/components/${gap.name}.md`;
	const current = [`app/views/components/_${gap.name}.html.erb`, `app/assets/stylesheets/components/${gap.name}.css`, `test/views/components/${gap.name}_test.rb`];
	await run({
		key: `spec:${gap.name}`, station: "ux-spec", prompt: "ux-spec",
		task: gap.kind === "new"
			? `Write the spec for the new component \`${gap.name}\`: ${gap.purpose}`
			: `Write the spec for a change to the existing component \`${gap.name}\`: ${gap.purpose}\nKeep its existing locals and behavior working for current callers; spec only the change.`,
		inputs: [`${S}/design.md`, "factory/components.md", ...(gap.kind === "change" ? current : []), ...mockupFiles()],
		outputs: [spec],
	});
	await gated(
		{
			key: `component:${gap.name}`, station: "ux-dev", prompt: "ux-dev",
			task: gap.kind === "new" ? `Build the component \`${gap.name}\` exactly to its spec.` : `Change the existing component \`${gap.name}\` exactly to its spec. Existing callers must keep working.`,
			inputs: [spec, "factory/components.md", "app/views/layouts/application.html.erb", ...(gap.kind === "change" ? current : [])],
			outputs: [`app/views/components/_${gap.name}.html.erb`, `test/views/components/${gap.name}_test.rb`],
			check: gap.kind === "new" ? `bin/rails test test/views/components/${gap.name}_test.rb` : "bin/rails test test/views/components",
		},
		() => ({
			key: `ux-review:${gap.name}`, station: "ux-review", prompt: "ux-review",
			task: `Review the component \`${gap.name}\` against its spec. Write the verdict to ${VERDICT(`component-${gap.name}`)}.`,
			inputs: [spec, ...current, "factory/components.md"],
			outputs: [VERDICT(`component-${gap.name}`)],
		}),
	);
}
}

const archStep = {
	key: "architecture", station: "architect", prompt: "architect",
	task: `Design how this story is built in this Rails app and cut it into build tasks. Build on the existing code; change existing files only where the story needs it.\n\nFiles in the app:\n\`\`\`\n${inventory}\n\`\`\``,
	inputs: [`${S}/story.md`, `${S}/design.md`, `${S}/mockups/base.css`, "factory/components.md", "config/routes.rb", "Gemfile", "db/schema.rb", "app/controllers/application_controller.rb", "config/locales/en.yml"],
	outputs: [`${S}/architecture.md`, `${S}/tasks.json`],
};
if (plan.security)
	await gated(archStep, () => ({
		key: "security", station: "security", prompt: "security",
		task: `Review the architecture for security problems. Write the verdict to ${VERDICT("security")}.`,
		inputs: [`${S}/story.md`, `${S}/architecture.md`],
		outputs: [VERDICT("security")],
	}));
else await run(archStep);

await run({
	key: "tests", station: "tester", prompt: "tester",
	task: `Write failing tests for the story's acceptance. Name the system test file test/system/${STORY.replace(/-/g, "_")}_test.rb.\n\nMockup names to capture with capture_screen: ${mockups.map((m) => m.name).join(", ")}`,
	inputs: [`${S}/story.md`, `${S}/design.md`, `${S}/architecture.md`, "test/application_system_test_case.rb", "test/test_helper.rb"],
	outputs: [`test/system/${STORY.replace(/-/g, "_")}_test.rb`],
});

type Task = { id: string; station: string; title: string; files: string[]; depends?: string[] };
const tasks: Task[] = readJson(`${S}/tasks.json`)?.tasks ?? [];
const done = new Set<string>();
const ordered: Task[] = [];
while (ordered.length < tasks.length) {
	const next = tasks.find((t) => !done.has(t.id) && (t.depends ?? []).every((d) => done.has(d) || !tasks.some((x) => x.id === d)));
	if (!next) break;
	ordered.push(next);
	done.add(next.id);
}
const lastView = [...ordered].reverse().find((t) => t.station === "view")?.id;
log(`\n**Build tasks:** ${ordered.map((t) => `${t.id} ${t.station}: ${t.title}`).join("; ") || "none"}`);
for (const t of ordered) {
	if (!LANES[t.station] || !["migration", "model", "controller", "view"].includes(t.station)) {
		log(`- **task ${t.id} has invalid station "${t.station}", skipped**`);
		continue;
	}
	const outside = t.files.filter((f) => !inLane(t.station, f));
	if (outside.length) log(`- task ${t.id}: files outside the ${t.station} lane were planned (dropped): ${outside.join(", ")}`);
	t.files = t.files.filter((f) => inLane(t.station, f));
	if (!t.files.length) {
		log(`- **task ${t.id} has no files in the ${t.station} lane, skipped**`);
		continue;
	}
	await gated(
		{
			key: `build:${t.id}`, station: t.station, prompt: "dev",
			task: `You are the **${t.station}** developer. Task ${t.id}: ${t.title}\nFiles: ${t.files.join(", ")}`,
			inputs: [`${S}/architecture.md`, ...(t.station === "view" ? [`${S}/design.md`, "factory/components.md", ...mockupFiles()] : []), ...t.files.filter((f) => !f.includes("*"))],
			outputs: [],
			check: t.station === "migration" ? "bin/rails db:migrate" : t.id === lastView ? `bin/rails test test/system/${STORY.replace(/-/g, "_")}_test.rb` : undefined,
		},
		() => ({
			key: `code-review:${t.id}`, station: "code-review", prompt: "code-review",
			task: `Review task ${t.id} (${t.station}): ${t.title}. Write the verdict to ${VERDICT(`task-${t.id}`)}.\n\nDiff of the task's commit:\n\`\`\`diff\n${lastDiff()}\n\`\`\``,
			inputs: [`${S}/architecture.md`, `${S}/tasks.json`],
			outputs: [VERDICT(`task-${t.id}`)],
		}),
	);
}

const SYSTEM_TEST = `test/system/${STORY.replace(/-/g, "_")}_test.rb`;
async function verify(round: number) {
	const suffix = round ? `#${round}` : "";
	await run({
		key: `qa${suffix}`, station: "qa", prompt: "qa",
		task: `Verify the story's acceptance. Write ${S}/qa.md and the verdict to ${VERDICT("qa")}.`,
		inputs: [`${S}/story.md`, SYSTEM_TEST],
		outputs: [`${S}/qa.md`, VERDICT("qa")],
	});
	if (!mockups.length) return [readJson(VERDICT("qa")), { verdict: "approve" }];
	const pairs = await shootApp(mockups);
	log(`- app screenshots: ${pairs.map((p) => `${p.name}${p.app ? "" : " (NOT CAPTURED)"}`).join(", ")}`);
	await run({
		key: `visual-review${suffix}`, station: "visual-review", prompt: "visual-review",
		task: `Compare the app with the approved mockups. Write the verdict to ${VERDICT("design")}.\n\nScreenshot pairs (read both of each):\n${pairs.map((p) => `- ${p.name} (route ${p.route}): app ${p.app ?? "(NOT CAPTURED: the system test never called capture_screen for it; report that as the issue)"} vs mockup ${p.mockup}`).join("\n")}`,
		inputs: [`${S}/design.md`],
		outputs: [VERDICT("design")],
	});
	return [readJson(VERDICT("qa")), readJson(VERDICT("design"))];
}
// Rework loop: a failed verification is triaged to one station, fixed there, and verified again.
for (let round = 0; ; round++) {
	const [qa, design] = await verify(round);
	const suite = shOk("bin/rails test && bin/rails test:system");
	const red = suite.ok ? null : { verdict: "changes", issue: `The full test suite fails (this story's tests or an earlier story's):\n${tail(suite.out, 2500)}` };
	const failing = [red, qa, design].find((v) => v && v.verdict !== "approve");
	if (!failing) break;
	if (round >= 3) {
		log(`- **still failing after ${round} rework rounds: ${failing?.issue}**`);
		break;
	}
	const tests = suite.ok ? shOk(`bin/rails test ${SYSTEM_TEST}`) : suite;
	await run({
		key: `triage#${round + 1}`, station: "triage", prompt: "triage",
		task: `Assign this failure to one station. Write ${VERDICT("triage")}.\nTests from earlier stories describe released behavior: fix the code to keep them passing, never remove that behavior.\n\nFailure: ${failing?.issue ?? "no valid verdict"}\n\nTest output:\n\`\`\`\n${tail(tests.out, 3000)}\n\`\`\``,
		inputs: [`${S}/story.md`, `${S}/design.md`, `${S}/architecture.md`, `${S}/tasks.json`, SYSTEM_TEST, "test/fixtures/users.yml", `${S}/qa.md`, "factory/components.md", ...mockupFiles().filter((f) => f.endsWith(".css"))],
		outputs: [VERDICT("triage")],
		budget: 40,
	});
	const t = readJson(VERDICT("triage"));
	const station = ["tester", "ux-dev", "migration", "model", "controller", "view"].includes(t?.station) ? t.station : null;
	if (!station) {
		log(`- **triage produced no valid station: ${JSON.stringify(t)}**`);
		break;
	}
	const files = (t.files ?? []).filter((f: string) => typeof f === "string" && !f.includes("*"));
	await run(
		{
			key: `rework#${round + 1}:${station}`, station, prompt: station === "ux-dev" ? "ux-dev" : station === "tester" ? "tester" : "dev",
			task: station === "tester"
				? `Fix the story's tests: ${t.title}\nFiles: ${files.join(", ")}`
				: station === "ux-dev"
				? `Fix the component \`${t.component}\`: ${t.title}`
				: `You are the **${station}** developer. Fix: ${t.title}\nFiles: ${files.join(", ")}`,
			inputs: [
				`${S}/architecture.md`,
				...(station === "ux-dev" && t.component ? [`${S}/components/${t.component}.md`, "factory/components.md"] : []),
				...(station === "view" ? [`${S}/design.md`, "factory/components.md", ...mockupFiles()] : []),
				...(station === "ux-dev" ? mockupFiles().filter((f) => f.endsWith(".css")) : []),
				...files,
			],
			outputs: [],
			check: "bin/rails test && bin/rails test:system",
		},
		t.issue,
	);
}

const unit = shOk("bin/rails test");
const system = shOk("bin/rails test:system");
log(`\n## Gate\n- bin/rails test: ${unit.ok ? "pass" : "FAIL"}\n- bin/rails test:system: ${system.ok ? "pass" : "FAIL"}\n\n\`\`\`\n${tail(unit.out, 600)}\n${tail(system.out, 1200)}\n\`\`\``);
for (const v of ["design-critique", "qa", "design", "security"]) log(`- verdict ${v}: ${JSON.stringify(readJson(VERDICT(v)))}`);
await harness.close(context);
process.exit(0);
