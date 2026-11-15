// agy 1.5.9 budgets MCP declarations alongside other non-rule customizations.
// A large eager Pi catalog can therefore silently lose tools. Raise that budget
// in the private derivative only; the separate rules budget is untouched.
import { inspectExecutable, type BinaryArch } from "./binary-image.js";
import { buildGoFunctions, findGoText } from "./go-symbols.js";

const FUNCTION = "customizations.(*Manager).computeTruncatedCustomizations";
export const CUSTOMIZATION_BUDGET = 200_000;
const bytes = (hex: string): Buffer => Buffer.from(hex, "hex");
// These include the following rules-budget selector's entry, so an accidental
// match elsewhere or a changed branch target is rejected rather than patched.
const X64 = bytes("4585c97e374885d274064c8b4a08eb034531c94d85c974194d8b89000100004d85c97408458b094885d2eb194885d2eb034885d241b900000000eb094885d241b9204e000074084c8b52086690eb03");
const ARM64 = bytes("ff0000718d010054660000b4c70440f902000014e7031faaa70000b4e78040f9670000b4e70080b904000014e7031faa0200001407c489d2660000b4c80440f9");

/** Patch the complete selector, recognizing both native and our exact result. */
export function patchCustomizationBudgetBody(body: Buffer, arch: BinaryArch): { data: Buffer; offset: number } {
	const original = arch === "arm64" ? ARM64 : X64;
	const replacement = Buffer.from(original);
	if (arch === "arm64") {
		// movz/movk x7,200000; b to the following rules selector. The
		// remaining unreachable instructions are kept as verification context.
		replacement.set(bytes("07a881d26700a0f20c000014"), 0);
	} else {
		// Route both the configured and default paths through the raised default.
		replacement[3] = 0xeb;
		replacement.writeUInt32LE(CUSTOMIZATION_BUDGET, 65);
	}
	const matches: number[] = [];
	for (let i = 0; i + original.length <= body.length; i += arch === "arm64" ? 4 : 1) {
		const candidate = body.subarray(i, i + original.length);
		if (candidate.equals(original) || candidate.equals(replacement)) matches.push(i);
	}
	const offset = matches[0];
	if (matches.length !== 1 || offset === undefined) throw new Error(`Cannot derive customization-budget agy: expected one verified ${arch} selector, found ${matches.length}; no bytes were written.`);
	const data = Buffer.from(body);
	replacement.copy(data, offset);
	return { data, offset };
}

export function patchAgyCustomizationBudget(source: Buffer): { data: Buffer; offset: number } {
	const text = findGoText(source);
	const image = inspectExecutable(source);
	const fn = buildGoFunctions(source).get(FUNCTION);
	if (!fn) throw new Error(`Cannot derive customization-budget agy: missing ${FUNCTION}; no bytes were written.`);
	const start = text.textOff + fn.entryOff;
	if (fn.size <= 0 || start < 0 || start + fn.size > source.length) throw new Error("Cannot derive customization-budget agy: invalid function range; no bytes were written.");
	const patch = patchCustomizationBudgetBody(source.subarray(start, start + fn.size), image.arch);
	const data = Buffer.from(source);
	patch.data.copy(data, start);
	return { data, offset: start + patch.offset };
}
