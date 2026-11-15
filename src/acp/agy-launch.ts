// Homebrew's command_wrapper is a shell script, not the Mach-O/ELF image we
// can patch. Recognize the official antigravity-cli wrapper without executing
// it, and preserve the environment that disables agy's own updater.
import fs from "node:fs";
import path from "node:path";

export interface AgyLaunch {
	bin: string;
	extraEnv?: Record<string, string>;
	wrapper?: string;
}

/** Ordinary binaries/scripts remain unchanged (including test ACP servers).
 * Only Homebrew's known antigravity-cli command-wrapper layout is unwrapped. */
export function resolveAgyLaunch(source: string): AgyLaunch {
	let real: string;
	try { real = fs.realpathSync(source); } catch { return { bin: source }; }
	const wrapperDir = path.dirname(real);
	const versionDir = path.dirname(wrapperDir);
	if (path.basename(real) !== "agy" || path.basename(wrapperDir) !== ".homebrew-command-wrappers"
		|| path.basename(path.dirname(versionDir)) !== "antigravity-cli") return { bin: source };

	const target = path.join(versionDir, "antigravity");
	const fail = (reason: string): never => {
		throw new Error(`Cannot resolve Homebrew agy wrapper (${source}): ${reason}. Set AGY_BIN to the native executable ${target}, not the shell wrapper.`);
	};
	let content: string;
	try {
		if (fs.statSync(real).size > 16_384) return fail("wrapper exceeds the supported size");
		content = fs.readFileSync(real, "utf8");
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Cannot resolve Homebrew agy wrapper")) throw error;
		return fail("wrapper could not be read");
	}
	// Homebrew Pathname#write_env_script, cask antigravity-cli 1.5.9:
	// #!/bin/bash
	// AGY_CLI_DISABLE_AUTO_UPDATE="true" exec "<staged_path>/antigravity"  "$@"
	// Do not interpret substitutions, extra commands, arguments, or arbitrary
	// environment assignments. An unrecognized wrapper must not be guessed.
	const match = /^#!\/bin\/bash\r?\nAGY_CLI_DISABLE_AUTO_UPDATE="true"[ \t]+exec "([^"\r\n$`\\]+)"[ \t]+"\$@"[ \t]*(?:\r?\n)?$/.exec(content);
	if (!match || match[1] !== target) return fail("unsupported command-wrapper contents");
	try {
		fs.accessSync(target, fs.constants.X_OK);
		if (!fs.statSync(target).isFile()) return fail("native target is not a file");
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Cannot resolve Homebrew agy wrapper")) throw error;
		return fail("native target is missing or not executable");
	}
	return { bin: target, extraEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, wrapper: source };
}
