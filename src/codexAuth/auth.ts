import { getLocalParentPath, joinLocalPath } from "../utils/localPath";

export const CODEX_DIRECT_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_DIRECT_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models?client_version=0.0.0";

const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type IOUtilsLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type OSFileLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type ProcessLike = { env?: Record<string, string | undefined> };
type PathUtilsLike = { homeDir?: string };
type ServicesLike = {
  dirsvc?: {
    get?: (key: string, iface?: unknown) => { path?: string } | undefined;
  };
};
type OSLike = { Constants?: { Path?: { homeDir?: string } } };

type CodexTokenData = Record<string, unknown> & {
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
};

export type CodexAuthJson = Record<string, unknown> & {
  tokens?: CodexTokenData;
  last_refresh?: string;
};

export type CodexAuthSession = {
  token: string;
  refreshToken: string;
  accountId?: string;
  authPath: string;
};

export type CodexAuthDependencies = {
  authPath?: string;
  fetchFn?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, content: string) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  const direct = (globalThis as { IOUtils?: IOUtilsLike }).IOUtils;
  if (direct?.read) return direct;
  const toolkit = ztoolkit.getGlobal("IOUtils") as IOUtilsLike | undefined;
  return toolkit?.read ? toolkit : undefined;
}

function getOSFile(): OSFileLike | undefined {
  const direct = (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
  if (direct?.read) return direct;
  const toolkit = ztoolkit.getGlobal("OS") as { File?: OSFileLike } | undefined;
  return toolkit?.File?.read ? toolkit.File : undefined;
}

function getProcess(): ProcessLike | undefined {
  const direct = (globalThis as { process?: ProcessLike }).process;
  if (direct?.env) return direct;
  const toolkit = ztoolkit.getGlobal("process") as ProcessLike | undefined;
  return toolkit?.env ? toolkit : undefined;
}

function getNsIFile(): unknown {
  const ci = (globalThis as { Ci?: { nsIFile?: unknown } }).Ci;
  if (ci?.nsIFile) return ci.nsIFile;
  return (
    globalThis as {
      Components?: { interfaces?: { nsIFile?: unknown } };
    }
  ).Components?.interfaces?.nsIFile;
}

function resolveHomeDir(): string {
  const env = getProcess()?.env;
  const pathUtils = (globalThis as { PathUtils?: PathUtilsLike }).PathUtils;
  const toolkitPathUtils = ztoolkit.getGlobal("PathUtils") as
    | PathUtilsLike
    | undefined;
  const os = (globalThis as { OS?: OSLike }).OS;
  const toolkitOS = ztoolkit.getGlobal("OS") as OSLike | undefined;
  const services = (globalThis as { Services?: ServicesLike }).Services;
  const toolkitServices = ztoolkit.getGlobal("Services") as
    | ServicesLike
    | undefined;
  const home =
    env?.HOME?.trim() ||
    env?.USERPROFILE?.trim() ||
    pathUtils?.homeDir?.trim() ||
    toolkitPathUtils?.homeDir?.trim() ||
    os?.Constants?.Path?.homeDir?.trim() ||
    toolkitOS?.Constants?.Path?.homeDir?.trim() ||
    services?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
    toolkitServices?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
    (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim();
  if (!home) throw new Error("Unable to resolve HOME directory for Codex auth");
  return home;
}

export function resolveCodexAuthPath(): string {
  const codexHome = getProcess()?.env?.CODEX_HOME?.trim();
  if (codexHome) return joinLocalPath(codexHome, "auth.json");
  return joinLocalPath(resolveHomeDir(), ".codex", "auth.json");
}

function coerceBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function defaultReadText(path: string): Promise<string> {
  const io = getIOUtils();
  if (io?.read) {
    return new TextDecoder("utf-8").decode(coerceBytes(await io.read(path)));
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    return new TextDecoder("utf-8").decode(
      coerceBytes(await osFile.read(path)),
    );
  }
  throw new Error("No file API available to read Codex auth");
}

async function ensureParentDirectory(path: string): Promise<void> {
  const parent = getLocalParentPath(path);
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(parent, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(parent, {
      from: getLocalParentPath(parent),
      ignoreExisting: true,
    });
    return;
  }
}

async function defaultWriteText(path: string, content: string): Promise<void> {
  await ensureParentDirectory(path);
  const data = new TextEncoder().encode(content);
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, data);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, data);
    return;
  }
  throw new Error("No file API available to persist Codex auth");
}

