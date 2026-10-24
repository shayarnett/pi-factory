// Durable chat: state lives in session.sqlite, so a killed run resumes on reopen.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { localModels, MODEL_ID, PROVIDER } from "./local-model.ts";

const context = BACKGROUND_CONTEXT;
const prompt = process.argv.slice(2).join(" ") || "Say hello in five words.";

const harness = await Harness.open(
	await openNodeSqliteStorage("./session.sqlite"),
	{ models: localModels(), registry: createRegistry() },
	context,
);
const root = await harness.root(context, { agent: { model: { provider: PROVIDER, modelId: MODEL_ID } } });

const submission = await root.submit({ type: "input", content: prompt }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log(answer?.model?.[0]);
} else {
	console.error("unanswered:", settled);
}
await harness.close(context);
