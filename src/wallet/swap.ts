import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { CdpWalletClient } from './client.js';
import { logger } from '../core/logger.js';

export interface SwapPrice {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  priceImpact?: string;
}

export interface SwapResult {
  txHash: string;
  status: string;
}

// Known token decimals by lowercase address
const TOKEN_DECIMALS: Record<string, number> = {
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 18, // ETH sentinel
  '0x4200000000000000000000000000000000000006': 18, // WETH on Base
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,  // USDC mainnet
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 6,  // USDC sepolia
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 8,  // CBBTC mainnet
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 18, // CBETH mainnet
};

const ERC20_DECIMALS_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

function sdkNetwork(network: string): string {
  return network === 'base-mainnet' ? 'base' : network;
}

function toWei(amount: string | number, decimals: number): bigint {
  const parts = String(amount).split('.');
  const whole = BigInt(parts[0] || '0');
  const fracStr = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
  const frac = BigInt(fracStr);
  return whole * (10n ** BigInt(decimals)) + frac;
}

function fromWei(raw: bigint | string, decimals: number): string {
  const n = typeof raw === 'bigint' ? raw : BigInt(raw);
  const divisor = 10n ** BigInt(decimals);
  const whole = n / divisor;
  const remainder = n % divisor;
  if (remainder === 0n) return whole.toString();
  const fracStr = remainder.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

export class SwapService {
  constructor(private readonly walletClient: CdpWalletClient) {}

  private async getDecimals(tokenAddress: string, network: string): Promise<number> {
    const lower = tokenAddress.toLowerCase();
    if (TOKEN_DECIMALS[lower] !== undefined) return TOKEN_DECIMALS[lower];

    // Read from contract
    const chain = network === 'base-mainnet' ? base : baseSepolia;
    const client = createPublicClient({ chain, transport: http() });
    const dec = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
    }) as number;
    TOKEN_DECIMALS[lower] = dec; // cache
    return dec;
  }

  async getSwapPrice(
    fromTokenAddress: string,
    toTokenAddress: string,
    fromAmount: string,
    network: string,
  ): Promise<SwapPrice> {
    const address = this.walletClient.address;
    if (!address) throw new Error('Wallet not initialised');

    const fromDecimals = await this.getDecimals(fromTokenAddress, network);
    const toDecimals   = await this.getDecimals(toTokenAddress, network);
    const fromWeiAmt   = toWei(fromAmount, fromDecimals);

    const quote = await this.walletClient.sdk.evm.getSwapPrice({
      network: sdkNetwork(network) as any,
      fromToken: fromTokenAddress as `0x${string}`,
      toToken:   toTokenAddress   as `0x${string}`,
      fromAmount: fromWeiAmt,
      taker: address as `0x${string}`,
    });

    const q = quote as any;
    const toAmountStr = q.toAmount !== undefined
      ? fromWei(BigInt(q.toAmount.toString()), toDecimals)
      : '0';

    return {
      fromToken:   fromTokenAddress,
      toToken:     toTokenAddress,
      fromAmount,
      toAmount:    toAmountStr,
      priceImpact: q.liquidityAvailable ? undefined : 'no_liquidity',
    };
  }

  async swap(
    fromTokenAddress: string,
    toTokenAddress: string,
    fromAmount: string,
    network: string,
  ): Promise<SwapResult> {
    const account = this.walletClient.account;
    if (!account) throw new Error('Wallet not initialised');

    const fromDecimals = await this.getDecimals(fromTokenAddress, network);
    const fromWeiAmt   = toWei(fromAmount, fromDecimals);

    try {
      const { transactionHash } = await account.swap({
        network:    sdkNetwork(network),
        fromToken:  fromTokenAddress as `0x${string}`,
        toToken:    toTokenAddress   as `0x${string}`,
        fromAmount: fromWeiAmt,
        slippageBps: 100,
      });

      logger.info(`Swap executed: ${fromAmount} ${fromTokenAddress} → ${toTokenAddress} txHash=${transactionHash}`);
      return { txHash: transactionHash, status: 'executed' };

    } catch (cdpErr) {
      logger.warn(`CDP swap failed: ${cdpErr}`);

      // 0x fallback — only if key is set
      const zeroXKey = process.env.ZEROX_API_KEY;
      if (!zeroXKey) throw cdpErr;

      logger.info('Falling back to 0x API swap');
      return this.swapVia0x(fromTokenAddress, toTokenAddress, fromWeiAmt, network, zeroXKey);
    }
  }

  private async swapVia0x(
    fromToken: string,
    toToken: string,
    fromAmountWei: bigint,
    network: string,
    apiKey: string,
  ): Promise<SwapResult> {
    const address = this.walletClient.address;
    if (!address) throw new Error('Wallet not initialised');

    const chainId = network === 'base-mainnet' ? 8453 : 84532;
    const url = `https://api.0x.org/swap/permit2/quote?chainId=${chainId}&sellToken=${fromToken}&buyToken=${toToken}&sellAmount=${fromAmountWei.toString()}&taker=${address}`;

    const res = await fetch(url, { headers: { '0x-api-key': apiKey, '0x-version': 'v2' } });
    if (!res.ok) throw new Error(`0x quote failed: ${res.status} ${await res.text()}`);
    const quote = await res.json() as { transaction: { to: string; data: string; value: string } };

    const tx = quote.transaction;
    const { transactionHash } = await this.walletClient.sdk.evm.sendTransaction({
      address: address as `0x${string}`,
      network: sdkNetwork(network) as any,
      transaction: {
        to:    tx.to   as `0x${string}`,
        data:  tx.data as `0x${string}`,
        value: BigInt(tx.value ?? '0'),
      },
    });

    return { txHash: transactionHash, status: 'executed_via_0x' };
  }
}
