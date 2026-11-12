#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// stdout carries the MCP protocol, so all logging goes to stderr.
const log = (...args: unknown[]) => console.error("[mcp-rabbitmq]", ...args);

const BASE_URL = (process.env.RABBITMQ_MGMT_URL ?? "http://localhost:15673").replace(/\/+$/, "");
const USER = process.env.RABBITMQ_MGMT_USER;
const PASSWORD = process.env.RABBITMQ_MGMT_PASSWORD;
const TIMEOUT_MS = 5000;

const TUNNEL_HINT = "is `make tunnel` running in importer?";
const AUTH_HINT = "check RABBITMQ_MGMT_USER/PASSWORD";

class MgmtError extends Error {}

async function mgmtGet(path: string): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const auth = Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const reason = name === "TimeoutError" ? `timed out after ${TIMEOUT_MS}ms` : describeFetchError(err);
    throw new MgmtError(`GET ${url} failed: ${reason} (${TUNNEL_HINT})`);
  }
  if (res.status === 401) {
    throw new MgmtError(`GET ${url} returned 401 Unauthorized (${AUTH_HINT})`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new MgmtError(`GET ${url} returned ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // undici wraps the real reason (e.g. ECONNREFUSED) in `cause`.
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? err.message;
}

async function startupCheck(): Promise<void> {
  const missing = [
    ["RABBITMQ_MGMT_USER", USER],
    ["RABBITMQ_MGMT_PASSWORD", PASSWORD],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new MgmtError(`missing env var(s): ${missing.join(", ")}`);
  }
  await mgmtGet("/api/overview");
}

interface RawQueue {
  vhost: string;
  name: string;
  type?: string;
  state?: string;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
}

interface QueueStat {
  vhost: string;
  name: string;
  type: string;
  state: string;
  ready: number;
  unacked: number;
  consumers: number;
}

function formatTable(rows: QueueStat[]): string {
  if (rows.length === 0) return "(no queues)";
  const headers = ["vhost", "name", "type", "state", "ready", "unacked", "consumers"] as const;
  const cells = rows.map((r) => headers.map((h) => String(r[h])));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (cols: readonly string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

const server = new McpServer({ name: "rabbitmq", version: "0.1.0" });

server.registerTool(
  "queue_stats",
  {
    title: "RabbitMQ queue stats",
    description:
      "List RabbitMQ queues with ready / unacked message counts and consumer count, from the management API.",
    inputSchema: {
      vhost: z.string().optional().describe("Only queues in this vhost (default: all vhosts)"),
      name: z.string().optional().describe("Case-insensitive substring filter on queue name"),
    },
  },
  async ({ vhost, name }) => {
    try {
      const columns = "vhost,name,type,state,messages_ready,messages_unacknowledged,consumers";
      const path = `/api/queues${vhost !== undefined ? `/${encodeURIComponent(vhost)}` : ""}?columns=${columns}`;
      const raw = (await mgmtGet(path)) as RawQueue[];
      const needle = name?.toLowerCase();
      const rows: QueueStat[] = raw
        .filter((q) => !needle || q.name.toLowerCase().includes(needle))
        .map((q) => ({
          vhost: q.vhost,
          name: q.name,
          type: q.type ?? "unknown",
          state: q.state ?? "unknown",
          // Fresh quorum queues can omit counters entirely.
          ready: q.messages_ready ?? 0,
          unacked: q.messages_unacknowledged ?? 0,
          consumers: q.consumers ?? 0,
        }))
        .sort((a, b) => a.vhost.localeCompare(b.vhost) || a.name.localeCompare(b.name));
      return {
        content: [{ type: "text", text: `${formatTable(rows)}\n\n${JSON.stringify(rows, null, 2)}` }],
      };
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (vhost !== undefined && / 404 /.test(message)) message += ` (vhost "${vhost}" may not exist)`;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

async function main(): Promise<void> {
  await startupCheck();
  await server.connect(new StdioServerTransport());
  log(`connected to ${BASE_URL}`);
}

main().catch((err) => {
  log("startup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
