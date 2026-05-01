/**
 * aws-corp provider — wraps streamBedrock with SSO credentials.
 * Uses AWS SDK credential-provider-sso + OIDC device auth (no AWS CLI dependency).
 *
 * Env vars: AWS_CORP_PROFILE (required), AWS_CORP_REGION (default: us-east-1)
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { parseKnownFiles, loadSsoSessionData, getSSOTokenFromFile } from "@smithy/shared-ini-file-loader";
import { type BedrockOptions, streamBedrock } from "./amazon-bedrock";
import type { AssistantMessageEventStream, Context, Model, StreamFunction } from "../types";

const log = (msg: string) => console.error("[aws-corp] " + msg);

function env(k: string): string {
	return Bun.env[k] || process.env[k] || "";
}

function getProfile(): string {
	return env("AWS_CORP_PROFILE") || env("AWS_CORP_SSO_SESSION") || "";
}

function getRegion(): string {
	return env("AWS_CORP_REGION") || "us-east-1";
}

let credsExpiry = 0;

// ── SSO config resolution ──────────────────────────────────────────────

interface SsoInfo {
	ssoSession: string;
	startUrl: string;
	ssoRegion: string;
	accountId: string;
}

async function resolveSsoInfo(): Promise<SsoInfo | null> {
	const profile = getProfile();
	if (!profile) return null;
	try {
		const profiles = await parseKnownFiles({});
		const p = profiles[profile];
		if (!p?.sso_session) return null;
		const sessions = await loadSsoSessionData({});
		const s = sessions[p.sso_session];
		if (!s) return null;
		return {
			ssoSession: p.sso_session,
			startUrl: s.sso_start_url || "",
			ssoRegion: s.sso_region || "us-east-1",
			accountId: p.sso_account_id || "",
		};
	} catch {
		return null;
	}
}

// Cache resolved account ID for ARN construction
let _accountId = "";

async function getAccountId(): Promise<string> {
	if (_accountId) return _accountId;
	const info = await resolveSsoInfo();
	if (info?.accountId) _accountId = info.accountId;
	return _accountId;
}

/** Convert short profile ID to full inference profile ARN */
function toInferenceProfileArn(modelId: string, region: string, accountId: string): string {
	if (modelId.startsWith("arn:")) return modelId; // already an ARN
	return `arn:aws:bedrock:${region}:${accountId}:inference-profile/${modelId}`;
}

// ── Credential storage (module-scoped, not in process.env) ─────────────

interface CorpCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
}

let _corpCreds: CorpCredentials | null = null;

/** Get current corp credentials without polluting process.env */
export function getCorpCredentials(): CorpCredentials | null {
	return _corpCreds;
}

async function tryLoadCredentials(): Promise<boolean> {
	const profile = getProfile();
	if (!profile) return false;
	try {
		const creds = await fromSSO({ profile })();
		if (!creds.accessKeyId) return false;
		_corpCreds = {
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
			sessionToken: creds.sessionToken || "",
		};
		// Do NOT set process.env — subprocesses should not inherit corp credentials
		delete process.env.AWS_PROFILE;
		delete Bun.env.AWS_PROFILE;
		credsExpiry = Date.now() + 50 * 60 * 1000;
		return true;
	} catch {
		return false;
	}
}

// ── OIDC device authorization flow (replaces `aws sso login`) ──────────

function oidcEndpoint(region: string): string {
	return `https://oidc.${region}.amazonaws.com`;
}

async function oidcPost(url: string, body: Record<string, unknown>): Promise<any> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`OIDC ${res.status}: ${text}`);
	}
	return res.json();
}

function ssoTokenCachePath(sessionName: string): string {
	const hash = createHash("sha1").update(sessionName).digest("hex");
	return join(homedir(), ".aws", "sso", "cache", `${hash}.json`);
}

function openBrowser(url: string): void {
	try {
		if (process.platform === "win32") {
			spawnSync("cmd", ["/c", "start", "", url], { windowsHide: true });
		} else if (process.platform === "darwin") {
			spawnSync("open", [url]);
		} else {
			spawnSync("xdg-open", [url]);
		}
	} catch {}
}

function clientCachePath(region: string): string {
	return join(homedir(), ".aws", "sso", "cache", `omp-client-${region}.json`);
}

