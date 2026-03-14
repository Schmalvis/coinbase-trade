import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCallTool = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: function MockClient() {
    return { connect: mockConnect, callTool: mockCallTool };
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: function MockTransport() {
    return { close: mockClose };
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { MCPClient } from '../src/mcp/client.js';

describe('MCPClient resilience', () => {
  let onHealthChange: ReturnType<typeof vi.fn>;
  let client: MCPClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    onHealthChange = vi.fn();
    client = new MCPClient('http://mcp-server:3002/mcp', () => 'base-sepolia', onHealthChange);
    await client.connect();
    // Default: health check passes
    mockFetch.mockResolvedValue({ ok: true });
  });

  it('does not call onHealthChange on first success', async () => {
    mockCallTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: '"ok"' }],
    });
    await client.callTool('test_tool', {});
    expect(onHealthChange).not.toHaveBeenCalled();
  });

  it('calls onHealthChange(false) after 3 consecutive health-check failures', async () => {
    mockFetch.mockResolvedValue({ ok: false }); // health check fails
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});
    expect(onHealthChange).toHaveBeenCalledWith(false);
  });

  it('calls onHealthChange(true) on recovery after failures', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});

    // Recover
    mockFetch.mockResolvedValue({ ok: true });
    mockCallTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: '"recovered"' }],
    });
    await client.callTool('test_tool', {});
    expect(onHealthChange).toHaveBeenCalledWith(true);
  });

  it('does not call onHealthChange(false) twice in a row', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    for (let i = 0; i < 6; i++) {
      await client.callTool('test_tool', {}).catch(() => {});
    }
    const falseCallCount = onHealthChange.mock.calls.filter(c => c[0] === false).length;
    expect(falseCallCount).toBe(1);
  });

  it('counts isError tool response as a failure', async () => {
    // Health check passes, but tool returns isError
    mockFetch.mockResolvedValue({ ok: true });
    mockCallTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'tool failed' }],
    });

    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});

    expect(onHealthChange).toHaveBeenCalledWith(false);
  });
});
