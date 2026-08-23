import { afterEach, describe, expect, it } from "vitest";
import {
  getWindowedFloats,
  resetWindowedFloatsForTests,
  setWindowedFloats,
  subscribeWindowedFloats,
} from "./extension-float-placement-state";

afterEach(() => {
  resetWindowedFloatsForTests();
});

describe("windowed float membership", () => {
  it("publishes the set the in-window layer must skip", () => {
    setWindowedFloats(["a:widget", "b:custom"]);
    expect([...getWindowedFloats()].sort()).toEqual(["a:widget", "b:custom"]);
  });

  it("stays quiet when the same slots are republished in another order", () => {
    // The controller republishes on every reconcile, and a reconcile runs on
    // every content change. Waking the float layer for an unchanged set would
    // re-render every float behind a widget that merely updated its text.
    setWindowedFloats(["a:widget", "b:custom"]);
    let notified = 0;
    const unsubscribe = subscribeWindowedFloats(() => (notified += 1));

    setWindowedFloats(["b:custom", "a:widget"]);
    expect(notified).toBe(0);

    setWindowedFloats(["a:widget"]);
    expect(notified).toBe(1);
    unsubscribe();
  });

  it("does not treat a same-sized different set as unchanged", () => {
    setWindowedFloats(["a:widget"]);
    let notified = 0;
    const unsubscribe = subscribeWindowedFloats(() => (notified += 1));
    setWindowedFloats(["b:custom"]);
    expect(notified).toBe(1);
    expect([...getWindowedFloats()]).toEqual(["b:custom"]);
    unsubscribe();
  });

  it("stops notifying an unsubscribed listener", () => {
    let notified = 0;
    const unsubscribe = subscribeWindowedFloats(() => (notified += 1));
    unsubscribe();
    setWindowedFloats(["a:widget"]);
    expect(notified).toBe(0);
  });

  it("resets to empty only when something was published", () => {
    let notified = 0;
    const unsubscribe = subscribeWindowedFloats(() => (notified += 1));
    resetWindowedFloatsForTests();
    expect(notified).toBe(0);

    setWindowedFloats(["a:widget"]);
    resetWindowedFloatsForTests();
    expect(getWindowedFloats().size).toBe(0);
    expect(notified).toBe(2);
    unsubscribe();
  });
});
