// src/jager/rpc.ts
// Resilient BSC RPC provider helper with fallback endpoints,
// gas estimation with 20% buffer, and tx receipt parsing.
import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../core/logger';

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const providerCache = new Map<string, ethers.JsonRpcProvider>();

export function getBscProvider(rpcUrl: string = config.bscRpcUrl): ethers.JsonRpcProvider {
  let provider = providerCache.get(rpcUrl);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(rpcUrl, config.BSC_CHAIN_ID, {
      staticNetwork: ethers.Network.from(config.BSC_CHAIN_ID),
      batchMaxCount: 1,
    });
    providerCache.set(rpcUrl, provider);
  }
  return provider;
}

/** Run an RPC operation trying primary and fallback BSC RPC URLs */
export async function withBscRpc<T>(
  fn: (provider: ethers.JsonRpcProvider, url: string) => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (const url of config.bscFallbackRpcs) {
    try {
      const provider = getBscProvider(url);
      return await fn(provider, url);
    } catch (err) {
      lastErr = err;
      logger.debug('BSC RPC attempt failed, trying next fallback', {
        url,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Estimate gas for a transaction and add a 20% buffer */
export async function estimateGasWithBuffer(tx: {
  from?: string;
  to: string;
  value?: string;
  data?: string;
}): Promise<{ gasLimit: bigint; gasPriceWei: bigint; gasCostBnb: string }> {
  let gasLimit = 300_000n;
  let gasPriceWei = 1_000_000_000n; // 1 gwei BSC fallback

  try {
    gasLimit = await withBscRpc(async (provider) => {
      const est = await provider.estimateGas({
        from: tx.from,
        to: tx.to,
        value: tx.value ? BigInt(tx.value) : 0n,
        data: tx.data && tx.data !== '' ? tx.data : '0x',
      });
      return (est * 120n) / 100n;
    });
  } catch (err) {
    logger.warn('Gas estimation failed, using fallback 300000 (+20% = 360000)', {
      to: tx.to,
      err: err instanceof Error ? err.message : String(err),
    });
    gasLimit = 360_000n;
  }

  try {
    const feeData = await withBscRpc((p) => p.getFeeData());
    if (feeData.gasPrice && feeData.gasPrice > 0n) {
      gasPriceWei = feeData.gasPrice;
    }
  } catch {
    // keep default
  }

  const gasCostBnb = ethers.formatEther(gasLimit * gasPriceWei);
  return { gasLimit, gasPriceWei, gasCostBnb };
}

/** Query current BSC gas price in wei */
export async function getCurrentGasPriceWei(): Promise<bigint> {
  try {
    const feeData = await withBscRpc((p) => p.getFeeData());
    return feeData.gasPrice && feeData.gasPrice > 0n ? feeData.gasPrice : 1_000_000_000n;
  } catch {
    return 1_000_000_000n;
  }
}

/** Read current ERC-20 allowance */
export async function getErc20Allowance(
  tokenAddress: string,
  owner: string,
  spender: string
): Promise<bigint> {
  try {
    const abi = ['function allowance(address owner, address spender) view returns (uint256)'];
    return await withBscRpc(async (provider) => {
      const contract = new ethers.Contract(tokenAddress, abi, provider);
      return (await contract.allowance(owner, spender)) as bigint;
    });
  } catch {
    return 0n;
  }
}

export interface TxReceiptSummary {
  confirmed: boolean;
  reverted: boolean;
  gasUsedBnb: string;
  jagentReceived: string;
}

/**
 * Wait briefly for an on-chain BSC receipt and extract actual gas used + JAGENT received.
 */
export async function waitForMintReceipt(
  txHash: string,
  walletAddress: string,
  timeoutMs = 30_000
): Promise<TxReceiptSummary> {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { confirmed: false, reverted: false, gasUsedBnb: '0', jagentReceived: '0' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await withBscRpc((p) => p.getTransactionReceipt(txHash));
      if (receipt) {
        const gasPrice = receipt.gasPrice ?? 0n;
        const gasUsedBnb = ethers.formatEther(receipt.gasUsed * gasPrice);
        const reverted = receipt.status === 0;

        let totalJagentWei = 0n;
        const walletTopic = ethers.zeroPadValue(walletAddress.toLowerCase(), 32).toLowerCase();
        for (const log of receipt.logs) {
          if (
            log.address.toLowerCase() === config.JAGENT_TOKEN.toLowerCase() &&
            log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase() &&
            log.topics[2]?.toLowerCase() === walletTopic
          ) {
            try {
              totalJagentWei += BigInt(log.data);
            } catch {
              // ignore malformed data
            }
          }
        }

        return {
          confirmed: true,
          reverted,
          gasUsedBnb,
          jagentReceived: ethers.formatUnits(totalJagentWei, 18),
        };
      }
    } catch {
      // retry until timeout
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return { confirmed: false, reverted: false, gasUsedBnb: '0', jagentReceived: '0' };
}

/** Wait briefly for any tx hash (such as USDT approve) to confirm on-chain */
export async function waitForTxConfirmation(
  txHash: string,
  timeoutMs = 45_000
): Promise<{ confirmed: boolean; reverted: boolean; gasUsedBnb: string }> {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { confirmed: false, reverted: false, gasUsedBnb: '0' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await withBscRpc((p) => p.getTransactionReceipt(txHash));
      if (receipt) {
        const gasPrice = receipt.gasPrice ?? 0n;
        return {
          confirmed: true,
          reverted: receipt.status === 0,
          gasUsedBnb: ethers.formatEther(receipt.gasUsed * gasPrice),
        };
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return { confirmed: false, reverted: false, gasUsedBnb: '0' };
}
