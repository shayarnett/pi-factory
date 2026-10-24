// node tools/validate.mjs <file.glb> : Khronos glTF validator; exits 1 on any error.
import { readFileSync } from "node:fs";
import validator from "gltf-validator";
const file = process.argv[2];
const report = await validator.validateBytes(new Uint8Array(readFileSync(file)), { maxIssues: 20 });
const { numErrors, numWarnings, messages } = report.issues;
for (const m of messages.filter((m) => m.severity <= 1)) console.log(`${m.severity === 0 ? "error" : "warning"} ${m.code}: ${m.message} (${m.pointer ?? ""})`);
console.log(`VALIDATOR errors=${numErrors} warnings=${numWarnings}`);
process.exit(numErrors ? 1 : 0);
