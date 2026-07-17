const originalReadPixels = globalThis.WebGL2RenderingContext.prototype.readPixels;
let injected = false;

globalThis.WebGL2RenderingContext.prototype.readPixels = function (...args) {
  const result = Reflect.apply(originalReadPixels, this, args);
  if (!injected) {
    injected = true;
    globalThis.queueMicrotask(() => {
      throw new Error('SOLAR_VOYAGER_INJECTED_FRAMEBUFFER_RUNTIME_ERROR');
    });
  }
  return result;
};
