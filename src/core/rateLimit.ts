// src/core/rateLimit.ts
// Simple per-user rate limiting to prevent bot abuse
const userCooldowns = new Map<string, number>();

export function checkUserCooldown(userId: number, action: string, cooldownMs = 2000): boolean {
  const key = `${userId}:${action}`;
  const last = userCooldowns.get(key) ?? 0;
  if (Date.now() - last < cooldownMs) return false;
  userCooldowns.set(key, Date.now());
  return true;
}

// Clean up old entries every 10 minutes without keeping Node event loop alive
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of userCooldowns.entries()) {
    if (now - ts > 60_000) userCooldowns.delete(key);
  }
}, 600_000);
cleanupTimer.unref();
