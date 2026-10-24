// Provider for the local Qwen3.8-Flash-Next server on 192.168.1.69:8888.
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const PROVIDER = "local8888";
export const MODEL_ID = "Qwen3.8-Flash-Next";
// LOCAL_LLM_BASE_URL lets processes without macOS Local Network access (e.g. under tmux) go through the localhost shim.
const BASE_URL = process.env.LOCAL_LLM_BASE_URL ?? "http://192.168.1.69:8888/v1";

const qwen: Model<"openai-completions"> = {
	id: MODEL_ID,
	name: "Qwen3.8 Flash Next (local8888)",
	api: "openai-completions",
	provider: PROVIDER,
	baseUrl: BASE_URL,
	reasoning: true,
	// The server thinks by default; without an explicit "off" value pi-ai sends nothing and thinking runs unbounded.
	thinkingLevelMap: { off: "none" },
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 32768,
	compat: {
		thinkingFormat: "openai",
		supportsReasoningEffort: true,
		maxTokensField: "max_tokens",
		supportsDeveloperRole: false,
		supportsStore: false,
	},
};

export function localModels() {
	const models = createModels();
	models.setProvider(
		createProvider({
			id: PROVIDER,
			name: "Local 8888",
			baseUrl: BASE_URL,
			auth: { apiKey: { name: "Local 8888", resolve: async () => ({ auth: { apiKey: "none" } }) } },
			models: [qwen],
			api: openAICompletionsApi(),
		}),
	);
	return models;
}
