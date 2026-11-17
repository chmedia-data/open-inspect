/**
 * The Workers binding types the bots name, declared as exactly the surface
 * this host implements (src/store.ts, src/host.ts). The bots' own programs
 * take these from workers-types; this program never loads workers-types, so
 * a bot reaching for a binding method the host lacks fails to typecheck.
 */

interface KVNamespaceListResult {
  keys: { name: string; expiration?: number }[];
  list_complete: true;
  cacheStatus: null;
}

interface KVNamespace {
  get(key: string, type?: "text"): Promise<string | null>;
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<KVNamespaceListResult>;
}

interface Queue<Body = unknown> {
  send(body: Body, options?: { contentType?: "json"; delaySeconds?: number }): Promise<void>;
}

interface Message<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: unknown;
}

type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
type RequestInfo = NonNullable<ConstructorParameters<typeof Request>[0]>;
