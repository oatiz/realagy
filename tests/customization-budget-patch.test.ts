import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { CUSTOMIZATION_BUDGET, patchAgyCustomizationBudget, patchCustomizationBudgetBody } from "../src/acp/customization-budget-patch.js";

// Extracted from SHA-512-verified official 1.5.9 Linux/Windows x64 and macOS arm64 binaries.
const x64 = Buffer.from("4585c97e374885d274064c8b4a08eb034531c94d85c974194d8b89000100004d85c97408458b094885d2eb194885d2eb034885d241b900000000eb094885d241b9204e000074084c8b52086690eb03", "hex");
const arm = Buffer.from("ff0000718d010054660000b4c70440f902000014e7031faaa70000b4e78040f9670000b4e70080b904000014e7031faa0200001407c489d2660000b4c80440f9", "hex");

for (const [arch, original] of [["x64", x64], ["arm64", arm]] as const) {
	test(`${arch} budget selector is bounded, idempotent, and leaves rules selection intact`, () => {
		const prefix = Buffer.alloc(8, 0x90), suffix = Buffer.alloc(12, 0x90);
		const body = Buffer.concat([prefix, original, suffix]);
		const { data, offset } = patchCustomizationBudgetBody(body, arch);
		assert.equal(offset, prefix.length);
		assert.deepEqual(body.subarray(offset, offset + original.length), original, "source is not modified");
		assert.deepEqual(data.subarray(0, offset), prefix);
		assert.deepEqual(data.subarray(offset + original.length), suffix);
		assert.deepEqual(patchCustomizationBudgetBody(data, arch).data, data);
		if (arch === "x64") {
			assert.equal(data[offset + 3], 0xeb);
			assert.equal(data.readInt8(offset + 4) + 5, 60, "branch lands on native test before default");
			assert.equal(data.readUInt32LE(offset + 65), CUSTOMIZATION_BUDGET);
			assert.deepEqual(data.subarray(offset + 69, offset + original.length), original.subarray(69));
		} else {
			assert.equal(data.readUInt32LE(offset), 0xd281a807); // movz x7,#0xd40
			assert.equal(data.readUInt32LE(offset + 4), 0xf2a00067); // movk x7,#3,lsl 16
			assert.equal(data.readUInt32LE(offset + 8), 0x1400000c); // b to following cbz
			assert.deepEqual(data.subarray(offset + 12, offset + original.length), original.subarray(12));
		}
	});
	test(`${arch} rejects missing, ambiguous, and altered selectors`, () => {
		assert.throws(() => patchCustomizationBudgetBody(Buffer.alloc(128), arch), /found 0/);
		assert.throws(() => patchCustomizationBudgetBody(Buffer.concat([original, Buffer.alloc(4), original]), arch), /found 2/);
		const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
		assert.throws(() => patchCustomizationBudgetBody(changed, arch), /found 0/);
	});
}

test.skipIf(!process.env.REALAGY_BUDGET_FIXTURES)("optional official binaries accept the selector and preserve installed bytes", () => {
	const files = process.env.REALAGY_BUDGET_FIXTURES?.split(",").filter(Boolean) ?? [];
	for (const file of files) {
		const original = fs.readFileSync(file);
		const patched = patchAgyCustomizationBudget(original);
		assert.notDeepEqual(patched.data, original);
		assert.deepEqual(patchAgyCustomizationBudget(patched.data).data, patched.data);
		assert.deepEqual(fs.readFileSync(file), original);
	}
});
