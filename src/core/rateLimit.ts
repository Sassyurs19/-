// src/core/rateLimit.ts
// Simple per-user rate limiting to prevent bot abuse
const userCooldowns = new Map<string, number>();

export function checkUserCooldown(userId: number, action: string, cooldownMs = 2000): boolean {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const last = userCooldowns.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  userCooldowns.set(key, now);
  return true;
}

/** Per-wallet in-flight operation mutex so concurrent button taps cannot double-execute */
const activeWalletOps = new Set<number>();

export function tryAcquireWalletOp(walletId: number): boolean {
  if (activeWalletOps.has(walletId)) return false;
  activeWalletOps.add(walletId);
  return true;
}

export function releaseWalletOp(walletId: number): void {
  activeWalletOps.delete(walletId);
}

// Clean up old entries every 10 minutes without keeping Node event loop alive
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of userCooldowns.entries()) {
    if (now - ts > 60_000) userCooldowns.delete(key);
  }
}, 600_000);
cleanupTimer.unref();
