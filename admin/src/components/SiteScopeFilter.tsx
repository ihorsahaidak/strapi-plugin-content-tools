import * as React from 'react';
import {
  Flex,
  Typography,
  Combobox,
  ComboboxOption,
  SingleSelect,
  SingleSelectOption,
} from '@strapi/design-system';
import {
  useFetchClient,
  useQueryParams,
  unstable_useContentManagerContext as useContentManagerContext,
} from '@strapi/strapi/admin';

import { fetchContentToolsConfig } from '../utils/configClient';
import {
  Descriptor,
  readValues,
  writeValues,
  readCookie,
  writeCookie,
  cookieSeed,
  cookieStore,
  prettyLabel,
  DATE_PRESETS,
} from '../utils/scope';

type Option = { value: string; label: string };

const relationOptions = (results: any[]): Option[] =>
  (results ?? [])
    .map((r) => ({
      value: String(r.id),
      label: r.name ?? r.title ?? r.slug ?? `#${r.id}`,
    }))
    .filter((o) => o.label);

/**
 * Config-driven sticky filter bar injected into the Content Manager list view.
 * The set of fields is configured per content type in
 * Settings → Content Tools → Filters. Selections are reflected in the list
 * `filters` query param and remembered in a cookie.
 */
const SiteScopeFilter = () => {
  const ctx = useContentManagerContext() as any;
  const { get } = useFetchClient();
  const [{ query }, setQuery] = useQueryParams<any>();

  const model: string | undefined = ctx?.model;
  const collectionType: string | undefined = ctx?.collectionType;
  const attributes: Record<string, any> = ctx?.contentType?.attributes ?? {};

  const [fields, setFields] = React.useState<string[] | null>(null);
  const [relOptions, setRelOptions] = React.useState<Record<string, Option[]>>({});

  // Load the configured filter fields for this content type.
  React.useEffect(() => {
    if (!model || collectionType !== 'collection-types') {
      setFields([]);
      return;
    }
    let cancelled = false;
    fetchContentToolsConfig(get).then((cfg) => {
      if (!cancelled) setFields(cfg[model]?.fields ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [model, collectionType, get]);

  const descriptors: Descriptor[] = React.useMemo(() => {
    if (collectionType !== 'collection-types') return [];
    return (fields ?? [])
      .map((field) => {
        // Timestamp fields aren't always present in the schema attributes.
        const isTimestamp = ['createdAt', 'updatedAt', 'publishedAt'].includes(field);
        const attr = attributes[field];
        if (attr?.type === 'datetime' || isTimestamp) {
          return { field, kind: 'dateRange' } as Descriptor;
        }
        if (!attr) return null;
        if (attr.type === 'relation' && attr.target) {
          return { field, kind: 'relation', target: attr.target } as Descriptor;
        }
        if (attr.type === 'enumeration') {
          return { field, kind: 'enumeration', values: attr.enum ?? [] } as Descriptor;
        }
        if (attr.type === 'boolean') {
          return { field, kind: 'boolean' } as Descriptor;
        }
        return null;
      })
      .filter(Boolean) as Descriptor[];
  }, [fields, attributes, collectionType]);

  // Fetch options for each distinct relation target.
  React.useEffect(() => {
    const targets = Array.from(
      new Set(descriptors.filter((d) => d.kind === 'relation').map((d) => d.target!))
    );
    let cancelled = false;
    targets.forEach((target) => {
      if (relOptions[target]) return;
      get(`/content-manager/collection-types/${target}?pageSize=100&sort=name:ASC`)
        .then((res) => {
          if (cancelled) return;
          setRelOptions((prev) => ({ ...prev, [target]: relationOptions((res.data as any)?.results) }));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [descriptors, get, relOptions]);

  const values = React.useMemo(
    () => readValues(query, descriptors),
    [query, descriptors]
  );

  const applyValues = React.useCallback(
    (next: Record<string, string>) => {
      const filters = writeValues(query?.filters, descriptors, next);
      setQuery({ filters, page: 1 }, 'push');
    },
    [query, descriptors, setQuery]
  );

  const onChange = React.useCallback(
    (d: Descriptor, value: string) => {
      const next = { ...values, [d.field]: value };
      if (!value) delete next[d.field];
      applyValues(next);
      writeCookie(cookieStore(readCookie(), model!, d, value));
    },
    [values, applyValues, model]
  );

  // Seed from the cookie once per (model, config) when the URL has no value.
  const seededRef = React.useRef('');
  React.useEffect(() => {
    if (!model || descriptors.length === 0) return;
    const sig = `${model}:${descriptors.map((d) => d.field).join(',')}`;
    if (seededRef.current === sig) return;
    seededRef.current = sig;

    const cookie = readCookie();
    const seeded = { ...values };
    let changed = false;
    for (const d of descriptors) {
      if (seeded[d.field]) continue;
      const seed = cookieSeed(cookie, model, d);
      if (seed) {
        seeded[d.field] = seed;
        changed = true;
      }
    }
    if (changed) applyValues(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, descriptors]);

  if (collectionType !== 'collection-types' || descriptors.length === 0) return null;

  return (
    <Flex gap={2} alignItems="flex-end" wrap="wrap" paddingTop={2} paddingBottom={4}>
      {descriptors.map((d) => (
        <Flex key={d.field} direction="column" alignItems="stretch" gap={1} width="16rem">
          <Typography variant="pi" fontWeight="bold" textColor="neutral600">
            {prettyLabel(d.field)}
          </Typography>
          {d.kind === 'relation' ? (
            <Combobox
              size="S"
              placeholder={`All ${prettyLabel(d.field).toLowerCase()}`}
              aria-label={`Filter by ${prettyLabel(d.field)}`}
              value={values[d.field] ?? ''}
              onChange={(v?: string) => onChange(d, v ?? '')}
              onClear={() => onChange(d, '')}
            >
              {(relOptions[d.target!] ?? []).map((o) => (
                <ComboboxOption key={o.value} value={o.value}>
                  {o.label}
                </ComboboxOption>
              ))}
            </Combobox>
          ) : (
            <SingleSelect
              size="S"
              placeholder={
                d.kind === 'dateRange'
                  ? `${prettyLabel(d.field).replace(/ At$/, '')}: any time`
                  : `All ${prettyLabel(d.field).toLowerCase()}`
              }
              aria-label={`Filter by ${prettyLabel(d.field)}`}
              value={values[d.field] ?? ''}
              onChange={(v: string | number) => onChange(d, v === undefined ? '' : String(v))}
              onClear={() => onChange(d, '')}
            >
              {d.kind === 'dateRange'
                ? DATE_PRESETS.map((p) => (
                    <SingleSelectOption key={p.key} value={p.key}>
                      {p.label}
                    </SingleSelectOption>
                  ))
                : d.kind === 'boolean'
                  ? [
                      <SingleSelectOption key="true" value="true">
                        Yes
                      </SingleSelectOption>,
                      <SingleSelectOption key="false" value="false">
                        No
                      </SingleSelectOption>,
                    ]
                  : (d.values ?? []).map((v) => (
                      <SingleSelectOption key={v} value={v}>
                        {v}
                      </SingleSelectOption>
                    ))}
            </SingleSelect>
          )}
        </Flex>
      ))}
    </Flex>
  );
};

export default SiteScopeFilter;
