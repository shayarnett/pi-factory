// Orchestrator chat + a pool of 4 durable worker slots, all on the local Qwen server (5 concurrent slots there:
// 1 for the orchestrator, 4 for workers). Built on the anchor/reporter pattern from pi-durable's
// 22-subagent-background example: workers run in the background, their answers come back to the orchestrator as
// follow-up messages, and everything survives a restart (state lives in pool.sqlite).
//
//   npm run pool [-- --cwd /path/to/project]
//
// Chat commands: /status (slot states), /stop <slot>, /quit.
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	Harness,
	LiveDoc,
	section,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { localModels, MODEL_ID, PROVIDER } from "./local-model.ts";

const context = BACKGROUND_CONTEXT;
const SLOTS = ["w1", "w2", "w3", "w4"] as const;
const WORKER_THINKING = "low";
const ORCHESTRATOR_THINKING = "low";
type SlotName = (typeof SLOTS)[number];

const cwdFlag = process.argv.indexOf("--cwd");
const workspace = resolve(cwdFlag >= 0 ? process.argv[cwdFlag + 1]! : process.cwd());

// ─── Durable pool state, kept on the orchestrator conversation ───────────────

type Slot = {
	conversationId?: ConversationId;
	/** Set when a message is handed to the slot, cleared once its reporter has decided the outcome. */
	busy: boolean;
	task?: string;
	/** Answers already reported, so several messages ending in one answer are reported once. */
	reported: EntryId[];
};
const Pool = defineDoc<{ slots: Record<SlotName, Slot> }>({
	checkpointWhen: () => false,
	kind: "app.pool",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => emptyPool(),
});
function emptyPool(): { slots: Record<SlotName, Slot> } {
	return { slots: Object.fromEntries(SLOTS.map((s) => [s, { busy: false, reported: [] }])) as unknown as Record<SlotName, Slot> };
}

// Owns a worker conversation. Background, so the orchestrator's aborts and idle waits stop here.
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "app.pool-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_t, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

