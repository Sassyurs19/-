// src/jager/mint.ts
// Mint flow: fetch calldata from jager.live, enforce contract-address guards,
// simulate & preview via baw, execute only after user Confirm, and read post-mint state.
import { ethers } from 'ethers';
import { config } from '../config';
import { ContractAddressMismatchError, JagentError } from '../core/errors';
import { logger } from '../core/logger';
import {
  bawBalance,
  bawContractCallExecute,
  bawContractCallPreview,
  bawSettings,
  bawTxHistory,
  bawTxLock,
  BawContractCallPreview,
  BawTxStatusResult,
} from '../wallet/baw';
import { getAgentStatus, getMintTx, MintTxResponse, MintTxStep } from './api';
import { checkDevMode, parseDevModeExpiry } from './eligibility';
import {
  estimateGasWithBuffer,
  getCurrentGasPriceWei,
  getErc20Allowance,
  waitForMintReceipt,
  waitForTxConfirmation,
} from './rpc';

const ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const APPROVE_SELECTOR = '0x095ea7b3';

export interface MintPreviewResult {
  mintTx: MintTxResponse;
  mintStep: MintTxStep;
  approveStep?: MintTxStep;
  needsApproval: boolean;
  approvalRequestId?: string;
  mintRequestId?: string;
  preview?: BawContractCallPreview;
  approvePreview?: BawContractCallPreview;
  gasEstimateBnb: string;
  totalDisplayCost: string;
  costValueForDb: string;
  referrerDisplay: string;
  riskLines: string[];
  expiresAt: number;
}

export interface MintExecutionResult {
  txHash: string;
  approveTxHash?: string;
  status: 'SUCCESS' | 'PENDING_CONFIRMATION' | 'BROADCASTED' | 'FAILED';
  gasUsedBnb: string;
  jagentReceived: string;
  newBalances: {
    bnb: string;
    usdt: string;
    jagent: string;
  };
  errorReason?: string;
}

/**
 * Strictly verify the mint destination equals official MINT_CONTRACT and never JAGENT_TOKEN.
 * Exported so unit tests validate the exact production guard.
 */
export function guardContractAddress(to: string): void {
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new ContractAddressMismatchError(config.MINT_CONTRACT, String(to));
  }
  if (to.toLowerCase() === config.JAGENT_TOKEN.toLowerCase()) {
    throw new ContractAddressMismatchError(config.MINT_CONTRACT, to);
  }
  if (to.toLowerCase() !== config.MINT_CONTRACT.toLowerCase()) {
    throw new ContractAddressMismatchError(config.MINT_CONTRACT, to);
  }
}

/** Validate a USDT ERC-20 approve step targets USDT_BSC and approves only MINT_CONTRACT */
export function guardApproveStep(step: MintTxStep): void {
  if (!step.to || step.to.toLowerCase() !== config.USDT_BSC.toLowerCase()) {
    throw new ContractAddressMismatchError(config.USDT_BSC, String(step.to));
  }
  if (step.value && BigInt(step.value) !== 0n) {
    throw new ContractAddressMismatchError('value=0 for ERC-20 approve', String(step.value));
  }
  try {
    const decoded = ERC20_IFACE.decodeFunctionData('approve', step.data);
    const spender = String(decoded[0]);
    if (spender.toLowerCase() !== config.MINT_CONTRACT.toLowerCase()) {
      throw new ContractAddressMismatchError(config.MINT_CONTRACT, spender);
    }
  } catch (err) {
    if (err instanceof ContractAddressMismatchError) throw err;
    throw new ContractAddressMismatchError(config.MINT_CONTRACT, 'invalid approve calldata');
  }
}

