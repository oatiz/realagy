// The output decorator is only the first MCP clamp. Both trajectory converters
// also limit each rendered tool result. Bypass only MCP (legacy oneof 47,
// Cortex step 132), preserving every other type's limit and USER_INPUT policy.
// Verified against official agy 1.5.9 Linux/Windows x64 and macOS arm64.
import { buildGoFunctions, findGoText } from "./go-symbols.js";
import { inspectExecutable, type BinaryArch } from "./binary-image.js";

const SERIALIZER = "serializers.DefaultSerializer.stepToMessage";
const LEGACY = "chatconverters.(*TrajectoryChatConverter).getMaxTokensForStep";
const hex = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ""), "hex");
const word = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const words = (...ns: number[]): Buffer => Buffer.concat(ns.map(word));
const NOP_ARM = 0xd503201f;

function fail(message: string): never {
	throw new Error(`Cannot derive full-MCP-output agy: ${message}; no bytes were written.`);
}

// A tiny label assembler for bounded replacements; no code caves, new sections,
// stack layout changes, or additional calls. All branches stay inside the slot.
class Slot {
	bytes: number[] = [];
	labels = new Map<string, number>();
	fixups: Array<{ at: number; label: string; arm?: number }> = [];
	put(b: Buffer): void { this.bytes.push(...b); }
	label(name: string): void { this.labels.set(name, this.bytes.length); }
	jump(op: number, label: string): void {
		this.bytes.push(op, 0); this.fixups.push({ at: this.bytes.length - 2, label });
	}
	branch(op: number, label: string): void {
		this.fixups.push({ at: this.bytes.length, label, arm: op }); this.put(word(op));
	}
	finish(size: number, arm = false): Buffer {
		if (this.bytes.length > size) fail("MCP selector replacement does not fit");
		while (this.bytes.length < size) this.put(arm ? word(NOP_ARM) : hex("90"));
		this.label("end");
		const out = Buffer.from(this.bytes);
		for (const f of this.fixups) {
			const to = this.labels.get(f.label);
			if (to === undefined) fail("unresolved MCP selector branch");
			if (f.arm !== undefined) {
				const delta = to - f.at;
				if (delta % 4 !== 0) fail("unaligned MCP selector branch");
				const b = f.arm === 0x14000000
					? f.arm | ((delta / 4) & 0x03ffffff)
					: f.arm | (((delta / 4) & 0x7ffff) << 5);
				out.writeUInt32LE(b >>> 0, f.at);
			} else {
				const delta = to - f.at - 2;
				if (delta < -128 || delta > 127) fail("MCP selector branch out of range");
				out.writeInt8(delta, f.at + 1);
			}
		}
		return out;
	}
}

const X64_SERIALIZER = hex("83fa0e750a488bbc2438020000eb1183fa17750431ffeb08488bbc2430020000");
const ARM_SERIALIZER = words(0x710038bf, 0x540000c0, 0x71005cbf, 0x54000061, 0xaa1f03e4, 0x14000002, 0xaa0303e4);
const X64_LEGACY = hex("83f808740583f8137526488b4c2420488b094885c97412488b49780f1f4400004885c974048b09eb0231c94863c9eb05488b4c2408");
const ARM_LEGACY = words(
	0x7100201f, 0x54000060, 0x71004c1f, 0x54000161,
	0xf94017e1, 0xf9400021, 0xb40000a1, 0xf9403c21,
	0xb4000061, 0xb9800021, 0x14000002, 0xaa1f03e1,
	0x93407c22, 0x14000002, 0xf9400be2,
);

function serializerSlot(arch: BinaryArch, unlocked: boolean): Buffer {
	const s = new Slot();
	if (arch === "arm64") {
		// x4 already holds the user limit, x3 the ordinary step limit, w5 type.
		s.put(words(0x710038bf, unlocked ? 0x9a8303e4 : 0x9a830084)); // cmp 14; csel
		s.put(words(0x71005cbf, 0x9a8403e4)); // step 23 keeps its native zero limit
		s.put(words(0x710210bf, 0x9a8403e4)); // cmp 132; csel x4,xzr,x4,eq
		return s.finish(ARM_SERIALIZER.length, true);
	}
	if (unlocked) {
		s.put(hex("31ff83fa0e")); s.jump(0x74, "end");
		s.put(hex("83fa17")); s.jump(0x74, "end");
		s.put(hex("81fa84000000")); s.jump(0x74, "end");
		s.put(hex("488bbc2430020000"));
	} else {
		// Subtracting 23 makes both comparisons fit signed imm8. EDX is dead
		// at the merge; RDI alone carries the selected cap to the native test.
		s.put(hex("31ff83ea17")); s.jump(0x74, "end");
		s.put(hex("83fa6d")); s.jump(0x74, "end");
		s.put(hex("488bbc243002000083faf7480f44bc2438020000"));
	}
	return s.finish(X64_SERIALIZER.length);
}

