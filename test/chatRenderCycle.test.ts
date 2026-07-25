import { assert } from "chai";
import { describe, it } from "mocha";

import {
  beginChatRenderCycle,
  claimAsyncChatRender,
  claimDeferredChatRender,
  currentChatRenderCycle,
} from "../src/modules/contextPanel/chatRenderCycle";

function fakeBody(): Element {
  return {} as Element;
}

describe("chatRenderCycle", function () {
  it("deferred path renders when it gets there first, async path skips", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    const captured = currentChatRenderCycle(body);
    assert.isTrue(claimDeferredChatRender(body, cycle));
    assert.isFalse(claimAsyncChatRender(body, captured));
  });

  it("async path renders when it gets there first, deferred path skips", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    assert.isTrue(claimAsyncChatRender(body, currentChatRenderCycle(body)));
    assert.isFalse(claimDeferredChatRender(body, cycle));
  });

  it("deferred path renders alone when onAsyncRender never fires", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    assert.isTrue(claimDeferredChatRender(body, cycle));
    // A second wake-up of the same deferred task must not render again.
    assert.isFalse(claimDeferredChatRender(body, cycle));
  });

  it("stale deferred task from a superseded cycle never renders", function () {
    const body = fakeBody();
    const staleCycle = beginChatRenderCycle(body);
    const currentCycle = beginChatRenderCycle(body);
    // Old tab-switch cycle wakes up after a newer full render began.
    assert.isFalse(claimDeferredChatRender(body, staleCycle));
    // The current cycle is unaffected by the stale claim attempt.
    assert.isTrue(claimDeferredChatRender(body, currentCycle));
  });

  it("stale in-flight async render cannot steal a newer cycle's claim", function () {
    const body = fakeBody();
    // onRender#1 (item A) begins C1; onAsyncRender A1 captures it, then
    // stalls on a slow conversation load.
    beginChatRenderCycle(body);
    const capturedByA1 = currentChatRenderCycle(body);
    // Fast tab switch: onRender#2 (item B) begins C2 with a deferred task D2.
    const cycle2 = beginChatRenderCycle(body);
    // A1 resumes late: it must NOT render (it would paint item A's
    // conversation into item B's panel) and must NOT consume C2's claim.
    assert.isFalse(claimAsyncChatRender(body, capturedByA1));
    // D2 still owns the render for item B.
    assert.isTrue(claimDeferredChatRender(body, cycle2));
  });

  it("async-only render cycles are never blocked by earlier full cycles", function () {
    const body = fakeBody();
    const cycle = beginChatRenderCycle(body);
    assert.isTrue(claimDeferredChatRender(body, cycle));
    // A later onAsyncRender cycle without a sync onRender (e.g. context
    // refresh only) captures no cycle and must still render even though the
    // previous cycle's claim was consumed.
    assert.isTrue(claimAsyncChatRender(body, null));
  });

  it("async path without any prior cycle renders unconditionally", function () {
    const body = fakeBody();
    assert.strictEqual(currentChatRenderCycle(body), null);
    assert.isTrue(claimAsyncChatRender(body, null));
  });

  it("claims are tracked per body", function () {
    const bodyA = fakeBody();
    const bodyB = fakeBody();
    const cycleA = beginChatRenderCycle(bodyA);
    const cycleB = beginChatRenderCycle(bodyB);
    assert.isTrue(claimDeferredChatRender(bodyA, cycleA));
    assert.isTrue(claimAsyncChatRender(bodyB, currentChatRenderCycle(bodyB)));
    assert.isFalse(claimAsyncChatRender(bodyA, currentChatRenderCycle(bodyA)));
    assert.isFalse(claimDeferredChatRender(bodyB, cycleB));
  });
});
