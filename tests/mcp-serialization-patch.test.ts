import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { patchMcpLimitBody, patchMcpSerialization } from "../src/acp/mcp-serialization-patch.js";
import type { BinaryArch } from "../src/acp/binary-image.js";

type Vector = { platform: string; arch: BinaryArch; kind: "serializer" | "legacy"; selectorOffset: number; selectorSize: number; native: string; contextUnlocked: string };
const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/mcp-limit-selectors-1.5.9.json", import.meta.url), "utf8")) as Vector[];

// Execute the emitted selector instructions, not a restatement of its intended
// decision table. This keeps tests portable without executing foreign binaries.
function executeX64(code: Buffer, type: number, legacy: boolean, config: boolean): number {
	let pc = 0, eax = type, edx = type, rcx = 0, rdi = 0, equal = false;
	for (let steps = 0; pc < code.length && steps < 100; steps++) {
		const starts = (h: string) => code.subarray(pc, pc + h.length / 2).toString("hex") === h;
		if (starts("90")) pc++;
		else if (starts("31ff")) { rdi = 0; pc += 2; }
		else if (starts("31c9")) { rcx = 0; pc += 2; }
		else if (starts("83ea")) { edx = (edx - code.readInt8(pc + 2)) | 0; equal = edx === 0; pc += 3; }
		else if (starts("83fa") || starts("83f8")) { equal = (code[pc + 1] === 0xfa ? edx : eax) === code.readInt8(pc + 2); pc += 3; }
		else if (starts("81fa")) { equal = edx === code.readInt32LE(pc + 2); pc += 6; }
		else if ([0x74, 0x75, 0xeb].includes(code[pc]!)) {
			const jump = code[pc] === 0xeb || (code[pc] === 0x74 ? equal : !equal);
			pc += 2 + (jump ? code.readInt8(pc + 1) : 0);
		} else if (starts("488bbc24")) { rdi = code.readUInt32LE(pc + 4) === 0x238 ? 65536 : 16384; pc += 8; }
		else if (starts("480f44bc24")) { if (equal) rdi = code.readUInt32LE(pc + 5) === 0x238 ? 65536 : 16384; pc += 9; }
		else if (starts("488b4c24")) { rcx = code[pc + 4] === 0x20 ? 100 : 16384; pc += 5; }
		else if (starts("488b09")) { rcx = config ? 200 : 0; pc += 3; }
		else if (starts("4885c9")) { equal = rcx === 0; pc += 3; }
		else if (starts("488b4978")) { rcx = config ? 300 : 0; pc += 4; }
		else if (starts("486309")) { assert.equal(rcx, 300); rcx = 65536; pc += 3; }
		else assert.fail(`Unexpected x64 instruction at ${pc}: ${code.subarray(pc).toString("hex")}`);
	}
	assert.equal(pc, code.length, "branches must merge at the native instruction after the slot");
	return legacy ? rcx : rdi;
}

