import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingService {
  get(): Promise<AppSettings>;
  update(
    patch: Partial<AppSettings>,
    // Compare-and-set guard for the account connection selections, so a write that raced
    // an account switch is rejected instead of overwriting the user's newer choice.
    expectedAccountSettings?: Pick<AppSettings, "providerFamilyConnectionSelections">,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
