const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("marsDesktop", {
  gatewayHttpUrl: process.env.MARS_GATEWAY_HTTP_URL || "http://127.0.0.1:3037",
  gatewayWsUrl: process.env.MARS_GATEWAY_WS_URL || "ws://127.0.0.1:3037/ws",
  platform: process.platform,
  configureProvider: (input) => ipcRenderer.invoke("mars:configure-provider", input),
});