/** Normalize mint-tx response into validated approveStep (optional) and mintStep */
export function normalizeAndGuardMintSteps(mintTx: MintTxResponse): {
  approveStep?: MintTxStep;
  mintStep: MintTxStep;
} {
  const steps: MintTxStep[] =
    Array.isArray(mintTx.steps) && mintTx.steps.length > 0
      ? mintTx.steps
      : mintTx.to && mintTx.data
        ? [{ to: mintTx.to, value: mintTx.value ?? '0', data: mintTx.data, gasLimit: mintTx.gasLimit }]
        : [];

  if (steps.length === 0) {
    throw new JagentError('mint-tx API returned no executable transaction steps');
  }

  let approveStep: MintTxStep | undefined;
  let mintStep: MintTxStep | undefined;

  for (const step of steps) {
    const isApprove =
      step.to?.toLowerCase() === config.USDT_BSC.toLowerCase() ||
      step.data?.toLowerCase().startsWith(APPROVE_SELECTOR);

    if (isApprove) {
      guardApproveStep(step);
      approveStep = step;
    } else {
      guardContractAddress(step.to);
      mintStep = step;
    }
  }

  if (!mintStep) {
    throw new ContractAddressMismatchError(config.MINT_CONTRACT, steps[steps.length - 1]?.to ?? 'none');
  }

  return { approveStep, mintStep };
}

function collectRisks(preview: BawContractCallPreview): string[] {
  const out: string[] = [];
  for (const r of preview.risks?.riskDetails ?? []) {
    out.push(`• ${r.title}: ${r.description}`);
  }
  for (const [addr, info] of Object.entries(preview.risks?.addresses ?? {})) {
    for (const r of info.riskDetails ?? []) {
      out.push(`• Address ${addr}: ${r.title} — ${r.description}`);
    }
  }
  return out;
}

/**
 * Prepare mint cost card & simulation preview before showing [Confirm] [Cancel].
 */