function legacySlot(arch: BinaryArch, unlocked: boolean): Buffer {
	const s = new Slot();
	if (arch === "arm64") {
		s.put(word(0x7100bc1f)); s.branch(0x54000000, "zero"); // WhichStep == 47
		s.put(word(0x7100201f));
		if (unlocked) {
			s.branch(0x54000000, "zero");
			s.put(word(0x71004c1f)); s.branch(0x54000000, "zero");
		} else {
			// cmp 8; ccmp 19,#Z,ne combines the two native USER_INPUT cases.
			s.put(word(0x7a531804)); s.branch(0x54000001, "ordinary");
			s.put(words(0xf94017e1, 0xf9400021));
			s.branch(0xb4000001, "zero"); // cbz x1
			s.put(word(0xf9403c21)); s.branch(0xb4000001, "zero");
			s.put(word(0xb9800022)); s.branch(0x14000000, "end"); // ldrsw x2,[x1]
		}
		if (unlocked) s.branch(0x14000000, "ordinary");
		s.label("zero"); s.put(word(0xaa1f03e2)); s.branch(0x14000000, "end");
		s.label("ordinary"); s.put(word(0xf9400be2));
		return s.finish(ARM_LEGACY.length, true);
	}
	s.put(hex("83f82f")); s.jump(0x74, "zero");
	s.put(hex("83f808")); s.jump(0x74, unlocked ? "zero" : "user");
	s.put(hex("83f813")); s.jump(unlocked ? 0x74 : 0x75, unlocked ? "zero" : "ordinary");
	if (!unlocked) {
		s.label("user"); s.put(hex("488b4c2420488b094885c9")); s.jump(0x74, "zero");
		s.put(hex("488b49784885c9")); s.jump(0x74, "zero");
		s.put(hex("486309")); s.jump(0xeb, "end"); // load + sign extend directly
	}
	s.label("ordinary"); s.put(hex("488b4c2408")); s.jump(0xeb, "end");
	s.label("zero"); s.put(hex("31c9")); s.jump(0xeb, "end");
	return s.finish(X64_LEGACY.length);
}

/** Pure, bounded function-body patch, exported for native-vector regression tests. */
export function patchMcpLimitBody(body: Buffer, arch: BinaryArch, kind: "serializer" | "legacy", userInputUnlocked: boolean): { data: Buffer; offset: number } {
	const patterns = arch === "arm64"
		? { serializer: ARM_SERIALIZER, legacy: ARM_LEGACY }
		: { serializer: X64_SERIALIZER, legacy: X64_LEGACY };
	const original = Buffer.from(patterns[kind]);
	if (userInputUnlocked) {
		if (kind === "serializer") {
			if (arch === "arm64") original.writeUInt32LE(0x54000060, 4);
			else original.set(hex("31ff909090909090"), 5);
		} else if (arch === "arm64") {
			original.set(words(0xaa1f03e2, 0x1400000a), 16);
		} else {
			original.set(hex("31c0e927000000"), 10);
		}
	}
	const replacement = kind === "serializer" ? serializerSlot(arch, userInputUnlocked) : legacySlot(arch, userInputUnlocked);
	// Require the native merge instruction too. A coincidental byte sequence
	// elsewhere in a function must not be accepted as a valid selector.
	const merges = arch === "arm64"
		? { serializer: word(0xf100009f), legacy: word(0xaa0203e0) }
		: { serializer: hex("4885ff"), legacy: hex("4889c8") };
	const merge = merges[kind];
	const matches: number[] = [];
	for (let at = 0; at + original.length + merge.length <= body.length; at += arch === "arm64" ? 4 : 1) {
		if (!body.subarray(at + original.length, at + original.length + merge.length).equals(merge)) continue;
		if (body.subarray(at, at + original.length).equals(original) || body.subarray(at, at + original.length).equals(replacement)) matches.push(at);
	}
	const [offset] = matches;
	if (matches.length !== 1 || offset === undefined) fail(`${kind} MCP limit selector: expected one verified ${arch} layout, found ${matches.length}`);
	const data = Buffer.from(body);
	replacement.copy(data, offset);
	return { data, offset };
}

export interface McpSerializationPatchResult {
	data: Buffer;
	gates: Array<{ function: string; offset: number }>;
}

/** Resolve only verified Go functions; never scan unrelated executable bytes. */
export function patchMcpSerialization(source: Buffer, userInputUnlocked = false): McpSerializationPatchResult {
	const text = findGoText(source);
	const functions = buildGoFunctions(source);
	const image = inspectExecutable(source);
	const data = Buffer.from(source);
	const gates: McpSerializationPatchResult["gates"] = [];
	for (const [name, kind] of [[LEGACY, "legacy"], [SERIALIZER, "serializer"]] as const) {
		const fn = functions.get(name);
		if (!fn) {
			if (kind === "legacy" && functions.has(SERIALIZER)) continue;
			fail(`required MCP serializer symbol not found: ${name}`);
		}
		const offset = text.textOff + fn.entryOff;
		if (fn.size <= 0 || offset < 0 || offset + fn.size > data.length) fail(`invalid function range: ${name}`);
		if (!image.executable.some((region) => offset >= region.offset && offset + fn.size <= region.offset + region.size)) {
			fail(`MCP serializer function is outside executable code: ${name}`);
		}
		const patched = patchMcpLimitBody(data.subarray(offset, offset + fn.size), text.arch, kind, userInputUnlocked);
		patched.data.copy(data, offset);
		gates.push({ function: name, offset: offset + patched.offset });
	}
	return { data, gates };
}
