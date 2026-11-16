# Running the Bots Under Node

The GitHub, Slack and Linear bots are Cloudflare Workers. When the control plane runs as a container
([CONTROL_PLANE_CONTAINER.md](./CONTROL_PLANE_CONTAINER.md)), the bots can run beside it as
containers too: `packages/bots-node` serves an unchanged bot Worker over HTTP and stands in for the
Cloudflare bindings it uses.

| Worker binding                                  | Under Node                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `CONTROL_PLANE` service                         | HTTP to `CONTROL_PLANE_URL`; requests stay sig1-signed with the bot's secret    |
| `GITHUB_KV`, `SLACK_KV`, ...                    | SQLite in `DATA_DIR/bot.sqlite`, with expiry and prefix listing                 |
| `ctx.waitUntil`                                 | Tracked promises, logged on failure and awaited on shutdown                     |
| `AUTOFIX_QUEUE` (GitHub)                        | A signed `POST /internal/github-autofix` to the control plane's own job queue   |
| `SLACK_COMPLETION_QUEUE`                        | A queue table in the same SQLite file, consumed in-process with the same policy |
| Control plane → bot (`SLACK_BOT`, `LINEAR_BOT`) | `SLACK_BOT_URL` and `LINEAR_BOT_URL` on the control plane                       |

## Topology

One image, one container per bot. `BOT=github|slack|linear` picks the bot. Each container gets only
its own bot's variables, under the names the Worker reads (`SERVICE_AUTH_SECRET`, `DEFAULT_MODEL`,
`LOG_LEVEL`, ...), and its own data volume.

Each container listens twice:

- `PORT` (default 8080), the public listener: `GET /health` and the bot's webhook routes, nothing
  else. Point the load balancer here.
- `INTERNAL_PORT` (default 8081), the private listener: every route the Worker has, including the
  control plane's callbacks. Reachable only from the control plane's network.

| Bot    | Public webhook routes                | Internal-only routes                                                 |
| ------ | ------------------------------------ | -------------------------------------------------------------------- |
| GitHub | `POST /webhooks/github`              | none                                                                 |
| Slack  | `POST /events`, `POST /interactions` | `/callbacks/*`, `/internal/thread-context`, `/internal/channel-info` |
| Linear | `POST /webhook`                      | `/callbacks/*`                                                       |

The Linear Worker's OAuth installation routes (`/oauth/authorize`, `/oauth/callback`) are not served
on either listener: they have no OAuth state or owner check. The Linear bot obtains its runtime
token with the client-credentials grant, per organization, on first use.

## Webhook ingress

Before a bot sees a webhook, the host:

1. rejects malformed signature headers, and a stale Slack timestamp, without reading the body;
2. reads the body as a stream, cancelled past `WEBHOOK_MAX_BODY_BYTES` (default 1 MiB) or
   `WEBHOOK_BODY_TIMEOUT_MS` (default 10 s), with at most `WEBHOOK_MAX_CONCURRENT_READS`
   (default 32) reads at a time;
3. verifies the provider's HMAC over exactly those bytes;
4. checks the tenant: the GitHub delivery's installation must be `GITHUB_APP_INSTALLATION_ID`, the
   Slack team one of `SLACK_ALLOWED_TEAM_IDS`, the Linear organization one of
   `LINEAR_ALLOWED_ORGANIZATION_IDS`; Linear's signed `webhookTimestamp` must be within five
   minutes;
5. records the request's signature in a durable replay ledger. A Slack or Linear request seen before
   is refused. A GitHub body seen before is accepted only under its original `X-GitHub-Delivery`
   (GitHub's own redelivery, which the bot deduplicates); under any other delivery id it is refused.

## Configuration

Host settings: `BOT`, `DATA_DIR` (required), `HOST`, `PORT`, `INTERNAL_PORT`, `SHUTDOWN_TIMEOUT_MS`,
and the `WEBHOOK_*` limits above. `CONTROL_PLANE_URL` is the control plane's private origin, for
example `http://app:8787`.

Required per bot, besides `CONTROL_PLANE_URL`, `SERVICE_AUTH_SECRET` and `DEPLOYMENT_NAME`:

- GitHub: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_APP_INSTALLATION_ID`, `GITHUB_BOT_USERNAME`, `DEFAULT_MODEL`.
- Slack: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_ALLOWED_TEAM_IDS`, `WEB_APP_URL`,
  `DEFAULT_MODEL`.
- Linear: `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
  `LINEAR_ALLOWED_ORGANIZATION_IDS`, `WEB_APP_URL`, `DEFAULT_MODEL`.

Each bot's `SERVICE_AUTH_SECRET` must equal the control plane's `SERVICE_AUTH_SECRET_GITHUB_BOT`,
`SERVICE_AUTH_SECRET_SLACK_BOT` or `SERVICE_AUTH_SECRET_LINEAR_BOT`; use a different value per bot.
For Slack and Linear, set `SLACK_BOT_URL` or `LINEAR_BOT_URL` on the control plane to the bot's
internal listener, for example `http://slack-bot:8081`.

The bots need no cloud credentials. Run them on a network that cannot reach the instance metadata
service.

## Build

```bash
docker build -f packages/bots-node/Dockerfile -t open-inspect-bots .
```

The build runs from the repository root; `packages/bots-node/Dockerfile.dockerignore` limits the
context to the shared package, the three bots and the host.
