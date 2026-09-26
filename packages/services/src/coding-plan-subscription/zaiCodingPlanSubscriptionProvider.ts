import { BUILTIN_MODEL_PROVIDER_IDS, resolveZaiBusinessBaseUrl } from "@zcode/shared";
import type { CodingPlanSubscriptionProviderId } from "@zcode/shared";
import {
  BigModelCodingPlanSubscriptionProvider,
  createZaiLoginAuthHeaders,
} from "./bigmodelCodingPlanSubscriptionProvider.js";

/**
 * ZaiCodingPlanSubscriptionProvider
 *
 * Team Plan enterprise pricing was only ever implemented on the bigmodel family, so the
 * service layer sent every enterprise read straight to BigModelCodingPlanSubscriptionProvider
 * with a hardcoded vendor domain, providerId and OAuth token. The zai family had no
 * independent pricing source even when it produced a team plan connection key.
 *
 * The zai family is now symmetric with the bigmodel family: this class extends
 * BigModelCodingPlanSubscriptionProvider and overrides only the family dimension of the
 * enterprise read path:
 *   - providerId    -> zaiCodingPlan
 *   - business host -> resolveZaiCodingPlanHost()
 *   - OAuth token   -> loadZaiAuthorization() (oauth:zai:access_token, reused from the parent)
 *   - auth headers  -> createZaiLoginAuthHeaders()
 *
 * No vendor host is hardcoded in this file. The business host is exactly what
 * resolveZaiBusinessBaseUrl(process.env) returns, that is the ZAI_BUSINESS_BASE_URL the
 * operator configured. Nothing in this class invents a fallback host, so an operator without
 * a configured business origin gets a loud failure from the resolver instead of a silent
 * request to a vendor endpoint.
 *
 * Overridden scope: only the family dimension of getEnterprisePricing and
 * enrichEnterprisePricingTeamProjects, through protected virtual methods. The purchase loop
 * (balance/order/pending/cancel/continue/status) still runs through the parent on the
 * bigmodel domain, matching the "pricing reads plus team context only" product boundary.
 *
 * Everything else (batchPreview/preview/productInfo/checkPayment/checkPendingOrders/
 * Stripe/PayPal/createSign/updateSign/staticConfigs) is inherited from the parent: purchase
 * calls already route on request.providerId inside the parent resolveEndpointConfig, so zai
 * goes to /api/pay with the zai host and zai token while bigmodel goes to /api/biz with the
 * bigmodel host and bigmodel token. staticConfigs is a platform level client/configs payload
 * that is not family specific.
 */
export class ZaiCodingPlanSubscriptionProvider extends BigModelCodingPlanSubscriptionProvider {
  protected codingPlanProviderId(): CodingPlanSubscriptionProviderId {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  protected resolveFamilyEnterpriseHost(): string {
    return resolveZaiCodingPlanHost();
  }

  protected async loadFamilyEnterpriseToken(): Promise<string> {
    // 复用父类 loadZaiAuthorization：credential key = oauth:zai:access_token。
    return this.loadZaiAuthorization();
  }

  protected createFamilyEnterpriseAuthHeaders(token: string): Record<string, string> {
    return createZaiLoginAuthHeaders(token);
  }
}

/**
 * Business host for the zai /api/biz and /api/pay endpoints.
 * Kept file scoped because the parent copy is not exported. Must stay equivalent to the
 * parent implementation: it follows the Z.ai business origin the operator configured, with no
 * built-in vendor default in this file.
 */
function resolveZaiCodingPlanHost(): string {
  return resolveZaiBusinessBaseUrl(process.env);
}