function getFetch(dependencies?: CodexAuthDependencies): typeof fetch {
  if (dependencies?.fetchFn) return dependencies.fetchFn;
  const toolkitFetch = ztoolkit.getGlobal("fetch") as typeof fetch | undefined;
  if (toolkitFetch) return toolkitFetch;
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  throw new Error("fetch is unavailable for Codex auth");
}

export async function loadCodexAuthJson(
  dependencies: CodexAuthDependencies = {},
): Promise<CodexAuthJson | null> {
  const authPath = dependencies.authPath || resolveCodexAuthPath();
  try {
    const raw = await (dependencies.readText || defaultReadText)(authPath);
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as CodexAuthJson;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function refreshCodexAuthSession(
  session: CodexAuthSession,
  options: CodexAuthDependencies & { signal?: AbortSignal } = {},
): Promise<CodexAuthSession> {
  if (!session.refreshToken) {
    throw new Error(
      "codex auth refresh token missing. Please run `codex login` to restore ~/.codex/auth.json.",
    );
  }
  const response = await getFetch(options)(CODEX_REFRESH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Codex token refresh failed: ${response.status} ${response.statusText} - ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as unknown as Record<string, unknown>;
  const token = normalizeToken(payload.access_token);
  if (!token)
    throw new Error("Codex token refresh returned empty access token");
  const refreshToken =
    normalizeToken(payload.refresh_token) || session.refreshToken;
  const dependencies = { ...options, authPath: session.authPath };
  const current = (await loadCodexAuthJson(dependencies)) || {};
  const tokens: CodexTokenData = {
    ...(current.tokens || {}),
    access_token: token,
    refresh_token: refreshToken,
  };
  const nextAuth: CodexAuthJson = {
    ...current,
    tokens,
    last_refresh: new Date().toISOString(),
  };
  await (options.writeText || defaultWriteText)(
    session.authPath,
    `${JSON.stringify(nextAuth, null, 2)}\n`,
  );
  return {
    token,
    refreshToken,
    authPath: session.authPath,
    ...(normalizeToken(tokens.account_id)
      ? { accountId: normalizeToken(tokens.account_id) }
      : {}),
  };
}

export async function resolveCodexAuthSession(
  options: CodexAuthDependencies & { signal?: AbortSignal } = {},
): Promise<CodexAuthSession> {
  const authPath = options.authPath || resolveCodexAuthPath();
  const auth = await loadCodexAuthJson({ ...options, authPath });
  const token = normalizeToken(auth?.tokens?.access_token);
  const refreshToken = normalizeToken(auth?.tokens?.refresh_token);
  const accountId = normalizeToken(auth?.tokens?.account_id);
  const session: CodexAuthSession = {
    token,
    refreshToken,
    authPath,
    ...(accountId ? { accountId } : {}),
  };
  if (token) return session;
  if (refreshToken) return refreshCodexAuthSession(session, options);
  throw new Error(
    "codex auth token not found. Please run `codex login` and ensure ~/.codex/auth.json is available.",
  );
}

export function buildCodexAuthHeaders(
  session: Pick<CodexAuthSession, "token" | "accountId">,
  base: Record<string, string> = {},
): Record<string, string> {
  return {
    ...base,
    Authorization: `Bearer ${session.token}`,
    ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
  };
}

export function isTrustedCodexBackendUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      (url.pathname === "/backend-api/codex/models" ||
        url.pathname === "/backend-api/codex/responses")
    );
  } catch (_error) {
    return false;
  }
}

export async function fetchWithCodexAuth(
  url: string,
  init: RequestInit = {},
  options: CodexAuthDependencies & { signal?: AbortSignal } = {},
): Promise<Response> {
  if (!isTrustedCodexBackendUrl(url)) {
    throw new Error("Refusing to send Codex credentials to an untrusted URL");
  }
  const fetchFn = getFetch(options);
  let session = await resolveCodexAuthSession(options);
  const send = (current: CodexAuthSession) =>
    fetchFn(url, {
      ...init,
      headers: buildCodexAuthHeaders(current, {
        ...Object.fromEntries(new Headers(init.headers).entries()),
      }),
      signal: options.signal || init.signal,
    });
  let response = await send(session);
  if (response.status === 401 && session.refreshToken) {
    session = await refreshCodexAuthSession(session, options);
    response = await send(session);
  }
  return response;
}
