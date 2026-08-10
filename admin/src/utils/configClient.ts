import * as React from 'react';

export type ContentToolsEntry = {
  fields: string[];
  moveLocale: boolean;
  mergeLocale: boolean;
  mergeLabelTemplate: string;
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

/**
 * Whether a boolean feature flag (`moveLocale` / `mergeLocale`) is enabled for
 * a content type. Used inside document/bulk action descriptor functions —
 * these run like components (Strapi calls them during render and they may use
 * hooks, same as its own built-in actions), so a plain hook is the natural fit
 * here rather than threading a prop through every call site.
 *
 * Starts `false` and flips true once the (cached, shared) config resolves —
 * on a fully cold cache this means the action is briefly absent rather than
 * briefly wrong, which matters more for something that changes what a click
 * does to your data.
 */
export function useContentToolsFlag(
  get: Getter,
  uid: string | undefined,
  flag: 'moveLocale' | 'mergeLocale'
): boolean {
  const [allowed, setAllowed] = React.useState(false);

  React.useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    fetchContentToolsConfig(get).then((cfg) => {
      if (!cancelled) setAllowed(!!cfg[uid]?.[flag]);
    });
    return () => {
      cancelled = true;
    };
  }, [get, uid, flag]);

  return allowed;
}
