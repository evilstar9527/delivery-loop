/** Stable application identity required on every GitHub REST request. */
export const GITHUB_API_USER_AGENT = 'delivery-loop-control-plane';

/** Preserve injected test adapters while binding the runtime default fetch to globalThis. */
export function githubApiFetch(injected?: typeof globalThis.fetch): typeof globalThis.fetch {
  return injected ?? ((input, init) => globalThis.fetch(input, init));
}
