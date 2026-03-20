// ── Helpers (extracted for testability) ──

export function formatAgentMessage(text: string): string {
  return `agent> ${text}`;
}

export function computeBackoffMs(attempt: number): number {
  return Math.pow(2, attempt - 1) * 1000;
}

export function formatConnectionStatus(channel: string, peer: string): string {
  return `[${channel}/${peer}] Connected.`;
}

export const MAX_RECONNECT_ATTEMPTS = 3;
