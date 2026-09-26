/** 发送落定的原因码。 */
export type SendFunnelReasonCode =
  | "attachment_not_ready"
  | "blocked"
  | "rejected"
  | "stale"
  | "failed"
  | "render_timeout"
  | "transport_error"
  | "provider_not_ready"
  | "composer_error";
