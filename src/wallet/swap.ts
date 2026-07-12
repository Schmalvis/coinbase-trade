import type { CdpWalletClient } from './client.js';
import { logger } from '../core/logger.js';
import { ASSET_REGISTRY } from '../assets/registry.js';
import { getPublicClient } from './erc20.js';
import { botState } from '../core/state.js';
import { queries } from '../data/db.js';

// C8-followup: bounded wait for the on-chain receipt after submitting a swap. Base blocks
// land in ~2s, but this caps the worst case so a stuck/never-mined tx can't hang the poll loop.
const RECEIPT_TIMEOUT_MS = 90_000;

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
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 18, // AERO
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 18, // VIRTUAL
  '0xbaa5cc21fd487b8fcc2f45f966f723e0191b3d8e': 18, // MORPHO
  '0xa88594d404727625a9437c3f886c7643872296ae': 18, // WELL
  '0x4ed4e862860bed51a9570b96d89af5e1b0efefed': 18, // DEGEN
  '0x532f27101965dd16442e59d40670faf5ebb142e4': 18, // BRETT
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

  private isRegistrySwap(fromAddress: string, toAddress: string): boolean {
    const registryAddresses = new Set(
      ASSET_REGISTRY.flatMap(a => Object.values(a.addresses)).map(a => a.toLowerCase())
    );
    return registryAddresses.has(fromAddress.toLowerCase()) && registryAddresses.has(toAddress.toLowerCase());
  }

  private async getDecimals(tokenAddress: string, network: string): Promise<number> {
    const lower = tokenAddress.toLowerCase();
    if (TOKEN_DECIMALS[lower] !== undefined) return TOKEN_DECIMALS[lower];

    // Read from contract
    const client = getPublicClient(network);
    const dec = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
    }) as number;
    TOKEN_DECIMALS[lower] = dec; // cache
    return dec;
  }

  /**
   * C8-followup: wait for the submitted swap tx to actually settle on-chain, and interpret
   * the outcome. Called only for real (non-dry-run) swaps — callers gate on DRY_RUN before
   * ever reaching swap(), so this never runs in dry-run mode.
   *
   * - receipt.status === 'success'  → 'executed' (tx mined, effects applied — callers can now
   *   safely read post-swap balances, e.g. C8's leg-1 proceeds measurement).
   * - receipt.status === 'reverted' → 'failed' (tx mined but reverted — no funds moved; must
   *   NOT be reported as executed, or callers record a phantom fill/P&L).
   * - timeout or a receipt-fetch error → 'executed' (best-effort degrade). We deliberately do
   *   NOT hang the poll loop waiting indefinitely, and we deliberately do NOT report 'failed'
   *   on a merely-unconfirmed tx (it may still land and succeed — reporting 'failed' here could
   *   cause a caller to attempt a compensating action against a swap that actually succeeds).
   *   This matches pre-existing behavior for the rare un-mined case: the tx hash is still
   *   returned, and downstream balance-delta measurements (e.g. C8) simply see no delta yet
   *   and fall back to their pre-existing safe sizing rather than the real measured proceeds.
   */
  private async waitForSettlement(txHash: string, network: string): Promise<'executed' | 'failed'> {
    try {
      const client = getPublicClient(network);
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (receipt.status === 'reverted') {
        logger.error(`Swap tx reverted on-chain: ${txHash}`);
        return 'failed';
      }
      return 'executed';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Swap receipt wait failed/timed out for ${txHash} — treating as executed (best-effort, unconfirmed): ${msg}`);
      // Operator visibility: this degrade path reports 'executed' on a tx we never actually
      // confirmed on-chain. If it reverted, callers (P&L, position tracking) will still record
      // it as a real fill. Surface this loudly so an operator can manually verify the tx rather
      // than silently trusting an unconfirmed result.
      try {
        queries.insertEvent.run(
          'swap_settlement_timeout',
          `txHash=${txHash} network=${network} — receipt wait failed/timed out, reported as executed (best-effort, unconfirmed): ${msg}`,
        );
        botState.emitAlert(
          `⚠️ Swap settlement unconfirmed — treated as executed (best-effort) but not verified on-chain.\ntxHash: ${txHash}\nnetwork: ${network}\nReason: ${msg}\nPlease verify this tx manually.`,
        );
      } catch (alertErr) {
        logger.warn(`Failed to emit swap_settlement_timeout alert: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`);
      }
      return 'executed';
    }
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
        slippageBps: this.isRegistrySwap(fromTokenAddress, toTokenAddress) ? 150 : 200,
      });

      logger.info(`Swap submitted: ${fromAmount} ${fromTokenAddress} → ${toTokenAddress} txHash=${transactionHash} — waiting for settlement`);
      const settleStatus = await this.waitForSettlement(transactionHash, network);
      if (settleStatus === 'failed') {
        return { txHash: transactionHash, status: 'failed' };
      }
      logger.info(`Swap settled: ${fromAmount} ${fromTokenAddress} → ${toTokenAddress} txHash=${transactionHash}`);
      return { txHash: transactionHash, status: 'executed' };

    } catch (cdpErr) {
      const msg = cdpErr instanceof Error
        ? `${cdpErr.message}\n${cdpErr.stack ?? ''}`
        : String(cdpErr);
      logger.warn(`CDP swap failed: ${msg}`);

      // 0x fallback — only if key is set
      const zeroXKey = process.env.ZEROX_API_KEY;
      if (!zeroXKey) throw cdpErr;

      logger.info('Falling back to 0x API swap');
      return this.swapVia0x(fromTokenAddress, toTokenAddress, fromWeiAmt, network, zeroXKey);
    }
  }

  /**
   * Returns the estimated price impact (%) for buying `tokenAddress` with `amountUsd` of USDC,
   * or `null` when a reliable reading cannot be obtained. Callers must treat `null` as "unknown"
   * and fail-closed for non-registry assets — a `0` here would mean "fail-open", which would
   * silence the guard.
   *
   * S1: the 0x Swap API v2 `/swap/permit2/quote` response does not contain an
   * `estimatedPriceImpact` field (that was v1-only, removed in v2), and this bot runs with no
   * `ZEROX_API_KEY` configured — so a 0x-based impact read is permanently unavailable here.
   * Instead this computes impact via the CDP SDK quote path (`getSwapPrice`, no 0x key needed —
   * the same path the C7 promotion gate already relies on) compared against the latest known
   * spot price for the asset ("quote-vs-spot"). This is the most robust option for our tiny
   * (~$2) trade sizes, where a second reference quote would add noise rather than signal.
   *
   * `spotPriceUsd` must be a recent USD/token reference price (e.g. the latest `asset_snapshots`
   * row) supplied by the caller — this class has no DB access. If it's missing or <= 0, we
   * cannot compute a meaningful impact and return `null`.
   */
  async getQuoteImpactPct(tokenAddress: string, amountUsd: number, spotPriceUsd: number): Promise<number | null> {
    if (!(spotPriceUsd > 0)) {
      logger.debug(`getQuoteImpactPct: no valid spot price for ${tokenAddress} — returning null (cannot assess slippage)`);
      return null;
    }

    const network = this.walletClient.network;
    const usdcAddress = network === 'base-mainnet'
      ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      : '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

    try {
      const quote = await this.getSwapPrice(usdcAddress, tokenAddress, String(amountUsd), network);
      // No liquidity for this pair is an unconditional "can't assess" signal.
      if (quote.priceImpact === 'no_liquidity') {
        logger.warn(`getQuoteImpactPct: no liquidity for ${tokenAddress} — returning null`);
        return null;
      }
      const toAmountHuman = parseFloat(quote.toAmount);
      if (!(toAmountHuman > 0)) {
        logger.warn(`getQuoteImpactPct: quote returned zero/invalid toAmount for ${tokenAddress} — returning null`);
        return null;
      }
      const executionPriceUsd = amountUsd / toAmountHuman; // USDC paid per token received
      // Impact is how much worse the execution price is vs. spot. Clamp to >= 0 — a quote
      // "better" than the last snapshot just means the snapshot is stale, not negative slippage.
      const impactPct = Math.max(0, (executionPriceUsd / spotPriceUsd - 1) * 100);
      return impactPct;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`getQuoteImpactPct: quote failed for ${tokenAddress} — returning null (${msg})`);
      return null;
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

    logger.info(`0x swap submitted: txHash=${transactionHash} — waiting for settlement`);
    const settleStatus = await this.waitForSettlement(transactionHash, network);
    if (settleStatus === 'failed') {
      return { txHash: transactionHash, status: 'failed' };
    }
    return { txHash: transactionHash, status: 'executed_via_0x' };
  }
}
