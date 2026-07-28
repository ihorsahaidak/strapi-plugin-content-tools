export type ContentToolsEntry = {
  fields: string[];
  export: boolean;
  import: boolean;
};
export type ContentToolsConfig = Record<string, ContentToolsEntry>;

type Getter = (url: string) => Promise<{ data: any }>;

let cache: Promise<ContentToolsConfig> | null = null;

/** Fetch the per-content-type config once and reuse it across mounts. */
export function fetchContentToolsConfig(get: Getter): Promise<ContentToolsConfig> {
  if (!cache) {
    cache = get('/content-tools/config')
      .then((res) => (res.data && typeof res.data === 'object' ? res.data : {}))
      .catch(() => ({} as ContentToolsConfig));
  }
  return cache;
}

/** Call after saving the config so consumers pick up changes on next mount. */
export function clearContentToolsConfigCache(): void {
  cache = null;
}
