export function developmentHostnames(origin: string | undefined): string[] {
  if (!origin) return [];
  const url = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    !url.hostname || url.hostname.includes("*")
  ) throw Error("MARS_PUBLIC_ORIGIN must be an exact HTTP or HTTPS origin");
  return [url.hostname];
}
