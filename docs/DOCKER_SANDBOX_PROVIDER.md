# Local Docker sandboxes

Run the Node control plane and its session containers on one Docker Engine. The same provider works
on one EC2 host. No hosted sandbox service or public callback URL is required. Source control,
sign-in, and model authentication still need their usual configuration.

Use Docker Engine 26+ with Compose v2, Node 24+, and `uv`. The shared sandbox toolchain currently
pins Linux amd64 binaries, so the builder selects `linux/amd64`. On Apple Silicon, Colima must
support amd64 emulation. The control-plane image can remain native arm64.

From the repository root, prepare `.env` using
[the container quick start](CONTROL_PLANE_CONTAINER.md#quick-start), including its encryption keys
and object-store credentials. Keep `WORKER_URL=http://localhost:8787` and
`WEB_APP_URL=http://localhost:3000` for local browser access.

Build the sandbox image, then start the stack:

```bash
npm run sandbox:docker:build
DOCKER_SOCKET_GID=991 docker compose \
  -f docker-compose.yml -f docker-compose.docker-sandbox.yml up --build
```

The builder packs the existing shared runtime and pinned toolchain, then builds the `docker` target
with its installation checks. It does not start a session or run a separate container smoke test.
Set `DOCKER_SANDBOX_IMAGE` in the shell for a custom tag when building, and use the same value in
`.env` for Compose. Images must already exist in the selected Docker daemon; the provider does not
pull or build images when a session starts.

The overlay preserves the base stack and adds a shared bridge network. It mounts the daemon socket
into `app` and adds the socket's numeric group to the existing unprivileged app user. For this
Colima installation the group is `991`; on another host set `DOCKER_SOCKET_GID` to the socket's
group. `DOCKER_HOST_SOCKET_PATH` overrides the mount source, which is resolved on the Docker daemon
host. With Colima this is the Linux VM's socket, normally `/var/run/docker.sock`, not the macOS
client socket under `~/.colima`.

| Variable                    | Default in the overlay       | Purpose                                                      |
| --------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `SANDBOX_PROVIDER`          | `docker`                     | Selects this provider                                        |
| `DOCKER_SANDBOX_IMAGE`      | `open-inspect-sandbox:local` | Locally built runtime image                                  |
| `DOCKER_SANDBOX_NETWORK`    | `open-inspect-sandboxes`     | Network shared by `app` and session containers               |
| `DOCKER_CONTROL_PLANE_URL`  | `http://app:8787`            | Sandbox callback origin on that network                      |
| `DOCKER_SOCKET_PATH`        | `/var/run/docker.sock`       | Socket inside `app`; configurable when running Node directly |
| `DOCKER_HOST_SOCKET_PATH`   | `/var/run/docker.sock`       | Compose socket mount source                                  |
| `DOCKER_SOCKET_GID`         | `991`                        | Supplemental group for socket access                         |
| `DOCKER_PORTAL_PORT`        | `8790`                       | Second HTTP listener inside the Node control-plane process   |
| `DOCKER_PORTAL_BASE_DOMAIN` | `localhost`                  | Wildcard domain used in portal URLs                          |
| `DOCKER_PORTAL_PUBLIC_PORT` | `8790`                       | Port in URLs and the overlay's loopback port mapping         |
| `DOCKER_PORTAL_SCHEME`      | `http`                       | Public URL scheme; TLS terminates outside this listener      |

The Docker callback override replaces the `controlPlaneUrl` derived from `WORKER_URL` only when
assembling sandbox environment variables. Browser and OAuth URLs continue using the normal
deployment configuration. The Docker provider enables the runtime's explicit private network HTTP
opt-in. Other providers continue requiring HTTPS except on loopback.

Run the web app separately as described in
[connecting the web app](CONTROL_PLANE_CONTAINER.md#connecting-the-web-app):

```dotenv
# packages/web/.env.local
CONTROL_PLANE_URL=http://localhost:8787
NEXT_PUBLIC_WS_URL=ws://localhost:8787
SERVICE_AUTH_SECRET=<SERVICE_AUTH_SECRET_WEB from the root .env>
NEXT_PUBLIC_SANDBOX_PROVIDER=docker
```

```bash
npm run dev -w @open-inspect/web
```

Each session creates and starts one labeled container. `buildSandboxEnvVars` supplies the canonical
session payload and `bridge_early_connect=true`. The launcher execs the normal
`sandbox_runtime.entrypoint`; Docker process start is not readiness. The control plane waits for the
authenticated bridge's runtime `ready` event after repository and harness boot. There is no deferred
image-build launch because this provider does not build repository images.

Idle shutdown uses Docker stop and retains the writable container layer. On Docker start, the
launcher checks `OI_BOOT_COMPLETE_MARKER`, written by the supervisor only after a completed boot. A
completed boot resumes with `RESTORED_FROM_SNAPSHOT=true`, preserving the checkout and runtime
state. An incomplete boot retries fresh. Process memory is not retained. Terminal destruction stops
and removes the container. Missing containers fall back to a fresh sandbox, so manually removing one
discards its local workspace.

HTTP portals, WebSocket upgrades, code-server, the authenticated ttyd web terminal, and the noVNC
desktop are supported. They use the normal service port settings and password/token contracts. Raw
TCP/UDP tunnels and IPv6-only sandbox networks are unsupported; the proxy uses private IPv4
addresses on the configured Docker bridge.

Snapshots, snapshot restore, prebuilt repository/environment images, provider-enforced lifetimes,
and per-session resource settings remain unsupported; the deployment-wide limits are described in
[Isolation and resource limits](#isolation-and-resource-limits). Image-build admission returns the
existing unsupported-provider response. Control-plane inactivity and execution policies still apply.
Docker-in-Docker is disabled; session containers receive neither privileged mode nor the host
socket. The control plane's socket access can administer the Docker host, so use this as a
single-tenant deployment.

Session containers are created through the Engine API and are not Compose services. Stopping Compose
does not remove them or their network automatically. Inspect them with:

```bash
docker ps -a --filter label=openinspect_framework=open-inspect
docker logs <container-id>
```

Stopped containers retain their original session environment, including tokens and repo secrets. Do
not commit their filesystem as reusable images. A reaper in the Node host removes abandoned
containers; see [Reaping](#reaping).

## Isolation and resource limits

Session containers start with every Linux capability dropped except `CHOWN`, `DAC_OVERRIDE`,
`FOWNER`, `KILL`, `SETGID` and `SETUID`, and with `no-new-privileges`. `NET_RAW` and `NET_ADMIN` are
never granted, so sandbox code cannot open raw or packet sockets to forge source addresses or ARP
replies on the shared bridge. Each kept capability was shown necessary by removing it and running
the image's own `smoke_test.py verify`, a git clone, `apt-get install`, global and project
`npm install`, and file ownership and signal checks:

| Capability     | Without it                                                                   |
| -------------- | ---------------------------------------------------------------------------- |
| `CHOWN`        | Package scripts and tools that chown files fail                              |
| `DAC_OVERRIDE` | `apt-get` cannot write its lists; global `npm install` fails                 |
| `FOWNER`       | chmod of files owned by another user fails                                   |
| `KILL`         | The runtime cannot end a process group whose members run as another user     |
| `SETGID`       | `apt-get` fetchers cannot drop to `_apt`; the image verification probe fails |
| `SETUID`       | `apt-get` fetchers cannot drop to `_apt`                                     |

`FSETID`, `MKNOD`, `NET_BIND_SERVICE`, `SETFCAP`, `SETPCAP`, `SYS_CHROOT` and `AUDIT_WRITE` from
Docker's default set showed no use and are dropped. Without `NET_BIND_SERVICE`, services inside a
sandbox must listen on ports from 1024 up. The sandbox still runs as root inside its user namespace
so agents can install system packages with `apt-get`; a non-root image would remove that. Root here
holds only the capabilities above, and `no-new-privileges` stops setuid binaries from regaining
others. To also map container root to an unprivileged host user, enable the daemon's `userns-remap`,
an operator setting outside this provider.

Each container gets memory, swap, CPU and PID limits. The Node host admits a new or resumed
container only while fewer than `DOCKER_SANDBOX_MAX_RUNNING` session containers are running and the
filesystem holding `DATA_DIR` has at least `DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT` free. Starts are
serialized, so two cannot take the last slot. A start that finds the host full waits in a bounded
queue for up to a minute, polling for a slot, and is then refused; when the queue is full, further
starts are refused at once. A disk below the watermark refuses immediately. The session shows the
refusal as its sandbox error, and the refusal is transient, so it does not trip the spawn circuit
breaker; the next prompt tries again. The free-space check assumes `DATA_DIR` shares a filesystem
with Docker's data root, as in the Compose stack.

| Variable                               | Default        | Purpose                                                   |
| -------------------------------------- | -------------- | --------------------------------------------------------- |
| `DOCKER_SANDBOX_MEMORY_MB`             | `2048`         | Memory limit per sandbox                                  |
| `DOCKER_SANDBOX_SWAP_MB`               | `0`            | Swap allowed on top of memory                             |
| `DOCKER_SANDBOX_CPUS`                  | `1`            | CPU limit per sandbox, fractional allowed                 |
| `DOCKER_SANDBOX_PIDS_LIMIT`            | `2048`         | Processes and threads per sandbox                         |
| `DOCKER_SANDBOX_MAX_RUNNING`           | `3`            | Running sandboxes admitted on this host                   |
| `DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT` | `10`           | Free space on the `DATA_DIR` filesystem required to start |
| `DOCKER_SANDBOX_STOPPED_RETENTION_MS`  | 14 days        | How long a stopped sandbox stays resumable                |
| `DOCKER_SANDBOX_RUNTIME`               | daemon default | OCI runtime, for example `runsc`                          |
| `DOCKER_SANDBOX_DNS`                   | unset          | Comma-separated IPv4 resolvers for sandboxes              |

The defaults fit a 2 vCPU, 8 GiB host such as an AWS `t3a.large`: three 2 GiB sandboxes leave about
2 GiB for the control plane, Docker and the operating system. A sandbox that exceeds its memory is
OOM-killed inside its own cgroup, not the host. Raise the limits on a larger host.

The writable container layer has no size quota. Docker supports one only on `overlay2` over XFS with
project quotas, which this provider does not assume. Put Docker's data root on a separate volume
from the control plane's database, or rely on the disk watermark, which refuses new starts but does
not stop a running sandbox from filling the disk.

### DNS

Unset, sandboxes use Docker's embedded resolver, which resolves any name through the host. Set
`DOCKER_SANDBOX_DNS` to the address of an allowlisting resolver on the sandbox bridge (for example
dnsmasq on the bridge gateway) to close DNS exfiltration and to make sandboxes and an egress proxy
that verifies the Host header resolve rotating hosts such as `github.com` through the same resolver.
The value is applied to every sandbox container at creation; a resumed sandbox keeps the value it
was created with.

### gVisor

`DOCKER_SANDBOX_RUNTIME` is unset by default and containers use the daemon's default runtime. To run
sandboxes under gVisor, install `runsc` on the host, register it in `/etc/docker/daemon.json`
(`"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}`), restart Docker, and set
`DOCKER_SANDBOX_RUNTIME=runsc`. The value must name a registered runtime; an unknown name fails
every create with a Docker HTTP 400. gVisor narrows the kernel attack surface, but it is not network
isolation and does not replace the capability and firewall settings described here. Check the
sandbox image's toolchain under gVisor before relying on it.

### Network isolation

All session containers share one bridge with the control plane. Without `NET_RAW` a sandbox cannot
forge its source IP or ARP replies, but it can still reach other containers on the bridge and the
control plane's other listeners unless the host firewall restricts them. The host should:

- drop sandbox-to-sandbox traffic on the bridge,
- bind each sandbox veth to its assigned IP and MAC address,
- allow sandboxes to reach the control plane only on its API port (8787 in Compose), not the portal
  listener or anything else.

A network per sandbox would remove the shared bridge. The provider would create a network for each
container and attach the control-plane container to it, which needs the control plane's own
container ID and a create, connect, disconnect and remove step per session that must also be
recovered after crashes. Every sandbox network adds an interface and an address on the control
plane, a bridge and iptables rules on the host, and a subnet from Docker's default pools, which
allow about 30 such networks. The portal proxy would need to follow each sandbox onto its network.
That is not contained enough to do here, so the shared bridge stays and the firewall rules above
carry the isolation.

### Reaping

Every 10 minutes the Node host lists this deployment's session containers and removes:

- stopped containers whose last stop is older than `DOCKER_SANDBOX_STOPPED_RETENTION_MS`, and
- any container, running or stopped, older than an hour whose session no longer exists.

A stopped container inside its retention is a paused session and is kept. Resuming a session whose
container was removed starts a fresh sandbox, losing uncommitted work in the old one. A running
container whose session still exists is never reaped; idle shutdown stops it first.

## Open a local portal

1. Start the stack with the overlay above. It publishes the portal listener on `127.0.0.1:8790` and
   adds no published ports to session containers.
2. In the web app, open Settings > Sandbox, select your repository, add `3000` under Tunnel Ports,
   and save. This sets that repository's `tunnelPorts` to `[3000]`. Turn on Web Terminal there if
   wanted. Enable Code Server and VNC Desktop in their own integration settings for the repository.
3. Create a new session. Existing containers created before portal support retain their workspace on
   resume but have no portal token or port labels. Changes to enabled services or allowed ports
   apply to newly created containers.
4. Ask the agent: "Start an HTTP server on port 3000, listening on 0.0.0.0, and keep it running in
   the background. Show me the TUNNEL_3000 URL from /workspace/.tunnels.env."
5. Open that URL or the session's tunnel link in the web UI. For example:
   `http://p3000-0123456789abcdef0123456789abcdef.localhost:8790`. The token in this example is
   illustrative; use your session's actual URL.

Chrome and Firefox resolve `*.localhost` to loopback. The service must bind to `0.0.0.0` inside its
container so the proxy can reach it. Root paths and query strings are preserved, including WebSocket
connections used by development-server HMR. The upstream receives the original portal `Host`; if
your dev server restricts hosts, allow your portal hostname.

For a repeatable demonstration, put this in the repository's `.openinspect/start.sh` before creating
the session:

```bash
#!/usr/bin/env bash
set -euo pipefail
node -e 'require("node:http").createServer((req, res) => res.end("Docker portal works\n")).listen(3000, "0.0.0.0")' \
  </dev/null >/tmp/openinspect-portal-demo.log 2>&1 &
```

The provider sets `EXPECTED_TUNNEL_PORTS` from the extra tunnel ports. The existing runtime fetches
the control plane's committed URL map, writes `/workspace/.tunnels.env`, and makes `TUNNEL_3000`
available to `.openinspect/start.sh` through its normal startup ordering. Code-server, ttyd and
noVNC are started by the runtime when enabled; the hook only needs to start your application.
Code-server/VNC passwords and the terminal JWT reach the existing UI through the same access fields
used by hosted providers.

## Portal access boundary

Each new container gets a cryptographically random 128-bit token. Its label and the target port form
one lowercase DNS label, at most 39 characters: `p<port>-<token>`. The token, allowed ports, and
original service port plan are stored in Docker labels. Resume returns the same URLs and service
credentials while the deployment's public URL configuration and password derivation key remain
unchanged.

Anyone with a portal URL has its bearer credential and can address that session's allowed ports.
Treat these URLs as secrets. Code-server and VNC retain their own passwords, and ttyd retains its
JWT checks. The proxy sets `Referrer-Policy: no-referrer` on HTTP responses and does not log portal
hosts or tokens.

Every HTTP request and WebSocket upgrade is resolved through a label-filtered Docker query, then
container inspection. The proxy requires a running session container with this framework and
deployment's labels, matching token, an allowed port, and a private IPv4 endpoint on the configured
network. Host networking and shared container network namespaces are rejected. No upstream address
comes from a request URL, forwarding header, or DNS lookup. Unknown tokens, ports, networks, and
non-sandbox containers all receive an empty `404`. An authorized portal whose application is not
listening receives an empty `502`.

The portal listener has no control-plane routes. It strips untrusted forwarding and
connection-specific headers, supplies the configured public origin headers, and supports only HTTP
and WebSocket forwarding. It has no `CONNECT` or absolute-URL forward-proxy mode. The control plane
and object store do not carry session portal labels and cannot be selected.

## Later deployment on AWS

On one EC2 Docker host, keep the same private sandbox network and proxy listener. Point a wildcard
such as `*.portals.example.com` at your TLS reverse proxy, configure wildcard TLS, and set:

```dotenv
DOCKER_PORTAL_BASE_DOMAIN=portals.example.com
DOCKER_PORTAL_SCHEME=https
DOCKER_PORTAL_PUBLIC_PORT=443
DOCKER_PORTAL_PORT=8790
```

The listener still speaks HTTP internally. The TLS proxy must preserve the original `Host` and
support WebSocket upgrades. Configure its access logs to redact bearer hostnames. The local overlay
maps `DOCKER_PORTAL_PUBLIC_PORT` onto loopback; for AWS, override that mapping to a private upstream
port or reach `app:8790` from a TLS proxy on the Compose network. Keep the portal domain separate
from the control-plane/browser sign-in origin and keep the backend listener private. No hosted
sandbox provider is involved.