export async function prepareMintPreview(
  walletAddress: string,
  sessionDir: string,
  shares: number,
  pay: 'usdt' | 'bnb',
  adminRef: string,
  priceUsdtPerShare: string
): Promise<MintPreviewResult> {
  // 1. Pre-check Developer Mode & tx lock per external-sign spec
  const [settingsRes, lockRes] = await Promise.all([
    bawSettings(sessionDir),
    bawTxLock(sessionDir, config.BINANCE_CHAIN_ID),
  ]);

  if (!settingsRes.success) {
    throw new JagentError(`Could not verify wallet settings: ${settingsRes.error.message}`, 'DEVMODE_CHECK_FAILED');
  }
  const dm = settingsRes.data.devMode;
  if (!dm || !checkDevMode(dm.enabled, dm.expiresAt)) {
    const exp = parseDevModeExpiry(dm?.expiresAt);
    throw new JagentError(
      exp
        ? 'Developer Mode expired. Re-enable it in Binance App → Agentic Wallet → Settings.'
        : 'Developer Mode is disabled. Enable it in Binance App → Agentic Wallet → Settings.',
      'DEVMODE_OFF'
    );
  }
  if (dm.balanceExceeded) {
    throw new JagentError(
      'Wallet balance exceeds Developer Mode cap in Binance App settings. Lower balance or raise cap in App.',
      'DEVMODE_CAP_EXCEEDED'
    );
  }

  if (lockRes.success && lockRes.data.status === 'LOCKED') {
    throw new JagentError(
      'Wallet currently has a pending or unconfirmed transaction (LOCKED). Wait or resolve it in the Binance App first.',
      'TX_LOCKED'
    );
  }

  // 2. Fetch official calldata from jager.live
  const mintTx = await getMintTx(walletAddress, shares, pay, adminRef);
  logger.info('mint-tx API response received', {
    pay,
    shares: mintTx.shares ?? shares,
    stepsCount: mintTx.steps?.length ?? 1,
  });

  // 3. Guard EVERY returned step contract address
  const { approveStep, mintStep } = normalizeAndGuardMintSteps(mintTx);

  // 4. Determine whether USDT approval is needed on-chain
  let needsApproval = false;
  if (approveStep) {
    let requiredAllowance = 0n;
    try {
      const decoded = ERC20_IFACE.decodeFunctionData('approve', approveStep.data);
      requiredAllowance = BigInt(decoded[1]);
    } catch {
      requiredAllowance = ethers.parseUnits(
        (parseFloat(priceUsdtPerShare) * shares * config.SLIPPAGE_BUFFER_MULTIPLIER).toFixed(6),
        18
      );
    }
    const currentAllowance = await getErc20Allowance(config.USDT_BSC, walletAddress, config.MINT_CONTRACT);
    needsApproval = currentAllowance < requiredAllowance;
  }

  // 5. Estimate gas with +20% buffer for display (handle gasLimit: null cleanly)
  const gasPriceWei = await getCurrentGasPriceWei();
  let totalGasWei = 0n;

  if (needsApproval && approveStep) {
    if (approveStep.gasLimit) {
      totalGasWei += ((BigInt(approveStep.gasLimit) * 120n) / 100n) * gasPriceWei;
    } else {
      const est = await estimateGasWithBuffer({
        from: walletAddress,
        to: approveStep.to,
        value: approveStep.value ?? '0',
        data: approveStep.data,
      });
      totalGasWei += est.gasLimit * est.gasPriceWei;
    }
  }

  let mintGasLimitNum: number | undefined;
  if (mintStep.gasLimit) {
    const buffered = (BigInt(mintStep.gasLimit) * 120n) / 100n;
    totalGasWei += buffered * gasPriceWei;
    mintGasLimitNum = Number(buffered);
  } else if (needsApproval) {
    // Mint would revert in raw RPC eth_estimateGas before approval lands; use buffered typical ~360k mint gas
    totalGasWei += 360_000n * gasPriceWei;
  } else {
    const est = await estimateGasWithBuffer({
      from: walletAddress,
      to: mintStep.to,
      value: mintStep.value ?? '0',
      data: mintStep.data,
    });
    totalGasWei += est.gasLimit * est.gasPriceWei;
    mintGasLimitNum = Number(est.gasLimit);
  }

  const gasEstimateBnb = parseFloat(ethers.formatEther(totalGasWei)).toFixed(6);

  // 6. Run baw simulation preview
  let approvePreview: BawContractCallPreview | undefined;
  let mintPreview: BawContractCallPreview | undefined;
  const riskLines: string[] = [];

  if (needsApproval && approveStep) {
    const appRes = await bawContractCallPreview(sessionDir, {
      from: walletAddress,
      to: approveStep.to,
      value: approveStep.value ?? '0',
      inputData: approveStep.data,
    });
    if (!appRes.success) {
      throw new JagentError(appRes.error.message, String(appRes.error.code));
    }
    approvePreview = appRes.data;
    if (approvePreview.simulationResult.simulationErrorDetail) {
      throw new JagentError(`Approval simulation failed: ${approvePreview.simulationResult.simulationErrorDetail}`);
    }
    riskLines.push(...collectRisks(approvePreview));
  } else {
    const mRes = await bawContractCallPreview(sessionDir, {
      from: walletAddress,
      to: mintStep.to,
      value: mintStep.value ?? '0',
      inputData: mintStep.data,
      gasLimit: mintGasLimitNum,
    });
    if (!mRes.success) {
      throw new JagentError(mRes.error.message, String(mRes.error.code));
    }
    mintPreview = mRes.data;
    if (mintPreview.simulationResult.simulationErrorDetail) {
      throw new JagentError(`Mint simulation failed: ${mintPreview.simulationResult.simulationErrorDetail}`);
    }
    riskLines.push(...collectRisks(mintPreview));
  }

  // Format totals cleanly
  let totalDisplayCost: string;
  let costValueForDb: string;
  if (pay === 'usdt') {
    const quoteCost = mintTx.costUsdt ?? (parseFloat(priceUsdtPerShare) * shares).toFixed(2);
    const maxCost = mintTx.maxCostUsdt ?? (parseFloat(priceUsdtPerShare) * shares * 1.02).toFixed(2);
    totalDisplayCost = `${quoteCost} USDT (max w/ 2% buffer: ${maxCost} USDT)`;
    costValueForDb = `${quoteCost} USDT`;
  } else {
    const sendBnb = mintTx.sendBnb ?? ethers.formatEther(BigInt(mintStep.value || '0'));
    const quoteBnb = mintTx.quoteBnb ?? sendBnb;
    totalDisplayCost = `${parseFloat(sendBnb).toFixed(6)} BNB (est. spend ~${parseFloat(quoteBnb).toFixed(6)} BNB, excess refunded)`;
    costValueForDb = `${parseFloat(sendBnb).toFixed(6)} BNB`;
  }

  return {
    mintTx,
    mintStep,
    approveStep,
    needsApproval,
    approvalRequestId: approvePreview?.requestId,
    mintRequestId: mintPreview?.requestId,
    preview: mintPreview,
    approvePreview,
    gasEstimateBnb,
    totalDisplayCost,
    costValueForDb,
    referrerDisplay: mintTx.referrer ?? (adminRef || 'none'),
    riskLines,
    expiresAt: (approvePreview ?? mintPreview)?.expiresAt ?? Date.now() + 180_000,
  };
}

