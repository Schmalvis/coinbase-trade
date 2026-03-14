import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../core/logger.js';

const FAILURE_THRESHOLD = 3;

export class MCPClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  private consecutiveFailures = 0;
  private healthy = true;
  private readonly healthUrl: string;

  constructor(
    private readonly url: string,
    private readonly getNetwork: () => string,
    private readonly onHealthChange?: (healthy: boolean) => void,
  ) {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.client = new Client({ name: 'coinbase-trade-bot', version: '0.1.0' });
    this.healthUrl = url.replace(/\/mcp$/, '') + '/health';
  }

  get network(): string { return this.getNetwork(); }
  get isHealthy(): boolean { return this.healthy; }
  get failureCount(): number { return this.consecutiveFailures; }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
    logger.info(`MCP client connected`);
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new Error('MCP client not connected');

    // Pre-flight health check
    let healthOk = false;
    try {
      const res = await fetch(this.healthUrl);
      healthOk = res.ok;
    } catch {
      healthOk = false;
    }

    if (!healthOk) {
      this._recordFailure();
      throw new Error(`MCP server unreachable or unhealthy`);
    }

    const argsWithNetwork = { network: this.getNetwork(), ...args };

    let failureRecorded = false;

    try {
      const result = await this.client.callTool({ name, arguments: argsWithNetwork });

      if (result.isError) {
        this._recordFailure();
        failureRecorded = true;
        throw new Error(`MCP tool error [${name}]: ${JSON.stringify(result.content)}`);
      }

      this._recordSuccess();

      // Tools return content as an array of content blocks; extract text
      const content = result.content as { type: string; text?: string }[];
      const text = content
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('\n');

      try {
        const parsed = JSON.parse(text);
        // Handle double-encoded JSON (some tools return a JSON string inside JSON)
        if (typeof parsed === 'string') {
          try { return JSON.parse(parsed) as T; } catch { return parsed as unknown as T; }
        }
        return parsed as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      if (!failureRecorded) {
        this._recordFailure();
      }
      throw err;
    }
  }

  private _recordFailure(): void {
    this.consecutiveFailures++;
    logger.warn(`MCP failure #${this.consecutiveFailures}`);
    if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.healthy) {
      this.healthy = false;
      logger.error(`MCP server marked unhealthy after ${this.consecutiveFailures} consecutive failures`);
      this.onHealthChange?.(false);
    }
  }

  private _recordSuccess(): void {
    if (!this.healthy) {
      this.healthy = true;
      logger.info('MCP server recovered');
      this.onHealthChange?.(true);
    }
    this.consecutiveFailures = 0;
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.connected = false;
  }
}
