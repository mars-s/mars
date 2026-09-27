import { existsSync } from "node:fs";
import { join } from "node:path";
import { IZCodeTaskService, IPhoneRemoteService } from "@zcode/services";
import type {
  IPhoneRemoteService as IPhoneRemoteServiceType,
  PhoneRemotePairing,
  PhoneRemoteState,
  ServiceCollection,
} from "@zcode/services";
import { startPhoneRemoteServer, type PhoneRemoteServerHandle } from "./phoneRemoteServer.js";

/**
 * Task service methods that mean "a phone is driving this task right now".
 * Read-only browsing (list, snapshot polling) is deliberately excluded: opening
 * a task to look at it should not light up a badge claiming the phone owns it.
 */
const PHONE_DRIVEN_TASK_METHODS = [
  "sendPrompt",
  "enqueueTaskCommand",
  "promoteTaskCommand",
  "cancelTaskCommand",
  "stopGeneration",
  "compactSession",
  "goalSession",
  "respondPermission",
  "respondElicitation",
] as const;

export interface PhoneRemoteHostOptions {
  readonly services: ServiceCollection;
  readonly log?: (message: string) => void;
  /** Test seams. */
  readonly isPackaged?: () => boolean;
  readonly resourcesPath?: () => string | undefined;
  readonly repoRoot?: () => string | undefined;
}

/**
 * Where the phone-facing web client lives.
 *
 * Packaged builds read the copy staged next to the app by electron-builder
 * (`extraResources` with `to: "web"`). Dev runs point straight at the repo build
 * output, which is the same bytes, so a behaviour difference between the two
 * would be a bug in staging rather than something to branch around.
 */
export function resolvePhoneRemoteStaticRoot(
  options: {
    isPackaged?: () => boolean;
    resourcesPath?: () => string | undefined;
    repoRoot?: () => string | undefined;
  } = {},
): string {
  const root = resolvePhoneRemoteStaticRootPath(options);
  // A listening port with nothing to serve produces a blank page on the phone
  // and a QR that looks perfectly valid, so fail here where the reason is known.
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(
      `Phone remote control has no web client to serve at ${root}. Build it with: pnpm --filter @zcode/web build`,
    );
  }
  return root;
}

function resolvePhoneRemoteStaticRootPath(options: {
  isPackaged?: () => boolean;
  resourcesPath?: () => string | undefined;
  repoRoot?: () => string | undefined;
}): string {
  const packaged = (options.isPackaged ?? isHostProcessPackaged)();
  if (packaged) {
    const resourcesPath = (options.resourcesPath ?? (() => process.resourcesPath))();
    if (!resourcesPath?.trim()) {
      throw new Error("Phone remote control cannot locate the app resources directory.");
    }
    return join(resourcesPath, "web");
  }
  const repoRoot = (options.repoRoot ?? resolveDevRepoRoot)();
  if (!repoRoot) {
    throw new Error("Phone remote control cannot locate packages/web/dist in development.");
  }
  return join(repoRoot, "packages", "web", "dist");
}

/**
 * One server per host process, started on demand.
 *
 * Nothing listens until the user opens the remote control panel, so a machine
 * that never uses the feature never opens a port. The port is ephemeral rather
 * than fixed, so a second window gets its own server instead of colliding, and
 * each window's QR carries the port its own phone must actually reach.
 */
export function createPhoneRemoteService(options: PhoneRemoteHostOptions): IPhoneRemoteServiceType {
  const { services } = options;
  const log = options.log ?? (() => {});
  let handle: PhoneRemoteServerHandle | null = null;
  let state: PhoneRemoteState = { status: "stopped" };
  let pending: Promise<PhoneRemoteState> | null = null;
  const activeTaskIds = new Set<string>();

  const service: IPhoneRemoteServiceType = {
    async start() {
      // A second call must not rotate the token: the phone already scanned the
      // old QR, and silently invalidating it looks like a broken feature.
      if (handle) return state;
      if (pending) return pending;
      state = { status: "starting" };
      const attempt = (async () => {
        try {
          handle = await startPhoneRemoteServer({
            services,
            staticRoot: resolvePhoneRemoteStaticRoot({
              isPackaged: options.isPackaged,
              resourcesPath: options.resourcesPath,
              repoRoot: options.repoRoot,
            }),
            log,
            serviceOverrides: createPhoneTaskObserver(services, activeTaskIds),
          });
          state = {
            status: "running",
            port: handle.port,
            pairings: handle.pairings satisfies readonly PhoneRemotePairing[],
          };
        } catch (error) {
          handle = null;
          state = { status: "error", message: describeError(error) };
          log(`phone remote control failed to start: ${state.message}`);
        }
        return state;
      })();
      pending = attempt;
      // The body can reject before `pending` is assigned, because resolving the
      // static root throws synchronously. Clearing through the promise rather
      // than inside the body is what makes a retry after a failure possible; an
      // inner `finally` would leave a settled promise parked here forever and
      // every later start would replay the same error forever.
      void attempt.finally(() => {
        if (pending === attempt) pending = null;
      });
      return attempt;
    },

    async stop() {
      const current = handle;
      handle = null;
      activeTaskIds.clear();
      state = { status: "stopped" };
      await current?.dispose();
    },

    async getState() {
      return state;
    },

    async listActiveTaskIds() {
      return [...activeTaskIds];
    },
  };

  return service;
}

export function registerPhoneRemoteService(
  options: PhoneRemoteHostOptions,
): IPhoneRemoteServiceType {
  const service = createPhoneRemoteService(options);
  options.services.register(IPhoneRemoteService, service);
  return service;
}

/**
 * Wraps the task service for phone connections only, recording which task each
 * call targets. Returns a Map suitable for `serviceOverrides`, so the desktop's
 * own renderer keeps the unwrapped service.
 */
export function createPhoneTaskObserver(
  services: ServiceCollection,
  activeTaskIds: Set<string>,
): ReadonlyMap<string, unknown> | undefined {
  const taskService = services.getOptional(IZCodeTaskService);
  if (!taskService) return undefined;
  const observed = { ...taskService } as Record<string, unknown>;
  for (const method of PHONE_DRIVEN_TASK_METHODS) {
    const original = observed[method];
    if (typeof original !== "function") continue;
    observed[method] = (params: { taskId?: string } | undefined, ...rest: unknown[]) => {
      const taskId = params?.taskId;
      if (typeof taskId === "string" && taskId) activeTaskIds.add(taskId);
      return (original as (...args: unknown[]) => unknown).call(taskService, params, ...rest);
    };
  }
  return new Map([[IZCodeTaskService.channelName, observed]]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDevRepoRoot(): string | undefined {
  // This file lives at packages/desktop/src/host/, so the repo root is four up.
  const candidate = join(import.meta.dirname, "..", "..", "..", "..");
  return existsSync(join(candidate, "packages", "web", "package.json")) ? candidate : undefined;
}

/**
 * A packaged build runs from inside an `app.asar`, a dev run points at the
 * Electron distribution's own resources folder, which has no app.asar. The host
 * project cannot import the main-process helper for this, and the test seam
 * above covers the cases where that distinction is ambiguous.
 */
function isHostProcessPackaged(): boolean {
  const resourcesPath = process.resourcesPath;
  if (!resourcesPath?.trim()) return false;
  return existsSync(join(resourcesPath, "app.asar"));
}
