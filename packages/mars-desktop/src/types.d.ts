export {};

declare global {
  interface Window {
    marsDesktop?: {
      gatewayHttpUrl: string;
      gatewayWsUrl: string;
      platform: string;
      configureProvider(input: {
        apiKey: string;
        modelId: string;
        baseUrl: string;
      }): Promise<{
        baseUrl: string;
        modelId: string;
        providerReady: boolean;
        secretPersisted: boolean;
      }>;
    };
  }
}
