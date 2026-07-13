/* eslint-env mocha */

import { encode as cbEncode } from '@ipld/dag-cbor'
import { encode as vEncode } from 'varint'
import { CarBufferReader } from '../src/buffer-reader.js'
import { CarBlockIterator } from '../src/iterator.js'
import { assert, carBytes, goCarV2Bytes, makeIterable, rndCid } from './common.js'

/**
 * Drive a CarBlockIterator decode to completion and return the block count.
 * Rejects if decoding rejects at any point.
 *
 * @param {Uint8Array} data
 * @param {import('../src/api.js').CarCodecOptions} [options]
 */
async function decodeAll (data, options) {
  let count = 0
  for await (const block of await CarBlockIterator.fromIterable(makeIterable(data, 64), options)) {
    if (block) {
      count++
    }
  }
  return count
}

/** @param {Uint8Array[]} chunks */
function concatBytes (chunks) {
  const length = chunks.reduce((p, c) => p + c.length, 0)
  const bytes = new Uint8Array(length)
  let off = 0
  for (const chunk of chunks) {
    bytes.set(chunk, off)
    off += chunk.length
  }
  return bytes
}

/** @param {Uint8Array} payload */
function lengthPrefixed (payload) {
  return concatBytes([Uint8Array.from(vEncode(payload.length)), payload])
}

const validV1Header = lengthPrefixed(cbEncode({ version: 1, roots: [] }))

// A valid header followed by a section that declares `bodyLength` bytes of body
// past its CID, but supplies only the CID. Used to probe the section cap without
// materializing a real body.
/** @param {number} bodyLength */
function sectionDeclaring (bodyLength) {
  const cid = rndCid.bytes
  return concatBytes([validV1Header, Uint8Array.from(vEncode(bodyLength + cid.length)), cid])
}

describe('decode size limits', () => {
  it('a normal v1 CAR decodes under the defaults', async () => {
    assert.ok(await decodeAll(carBytes, undefined) > 0)
  })

  it('a v2 CAR decodes under the defaults', async () => {
    assert.ok(await decodeAll(goCarV2Bytes, undefined) > 0)
  })

  describe('section cap', () => {
    it('rejects an oversized section from the length prefix, before buffering the body', async () => {
      // Under the default cap the decoder must reject from the prefix
      // (RangeError), not stream-and-buffer and fail with "Unexpected end of data".
      await assert.isRejected(decodeAll(sectionDeclaring(1_000_000_000)), RangeError, 'maxAllowedSectionSize')
    })

    it('lifting the cap changes the failure to end-of-data, proving the cap caused the rejection', async () => {
      await assert.isRejected(
        decodeAll(sectionDeclaring(1_000_000_000), { maxAllowedSectionSize: Number.MAX_SAFE_INTEGER }),
        Error,
        'Unexpected end of data'
      )
    })

    it('a section equal to the cap passes, cap+1 rejects', async () => {
      // largest section (cid + body) in carBytes, learned from an uncapped decode
      const iter = await CarBlockIterator.fromIterable(makeIterable(carBytes, 64))
      let maxSection = 0
      for await (const { cid, bytes } of iter) {
        maxSection = Math.max(maxSection, cid.bytes.length + bytes.length)
      }
      assert.ok(maxSection > 0)
      assert.ok(await decodeAll(carBytes, { maxAllowedSectionSize: maxSection }) > 0)
      await assert.isRejected(decodeAll(carBytes, { maxAllowedSectionSize: maxSection - 1 }), RangeError, 'maxAllowedSectionSize')
    })

    it('0 rejects every section', async () => {
      await assert.isRejected(decodeAll(carBytes, { maxAllowedSectionSize: 0 }), RangeError, 'maxAllowedSectionSize')
    })
  })

  describe('header cap', () => {
    it('rejects a v1 header over the cap', async () => {
      await assert.isRejected(decodeAll(carBytes, { maxAllowedHeaderSize: 10 }), RangeError, 'maxAllowedHeaderSize')
    })

    it('fires on the inner v1 header of a v2 CAR (recursion passes the cap)', async () => {
      // cap == the v2 pragma length: the pragma passes (equal), the larger inner
      // v1 header fails, proving the recursive readHeader gets the same cap.
      const pragmaLen = cbEncode({ version: 2 }).length
      await assert.isRejected(decodeAll(goCarV2Bytes, { maxAllowedHeaderSize: pragmaLen }), RangeError, 'maxAllowedHeaderSize')
    })
  })

  describe('CID bounded by its section', () => {
    it('rejects a CIDv1 declaring a multihash past the section end', async () => {
      // CIDv1 raw sha2-256 declaring a 1000-byte digest, in a section sized only
      // for the CID prefix: the CID does not fit the section.
      const cidPrefix = concatBytes([Uint8Array.from([0x01, 0x55, 0x12]), Uint8Array.from(vEncode(1000))])
      const section = concatBytes([Uint8Array.from(vEncode(cidPrefix.length + 1)), cidPrefix])
      await assert.isRejected(decodeAll(concatBytes([validV1Header, section])), Error, 'exceeds section length')
    })

    it('rejects a sub-34-byte section opening with the CIDv0 prefix', async () => {
      // 0x12 0x20 triggers the CIDv0 branch; a 20-byte section cannot hold a
      // 34-byte CIDv0, so it must throw rather than read into the next section.
      const section = concatBytes([Uint8Array.from(vEncode(20)), Uint8Array.from([0x12, 0x20]), new Uint8Array(18)])
      await assert.isRejected(decodeAll(concatBytes([validV1Header, section])), Error, 'exceeds section length')
    })
  })

  it('rejects a CIDv1 digest over the 32 MiB allocation bound', async () => {
    const hugeDigest = (32 << 20) + 1
    const cidPrefix = concatBytes([Uint8Array.from([0x01, 0x55, 0x12]), Uint8Array.from(vEncode(hugeDigest))])
    const section = concatBytes([Uint8Array.from(vEncode(cidPrefix.length + 1)), cidPrefix])
    // the digest cap fires while reading the multihash length, before the CID is
    // measured against the section, so it applies even under the default caps
    await assert.isRejected(decodeAll(concatBytes([validV1Header, section])), RangeError, 'CID digest')
  })

  // buffer-decoder.js is a separate synchronous implementation, not just a
  // threading of the async path, so its own cap branches are exercised here.
  describe('the synchronous CarBufferReader shares the same caps', () => {
    it('decodes a normal CAR and rejects an oversized section', () => {
      assert.ok(CarBufferReader.fromBytes(carBytes).blocks().length > 0)
      assert.throws(() => CarBufferReader.fromBytes(sectionDeclaring(1_000_000_000)), RangeError, 'maxAllowedSectionSize')
    })

    it('rejects a header over an explicit cap', () => {
      assert.throws(() => CarBufferReader.fromBytes(carBytes, { maxAllowedHeaderSize: 10 }), RangeError, 'maxAllowedHeaderSize')
    })

    it('rejects a CIDv1 declaring a multihash past the section end', () => {
      const cidPrefix = concatBytes([Uint8Array.from([0x01, 0x55, 0x12]), Uint8Array.from(vEncode(1000))])
      const section = concatBytes([Uint8Array.from(vEncode(cidPrefix.length + 1)), cidPrefix])
      assert.throws(() => CarBufferReader.fromBytes(concatBytes([validV1Header, section])), Error, 'exceeds section length')
    })
  })
})
