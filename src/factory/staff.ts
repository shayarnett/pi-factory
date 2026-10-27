// Staff roles added by AIR (src/factory/roles/air.md), shared by every runner. factory/staff.json in the target repo:
//   { "roles": [{ "name": "<station>", "when": "before" | "after", "station": "<existing station>", "task": "..." }] }
// The role's job description is factory/stations/<name>.md. A "before" role writes notes that the station then
// reads as an input; an "after" role reviews the station's work and writes a verdict; "changes" sends it back once.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

type Role = { name: string; when: "before" | "after"; station: string; task?: string };
type Step = { key: string; station: string; prompt: string; task: string; inputs: string[]; outputs: string[]; check?: string; budget?: number };
type Result = { ok: boolean; check?: { ok: boolean; out: string } };
type Lanes = Record<string, { allow: string[]; deny?: string[] }>;

function roles(repo: string): Role[] {
	const p = join(repo, "factory", "staff.json");
	try {
		return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).roles ?? []) : [];
	} catch {
		return []; // a broken staff.json must not stop the line
	}
}

// Wraps a runner's single-step function so AIR's roles run around the station they attach to.
export function withStaff<S extends Step, R extends Result>(
	runOnce: (step: S, feedback?: string) => Promise<R>,
	{ repo, story, lanes }: { repo: string; story: string; lanes: Lanes },
) {
	const out = (r: Role) => `factory/staff/out/${story}/${r.name}.${r.when === "after" ? "json" : "md"}`;
	const verdict = (p: string) => {
		try {
			return JSON.parse(readFileSync(join(repo, p), "utf8"));
		} catch {
			return null;
		}
	};
	return async function run(step: S, feedback?: string): Promise<R> {
		const mine = roles(repo).filter((r) => r.station === step.station && existsSync(join(repo, "factory", "stations", `${r.name}.md`)));
		for (const r of mine) lanes[r.name] ??= { allow: [`factory/staff/out/${story}/**`] };
		const notes: string[] = [];
		for (const r of mine.filter((r) => r.when === "before")) {
			await runOnce({
				...step, key: `${step.key}/${r.name}`, station: r.name, prompt: r.name, check: undefined,
				task: `${r.task ?? "Prepare notes for the next station."}\nThe next station is ${step.station}, whose task is:\n${step.task}\n\nWrite your notes to ${out(r)}.`,
				outputs: [out(r)],
			});
			notes.push(out(r));
		}
		const task = { ...step, inputs: [...step.inputs, ...notes] };
		let res = await runOnce(task, feedback);
		for (const r of mine.filter((r) => r.when === "after")) {
			if (!res.ok || (res.check && !res.check.ok)) break;
			rmSync(join(repo, out(r)), { force: true }); // no stale verdict from an earlier round
			await runOnce({
				...step, key: `${step.key}/${r.name}`, station: r.name, prompt: r.name, check: undefined,
				task: `${r.task ?? "Review the previous station's work."}\nThe station ${step.station} just did:\n${step.task}\n\nIts output: ${step.outputs.join(", ")}.\nWrite your verdict to ${out(r)}, exactly {"verdict":"approve"} or {"verdict":"changes","issue":"<the ONE thing to fix>"}.`,
				inputs: [...step.inputs, ...step.outputs],
				outputs: [out(r)],
			});
			const v = verdict(out(r));
			if (v?.verdict === "changes") res = await runOnce(task, `${r.name}: ${v.issue}`);
		}
		return res;
	};
}