/** Poll Binance tx-history for an order/tx that required App confirmation */
async function waitForBawConfirmationOrUnlock(
  sessionDir: string,
  txHash: string | null,
  maxWaitMs = 90_000
): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (txHash) {
      const stRes = await bawTxHistory(sessionDir, {
        tx: txHash,
        binanceChainId: config.BINANCE_CHAIN_ID,
      }).catch(() => null);
      if (stRes?.success && stRes.data && 'status' in stRes.data) {
        const txStatus = (stRes.data as BawTxStatusResult).status;
        if (txStatus === 'SUCCESS') return txHash;
        if (txStatus === 'FAILED') throw new JagentError('Transaction failed on-chain', 'TX_FAILED');
      }
    } else {
      const lockRes = await bawTxLock(sessionDir, config.BINANCE_CHAIN_ID).catch(() => null);
      if (lockRes?.success && lockRes.data.status === 'UNLOCKED') {
        const histRes = await bawTxHistory(sessionDir, {
          type: 'confirmed',
          size: 5,
          binanceChainId: config.BINANCE_CHAIN_ID,
        }).catch(() => null);
        if (histRes?.success && histRes.data && 'transactions' in histRes.data) {
          const first = histRes.data.transactions[0];
          if (first?.txHash) return first.txHash;
        }
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return txHash;
}

/**
 * Execute previewed mint after user tapped Confirm.
 */
export async function executeMint(
  walletAddress: string,
  sessionDir: string,
  previewResult: MintPreviewResult,
  onProgress?: (stage: 'approving' | 'pending_app' | 'minting') => Promise<void>
): Promise<MintExecutionResult> {
  // Always re-verify contract guard right before signing
  guardContractAddress(previewResult.mintStep.to);

  let approveTxHash: string | undefined;
  let totalGasBnb = 0;

  // Step 1: Execute USDT approval if required
  if (previewResult.needsApproval && previewResult.approveStep) {
    if (onProgress) await onProgress('approving');

    let appReqId = previewResult.approvalRequestId;
    if (!appReqId || Date.now() > previewResult.expiresAt - 10_000) {
      guardApproveStep(previewResult.approveStep);
      const freshApp = await bawContractCallPreview(sessionDir, {
        from: walletAddress,
        to: previewResult.approveStep.to,
        value: previewResult.approveStep.value ?? '0',
        inputData: previewResult.approveStep.data,
      });
      if (!freshApp.success) {
        throw new JagentError(freshApp.error.message, String(freshApp.error.code));
      }
      appReqId = freshApp.data.requestId;
    }

    const appExec = await bawContractCallExecute(sessionDir, appReqId);
    if (!appExec.success) {
      throw new JagentError(appExec.error.message, String(appExec.error.code));
    }

    approveTxHash = appExec.data.txHash ?? undefined;
    if (appExec.data.status === 'PENDING_CONFIRMATION') {
      if (onProgress) await onProgress('pending_app');
      const confirmedHash = await waitForBawConfirmationOrUnlock(sessionDir, approveTxHash ?? null, 120_000);
      if (confirmedHash) approveTxHash = confirmedHash;
    }

    if (approveTxHash) {
      const appConf = await waitForTxConfirmation(approveTxHash, 45_000);
      totalGasBnb += parseFloat(appConf.gasUsedBnb || '0');
      if (appConf.reverted) {
        return {
          txHash: approveTxHash,
          approveTxHash,
          status: 'FAILED',
          gasUsedBnb: totalGasBnb.toFixed(6),
          jagentReceived: '0',
          newBalances: { bnb: '?', usdt: '?', jagent: '?' },
          errorReason: 'USDT approval transaction reverted on-chain',
        };
      }
    }
  }

  // Step 2: Preview (if just approved or preview expired) and execute Mint step
  if (onProgress) await onProgress('minting');

  let mintReqId = previewResult.mintRequestId;
  if (!mintReqId || previewResult.needsApproval || Date.now() > previewResult.expiresAt - 10_000) {
    guardContractAddress(previewResult.mintStep.to);
    const mintPreview = await bawContractCallPreview(sessionDir, {
      from: walletAddress,
      to: previewResult.mintStep.to,
      value: previewResult.mintStep.value ?? '0',
      inputData: previewResult.mintStep.data,
    });
    if (!mintPreview.success) {
      throw new JagentError(mintPreview.error.message, String(mintPreview.error.code));
    }
    if (mintPreview.data.simulationResult.simulationErrorDetail) {
      throw new JagentError(
        `Mint simulation failed: ${mintPreview.data.simulationResult.simulationErrorDetail}`
      );
    }
    mintReqId = mintPreview.data.requestId;
  }

  const mintExec = await bawContractCallExecute(sessionDir, mintReqId);
  if (!mintExec.success) {
    throw new JagentError(mintExec.error.message, String(mintExec.error.code));
  }

  let mintTxHash = mintExec.data.txHash ?? '';
  let status: MintExecutionResult['status'] = mintExec.data.status;

  if (status === 'PENDING_CONFIRMATION') {
    if (onProgress) await onProgress('pending_app');
    const resolvedHash = await waitForBawConfirmationOrUnlock(sessionDir, mintTxHash || null, 120_000);
    if (resolvedHash) mintTxHash = resolvedHash;
  }

  let jagentReceived = '0';
  if (mintTxHash) {
    const receiptSummary = await waitForMintReceipt(mintTxHash, walletAddress, 35_000);
    totalGasBnb += parseFloat(receiptSummary.gasUsedBnb || '0');
    jagentReceived = receiptSummary.jagentReceived;

    if (receiptSummary.confirmed) {
      status = receiptSummary.reverted ? 'FAILED' : 'SUCCESS';
    }
  }

  // Fetch updated live balances (best-effort)
  const newBalances = { bnb: '?', usdt: '?', jagent: '?' };
  try {
    const st = await getAgentStatus(walletAddress);
    if (st.balances) {
      newBalances.bnb = st.balances.bnb;
      newBalances.usdt = st.balances.usdt;
      newBalances.jagent = st.balances.jagent;
    }
  } catch {
    try {
      const bRes = await bawBalance(sessionDir, { binanceChainId: config.BINANCE_CHAIN_ID, hideLowValue: false });
      if (bRes.success) {
        for (const b of bRes.data) {
          if (b.symbol === 'BNB') newBalances.bnb = b.balance;
          if (b.address?.toLowerCase() === config.USDT_BSC.toLowerCase()) newBalances.usdt = b.balance;
          if (b.address?.toLowerCase() === config.JAGENT_TOKEN.toLowerCase()) newBalances.jagent = b.balance;
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    txHash: mintTxHash,
    approveTxHash,
    status,
    gasUsedBnb: totalGasBnb.toFixed(6),
    jagentReceived,
    newBalances,
    errorReason: status === 'FAILED' ? 'Mint transaction reverted on-chain' : undefined,
  };
}
