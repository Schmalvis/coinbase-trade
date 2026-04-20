import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';

const ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientCache = new Map<string, any>();

function getPublicClient(network: string) {
  if (clientCache.has(network)) return clientCache.get(network)!;
  const chain = network === 'base-mainnet' ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http() });
  clientCache.set(network, client);
  return client;
}

/**
 * Read the balance of a token for a given wallet address.
 * Returns a human-readable float (already divided by decimals).
 * ETH sentinel → uses getBalance; ERC20 → uses balanceOf.
 */
export async function getTokenBalance(
  tokenAddress: string,
  walletAddress: string,
  network: string,
  decimals?: number,
): Promise<number> {
  const client = getPublicClient(network);

  if (tokenAddress.toLowerCase() === ETH_SENTINEL) {
    const raw = await client.getBalance({ address: walletAddress as `0x${string}` });
    return Number(raw) / 1e18;
  }

  const addr = tokenAddress as `0x${string}`;
  const wallet = walletAddress as `0x${string}`;

  let dec = decimals;
  if (dec === undefined) {
    dec = await client.readContract({
      address: addr,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }) as number;
  }

  const raw = await client.readContract({
    address: addr,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [wallet],
  }) as bigint;

  return Number(raw) / Math.pow(10, dec);
}
