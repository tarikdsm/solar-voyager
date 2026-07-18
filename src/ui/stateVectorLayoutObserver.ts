/** Observes setup-time HUD panels whose responsive size changes can move the WebGL inset. */
export function observeStateVectorLayout(
  overlay: HTMLElement,
  refresh: () => void,
  ResizeObserverConstructor: typeof ResizeObserver = ResizeObserver,
): () => void {
  const observer = new ResizeObserverConstructor(refresh);
  for (let index = 0; index < overlay.children.length; index += 1) {
    const panel = overlay.children[index];
    if (panel !== undefined) observer.observe(panel);
  }
  return () => observer.disconnect();
}
