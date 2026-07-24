type FilterConfig = Record<string, string[]>;
type Getter = (url: string) => Promise<{ data: any }>;

let cache: Promise<FilterConfig> | null = null;

/** Fetch the per-content-type filter config once and reuse it across mounts. */
export function fetchFilterConfig(get: Getter): Promise<FilterConfig> {
  if (!cache) {
    cache = get('/content-tools/config')
      .then((res) => (res.data && typeof res.data === 'object' ? res.data : {}))
      .catch(() => ({} as FilterConfig));
  }
  return cache;
}

/** Call after saving the config so list views pick up changes on next mount. */
export function clearFilterConfigCache(): void {
  cache = null;
}
