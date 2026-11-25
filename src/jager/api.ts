// src/jager/api.ts
// jager.live API client with rate limiting, exponential backoff retries,
// and word-for-word API error relay.
import axios, { AxiosError, AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import Bottleneck from 'bottleneck';
import { config } from '../config';
import { JagentError } from '../core/errors';
import { logger } from '../core/logger';

const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: Math.ceil(60_000 / Math.max(1, config.jagerRateLimitRpm)),
});

const http: AxiosInstance = axios.create({
  baseURL: config.jagerApiBase,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

axiosRetry(http, {
  retries: config.apiMaxRetries,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err: AxiosError) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    err.response?.status === 429 ||
    (err.response?.status !== undefined && err.response.status >= 500),
  onRetry: (retryCount, err) => {
    logger.warn('API retry', {
      retryCount,
      url: err.config?.url,
      status: err.response?.status,
    });
  },
});

function extractApiErrorMessage(err: unknown): JagentError {
  if (err instanceof JagentError) return err;
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string; note?: string } | undefined;
    const rawMsg = data?.error || data?.message || data?.note;
    if (rawMsg) {
      return new JagentError(rawMsg, `HTTP_${err.response?.status ?? 'ERR'}`, false);
    }
    return new JagentError(err.message, 'NETWORK_ERROR', true);
  }
  return new JagentError(err instanceof Error ? err.message : String(err));
}

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  return limiter.schedule(async () => {
    logger.debug('API GET', { path, params });
    try {
      const resp = await http.get<T & { error?: string }>(path, { params });
      if (resp.data && typeof resp.data === 'object' && 'error' in resp.data && resp.data.error) {
        throw new JagentError(String(resp.data.error), 'API_ERROR', false);
      }
      return resp.data;
    } catch (err) {
      throw extractApiErrorMessage(err);
    }
  });
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return limiter.schedule(async () => {
    logger.debug('API POST', { path });
    try {
      const resp = await http.post<T & { error?: string }>(path, body);
      if (resp.data && typeof resp.data === 'object' && 'error' in resp.data && resp.data.error) {
        throw new JagentError(String(resp.data.error), 'API_ERROR', false);
      }
      return resp.data;
    } catch (err) {
      throw extractApiErrorMessage(err);
    }
  });
}

// ---- Exact jager.live API Types ----

export interface AgentStatusResponse {
  wallet: string;
  agentId: string | null;
  tokenId?: string;
  note?: string;
  balances: {
    bnb: string;
    usdt: string;
    jagent: string;
  } | null;
  mint: {
    contract: string;
    open: boolean;
    siteEntryOpen: boolean;
    totalMinted: number;
    priceUsdtPerShare: string;
    maxPerTransaction: number;
    sharesPerMint: number;
    minted?: number;
    quota?: number;
    remaining?: number;
  };
  socialTasks?: Record<string, string>;
  invite?: {
    link?: string;
    border?: { level: number; points: number };
    invited: number;
    reachedTenShares: number;
    pendingUsdt: number | string | null;
    paidUsdt: number | string | null;
    payoutsPaused?: boolean | null;
    rewardsPaused?: boolean;
  };
}

export interface JagerStatsResponse {
  token: { symbol: string; address: string; decimals: number };
  mintContract: string;
  pair: string;
  usdt: string;
  chainId: number;
  totalMinted: number;
  priceUsdtPerShare: number;
  tokensPerShare: number;
  mintingOpen: boolean;
  paused: boolean;
  maxPerTransaction: number;
  sharesPerMint: number;
  bnb?: Array<{
    shares: number;
    costUsdt: string;
    quoteBnb: string;
    sendBnb: string;
  }>;
}

export interface MintTxStep {
  step?: number;
  description?: string;
  to: string;
  value: string;
  data: string;
  gasLimit?: string | null;
  baw?: string;
}

export interface MintTxResponse {
  agentId?: string;
  shares?: number;
  pay?: string;
  costUsdt?: string;
  maxCostUsdt?: string;
  quoteBnb?: string;
  sendBnb?: string;
  referrer?: string | null;
  remainingAfter?: number;
  steps?: MintTxStep[];
  warnings?: string[];
  to?: string;
  value?: string;
  data?: string;
  gasLimit?: string | null;
}

export interface InviteRewardsStatusResponse {
  rewardsPaused?: boolean;
  rewardsUsdt?: {
    firstInviter?: number;
    firstInvitee?: number;
    targetInvitee?: number;
  };
  you?: {
    pending?: number | string | null;
    paid?: number | string | null;
  };
}

export interface ClaimInviteRewardsResponse {
  ok: boolean;
  paid?: string | number;
  hash?: string;
  reason?: string;
  error?: string;
}

// ---- API Calls ----

export async function getAgentStatus(address: string): Promise<AgentStatusResponse> {
  return get<AgentStatusResponse>('/agent/status', { address });
}

export async function getJagerStats(): Promise<JagerStatsResponse> {
  return get<JagerStatsResponse>('/stats');
}

export async function getMintTx(
  address: string,
  shares: number,
  pay: 'usdt' | 'bnb',
  ref?: string
): Promise<MintTxResponse> {
  const params: Record<string, string | number> = { address, shares, pay };
  if (ref && ref.trim()) {
    params.ref = ref.trim();
  }
  return get<MintTxResponse>('/agent/mint-tx', params);
}

export async function getInviteRewardsStatus(address: string): Promise<InviteRewardsStatusResponse> {
  return get<InviteRewardsStatusResponse>('/invite-rewards', { address });
}

export async function claimInviteRewards(address: string): Promise<ClaimInviteRewardsResponse> {
  return post<ClaimInviteRewardsResponse>('/invite-rewards', { address });
}
