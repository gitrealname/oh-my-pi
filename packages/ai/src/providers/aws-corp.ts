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

function getProfile(): string {
	return Bun.env.AWS_CORP_PROFILE || Bun.env.AWS_CORP_SSO_SESSION || process.env.AWS_CORP_PROFILE || process.env.AWS_CORP_SSO_SESSION || "";
}

function getRegion(): string {
	return Bun.env.AWS_CORP_REGION || process.env.AWS_CORP_REGION || "us-east-1";
}

// Resolve sso-session name from profile via: aws configure get sso_session --profile <p>
let _ssoSession: string | null = null;
function getSsoSession(): string {
	if (_ssoSession !== null) return _ssoSession;
	const profile = getProfile();
	if (!profile) { _ssoSession = ""; return ""; }
	try {
		_ssoSession = execSync(`aws configure get sso_session --profile ${profile}`, {
			encoding: "utf-8", timeout: 10000, windowsHide: true,
		}).trim();
	} catch {
		_ssoSession = profile; // fallback: use profile name as session name
	}
	return _ssoSession;
}

let credsExpiry = 0;

function tryExportCredentials(): { ok: boolean; error?: string } {
	const profile = getProfile();
	if (!profile) return { ok: false, error: "no AWS_CORP_PROFILE" };
	try {
		const out = execSync(`aws configure export-credentials --profile ${profile} --format env-no-export`, {
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
	const session = getSsoSession();
	if (!session) return false;
	console.error("[aws-corp] SSO token expired. Logging in...");
	const result = spawnSync("aws", ["sso", "login", "--sso-session", session], {
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

	const first = tryExportCredentials();
	if (first.ok) { log("credentials loaded"); return true; }
	log("export failed: " + first.error);

	if (!ssoLogin()) return false;

	// Poll for credentials after login — back off
	const delays = [500, 1000, 2000, 3000, 5000];
	for (let i = 0; i < delays.length; i++) {
		Bun.sleepSync(delays[i]);
		const result = tryExportCredentials();
		if (result.ok) { log("credentials loaded after login"); return true; }
	}

	console.error("[aws-corp] Failed to obtain credentials. Run: aws sso login --profile " + getProfile());
	return false;
}

// Deferred startup — module scope runs at compile time in bun --compile
setTimeout(() => {
	if (getProfile()) ensureCredentials();
}, 0);

export const streamAwsCorp: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	ensureCredentials();
	return streamBedrock(model, context, { ...options, region: getRegion(), profile: undefined });
};