// Delivers one message to a worker, waits for the answer, and posts it back to the orchestrator.
type ReporterInput = { slot: SlotName; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.pool-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, ctx) => {
			const { slot, conversationId, message, followUp } = reporter.input;
			const worker = (await runtime.conversation(conversationId, ctx))!;
			const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer" } as const;
			const settled = await (await worker.submit({ ...request, requestId: `pool:${reporter.id}` }, ctx)).wait(ctx);
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				const state = (await tx.doc(Pool, runtime.conversationId)).slots[slot];
				const stillCurrent = state.conversationId === conversationId;
				if (stillCurrent) state.busy = false;
				if (settled.status === "unanswered") {
					return next(settled.reason === "aborted" ? undefined : `[worker ${slot} failed: ${settled.reason}]`);
				}
				if (settled.type !== "input" || state.reported.includes(settled.answer)) return next();
				if (stillCurrent) state.reported.push(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage;
				return next(`[worker ${slot} finished] ${textOf(answer)}`);
			}, ctx);
		},
		report: async (reporter, runtime, ctx) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const main = (await runtime.conversation(runtime.conversationId, ctx))!;
				await main.submit(
					{ type: "input", content: report, whenBusy: "followUp", requestId: `pool-report:${reporter.id}` },
					ctx,
				);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const poolTool = defineTool({
	name: "pool",
	description:
		"Manage the pool of 4 background worker agents (w1-w4). Each worker has read/write/edit/bash in the project. " +
		"Actions: dispatch (message, optional slot: starts a FRESH worker on an idle slot with a self-contained task), " +
		"send (slot, message, optional followUp: continue the slot's current worker; steers it if busy unless " +
		"followUp is true), stop (slot: abort its current work), status. Results arrive later as " +
		"'[worker wN finished] ...' messages; do not wait or poll for them.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("dispatch"), Type.Literal("send"), Type.Literal("stop"), Type.Literal("status")]),
		slot: Type.Optional(Type.Union([Type.Literal("w1"), Type.Literal("w2"), Type.Literal("w3"), Type.Literal("w4")])),
		message: Type.Optional(Type.String()),
		followUp: Type.Optional(Type.Boolean()),
	}),
	// Not rerun after a crash: a repeated dispatch would start a second worker. The model can check with status.
	replay: "unsafe",
	execute: async (args, api, ctx) => {
		const { action, slot, message, followUp } = args;
		const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });
		const pool = (await api.snapshot(Pool, api.conversationId, ctx)) ?? emptyPool();

		if (action === "status") {
			const lines: string[] = [];
			for (const name of SLOTS) {
				const s = pool.slots[name];
				const running =
					s.conversationId !== undefined &&
					(await api.snapshot(LiveDoc, s.conversationId, ctx))?.run !== undefined;
				lines.push(`${name}: ${s.busy || running ? `working on: ${s.task ?? "?"}` : "idle"}`);
			}
			return reply(lines.join("\n"));
		}
		if (action === "stop") {
			if (slot === undefined) return reply("stop needs a slot.");
			const id = pool.slots[slot].conversationId;
			if (id === undefined) return reply(`${slot} has no worker.`);
			await (await api.conversation(id, ctx))!.abort(ctx);
			return reply(`Stopped ${slot}.`);
		}
		if (message === undefined) return reply(`${action} needs a message.`);

		const result = await api.commit(async (tx) => {
			const state = await tx.doc(Pool, api.conversationId);
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			let target: SlotName | undefined = slot;
			if (action === "dispatch") {
				target ??= SLOTS.find((s) => !state.slots[s].busy);
				if (target === undefined) return "All 4 workers are busy. Wait for a result, or stop one.";
				if (state.slots[target].busy) return `${target} is busy. Pick an idle slot, or use send to steer it.`;
				const anchor = await tx.createTask(Anchor, null, background);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				await configure(tx, child.id, {
					extensions: { remove: [PoolTools] },
					thinkingLevel: WORKER_THINKING,
					instructions:
						`You are worker ${target}, a coding agent in a pool run by an orchestrator. Complete the task ` +
						"using your tools, then reply with a concise report of what you did and found. " +
						"Your reply goes to the orchestrator, not a human.\n\n" +
						"KISS, YAGNI. Keep it simple; build only what the task asks for.\n" +
						"Work in small steps: write files to disk early with your tools, then build, test and iterate. " +
						"Never draft whole files in your head or in your reasoning before writing them.",
				});
				state.slots[target] = { conversationId: child.id, busy: true, task: message.slice(0, 80), reported: [] };
			} else {
				if (target === undefined) return "send needs a slot.";
				if (state.slots[target].conversationId === undefined) return `${target} has no worker; use dispatch.`;
				state.slots[target].busy = true;
			}
			const s = state.slots[target];
			await tx.createTask(
				Reporter,
				{ slot: target, conversationId: s.conversationId!, message, followUp: action === "send" && followUp === true },
				background,
			);
			return action === "dispatch" ? `Dispatched to ${target}.` : `Sent to ${target}.`;
		}, ctx);
		return reply(result);
	},
});

const PoolTools = defineExtension({
	name: "pool-tools",
	tasks: [Anchor, Reporter],
	tools: [poolTool],
	sections: [
		section(
			"orchestrator",
			() =>
				"You are the orchestrator for a pool of 4 worker agents (w1-w4). Chat with the user, break work into " +
				"self-contained tasks, and hand them to workers with the pool tool so they run in parallel. Give each " +
				"worker everything it needs: it cannot see this conversation. When '[worker wN finished]' messages " +
				"arrive, summarize the results for the user and dispatch follow-up work if needed. Do small lookups " +
				"yourself; delegate anything substantial. KISS, YAGNI: keep plans and tasks simple, and ask workers " +
				"only for what is needed now.",
			{ tag: false },
		),
	],
});

const Workspace = defineExtension({ name: "workspace", sections: [section("cwd", (input) => input.env?.cwd)] });

// ─── Host ────────────────────────────────────────────────────────────────────

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Workspace);
registry.install(PoolTools);

