import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 须在启动期其余 bootstrap 之前完成：先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// 远端 crash 上报已随遥测通道一并移除，只保留本地 crashReporter。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);
