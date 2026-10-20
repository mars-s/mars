import { proxyPi } from "@/lib/server/pi-proxy";
export const runtime = "nodejs";
export function GET(request: Request) {
  return proxyPi(request);
}
