/**
 * Per-body chat render-cycle claims.
 *
 * On a full panel render, both onRender's deferred IIFE and onAsyncRender
 * historically called refreshChat, rebuilding the whole conversation twice
 * back-to-back. Neither call can simply be removed: onAsyncRender is not
 * guaranteed to fire for every body, and the deferred call may wake up after
 * a newer render cycle has replaced the panel. These claims let whichever
 * path gets there first render once, and the other skip.
 */

export type ChatRenderCycle = { rendered: boolean };

const pendingChatRenderCycles = new WeakMap<Element, ChatRenderCycle>();

/** Start a new cycle for a full panel render; supersedes any previous cycle. */
export function beginChatRenderCycle(body: Element): ChatRenderCycle {
  const cycle: ChatRenderCycle = { rendered: false };
  pendingChatRenderCycles.set(body, cycle);
  return cycle;
}

/**
 * Deferred-onRender path. True when this cycle is still the body's current
 * cycle and nothing rendered yet; the claim is then taken.
 */
export function claimDeferredChatRender(
  body: Element,
  cycle: ChatRenderCycle,
): boolean {
  if (pendingChatRenderCycles.get(body) !== cycle) return false;
  if (cycle.rendered) return false;
  cycle.rendered = true;
  return true;
}

/**
 * The body's current cycle, captured by onAsyncRender in the same synchronous
 * block that consumes the sync-render flag — claiming must later be affine to
 * THIS cycle, not to whatever cycle is current at claim time, or a stale
 * in-flight async render could steal a newer cycle's claim and pin the
 * previous item's conversation on screen after a fast tab switch.
 */
export function currentChatRenderCycle(body: Element): ChatRenderCycle | null {
  return pendingChatRenderCycles.get(body) ?? null;
}

/**
 * onAsyncRender path. With a captured cycle the claim is shared with the
 * deferred path and refused when a newer cycle superseded it; without one
 * (async-only render, no sync onRender) onAsyncRender owns the render
 * unconditionally.
 */
export function claimAsyncChatRender(
  body: Element,
  cycle: ChatRenderCycle | null,
): boolean {
  if (!cycle) return true;
  if (pendingChatRenderCycles.get(body) !== cycle) return false;
  if (cycle.rendered) return false;
  cycle.rendered = true;
  return true;
}
