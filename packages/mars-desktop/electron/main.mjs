import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_VERSION = 1;
const gatewayHttpUrl = process.env.MARS_GATEWAY_HTTP_URL || "http://127.0.0.1:3037";

function providerPaths() {
  return {
    configPath: join(app.getPath("home"), ".mars", "config", `v${CONFIG_VERSION}`, "provider.json"),
    secretPath: join(app.getPath("userData"), "secrets", "provider-api-key.bin"),
  };
}

function normalizeProvider(input) {
  if (!input || typeof input !== "object") throw new Error("Provider configuration is required");
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!apiKey || !modelId || !baseUrl) throw new Error("apiKey, modelId, and baseUrl are required");
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("Provider endpoint must use http or https");
  }
  return { apiKey, modelId, baseUrl: parsedUrl.toString().replace(/\/$/, "") };
}

async function configureGatewayProvider(provider) {
  const response = await fetch(`${gatewayHttpUrl}/config/provider`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(provider),
    signal: AbortSignal.timeout(2_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || `Gateway provider setup failed (${response.status})`);
  }
  return body;
}

async function backupIfPresent(path) {
  try {
    await copyFile(path, `${path}.bak`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function saveProviderConfig(provider) {
  const { configPath } = providerPaths();
  await mkdir(dirname(configPath), { recursive: true });
  await backupIfPresent(configPath);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: CONFIG_VERSION,
        updatedAt: new Date().toISOString(),
        provider: { baseUrl: provider.baseUrl, modelId: provider.modelId },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(configPath, 0o600).catch(() => undefined);
}

function secureStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text") {
    return false;
  }
  return true;
}

async function saveProviderSecret(apiKey) {
  if (!secureStorageAvailable()) return false;
  const { secretPath } = providerPaths();
  await mkdir(dirname(secretPath), { recursive: true });
  await writeFile(secretPath, safeStorage.encryptString(apiKey), { mode: 0o600 });
  await chmod(secretPath, 0o600).catch(() => undefined);
  return true;
}

async function loadProviderConfig() {
  const { configPath } = providerPaths();
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed?.version !== CONFIG_VERSION || !parsed?.provider) return null;
    const { baseUrl, modelId } = parsed.provider;
    if (typeof baseUrl !== "string" || typeof modelId !== "string") return null;
    return { baseUrl, modelId };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    console.warn("[mars-desktop] could not read provider config", error);
    return null;
  }
}

async function loadProviderSecret() {
  if (!secureStorageAvailable()) return null;
  const { secretPath } = providerPaths();
  try {
    return safeStorage.decryptString(await readFile(secretPath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    console.warn("[mars-desktop] could not read provider secret", error);
    return null;
  }
}

async function restorePersistedProvider() {
  const [provider, apiKey] = await Promise.all([loadProviderConfig(), loadProviderSecret()]);
  if (!provider || !apiKey) return;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await configureGatewayProvider({ ...provider, apiKey });
      return;
    } catch (error) {
      if (attempt === 39) {
        console.warn("[mars-desktop] could not restore persisted provider", error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

ipcMain.handle("mars:configure-provider", async (_event, input) => {
  const provider = normalizeProvider(input);
  const gatewayProvider = await configureGatewayProvider(provider);
  await saveProviderConfig(provider);
  const secretPersisted = await saveProviderSecret(provider.apiKey);
  return { ...gatewayProvider, secretPersisted };
});

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 650,
    show: false,
    title: "Mars",
    backgroundColor: "#00000000",
    transparent: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? {
          vibrancy: "under-window",
          visualEffectState: "active",
          trafficLightPosition: { x: 18, y: 18 },
        }
      : { frame: false }),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  const rendererUrl = process.env.MARS_RENDERER_URL;
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(here, "../dist/renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  app.setName("Mars");
  await restorePersistedProvider();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
