# mcp-rabbitmq

A one-tool stdio MCP server that reads RabbitMQ queue stats (ready / unacked / consumers) from the management API, so Claude Code can check queue depth without the UI or `rabbitmqctl`.

## Build

```sh
npm install
npm run build
```

Requires Node 22+ (uses global `fetch`).

## Configuration

| Env var                  | Default                  |
| ------------------------ | ------------------------ |
| `RABBITMQ_MGMT_URL`      | `http://localhost:15673` |
| `RABBITMQ_MGMT_USER`     | required                 |
| `RABBITMQ_MGMT_PASSWORD` | required                 |

The default URL is the management UI as forwarded by `make tunnel` in `importer/`, which must be running. Credentials come from the operator's default-user Secret:

```sh
export RABBITMQ_MGMT_USER=$(kubectl -n data get secret rabbitmq-default-user -o jsonpath='{.data.username}' | base64 -d)
export RABBITMQ_MGMT_PASSWORD=$(kubectl -n data get secret rabbitmq-default-user -o jsonpath='{.data.password}' | base64 -d)
```

On startup the server checks the credentials and `GET /api/overview`. If either fails it exits 1 with a hint on stderr, so `/mcp` shows it as failed. After startup, API errors (tunnel dropped, unknown vhost) come back as tool errors and the server stays up.

## Register with Claude Code

From `importer/` (local scope, stored in `~/.claude.json`, nothing committed):

```sh
claude mcp add --scope local rabbitmq -- node /Users/cristianlopez/Projects/vandelay-labs/mcp-rabbitmq/dist/index.js
```

No `env` is configured: the stdio server inherits Claude Code's environment, so export the credentials before starting `claude`. Use `--scope user` instead to make it available in every repo.

## Tool

`queue_stats`

- `vhost?: string`: only this vhost (default: all)
- `name?: string`: case-insensitive substring filter on the queue name

Returns a text table plus JSON rows of `{vhost, name, type, state, ready, unacked, consumers}`.

## Smoke test

The inspector doesn't forward the parent environment, so pass credentials with `-e`:

```sh
npx @modelcontextprotocol/inspector --cli \
  -e RABBITMQ_MGMT_USER="$RABBITMQ_MGMT_USER" -e RABBITMQ_MGMT_PASSWORD="$RABBITMQ_MGMT_PASSWORD" \
  node dist/index.js --method tools/call --tool-name queue_stats
```
