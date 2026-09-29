/**
 * jsdom reports 0 for offsetHeight/offsetWidth, so @tanstack/react-virtual
 * sees an empty viewport and renders no rows. This gives only the scroll
 * container (`data-testid="bookmark-scroll"`) a 600x400 box.
 */
const SCROLL_TESTID = "bookmark-scroll";
let saved: [string, PropertyDescriptor | undefined][] = [];

export function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  saved = defs.map(([prop, value]) => {
    const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === SCROLL_TESTID ? value : 0;
      },
    });
    return [prop, prior];
  });
}

export function restoreElementRects(): void {
  for (const [prop, prior] of saved) {
    if (prior === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  saved = [];
}
