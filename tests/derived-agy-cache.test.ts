import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

const patches = vi.hoisted(() => ({ fail: false, output: vi.fn(), context: vi.fn() }));
vi.mock("../src/acp/binary-image.js", () => ({ inspectExecutable: () => ({ format: "elf", arch: "x64" }), signMacOSBinary: vi.fn() }));
vi.mock("../src/acp/context-unlock.js", () => ({ patchAgyContextUnlock: (source: Buffer) => {
	patches.context(); return { data: Buffer.concat([source, Buffer.from("+context")]), gates: [] };
} }));
vi.mock("../src/acp/output-patch.js", () => ({ patchAgyMcpOutput: (source: Buffer, unlocked: boolean) => {
	patches.output(unlocked);
	if (patches.fail) throw new Error("unrecognized MCP serializer");
	return { data: Buffer.concat([source, Buffer.from("+complete-mcp")]), offset: 1, target: 2, serialization: [] };
} }));
import { AGY_PATCH_REVISION, deriveAgy } from "../src/acp/derived-agy.js";

const dirs: string[] = [];
const hash = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-cache-revision-")); dirs.push(dir);
	const source = path.join(dir, "source-agy"), cacheDir = path.join(dir, "cache");
	const data = Buffer.from("synthetic agy source"); fs.writeFileSync(source, data);
	return { source, cacheDir, data };
}
afterEach(() => { patches.fail = false; vi.clearAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("verified legacy caches are not reused after the MCP patch revision", async () => {
	const f = fixture(); fs.mkdirSync(f.cacheDir);
	const old = path.join(f.cacheDir, `agy-${hash(f.data)}-context-unlock+full-mcp-output`);
	const obsolete = Buffer.from("validly hashed but obsolete decorator-only derivative");
	fs.writeFileSync(old, obsolete); fs.writeFileSync(`${old}.sha256`, hash(obsolete));
	const output = await deriveAgy(f.source, { cacheDir: f.cacheDir, fullMcpOutput: true, contextUnlock: true });
	assert.notEqual(output, old);
	assert.ok(path.basename(output).includes(`-${AGY_PATCH_REVISION}-`));
	assert.equal(fs.readFileSync(output, "utf8"), "synthetic agy source+context+complete-mcp");
	assert.equal(patches.output.mock.calls[0]?.[0], true);
	assert.equal(fs.existsSync(old), false);
	assert.deepEqual(fs.readFileSync(f.source), f.data);
	await deriveAgy(f.source, { cacheDir: f.cacheDir, fullMcpOutput: true, contextUnlock: true });
	assert.equal(patches.output.mock.calls.length, 1, "current verified revision still uses its cache");
	fs.writeFileSync(output, "corrupted derivative");
	await deriveAgy(f.source, { cacheDir: f.cacheDir, fullMcpOutput: true, contextUnlock: true });
	assert.equal(patches.output.mock.calls.length, 2, "corrupt current caches are rebuilt");
});

test("MCP output and USER_INPUT context unlocking remain independent", async () => {
	const f = fixture();
	const outputOnly = await deriveAgy(f.source, { cacheDir: f.cacheDir, fullMcpOutput: true, contextUnlock: false });
	assert.equal(patches.context.mock.calls.length, 0);
	assert.equal(patches.output.mock.calls[0]?.[0], false);
	assert.equal(fs.readFileSync(outputOnly, "utf8"), "synthetic agy source+complete-mcp");
	const contextOnly = await deriveAgy(f.source, { cacheDir: f.cacheDir, fullMcpOutput: false, contextUnlock: true });
	assert.notEqual(outputOnly, contextOnly);
	assert.equal(patches.output.mock.calls.length, 1);
	assert.equal(fs.readFileSync(contextOnly, "utf8"), "synthetic agy source+context");
	assert.equal(await deriveAgy(f.source, { cacheDir: f.cacheDir, fullMcpOutput: false, contextUnlock: false }), f.source);
	assert.deepEqual(fs.readFileSync(f.source), f.data);
});

test("unrecognized serialization layouts never publish a partial derivative", async () => {
	const f = fixture(); patches.fail = true;
	await assert.rejects(deriveAgy(f.source, { cacheDir: f.cacheDir, fullMcpOutput: true, contextUnlock: true }), /unrecognized MCP serializer/);
	assert.equal(fs.existsSync(f.cacheDir), false);
	assert.deepEqual(fs.readFileSync(f.source), f.data);
});
