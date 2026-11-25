// tests/contractGuard.test.ts
// Tests the REAL production contract address & approve-step guards from src/jager/mint.ts
import { ethers } from 'ethers';

jest.mock('../src/config', () => ({
  config: {
    MINT_CONTRACT: '0x3643A907f875fA9B740e1C0747E91b5aA5222aB8',
    JAGENT_TOKEN: '0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15',
    USDT_BSC: '0x55d398326f99059fF775485246999027B3197955',
    BNB_NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    BINANCE_CHAIN_ID: '56',
    BSC_CHAIN_ID: 56,
    MIN_BNB_GAS: 0.0005,
    SLIPPAGE_BUFFER_MULTIPLIER: 1.02,
    SELL_MAX_SLIPPAGE_PCT: '5',
    bscRpcUrl: 'https://bsc-rpc.publicnode.com',
    bscFallbackRpcs: ['https://bsc-rpc.publicnode.com'],
    jagerApiBase: 'https://jager.live/api',
    jagerRateLimitRpm: 30,
    apiMaxRetries: 3,
    logLevel: 'error',
    botToken: 'test',
    adminId: 123,
    adminRef: 'TEST',
    encryptionKey: 'a'.repeat(64),
    dbPath: ':memory:',
    sessionsDir: '/tmp/test-sessions',
    botTimezone: 'Asia/Kolkata',
    sessionTimeoutMinutes: 20,
    port: 0,
    nodeEnv: 'test',
    BAW_REQUIRED_VERSION: '1.12.0',
  },
}));

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ContractAddressMismatchError } from '../src/core/errors';
import {
  guardApproveStep,
  guardContractAddress,
  normalizeAndGuardMintSteps,
} from '../src/jager/mint';

describe('Contract Address Guard (Production Implementation)', () => {
  const MINT_CONTRACT = '0x3643A907f875fA9B740e1C0747E91b5aA5222aB8';
  const JAGENT_TOKEN = '0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15';
  const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';

  const erc20 = new ethers.Interface(['function approve(address spender, uint256 amount)']);

  it('accepts official MINT_CONTRACT in mixed, lower, and upper hex case', () => {
    expect(() => guardContractAddress(MINT_CONTRACT)).not.toThrow();
    expect(() => guardContractAddress(MINT_CONTRACT.toLowerCase())).not.toThrow();
    expect(() => guardContractAddress('0x' + MINT_CONTRACT.slice(2).toUpperCase())).not.toThrow();
  });

  const invalidAddresses = [
    { addr: JAGENT_TOKEN, label: 'JAGENT token contract' },
    { addr: JAGENT_TOKEN.toLowerCase(), label: 'JAGENT token contract lowercase' },
    { addr: JAGENT_TOKEN.toUpperCase(), label: 'JAGENT token contract uppercase' },
    { addr: USDT_BSC, label: 'USDT contract as mint destination' },
    { addr: '0x2239f7C884833e181302501B22f5D5265520BFd7', label: 'retired $JAGER mint contract' },
    { addr: '0x2435ec780262f1ab1b087A97EE8fF726d7D09928', label: 'retired $JAGER token contract' },
    { addr: '0x0000000000000000000000000000000000000000', label: 'zero address' },
    { addr: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', label: 'spoofed attacker address' },
    { addr: '', label: 'empty string' },
    { addr: '0x', label: 'bare 0x' },
    { addr: '0x1234', label: 'short hex' },
    { addr: 'not-an-address', label: 'non-address string' },
    { addr: MINT_CONTRACT + '00', label: 'padded mint contract' },
    { addr: MINT_CONTRACT.slice(0, -2), label: 'truncated mint contract' },
  ];

  for (const { addr, label } of invalidAddresses) {
    it(`rejects ${label}`, () => {
      expect(() => guardContractAddress(addr)).toThrow(ContractAddressMismatchError);
    });
  }

  it('includes both expected and unexpected addresses in ContractAddressMismatchError', () => {
    const fake = '0x1111111111111111111111111111111111111111';
    try {
      guardContractAddress(fake);
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractAddressMismatchError);
      expect((err as Error).message).toContain(MINT_CONTRACT);
      expect((err as Error).message).toContain(fake);
      expect((err as Error).message).toContain('SECURITY');
    }
  });

  describe('USDT Approve Step Guard', () => {
    it('accepts valid USDT approve spending to official MINT_CONTRACT with value 0', () => {
      const data = erc20.encodeFunctionData('approve', [MINT_CONTRACT, 56610000000000000000n]);
      expect(() =>
        guardApproveStep({ to: USDT_BSC, value: '0', data })
      ).not.toThrow();
    });

    it('rejects approve step pointing to non-USDT token address', () => {
      const data = erc20.encodeFunctionData('approve', [MINT_CONTRACT, 100n]);
      expect(() =>
        guardApproveStep({ to: JAGENT_TOKEN, value: '0', data })
      ).toThrow(ContractAddressMismatchError);
    });

    it('rejects approve step with attacker spender even when targeting USDT', () => {
      const attacker = '0x9999999999999999999999999999999999999999';
      const data = erc20.encodeFunctionData('approve', [attacker, 1000n]);
      expect(() =>
        guardApproveStep({ to: USDT_BSC, value: '0', data })
      ).toThrow(ContractAddressMismatchError);
    });

    it('rejects approve step trying to send native BNB value != 0', () => {
      const data = erc20.encodeFunctionData('approve', [MINT_CONTRACT, 100n]);
      expect(() =>
        guardApproveStep({ to: USDT_BSC, value: '1000000000000000', data })
      ).toThrow(ContractAddressMismatchError);
    });
  });

  describe('Multi-step normalization & guard', () => {
    it('normalizes valid 2-step USDT mint-tx steps without altering calldata', () => {
      const approveData = erc20.encodeFunctionData('approve', [MINT_CONTRACT, 56610000000000000000n]);
      const mintData = '0x836a1040' + '0'.repeat(192);
      const res = normalizeAndGuardMintSteps({
        steps: [
          { step: 1, to: USDT_BSC, value: '0', data: approveData },
          { step: 2, to: MINT_CONTRACT, value: '0', data: mintData },
        ],
      });
      expect(res.approveStep?.to).toBe(USDT_BSC);
      expect(res.approveStep?.data).toBe(approveData);
      expect(res.mintStep.to).toBe(MINT_CONTRACT);
      expect(res.mintStep.data).toBe(mintData);
    });

    it('aborts whole bundle if mint step points to JAGENT_TOKEN', () => {
      const approveData = erc20.encodeFunctionData('approve', [MINT_CONTRACT, 56610000000000000000n]);
      expect(() =>
        normalizeAndGuardMintSteps({
          steps: [
            { step: 1, to: USDT_BSC, value: '0', data: approveData },
            { step: 2, to: JAGENT_TOKEN, value: '0', data: '0x836a1040' },
          ],
        })
      ).toThrow(ContractAddressMismatchError);
    });
  });
});
