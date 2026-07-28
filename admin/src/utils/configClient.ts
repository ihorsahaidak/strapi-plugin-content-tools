export type ContentToolsEntry = {
  fields: string[];
  export: boolean;
  import: boolean;
};
export type ContentToolsConfig = Record<string, ContentToolsEntry>;

type Getter = (url: string) => Promise<{ data: any }>;

// Cache on `window` (not a module variable) so the single instance is shared
// across code-split chunks — otherwise the lazy Settings chunk and the main
// list-view chunk each get their own cache, and clearing one leaves the other
// stale (buttons wouldn't appear until a full page reload).
const CACHE_KEY = '__contentToolsConfigCache__';

type CacheWindow = Window & { [CACHE_KEY]?: Promise<ContentToolsConfig> };

/** Fetch the per-content-type config once and reuse it across mounts. */
export function fetchContentToolsConfig(get: Getter): Promise<ContentToolsConfig> {
  const w = window as unknown as CacheWindow;
  if (!w[CACHE_KEY]) {
    w[CACHE_KEY] = get('/content-tools/config')
      .then((res) => (res.data && typeof res.data === 'object' ? res.data : {}))
      .catch(() => ({} as ContentToolsConfig));
  }
  return w[CACHE_KEY] as Promise<ContentToolsConfig>;
}

/** Call after saving so every chunk refetches fresh config on next mount. */
export function clearContentToolsConfigCache(): void {
  if (typeof window !== 'undefined') {
    delete (window as unknown as CacheWindow)[CACHE_KEY];
  }
}
