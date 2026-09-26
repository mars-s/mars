import type { ProviderConfigObject } from "@zcode/provider";

/** 展示模型是否支持图片输入的原生视觉徽标。 */
export function shouldShowModelVisionBadge(
  modelId: string,
  supportsImage: boolean | null | undefined,
  access?: ProviderConfigObject["access"],
): boolean {
  void access;
  void modelId;
  if (supportsImage !== true) return false;
  // The Coding Plan bridged-vision exception went with the coding-plan subsystem, and the
  // access type that keyed it is no longer produced. The badge now reflects only the
  // model's own declared capability, and the access type and model id are not part of it.
  // 只控制徽标，不改能力事实、附件校验或精确模型身份。
  return true;
}
