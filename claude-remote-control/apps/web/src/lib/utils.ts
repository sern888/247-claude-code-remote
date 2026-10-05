import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip protocol (http://, https://, ws://, wss://) from a URL
 * Returns just the host:port/path portion
 */
export function stripProtocol(url: string): string {
  return url.replace(/^(https?|wss?):\/\//, '');
}

/**
 * Build a WebSocket URL from an agent URL
 * Handles both URLs with and without protocol
 */
export function buildWebSocketUrl(agentUrl: string, path: string): string {
  const cleanUrl = stripProtocol(agentUrl);
  const isLocalhost = cleanUrl.includes('localhost') || cleanUrl.startsWith('127.0.0.1');
  const wsProtocol = isLocalhost ? 'ws' : 'wss';
  return `${wsProtocol}://${cleanUrl}${path}`;
}

/**
 * Build an HTTP API URL from an agent URL
 * Handles both URLs with and without protocol
 */
export function buildApiUrl(agentUrl: string, path: string): string {
  const cleanUrl = stripProtocol(agentUrl);
  const isLocalhost = cleanUrl.includes('localhost') || cleanUrl.startsWith('127.0.0.1');
  const protocol = isLocalhost ? 'http' : 'https';
  return `${protocol}://${cleanUrl}${path}`;
}

/**
 * Build the agent URL that clears a session's needs_attention status
 */
export function buildSessionAcknowledgeUrl(agentUrl: string, sessionName: string): string {
  return buildApiUrl(agentUrl, `/api/sessions/${encodeURIComponent(sessionName)}/acknowledge`);
}
