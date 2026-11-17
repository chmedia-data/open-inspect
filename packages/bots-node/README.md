# Bots on Node

Serves one of the bot Workers (`packages/github-bot`, `packages/slack-bot`, `packages/linear-bot`)
as a Node process, with the Cloudflare bindings it uses replaced by local equivalents. Deployment,
routes and configuration are in [docs/BOTS_NODE.md](../../docs/BOTS_NODE.md).

| File                          | What it does                                                               |
| ----------------------------- | -------------------------------------------------------------------------- |
| `src/bots.ts`                 | Each bot once: its Worker, KV, queues, webhook and internal routes, env    |
| `src/ingress.ts`              | The webhook gate: header precheck, bounded read, HMAC, tenant, replay      |
| `src/store.ts`                | SQLite: the KV namespace, the replay ledger and the bot's own queue        |
| `src/host.ts`                 | The two listeners, bindings, `waitUntil`, queue consumer, shutdown         |
| `src/main.ts`                 | Process entry (`BOT=...`), signals, and the `kv` operator command          |
| `types/workers-bindings.d.ts` | The binding surface this host implements, which the bots typecheck against |

The bots are bundled from source unchanged. `npm run typecheck` checks them against
`types/workers-bindings.d.ts` rather than workers-types, so a bot that starts using a Workers API
this host does not provide fails here first.

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/bots-node
npm run build -w @open-inspect/bots-node
BOT=github DATA_DIR=/tmp/github-bot ... node packages/bots-node/dist/main.js

# Operator-managed keys (the Workers deployment uses `wrangler kv key put`):
DATA_DIR=/data node /app/main.js kv put config:team-repos '{"ENG":"acme/widgets"}'
```

`test/github-bot.integration.test.ts` runs the GitHub bot under the host against a fake control
plane on its own port that verifies every request's service signature.
