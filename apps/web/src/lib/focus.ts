// Keeping the keyboard focus through a save (#267). A button that's disabled while its action
// runs, or removed by it, drops the focus to the page: the browser moves it off a disabled
// element. Someone on a keyboard then starts again from the top.
import { useEffect, useRef } from "react";

/**
 * Once `busy` ends, puts the focus on `target()` if nothing has it (it fell to the page while
 * busy). Leaves it alone when it went somewhere, e.g. back to the button that opened a dialog
 * the save closed.
 */
export function useFocusAfter(busy: boolean, target: () => HTMLElement | null | undefined) {
  const wasBusy = useRef(false);
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const at = document.activeElement;
    if (at === null || at === document.body) latest.current()?.focus();
  }, [busy]);
}
