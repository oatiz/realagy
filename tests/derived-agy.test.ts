import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
// Budget selectors are tested separately; preserve this synthetic ELF's scope.
vi.mock("../src/acp/customization-budget-patch.js", () => ({ patchAgyCustomizationBudget: (source: Buffer) => ({ data: source, offset: 0 }) }));
// This cache fixture has no Go pclntab; supply its function boundaries while
// keeping the real decorator and serializer patchers under test.
vi.mock("../src/acp/go-symbols.js", () => ({
	findGoText: () => ({ format: "elf", arch: "x64", textOff: 0x1000, textVa: 0x400000 }),
	buildGoFunctions: () => new Map([
		["chatconverters.(*TrajectoryChatConverter).getMaxTokensForStep", { entryOff: 0x600, size: 69 }],
		["serializers.DefaultSerializer.stepToMessage", { entryOff: 0x700, size: 48 }],
	]),
}));
import { AGY_PATCH_REVISION, deriveAgy } from "../src/acp/derived-agy.js";
import { patchAgyMcpOutput } from "../src/acp/output-patch.js";
const selectors = JSON.parse(fs.readFileSync(new URL("./fixtures/mcp-limit-selectors-1.5.9.json", import.meta.url), "utf8")) as Array<{ platform: string; kind: string; native: string }>;

const SEGMENT_OFFSET = 0x1000;
const SEGMENT_VADDR = 0x400000;
const SEGMENT_SIZE = 0x1000;
const CONTINUATION = 0x1100;
const SECOND = CONTINUATION + 3 + 0xcf;
const THIRD = SECOND + 0x11;
const OUTPUT = 0x1400;