function executeArm(code: Buffer, type: number, legacy: boolean, config: boolean): number {
	const regs = Array<number>(32).fill(0); regs[0] = type; regs[3] = 16384; regs[4] = 65536; regs[5] = type;
	const reg = (r: number) => r === 31 ? 0 : regs[r]!;
	let pc = 0, equal = false;
	for (let steps = 0; pc < code.length && steps < 100; steps++) {
		const ins = code.readUInt32LE(pc), rd = ins & 31;
		const imm19 = ((ins >>> 5) & 0x7ffff) << 13 >> 13;
		if ((ins & 0xff00001f) >>> 0 === 0x7100001f) { equal = reg((ins >>> 5) & 31) === ((ins >>> 10) & 0xfff); pc += 4; }
		else if (ins === 0x7a531804) { equal = equal || regs[0] === 19; pc += 4; }
		else if ((ins & 0xff000010) >>> 0 === 0x54000000) { pc += ((ins & 15) === 0 ? equal : !equal) ? imm19 * 4 : 4; }
		else if ((ins & 0xff000000) >>> 0 === 0xb4000000) { pc += reg(rd) === 0 ? imm19 * 4 : 4; }
		else if ((ins & 0xfc000000) >>> 0 === 0x14000000) { pc += ((ins & 0x3ffffff) << 6 >> 6) * 4; }
		else if ((ins & 0xffe00c00) >>> 0 === 0x9a800000) { regs[rd] = reg(equal ? (ins >>> 5) & 31 : (ins >>> 16) & 31); pc += 4; }
		else if ((ins & 0xffffffe0) >>> 0 === 0xaa1f03e0) { regs[rd] = 0; pc += 4; }
		else if (ins === 0xf94017e1) { regs[1] = 100; pc += 4; }
		else if (ins === 0xf9400021) { regs[1] = config ? 200 : 0; pc += 4; }
		else if (ins === 0xf9403c21) { regs[1] = config ? 300 : 0; pc += 4; }
		else if (ins === 0xb9800022) { assert.equal(regs[1], 300); regs[2] = 65536; pc += 4; }
		else if (ins === 0xf9400be2) { regs[2] = 16384; pc += 4; }
		else if (ins === 0xd503201f) pc += 4;
		else assert.fail(`Unexpected arm64 instruction at ${pc}: ${ins.toString(16)}`);
	}
	assert.equal(pc, code.length);
	return legacy ? regs[2]! : regs[4]!;
}

for (const vector of vectors) {
	for (const unlocked of [false, true]) {
		test(`${vector.platform} ${vector.kind}: MCP alone is uncapped, user unlock=${unlocked}`, () => {
			const before = Buffer.from(unlocked ? vector.contextUnlocked : vector.native, "hex");
			const original = Buffer.from(before);
			const patched = patchMcpLimitBody(before, vector.arch, vector.kind, unlocked);
			assert.deepEqual(before, original);
			assert.equal(patched.offset, vector.selectorOffset);
			const end = patched.offset + vector.selectorSize;
			assert.deepEqual(patched.data.subarray(0, patched.offset), before.subarray(0, patched.offset));
			assert.deepEqual(patched.data.subarray(end), before.subarray(end));
			assert.deepEqual(patchMcpLimitBody(patched.data, vector.arch, vector.kind, unlocked).data, patched.data);
			const code = patched.data.subarray(patched.offset, end);
			for (const config of [false, true]) for (let type = 0; type < 512; type++) {
				const user = vector.kind === "legacy" ? type === 8 || type === 19 : type === 14;
				const exempt = vector.kind === "legacy" ? type === 47 : type === 23 || type === 132;
				const expected = exempt || (user && (unlocked || (vector.kind === "legacy" && !config))) ? 0 : user ? 65536 : 16384;
				const actual = (vector.arch === "arm64" ? executeArm : executeX64)(code, type, vector.kind === "legacy", config);
				assert.equal(actual, expected, `step ${type}, config=${config}`);
			}
		});
	}
}

test("unknown, ambiguous, mismatched-policy, and truncated selectors fail closed", () => {
	for (const v of vectors) {
		const original = Buffer.from(v.native, "hex");
		assert.throws(() => patchMcpLimitBody(Buffer.alloc(100), v.arch, v.kind, false), /found 0/);
		assert.throws(() => patchMcpLimitBody(Buffer.concat([original, original]), v.arch, v.kind, false), /found 2/);
		assert.throws(() => patchMcpLimitBody(original, v.arch, v.kind, true), /found 0/);
		assert.throws(() => patchMcpLimitBody(original.subarray(0, v.selectorOffset + v.selectorSize), v.arch, v.kind, false), /found 0/);
		assert.deepEqual(original, Buffer.from(v.native, "hex"));
	}
	assert.throws(() => patchMcpSerialization(Buffer.alloc(100)), /expected ELF/);
});
