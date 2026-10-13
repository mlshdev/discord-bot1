const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const WATCH_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

const SHORT_HOSTS: ReadonlySet<string> = new Set(["youtu.be", "www.youtu.be"]);

const PATH_PREFIXES: readonly string[] = ["shorts", "live", "embed", "v"];

function extractVideoId(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (SHORT_HOSTS.has(host)) {
    return segments[0];
  }
  if (!WATCH_HOSTS.has(host)) {
    return undefined;
  }
  if (segments.length === 1 && segments[0] === "watch") {
    return url.searchParams.get("v") ?? undefined;
  }
  const [prefix, id] = segments;
  if (prefix !== undefined && PATH_PREFIXES.includes(prefix)) {
    return id;
  }
  return undefined;
}

export function parseYouTubeUrl(input: string): string | undefined {
  const trimmed = input.trim().replace(/^<(.*)>$/, "$1");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const id = extractVideoId(url);
  if (id === undefined || !VIDEO_ID.test(id)) {
    return undefined;
  }
  return `https://www.youtube.com/watch?v=${id}`;
}
