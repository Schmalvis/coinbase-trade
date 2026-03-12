import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../core/logger.js';

export class MCPClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(url: string, private readonly network: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.client = new Client({ name: 'coinbase-trade-bot', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
    logger.info(`MCP client connected (network: ${this.network})`);
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new Error('MCP client not connected');

    // Always inject network — required by multi-network MCP server
    const argsWithNetwork = { network: this.network, ...args };

    const result = await this.client.callTool({ name, arguments: argsWithNetwork });

    if (result.isError) {
      throw new Error(`MCP tool error [${name}]: ${JSON.stringify(result.content)}`);
    }

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
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.connected = false;
  }
}
