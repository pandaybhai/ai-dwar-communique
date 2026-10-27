/**
 * Test-only stand-in for supabase.storage: upload / download / remove / list
 * over an in-memory map of bucket -> path -> bytes. Never used by the app.
 * `fail` makes the next calls of one kind answer with an error (a missing
 * bucket, a storage outage).
 */
export type StoredObject = { bytes: Uint8Array; contentType: string | null };

export function fakeStorage() {
  const buckets = new Map<string, Map<string, StoredObject>>();
  const calls: Array<{ op: string; bucket: string; paths: string[] }> = [];
  const fail = { upload: null as string | null, download: null as string | null, remove: null as string | null, list: null as string | null };
  const bucket = (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name)!;
  };
  const api = {
    from(name: string) {
      const objects = bucket(name);
      return {
        async upload(path: string, body: Uint8Array, opts?: { contentType?: string; upsert?: boolean }) {
          calls.push({ op: "upload", bucket: name, paths: [path] });
          if (fail.upload) return { data: null, error: { message: fail.upload } };
          if (objects.has(path) && !opts?.upsert) return { data: null, error: { message: "The resource already exists" } };
          objects.set(path, { bytes: body, contentType: opts?.contentType ?? null });
          return { data: { path }, error: null };
        },
        async download(path: string) {
          calls.push({ op: "download", bucket: name, paths: [path] });
          if (fail.download) return { data: null, error: { message: fail.download } };
          const hit = objects.get(path);
          if (!hit) return { data: null, error: { message: "Object not found" } };
          return { data: new Blob([hit.bytes as BlobPart], { type: hit.contentType ?? "" }), error: null };
        },
        async remove(paths: string[]) {
          calls.push({ op: "remove", bucket: name, paths: [...paths] });
          if (fail.remove) return { data: null, error: { message: fail.remove } };
          const gone = paths.filter((p) => objects.delete(p));
          return { data: gone.map((p) => ({ name: p })), error: null };
        },
        async list(prefix = "", opts?: { limit?: number }) {
          calls.push({ op: "list", bucket: name, paths: [prefix] });
          if (fail.list) return { data: null, error: { message: fail.list } };
          const base = prefix ? `${prefix.replace(/\/$/, "")}/` : "";
          const seen = new Map<string, { name: string; id: string | null }>();
          for (const key of objects.keys()) {
            if (!key.startsWith(base)) continue;
            const rest = key.slice(base.length);
            const [head, ...tail] = rest.split("/");
            if (!head) continue;
            // Folders come back with id null, as Supabase lists them.
            seen.set(head, { name: head, id: tail.length ? null : `obj-${key}` });
          }
          return { data: [...seen.values()].slice(0, opts?.limit ?? 100), error: null };
        },
      };
    },
  };
  return {
    storage: api,
    calls,
    fail,
    objects: (name: string) => bucket(name),
  };
}

/** Puts `storage` on a fake client (fakeDb / memoryDb), the way the real one has it. */
export function withStorage<T extends object>(client: T, storage: ReturnType<typeof fakeStorage>): T {
  (client as unknown as { storage: unknown }).storage = storage.storage;
  return client;
}
