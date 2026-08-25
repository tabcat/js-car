/**
 * Create a header from an array of roots.
 *
 * @param {CID[]} roots
 * @param {number} [maxAllowedHeaderSize]
 * @returns {Uint8Array}
 */
export function createHeader(roots: CID[], maxAllowedHeaderSize?: number): Uint8Array;
export type CID = import("multiformats").CID;
export type Block = import("./api.js").Block;
export type CarEncoder = import("./coding.js").CarEncoder;
export type IteratorChannel_Writer = import("./coding.js").IteratorChannel_Writer<Uint8Array>;
export type CarLimits = import("./limits.js").CarLimits;
/**
 * @param {IteratorChannel_Writer} writer
 * @param {CarLimits} limits
 * @returns {CarEncoder}
 */
export function createEncoder(writer: IteratorChannel_Writer, limits: CarLimits): CarEncoder;
//# sourceMappingURL=encoder.d.ts.map