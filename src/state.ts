/**
 * In-memory per-session runtime state.
 *
 * This data is intentionally ephemeral. Persisted remote compaction artifacts
 * live in Pi session entries; this module only caches the currently active
 * continuation and reconstructed replay state for the running process.
 */
import type {
  RemoteCompactionSessionState,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./remote-compaction.ts";

export type ContinuationState = {
  responseId: string;
  modelKey: string;
  updatedAt: number;
  contextLength?: number;
};

export type ResponsesRequestShapeState = {
  updatedAt: number;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
};

const continuationBySessionId = new Map<string, ContinuationState>();
const remoteCompactionBySessionId = new Map<string, RemoteCompactionSessionState>();
const requestShapeBySessionId = new Map<string, ResponsesRequestShapeState>();

export function getContinuationState(sessionId: string): ContinuationState | undefined {
  return continuationBySessionId.get(sessionId);
}

export function setContinuationState(sessionId: string, state: ContinuationState): void {
  continuationBySessionId.set(sessionId, state);
}

export function clearContinuationState(sessionId: string | undefined): void {
  if (!sessionId) return;
  continuationBySessionId.delete(sessionId);
}

export function getRemoteCompactionState(
  sessionId: string,
): RemoteCompactionSessionState | undefined {
  return remoteCompactionBySessionId.get(sessionId);
}

export function setRemoteCompactionState(
  sessionId: string,
  state: RemoteCompactionSessionState,
): void {
  remoteCompactionBySessionId.set(sessionId, state);
}

export function clearRemoteCompactionState(sessionId: string | undefined): void {
  if (!sessionId) return;
  remoteCompactionBySessionId.delete(sessionId);
}

export function getResponsesRequestShapeState(
  sessionId: string,
): ResponsesRequestShapeState | undefined {
  return requestShapeBySessionId.get(sessionId);
}

export function setResponsesRequestShapeState(
  sessionId: string,
  state: ResponsesRequestShapeState,
): void {
  requestShapeBySessionId.set(sessionId, state);
}

export function clearResponsesRequestShapeState(sessionId: string | undefined): void {
  if (!sessionId) return;
  requestShapeBySessionId.delete(sessionId);
}

export function clearAllContinuationState(): void {
  continuationBySessionId.clear();
  remoteCompactionBySessionId.clear();
  requestShapeBySessionId.clear();
}
