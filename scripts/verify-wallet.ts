import dotenv from 'dotenv';
dotenv.config();
import { CdpClient } from '@coinbase/cdp-sdk';

const EXPECTED_MAINNET = '0x7dD5Acd498BCF96832f82684584734cF48c7318D';

async function main() {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;

  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    console.error('Missing CDP credentials in environment');
    process.exit(1);
  }

  console.log('Connecting to CDP...');
  const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });

  // The original wallet was created by AgentKit's CdpEvmWalletProvider which
  // uses cdp.evm.createAccount() (not getOrCreateAccount with a name).
  // Use getAccount() with the known address to restore it.
  const account = await cdp.evm.getAccount({ address: EXPECTED_MAINNET as `0x${string}` });

  console.log(`Restored address: ${account.address}`);
  console.log(`Expected address: ${EXPECTED_MAINNET}`);

  if (account.address.toLowerCase() === EXPECTED_MAINNET.toLowerCase()) {
    console.log('SUCCESS: Address matches — wallet correctly restored.');
    process.exit(0);
  } else {
    console.error('FAILURE: Address does not match. DO NOT DEPLOY.');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