const harness = await Harness.open(
	await openNodeSqliteStorage(join(import.meta.dirname, "..", "pool.sqlite")),
	{
		models: localModels(),
		registry,
		env: ({ cwd = workspace }) => new NodeExecutionEnv({ cwd }),
		onReport: (error, info) => console.log(`\x1b[31m  ! ${info.type}: ${error instanceof Error ? error.message : String(error)}\x1b[0m`),
	},
	context,
);
const root = await harness.root(context, {
	agent: { model: { provider: PROVIDER, modelId: MODEL_ID }, cwd: workspace },
});
// Thinking levels are stored per conversation; apply the current policy to the orchestrator and existing workers.
await root.configure({ thinkingLevel: ORCHESTRATOR_THINKING }, context);
for (const slot of Object.values((await harness.snapshot(Pool, root.id, context))?.slots ?? {})) {
	if (slot.conversationId === undefined) continue;
	try {
		await (await harness.conversation(slot.conversationId, context))?.configure({ thinkingLevel: WORKER_THINKING }, context);
	} catch (error) {
		console.log(`  ! could not set thinking on conversation ${slot.conversationId}: ${String(error)}`);
	}
}
harness.resume(); // pick up workers and reports left unfinished by the last run

const color = (code: number) => (t: string) => (process.stdout.isTTY ? `\x1b[${code}m${t}\x1b[0m` : t);
const [bold, dim, cyan, yellow, magenta] = [1, 2, 36, 33, 35].map(color);
const contentText = (c: string | readonly { type: string; text?: string }[]) =>
	typeof c === "string" ? c : c.flatMap((p) => (p.text === undefined ? [] : [p.text])).join("");

const events = await watchEvents(harness, root.id, context);
events.start(async (batch: readonly AgentEvent[]) => {
	for (const event of batch) {
		if (event.type !== "message_end") continue;
		const m = event.entry.model?.[0];
		if (m?.role === "user") {
			const report = /^\[worker (w\d) ([^\]]*)\] ?(.*)$/s.exec(contentText(m.content));
			if (report) console.log(`\n${magenta(bold(`◆ ${report[1]} ${report[2]}`))}\n${dim(report[3]!)}`);
		} else if (m?.role === "assistant") {
			for (const part of m.content) {
				if (part.type !== "toolCall") continue;
				const a = part.arguments as Record<string, string | undefined>;
				const what = part.name === "pool" ? `${a.action}${a.slot ? ` ${a.slot}` : ""}` : JSON.stringify(a).slice(0, 80);
				console.log(yellow(`  ${part.name} ${what}`));
			}
			const text = textOf(m);
			if (text) console.log(`\n${text}`);
		} else if (m?.role === "toolResult") {
			console.log(dim(`  → ${contentText(m.content).split("\n")[0]!.slice(0, 120)}`));
		}
	}
});

async function slotStatus(): Promise<string> {
	const pool = (await harness.snapshot(Pool, root.id, context)) ?? emptyPool();
	const lines: string[] = [];
	for (const name of SLOTS) {
		const s = pool.slots[name];
		const running =
			s.conversationId !== undefined && (await harness.snapshot(LiveDoc, s.conversationId, context))?.run !== undefined;
		lines.push(`  ${name}  ${s.busy || running ? yellow(`working: ${s.task ?? "?"}`) : dim("idle")}`);
	}
	return lines.join("\n");
}

console.log(`${bold("pool")} ${dim(`· ${MODEL_ID} · orchestrator + ${SLOTS.length} workers · ${workspace}`)}`);
console.log(await slotStatus());
console.log(dim("  /status · /stop <slot> · /quit"));

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", async () => {
	await events.stop();
	await harness.close(context);
	process.exit(0);
});
for (;;) {
	const line = (await rl.question(`\n${cyan(bold("›"))} `)).trim();
	if (!line) continue;
	if (line === "/quit") break;
	if (line === "/status") {
		console.log(await slotStatus());
		continue;
	}
	if (line.startsWith("/stop ")) {
		const name = line.slice(6).trim() as SlotName;
		const id = (await harness.snapshot(Pool, root.id, context))?.slots[name]?.conversationId;
		if (id === undefined) console.log(dim(`  no worker on ${name}`));
		else await (await harness.conversation(id, context))!.abort(context);
		continue;
	}
	const submission = await root.submit({ type: "input", content: line, whenBusy: "followUp" }, context);
	void submission.wait(context).then((settled) => {
		if (settled.status === "unanswered") console.log(`\x1b[31m  ! not answered: ${settled.reason}${"detail" in settled && settled.detail ? ` (${settled.detail})` : ""}\x1b[0m`);
	});
}
rl.close();
