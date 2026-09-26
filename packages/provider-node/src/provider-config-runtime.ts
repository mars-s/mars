import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import {
  EndpointScopedZCodeBuiltinSource,
  type EndpointScopedZCodeBuiltinSourceOptions,
} from "./endpoint-scoped-zcode-builtin-source.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export type ZCodeBuiltinRefreshResult = "updated" | "unchanged" | "disposed";

export interface NodeProviderConfigRuntimeOptions {
  readonly zcodeBuiltinFilePath: string;
  readonly zcodeBuiltinActiveFilePath?: string;
  readonly zcodeBuiltinEnvironment?: Omit<
    EndpointScopedZCodeBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    zcodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 ZCode Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #zcodeBuiltinSource:
    | NodeZCodeBuiltinProviderConfigSource
    | EndpointScopedZCodeBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #onCheckError?: (error: unknown) => void;
  #zcodeBuiltinRevision: string | null = null;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#zcodeBuiltinSource = options.zcodeBuiltinEnvironment
      ? new EndpointScopedZCodeBuiltinSource({
          bundledFilePath: options.zcodeBuiltinFilePath,
          ...options.zcodeBuiltinEnvironment,
        })
      : new NodeZCodeBuiltinProviderConfigSource({
          bundledFilePath: options.zcodeBuiltinFilePath,
          activeFilePath: options.zcodeBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#onCheckError = options.onZCodeBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#zcodeBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      zcodeBuiltinSource: this.#zcodeBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#zcodeBuiltinSource instanceof NodeZCodeBuiltinProviderConfigSource
      ? Promise.resolve(this.#zcodeBuiltinSource.activeFilePath)
      : this.#zcodeBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@zcode/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖。 */
  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then((snapshot) => {
      if (this.#disposed) return;
      this.#zcodeBuiltinRevision = snapshot.zcodeBuiltinRevision;
      void this.#checkBackground();
      // Managed Worker 无恢复 owner，不建立周期任务。
      if (this.#checkListeners.size > 0) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  /**
   * Re-reads the local Built-in layer. There is no remote catalog: the bundled JSON is the
   * single source of truth and the Active/LKG file is a discardable cache of it.
   */
  refreshZCodeBuiltin(): Promise<ZCodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    return this.configService.read().then((snapshot) => {
      const previous = this.#zcodeBuiltinRevision;
      this.#zcodeBuiltinRevision = snapshot.zcodeBuiltinRevision;
      return previous !== null && previous !== snapshot.zcodeBuiltinRevision
        ? "updated"
        : "unchanged";
    });
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled(
      [...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    )
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onCheckError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#zcodeBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}
