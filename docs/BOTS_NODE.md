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
- `INTERNAL_PORT` (default 8081), the private listener: the same, plus only the routes the control
  plane calls (below), with their bodies read under the same cap and deadline as webhooks. Every
  other route the Worker has is served by neither listener.

Both listeners answer 404 to any path containing `%`, or one that URL normalization would change,
because the Worker's router decodes a path such as `/%6Fauth/callback` into a route the host's own
checks did not see.

| Bot    | Public webhook routes                | Internal-only routes                                                 |
| ------ | ------------------------------------ | -------------------------------------------------------------------- |
| GitHub | `POST /webhooks/github`              | none                                                                 |
| Slack  | `POST /events`, `POST /interactions` | `/callbacks/*`, `/internal/thread-context`, `/internal/channel-info` |
| Linear | `POST /webhook`                      | `/callbacks/*`                                                       |

The Linear Worker's OAuth installation routes (`/oauth/authorize`, `/oauth/callback`) are not served
on either listener, in any encoding: they have no OAuth state or owner check. The Linear bot obtains
its runtime token with the client-credentials grant, per organization, on first use.

## Webhook ingress

Before a bot sees a webhook, the host:

1. rejects malformed signature headers, and a stale Slack timestamp, without reading the body;
2. reads the body as a stream, cancelled past `WEBHOOK_MAX_BODY_BYTES` (default 1 MiB) or
   `WEBHOOK_BODY_TIMEOUT_MS` (default 10 s), with at most `WEBHOOK_MAX_CONCURRENT_READS`
   (default 32) reads at a time;
3. verifies the provider's HMAC over exactly those bytes, not their decoded text;
4. checks the tenant: the GitHub delivery's installation must be `GITHUB_APP_INSTALLATION_ID`, the
   Slack team one of `SLACK_ALLOWED_TEAM_IDS`, the Linear organization one of
   `LINEAR_ALLOWED_ORGANIZATION_IDS`; Linear's signed `webhookTimestamp` must be within five
   minutes;
5. records the request's signature in a durable replay ledger. A Slack or Linear request seen before
   is refused. A GitHub body seen before is accepted only under its original `X-GitHub-Delivery` and
   only within three days of its first sighting, GitHub's redelivery window (a manual redelivery,
   which the bot deduplicates). Under any other delivery id, or later, it is refused. GitHub signs
   no timestamp, so its records are kept for 90 days, after which a captured delivery would verify
   as new. When the bot fails a Slack or Linear request (an error, or a 5xx answer), its record is
   dropped, so the provider's retry of the same signed request gets through.

GitHub never retries a delivery on its own. Three paths answer it 503 and lose the event until
someone makes a manual redelivery from the GitHub App's settings: more than
`WEBHOOK_MAX_CONCURRENT_READS` bodies in flight (`too_many_concurrent_reads`), a repeat of a
delivery the bot is still handling (`delivery_in_flight`), and the control plane refusing an Autofix
job (`autofix.refused`). All three log at error level; alert on them, or on the load balancer's 503
rate.

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

Give each bot its own network, shared only with `app`. The internal listener trusts its whole
network segment: its routes check the control plane's signature, but a peer on the same network can
still reach them, so one bot should not share a network with another.

Set `stop_grace_period: 40s` on each bot service. On SIGTERM the host drains in-flight work for up
to `SHUTDOWN_TIMEOUT_MS` (30 s by default) and then exits; Docker's default grace of 10 s would kill
it first and lose events already acknowledged to the provider. The `app` service uses the same value
for the same reason.

## Build

```bash
docker build -f packages/bots-node/Dockerfile -t open-inspect-bots .
```

The build runs from the repository root; `packages/bots-node/Dockerfile.dockerignore` limits the
context to the shared package, the three bots and the host.
