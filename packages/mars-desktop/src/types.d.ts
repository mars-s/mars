export {};

declare global {
  interface Window {
    marsDesktop?: {
      gatewayHttpUrl: string;
      gatewayWsUrl: string;
      platform: string;
    };
  }
}