/** Minimal x64 ELF carrying both the output-decorator and prompt-admission signatures. */
function fixture(): Buffer {
	const data = Buffer.alloc(0x2000);
	data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	data.writeUInt16LE(3, 16);
	data.writeUInt16LE(62, 18);
	data.writeBigUInt64LE(64n, 32);
	data.writeUInt16LE(56, 54);
	data.writeUInt16LE(1, 56);
	data.writeUInt32LE(1, 64);
	data.writeUInt32LE(5, 68);
	data.writeBigUInt64LE(BigInt(SEGMENT_OFFSET), 72);
	data.writeBigUInt64LE(BigInt(SEGMENT_VADDR), 80);
	data.writeBigUInt64LE(BigInt(SEGMENT_SIZE), 96);
	data.writeBigUInt64LE(BigInt(SEGMENT_SIZE), 104);
	data.set([0x48, 0x85, 0xf6, 0x0f, 0x85, 0x20, 0, 0, 0], CONTINUATION);
	data.set([0x48, 0x8b, 0x94, 0x24, 0x78, 0x02, 0, 0], CONTINUATION + 9);
	data.set([0x48, 0x85, 0xf6, 0x0f, 0x84, 0x20, 0, 0, 0], SECOND);
	data.set([0x48, 0x85, 0xd2, 0x0f, 0x84, 0x20, 0, 0, 0], THIRD);
	data.set([0x48, 0x85, 0xd2, 0x0f, 0x8e, 0x20, 0, 0, 0, 0x48, 0x89, 0x54, 0x24, 0x38, 0xb8, 0x28, 0, 0, 0], OUTPUT);
	for (const [kind, at] of [["legacy", 0x1600], ["serializer", 0x1700]] as const) {
		const vector = selectors.find((v) => v.platform === "linux-x64" && v.kind === kind)!;
		data.set(Buffer.from(vector.native, "hex"), at);
	}
	return data;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(source: Buffer): { sourcePath: string; cacheDir: string; hash: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-derived-agy-"));
	roots.push(root);
	const sourcePath = path.join(root, "agy");
	fs.writeFileSync(sourcePath, source);
	return { sourcePath, cacheDir: path.join(root, "derived-bin"), hash: crypto.createHash("sha256").update(source).digest("hex") };
}

const patched = (source: Buffer): Buffer => patchAgyMcpOutput(source).data;

test("the full-output derivative is cached by source hash and leaves the source untouched", async () => {
	const source = fixture();
	const { sourcePath, cacheDir, hash } = setup(source);
	const logs: string[] = [];
	const options = { fullMcpOutput: true, cacheDir, log: (msg: string) => logs.push(msg) };
	const [first, concurrent] = await Promise.all([deriveAgy(sourcePath, options), deriveAgy(sourcePath, options)]);
	assert.equal(first, concurrent);
	assert.equal(path.basename(first), `agy-${hash}-${AGY_PATCH_REVISION}-customization-budget+full-mcp-output`);
	assert.deepEqual(fs.readdirSync(cacheDir).sort(), [path.basename(first), `${path.basename(first)}.sha256`]);
	assert.deepEqual(fs.readFileSync(first), patched(source));
	assert.deepEqual(fs.readFileSync(sourcePath), source);
	assert.ok(fs.statSync(first).mode & 0o111);
	assert.deepEqual(logs, ["agy-derived"]);

	const before = fs.statSync(first).mtimeMs;
	assert.equal(await deriveAgy(sourcePath, options), first);
	assert.equal(fs.statSync(first).mtimeMs, before, "a verified cache entry is reused");
	assert.deepEqual(logs, ["agy-derived"]);
});

test("a corrupt derivative is rebuilt", async () => {
	const { sourcePath, cacheDir } = setup(fixture());
	const output = await deriveAgy(sourcePath, { fullMcpOutput: true, cacheDir });
	fs.writeFileSync(output, fixture());
	assert.equal(await deriveAgy(sourcePath, { fullMcpOutput: true, cacheDir }), output);
	assert.deepEqual(fs.readFileSync(output), patched(fixture()));
});

test("an agy upgrade replaces the derivative; disabling optional patches still derives a private binary", async () => {
	const source = fixture();
	const { sourcePath, cacheDir } = setup(source);
	const first = await deriveAgy(sourcePath, { fullMcpOutput: true, cacheDir });
	assert.notEqual(await deriveAgy(sourcePath, { fullMcpOutput: false, cacheDir }), sourcePath);

	const upgraded = fixture();
	upgraded[0x1800] = 0x42;
	fs.writeFileSync(sourcePath, upgraded);
	const second = await deriveAgy(sourcePath, { fullMcpOutput: true, cacheDir });
	assert.notEqual(second, first);
	assert.deepEqual(fs.readFileSync(second), patched(upgraded));
	assert.deepEqual(fs.readdirSync(cacheDir).sort(), [path.basename(second), `${path.basename(second)}.sha256`]);
});

test("a patch that does not apply is an error and writes nothing", async () => {

	const noOutput = fixture();
	noOutput.fill(0, OUTPUT, OUTPUT + 19);
	const b = setup(noOutput);
	await assert.rejects(deriveAgy(b.sourcePath, { fullMcpOutput: true, cacheDir: b.cacheDir }), /full-MCP-output agy: expected one output-decorator signature, found 0/);
	assert.equal(fs.existsSync(b.cacheDir), false);

	const missingSerializer = fixture();
	missingSerializer.fill(0, 0x1708, 0x1708 + 32);
	const serializerCase = setup(missingSerializer);
	await assert.rejects(deriveAgy(serializerCase.sourcePath, { fullMcpOutput: true, cacheDir: serializerCase.cacheDir }), /serializer MCP limit selector/);
	assert.equal(fs.existsSync(serializerCase.cacheDir), false, "no decorator-only fallback is published");
	assert.deepEqual(fs.readFileSync(serializerCase.sourcePath), missingSerializer);

	const c = setup(Buffer.from("#!/bin/sh\n"));
	await assert.rejects(deriveAgy(c.sourcePath, { fullMcpOutput: false, cacheDir: c.cacheDir }));
	assert.equal(fs.existsSync(c.cacheDir), false);
});