async function getOrRegisterClient(base: string, region: string): Promise<{ clientId: string; clientSecret: string; clientSecretExpiresAt: number }> {
	const cachePath = clientCachePath(region);
	// Try cached registration
	try {
		const cached = JSON.parse(await Bun.file(cachePath).text());
		if (cached.clientId && cached.clientSecret && cached.clientSecretExpiresAt * 1000 > Date.now() + 60000) {
			return cached;
		}
	} catch {}

	// Register new client
	log("registering OIDC client...");
	const reg = await oidcPost(`${base}/client/register`, {
		clientName: "omp-aws-corp",
		clientType: "public",
		scopes: ["sso:account:access"],
	});
	// Cache for reuse (valid ~90 days)
	try {
		mkdirSync(join(homedir(), ".aws", "sso", "cache"), { recursive: true });
		writeFileSync(cachePath, JSON.stringify({
			clientId: reg.clientId,
			clientSecret: reg.clientSecret,
			clientSecretExpiresAt: reg.clientSecretExpiresAt,
		}));
	} catch {}
	return reg;
}

async function deviceAuthLogin(info: SsoInfo): Promise<boolean> {
	const base = oidcEndpoint(info.ssoRegion);

	// Step 1: Get or register client (cached to avoid repeated consent)
	const { clientId, clientSecret, clientSecretExpiresAt } = await getOrRegisterClient(base, info.ssoRegion);

	// Step 2: Start device authorization
	const auth = await oidcPost(`${base}/device_authorization`, {
		clientId,
		clientSecret,
		startUrl: info.startUrl,
	});
	const { deviceCode, verificationUriComplete, userCode, interval: pollInterval, expiresIn } = auth;

	// Step 3: Open browser
	console.error(`[aws-corp] Authorize this device: ${verificationUriComplete}`);
	if (userCode) console.error(`[aws-corp] Confirmation code: ${userCode}`);
	openBrowser(verificationUriComplete);

	// Step 4: Poll for token
	const intervalMs = ((pollInterval || 5) + 1) * 1000; // add 1s buffer
	const deadline = Date.now() + (expiresIn || 600) * 1000;

	while (Date.now() < deadline) {
		Bun.sleepSync(intervalMs);
		try {
			const token = await oidcPost(`${base}/token`, {
				clientId,
				clientSecret,
				deviceCode,
				grantType: "urn:ietf:params:oauth:grant-type:device_code",
			});

			// Step 5: Write token to cache
			const cacheData = {
				startUrl: info.startUrl,
				region: info.ssoRegion,
				accessToken: token.accessToken,
				expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
				clientId,
				clientSecret,
				registrationExpiresAt: new Date(clientSecretExpiresAt * 1000).toISOString(),
				refreshToken: token.refreshToken,
			};
			const cachePath = ssoTokenCachePath(info.ssoSession);
			mkdirSync(join(homedir(), ".aws", "sso", "cache"), { recursive: true });
			writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
			log("SSO login succeeded, token cached");
			return true;
		} catch (e: any) {
			const body = e.message || "";
			if (body.includes("authorization_pending") || body.includes("slow_down")) {
				continue; // user hasn't authorized yet
			}
			log("token poll error: " + body);
			return false;
		}
	}

	log("device authorization timed out");
	return false;
}

// ── Main credential flow ───────────────────────────────────────────────

async function ssoLogin(): Promise<boolean> {
	const info = await resolveSsoInfo();
	if (!info?.startUrl) {
		log("cannot resolve SSO config for profile: " + getProfile());
		return false;
	}
	log("SSO token expired or missing");
	try {
		if (await deviceAuthLogin(info)) {
			return await tryLoadCredentials();
		}
	} catch (e: any) {
		log("device auth failed: " + (e.message || e));
	}
	return false;
}

let _credentialPromise: Promise<boolean> | null = null;

async function ensureCredentials(): Promise<boolean> {
	if (Date.now() < credsExpiry) return true;

	// Prevent concurrent auth flows
	if (_credentialPromise) return _credentialPromise;

	_credentialPromise = (async () => {
		try {
			// Resolve account ID for ARN construction
			if (!_accountId) await getAccountId();
			if (await tryLoadCredentials()) {
				return true;
			}
			if (await ssoLogin()) {
				return true;
			}
			console.error("[aws-corp] Failed to obtain credentials. Ensure SSO is configured for profile: " + getProfile());
			return false;
		} finally {
			_credentialPromise = null;
		}
	})();

	return _credentialPromise;
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
	const region = getRegion();
	// Construct full inference profile ARN for corp accounting
	const modelIdOverride = _accountId ? toInferenceProfileArn(model.id, region, _accountId) : undefined;
	return streamBedrock(model, context, { ...options, region, profile: undefined, modelIdOverride });
};
