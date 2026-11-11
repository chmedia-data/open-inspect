/** Host port for Docker Engine requests. Only the Node host supplies this capability. */
export interface DockerTransport {
  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<{ status: number; body: unknown }>;
}
