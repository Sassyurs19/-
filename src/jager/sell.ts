// src/jager/sell.ts
// Sell flow: quote JAGENT -> BNB or USDT with 5% max slippage, show tax/impact/gas,
// execute via baw market-order swap only on Confirm, and poll until terminal state.
import { ethers } from 'ethers';
import { config } from '../config';
import { JagentError } from '../core/errors';
import { logger } from '../core/logger';
import {
  bawMarketOrderList,
  bawMarketQuote,
  bawMarketSwap,
} from '../wallet/baw';
import { getJagerStats } from './api';
import { getCurrentGasPriceWei, waitForTxConfirmation } from './rpc';

export interface SellQuote {
  jagentAmount: string;
  receiveToken: 'BNB' | 'USDT';
  receiveAmount: string;
  priceImpact: string;
  sellTaxPct: string;
  gasFee: string;
  slippage: string;
}

export interface SellExecutionResult {
  orderId: string;
  status: 'FINISHED' | 'FAILED' | 'PENDING';
  txHash: string;
  receivedAmount: string;
  gasUsedBnb: string;
  refundNote: string;
  errorReason?: string;
}

/** Poll delay helper */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getSellQuote(
  sessionDir: string,
  jagentAmount: string,
  toToken: 'BNB' | 'USDT'
): Promise<SellQuote> {
  const toAddress = toToken === 'BNB' ? config.BNB_NATIVE : config.USDT_BSC;

  const [quoteResult, gasPriceWei, stats] = await Promise.all([
    bawMarketQuote(sessionDir, {
      fromToken: config.JAGENT_TOKEN,
      toToken: toAddress,
      fromTokenQty: jagentAmount,
      slippage: config.SELL_MAX_SLIPPAGE_PCT,
      binanceChainId: config.BINANCE_CHAIN_ID,
    }),
    getCurrentGasPriceWei(),
    getJagerStats().catch(() => null),
  ]);

  if (!quoteResult.success) {
    throw new JagentError(quoteResult.error.message, String(quoteResult.error.code));
  }

  const q = quoteResult.data;
  const gasEstimateBnb = parseFloat(ethers.formatEther(260_000n * gasPriceWei)).toFixed(6);

  // Compute approximate price impact when reference pool price is available
  let priceImpact = 'N/A';
  try {
    const qtyIn = parseFloat(jagentAmount);
    const outAmt = parseFloat(q.toCoinAmount);
    if (stats && stats.tokensPerShare > 0 && stats.priceUsdtPerShare > 0 && qtyIn > 0 && outAmt > 0) {
      const refUsdPerJagent = stats.priceUsdtPerShare / stats.tokensPerShare;
      let quoteUsdPerOut = 1;
      if (toToken === 'BNB' && stats.bnb?.[0]) {
        const quoteBnb = parseFloat(stats.bnb[0].quoteBnb);
        const costUsdt = parseFloat(stats.bnb[0].costUsdt);
        if (quoteBnb > 0 && costUsdt > 0) quoteUsdPerOut = costUsdt / quoteBnb;
      }
      const expectedGrossUsd = qtyIn * refUsdPerJagent;
      const netOutUsd = outAmt * quoteUsdPerOut;
      if (expectedGrossUsd > 0) {
        // Subtract the known 2% protocol sell tax when estimating swap price impact
        const grossOutBeforeTax = netOutUsd / 0.98;
        const impactPct = Math.max(0, ((expectedGrossUsd - grossOutBeforeTax) / expectedGrossUsd) * 100);
        priceImpact = `${impactPct.toFixed(2)}%`;
      }
    }
  } catch {
    priceImpact = 'N/A';
  }

  logger.info('Sell quote obtained', {
    jagentAmount,
    toToken,
    receiveAmount: q.toCoinAmount,
    priceImpact,
  });

  return {
    jagentAmount,
    receiveToken: toToken,
    receiveAmount: q.toCoinAmount,
    priceImpact,
    sellTaxPct: '2',
    gasFee: gasEstimateBnb,
    slippage: config.SELL_MAX_SLIPPAGE_PCT,
  };
}

/**
 * Submit market-order swap and poll market-order list until FINISHED or FAILED.
 */
export async function executeSell(
  sessionDir: string,
  jagentAmount: string,
  toToken: 'BNB' | 'USDT',
  maxWaitMs = 60_000
): Promise<SellExecutionResult> {
  const toAddress = toToken === 'BNB' ? config.BNB_NATIVE : config.USDT_BSC;

  const swapResult = await bawMarketSwap(sessionDir, {
    fromToken: config.JAGENT_TOKEN,
    toToken: toAddress,
    fromTokenQty: jagentAmount,
    slippage: config.SELL_MAX_SLIPPAGE_PCT,
    binanceChainId: config.BINANCE_CHAIN_ID,
  });

  if (!swapResult.success) {
    throw new JagentError(swapResult.error.message, String(swapResult.error.code));
  }

  const orderId = swapResult.data.orderId;
  if (!orderId) {
    throw new JagentError('baw market-order swap did not return an orderId');
  }

  // Poll until terminal state (FINISHED or FAILED) per Binance Agentic Wallet spec
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(2_500);
    const listRes = await bawMarketOrderList(sessionDir, {
      orderId,
      binanceChainId: config.BINANCE_CHAIN_ID,
    });

    if (!listRes.success) {
      logger.warn('market-order list poll error', { orderId, err: listRes.error.message });
      continue;
    }

    const order = listRes.data.list?.find((o) => o.orderId === orderId) ?? listRes.data.list?.[0];
    if (!order) continue;

    if (order.status === 'FINISHED' || order.status === 'FAILED') {
      const txHash = order.txHash ?? '';
      let gasUsedBnb = '0';
      if (txHash) {
        const conf = await waitForTxConfirmation(txHash, 15_000).catch(() => null);
        if (conf?.gasUsedBnb) gasUsedBnb = conf.gasUsedBnb;
      }

      const refundEntries = Array.isArray(order.refund)
        ? order.refund.filter((r) => r && r.amount && r.symbol)
        : [];
      const refundNote =
        refundEntries.length > 0
          ? `Partially filled — refunded: ${refundEntries.map((r) => `${r.amount} ${r.symbol}`).join(', ')}`
          : '';

      if (order.status === 'FAILED') {
        return {
          orderId,
          status: 'FAILED',
          txHash,
          receivedAmount: '0',
          gasUsedBnb,
          refundNote,
          errorReason: 'Swap order failed on-chain',
        };
      }

      return {
        orderId,
        status: 'FINISHED',
        txHash,
        receivedAmount: order.toTokenActualQty ?? '0',
        gasUsedBnb,
        refundNote,
      };
    }
  }

  return {
    orderId,
    status: 'PENDING',
    txHash: '',
    receivedAmount: '',
    gasUsedBnb: '0',
    refundNote: '',
  };
}
