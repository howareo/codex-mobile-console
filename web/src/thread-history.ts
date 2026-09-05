import type { JsonObject, ThreadPageResult } from "../../src/shared/types";

export function mergeThreadPage(current: ThreadPageResult | null, incoming: ThreadPageResult): ThreadPageResult {
  if (!current || current.thread.id !== incoming.thread.id) return incoming;
  const currentTurns = current.thread.turns;
  const incomingTurns = incoming.thread.turns;
  const currentById = new Map(currentTurns.map((turn, index) => [turnId(turn, index), turn]));

  if (incoming.history.kind === "older") {
    const older = incomingTurns
      .filter((turn, index) => !currentById.has(turnId(turn, index)))
      .concat(currentTurns);
    return {
      ...current,
      thread: { ...current.thread, ...incoming.thread, turns: older },
      history: { ...incoming.history, loadedOlder: true }
    };
  }

  const incomingIds = new Set(incomingTurns.map((turn, index) => turnId(turn, index)));
  const firstOverlap = currentTurns.findIndex((turn, index) => incomingIds.has(turnId(turn, index)));
  if (currentTurns.length > 0 && incomingTurns.length > 0 && firstOverlap < 0) return incoming;

  const prefix = firstOverlap < 0 ? [] : currentTurns.slice(0, firstOverlap);
  const refreshed = incomingTurns.map((turn, index) => {
    const existing = currentById.get(turnId(turn, index));
    return existing ? mergeTurn(existing, turn) : turn;
  });
  const keepLoadedCursor = current.history.loadedOlder === true;
  return {
    ...incoming,
    thread: { ...current.thread, ...incoming.thread, turns: [...prefix, ...refreshed] },
    history: keepLoadedCursor
      ? { ...incoming.history, olderCursor: current.history.olderCursor, hasOlder: current.history.hasOlder, loadedOlder: true }
      : incoming.history
  };
}

function turnId(value: unknown, index: number): string {
  const turn = objectValue(value);
  return typeof turn?.id === "string" ? turn.id : `index:${index}`;
}

function mergeTurn(current: unknown, incoming: unknown): unknown {
  const currentTurn = objectValue(current);
  const incomingTurn = objectValue(incoming);
  if (!currentTurn || !incomingTurn) return incoming;
  const currentItems = Array.isArray(currentTurn.items) ? currentTurn.items : [];
  const incomingItems = Array.isArray(incomingTurn.items) ? incomingTurn.items : [];
  if (JSON.stringify(currentItems).length <= JSON.stringify(incomingItems).length) return incoming;
  return { ...currentTurn, ...incomingTurn, items: currentItems };
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}
