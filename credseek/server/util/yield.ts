/** Let the event loop breathe so HTTP/static/search can run during heavy import. */
export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
