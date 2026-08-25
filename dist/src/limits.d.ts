/**
 * Resolve a `CarCodecOptions` into a complete set of caps, applying the default
 * for each option left unset and validating any value provided.
 *
 * @param {CarCodecOptions} [options]
 * @returns {CarLimits}
 */
export function resolveLimits(options?: CarCodecOptions): CarLimits;
/**
 * @typedef {import('./api.js').CarCodecOptions} CarCodecOptions
 * @typedef {Required<CarCodecOptions>} CarLimits
 */
export const DEFAULT_MAX_ALLOWED_HEADER_SIZE: number;
export const DEFAULT_MAX_ALLOWED_SECTION_SIZE: number;
export type CarCodecOptions = import("./api.js").CarCodecOptions;
export type CarLimits = Required<CarCodecOptions>;
//# sourceMappingURL=limits.d.ts.map