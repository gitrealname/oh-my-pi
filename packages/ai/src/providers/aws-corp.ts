/**
 * aws-corp provider — wraps streamBedrock with SSO credentials.
 * Loads credentials via `aws configure export-credentials` at startup.
 * Auto-triggers `aws sso login` if token is expired.
 *
 * Env vars: AWS_CORP_PROFILE (required), AWS_CORP_REGION (default: us-east-1)
 */
import { execSync, spawnSync } from "node:child_process";
import { type BedrockOptions, streamBedrock } from "./amazon-bedrock";
import type { AssistantMessageEventStream, Context, Model, StreamFunction } from "../types";

const log = (msg: string) => console.error("[aws-corp] " + msg);

// Read from Bun.env (process.env diverges in Bun compiled binaries)
function env() {
	const profile = Bun.env.AWS_CORP_PROFILE || Bun.env.AWS_CORP_SSO_SESSION || process.env.AWS_CORP_PROFILE || process.env.AWS_CORP_SSO_SESSION || "";
	const session = Bun.env.AWS_CORP_SSO_SESSION || Bun.env.AWS_CORP_PROFILE || process.env.AWS_CORP_SSO_SESSION || process.env.AWS_CORP_PROFILE || "";
	const region = Bun.env.AWS_CORP_REGION || process.env.AWS_CORP_REGION || "us-east-1";
	return { profile, session, region };
}

let credsExpiry = 0;

function tryExportCredentials(): { ok: boolean; error?: string } {
	if (!env().profile) return { ok: false, error: "no profile" };
	try {
		const out = execSync(`aws configure export-credentials --profile ${env().profile} --format env-no-export`, {
			encoding: "utf-8", timeout: 30000, windowsHide: true,
		});
		const lines = out.trim().split("\n");
		let gotKey = false;
		for (const line of lines) {
			const eq = line.indexOf("=");
			if (eq > 0) {
				const k = line.slice(0, eq).trim();
				const v = line.slice(eq + 1).trim();
				process.env[k] = v;
				Bun.env[k] = v;
				if (k === "AWS_ACCESS_KEY_ID") gotKey = true;
			}
		}
		if (!gotKey) return { ok: false, error: "export returned no AWS_ACCESS_KEY_ID" };
		delete process.env.AWS_PROFILE;
		delete Bun.env.AWS_PROFILE;
		credsExpiry = Date.now() + 50 * 60 * 1000;
		return { ok: true };
	} catch (e: any) {
		return { ok: false, error: e.stderr?.toString().trim() || e.message || "unknown" };
	}
}

function ssoLogin(): boolean {
	if (!env().session) return false;
	console.error("[aws-corp] SSO token expired. Logging in...");
	const result = spawnSync("aws", ["sso", "login", "--sso-session", env().session], {
		stdio: "inherit", timeout: 120000, windowsHide: false,
	});
	if (result.status !== 0) {
		log("SSO login failed, exit=" + result.status);
		return false;
	}
	log("SSO login succeeded");
	return true;
}

function ensureCredentials(): boolean {
	if (Date.now() < credsExpiry) return true;

	// Try immediately
	const first = tryExportCredentials();
	if (first.ok) { log("credentials loaded (direct)"); return true; }
	log("initial export failed: " + first.error);

	// Need SSO login
	if (!ssoLogin()) return false;

	// Poll for credentials — short sleep, check, back off
	const delays = [500, 1000, 2000, 3000, 5000];
	for (let i = 0; i < delays.length; i++) {
		log("waiting " + delays[i] + "ms then checking credentials (" + (i + 1) + "/" + delays.length + ")...");
		Bun.sleepSync(delays[i]);
		const result = tryExportCredentials();
		if (result.ok) { log("credentials loaded after attempt " + (i + 1)); return true; }
		log("attempt " + (i + 1) + " failed: " + result.error);
	}

	console.error("[aws-corp] Failed to obtain credentials after 5 attempts. Run: aws sso login --sso-session ai");
	return false;
}

// Deferred startup — module scope runs at compile time in bun --compile
setTimeout(() => {
	if (env().profile) ensureCredentials();
}, 0);

export const streamAwsCorp: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	const region = env().region;
	ensureCredentials();
	return streamBedrock(model, context, { ...options, region, profile: undefined });
};
