type RoomStub = {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};

type RoomNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): RoomStub;
};

export async function getRoomNamespace(): Promise<RoomNamespace> {
  const { env } = await import("cloudflare:workers");
  if (!env.ROOM) {
    throw new Error("Cloudflare Durable Object binding `ROOM` is unavailable. Update wrangler.jsonc before using the room API.");
  }
  return env.ROOM as RoomNamespace;
}

export async function roomStub(roomId: string): Promise<RoomStub> {
  const namespace = await getRoomNamespace();
  return namespace.get(namespace.idFromName(roomId.toUpperCase()));
}

/**
 * Vinext's response finalizer mutates headers on route responses, but responses
 * proxied from a Durable Object subrequest are immutable. Re-wrap in a fresh
 * Response 并透传上游 body/statusText/headers，避免整个响应读入内存（B031）。
 */
export async function roomFetch(stub: RoomStub, path: string, init?: RequestInit): Promise<Response> {
  const upstream = await stub.fetch(path, init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}