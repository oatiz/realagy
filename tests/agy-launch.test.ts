import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { resolveAgyLaunch } from "../src/acp/agy-launch.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "realagy homebrew ")); roots.push(root);
	const version = path.join(root, "Caskroom", "antigravity-cli", "1.5.9,4515810895593472");
	const wrapper = path.join(version, ".homebrew-command-wrappers", "agy");
	const target = path.join(version, "antigravity");
	const link = path.join(root, "bin", "agy");
	fs.mkdirSync(path.dirname(wrapper), { recursive: true }); fs.mkdirSync(path.dirname(link), { recursive: true });
	fs.writeFileSync(target, "native placeholder", { mode: 0o755 });
	const write = (body: string) => fs.writeFileSync(wrapper, body, { mode: 0o755 });
	write(`#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "${target}"  "$@"\n`);
	fs.symlinkSync(wrapper, link);
	return { root, version, wrapper, target, link, write };
}

test("resolve Homebrew 1.5.9 wrapper through PATH or AGY_BIN symlink and retain updater policy", () => {
	const f = fixture();
	for (const source of [f.link, f.wrapper]) {
		assert.deepEqual(resolveAgyLaunch(source), { bin: f.target, wrapper: source, extraEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } });
	}
	assert.deepEqual(resolveAgyLaunch(f.target), { bin: f.target });
	assert.deepEqual(resolveAgyLaunch(path.join(f.root, "missing")), { bin: path.join(f.root, "missing") });
});

test("fail closed on modified wrappers without executing shell code or guessing the target", () => {
	const f = fixture();
	for (const body of [
		`#!/bin/bash\nexec "${f.target}" "$@"\n`,
		`#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "${f.target}" --flag "$@"\n`,
		`#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "${f.target}" "$@"\ntouch ${f.root}/executed\n`,
		`#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "$(touch ${f.root}/executed)" "$@"\n`,
		`#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "/tmp/other" "$@"\n`,
	]) {
		f.write(body);
		assert.throws(() => resolveAgyLaunch(f.link), /unsupported command-wrapper contents.*AGY_BIN/);
		assert.equal(fs.existsSync(path.join(f.root, "executed")), false);
	}
});

test("missing native target is actionable; unrelated shell scripts are left alone", () => {
	const f = fixture(); fs.unlinkSync(f.target);
	assert.throws(() => resolveAgyLaunch(f.link), /native target is missing or not executable/);
	const script = path.join(f.root, "custom-agy"); fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
	assert.deepEqual(resolveAgyLaunch(script), { bin: script });
});

test("driver derives the native Homebrew target and forwards its updater environment", async () => {
	const f = fixture();
	const capture = path.join(f.root, "requests.ndjson");
	fs.writeFileSync(capture, "");
	const fakeServer = path.resolve("tests/helpers/fake-acp-server.mjs");
	const derived = path.join(f.root, "derived");
	fs.writeFileSync(derived, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeServer)} ${JSON.stringify(capture)} "$@"\n`, { mode: 0o755 });
	let derivedFrom = "";
	const { AcpDriver } = await import("../src/acp/driver.js");
	const driver = new AcpDriver({
		bin: f.link, noAutoCompaction: false,
		extraEnv: { FAKE_ACP_RECORD_AGY_ENV: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "false" },
		deriveBin: async (source) => { derivedFrom = source; return derived; },
	});
	try {
		assert.ok((await driver.listModels(f.root)).length > 0);
		assert.equal(derivedFrom, f.target);
		const records = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.find((item) => item.method === "agy-env")?.params, { disableAutoUpdate: "true" });
	} finally { await driver.close(); }
});
