import { CdpClient } from '@coinbase/cdp-sdk';
import { logger } from '../core/logger.js';

export class CdpWalletClient {
  private cdp: CdpClient;
  private _address: string | null = null;
  private _account: any | null = null; // EvmAccount from CDP SDK
  private _network: string;

  /**
   * @param walletAddress Optional known address — uses getAccount() to restore
   *   the exact wallet (e.g. one originally created by AgentKit/MCP server).
   *   If omitted, falls back to getOrCreateAccount({ name: 'coinbase-trade-bot' }).
   */
  constructor(
    private readonly apiKeyId: string,
    private readonly apiKeySecret: string,
    private readonly walletSecret: string,
    network: string,
    private readonly walletAddress?: string,
  ) {
    this._network = network;
    this.cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
  }

  get network(): string { return this._network; }
  set network(n: string) { this._network = n; }
  get address(): string | null { return this._address; }
  get sdk(): CdpClient { return this.cdp; }
  get account(): any { return this._account; }

  async init(): Promise<string> {
    if (this.walletAddress) {
      this._account = await this.cdp.evm.getAccount({ address: this.walletAddress as `0x${string}` });
      logger.info(`CDP wallet restored by address: ${this._account.address}`);
    } else {
      this._account = await this.cdp.evm.getOrCreateAccount({ name: 'coinbase-trade-bot' });
      logger.info(`CDP wallet initialised (getOrCreate): ${this._account.address}`);
    }
    this._address = this._account.address as string;
    return this._address;
  }
}
