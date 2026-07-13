/* eslint-env mocha */

import { encode as cbEncode } from '@ipld/dag-cbor'
import { expect } from 'aegir/chai'
import { CarBufferReader } from '../src/buffer-reader.js'
import * as CarBufferWriter from '../src/buffer-writer.js'
import { DEFAULT_MAX_ALLOWED_SECTION_SIZE } from '../src/limits.js'
import { CarReader } from '../src/reader.js'
import { CarWriter } from '../src/writer.js'
import { assert, makeData, makeIterable } from './common.js'

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

/** @param {AsyncIterable<Uint8Array>} iterable */
function collector (iterable) {
  const chunks = []
  return (async () => {
    for await (const chunk of iterable) {
      chunks.push(chunk)
    }
    return concatBytes(chunks)
  })()
}

/**
 * Write roots + blocks through CarWriter and return the full CAR bytes.
 * Rejects if any put/close rejects.
 *
 * @param {import('../src/api.js').CID[]} roots
 * @param {import('../src/api.js').Block[]} blocks
 * @param {import('../src/api.js').CarCodecOptions} [options]
 */
async function writeAll (roots, blocks, options) {
  const { writer, out } = CarWriter.create(roots, options)
  const collection = collector(out)
  const writes = blocks.map((b) => writer.put(b))
  writes.push(writer.close())
  await Promise.all(writes)
  return collection
}

/**
 * Build a synthetic block whose section (cid + body) is `sectionSize` bytes.
 *
 * @param {import('../src/api.js').CID} cid
 * @param {number} sectionSize
 */
function blockOfSection (cid, sectionSize) {
  return { cid, bytes: new Uint8Array(sectionSize - cid.bytes.length) }
}

describe('encode size limits', () => {
  /** @type {import('../src/api.js').Block[]} */
  let rawBlocks
  /** @type {import('../src/api.js').CID[]} */
  let roots

  before(async () => {
    const data = await makeData()
    rawBlocks = data.rawBlocks // CIDv1 raw, 4-byte bodies
    roots = [data.cborBlocks[0].cid, data.cborBlocks[1].cid]
  })

  describe('CarWriter defaults', () => {
    it('writes a normal CAR with no options', async () => {
      const bytes = await writeAll(roots, [rawBlocks[0]], undefined)
      assert.ok(bytes.length > 0)
    })

    it('rejects a section over the default 8 MiB cap with no options', async () => {
      const big = blockOfSection(rawBlocks[0].cid, DEFAULT_MAX_ALLOWED_SECTION_SIZE + 1)
      const { writer, out } = CarWriter.create(roots)
      await out[Symbol.asyncIterator]().next() // drain the header so writeBlock runs
      await expect(writer.put(big)).to.eventually.be.rejectedWith(RangeError, /maxAllowedSectionSize/)
    })
  })

  describe('section cap boundaries', () => {
    it('a section exactly at the cap is allowed, one over rejects', async () => {
      const cap = rawBlocks[0].cid.bytes.length + 8 // small explicit cap
      // exactly at the cap: allowed
      await writeAll(roots, [blockOfSection(rawBlocks[0].cid, cap)], { maxAllowedSectionSize: cap, maxAllowedHeaderSize: 1 << 20 })
      // one over: rejected
      const { writer, out } = CarWriter.create(roots, { maxAllowedSectionSize: cap, maxAllowedHeaderSize: 1 << 20 })
      await out[Symbol.asyncIterator]().next()
      await expect(writer.put(blockOfSection(rawBlocks[0].cid, cap + 1))).to.eventually.be.rejectedWith(RangeError, /maxAllowedSectionSize/)
    })
  })

  describe('header cap surfaces via the mutex', () => {
    it('rejects an over-cap header from the first put', async () => {
      const { writer } = CarWriter.create(roots, { maxAllowedHeaderSize: 10 })
      await expect(writer.put(rawBlocks[0])).to.eventually.be.rejectedWith(RangeError, /maxAllowedHeaderSize/)
    })

    it('allows a header exactly equal to the cap', async () => {
      const headerLen = cbEncode({ version: 1, roots }).length
      const bytes = await writeAll(roots, [rawBlocks[0]], { maxAllowedHeaderSize: headerLen })
      assert.ok(bytes.length > 0)
    })
  })

  describe('createAppender', () => {
    it('enforces the section cap on appended blocks (no header cap applies)', async () => {
      const big = blockOfSection(rawBlocks[0].cid, DEFAULT_MAX_ALLOWED_SECTION_SIZE + 1)
      const { writer } = CarWriter.createAppender()
      await expect(writer.put(big)).to.eventually.be.rejectedWith(RangeError, /maxAllowedSectionSize/)
    })

    it('writes normally within the caps', async () => {
      const { writer, out } = CarWriter.createAppender()
      const collection = collector(out)
      await writer.put(rawBlocks[0])
      await writer.close()
      assert.ok((await collection).length > 0)
    })
  })

  describe('round-trip guarantee', () => {
    it('a section written at a real custom cap decodes back under the same cap', async () => {
      // exercise the write-side (cid.bytes.length + bytes.length) and read-side
      // (sectionLength) arithmetic against the same non-trivial cap
      const cap = rawBlocks[0].cid.bytes.length + 8
      const profile = { maxAllowedSectionSize: cap, maxAllowedHeaderSize: 1 << 20 }
      const bytes = await writeAll(roots, [blockOfSection(rawBlocks[0].cid, cap)], profile)
      const reader = await CarReader.fromIterable(makeIterable(bytes, 64), profile)
      const decoded = []
      for await (const block of reader.blocks()) {
        decoded.push(block)
      }
      assert.strictEqual(decoded.length, 1)
    })

    it('default-written bytes are identical to explicitly-default-capped bytes', async () => {
      const data = await makeData()
      const baseline = await writeAll(roots, data.allBlocksFlattened, undefined)
      const capped = await writeAll(roots, data.allBlocksFlattened, {
        maxAllowedHeaderSize: 32 << 20,
        maxAllowedSectionSize: 8 << 20
      })
      assert.deepEqual(capped, baseline)
    })
  })

  it('create() throws a TypeError synchronously for a bad option value', () => {
    // resolveLimits runs synchronously inside create(), before any async work, so
    // a bad option throws here rather than through the writer's mutex. The full
    // validation predicate is covered in test-limits.spec.js.
    assert.throws(() => CarWriter.create([], { maxAllowedSectionSize: -1 }), TypeError, 'must be a non-negative safe integer')
  })

  describe('CarBufferWriter', () => {
    it('rejects an over-cap block even when the buffer has room (cap before capacity)', () => {
      const cid = rawBlocks[0].cid
      const cap = cid.bytes.length + 8
      // buffer is large enough for the block; the cap must still reject it
      const writer = CarBufferWriter.createWriter(new ArrayBuffer(1 << 16), {
        roots: [],
        maxAllowedSectionSize: cap
      })
      const overCap = { cid, bytes: new Uint8Array((cap + 1) - cid.bytes.length) }
      assert.throws(() => writer.write(overCap), RangeError, 'maxAllowedSectionSize')
    })

    it('the section-cap error precedes the capacity error', () => {
      const cid = rawBlocks[0].cid
      const cap = cid.bytes.length + 8
      // tiny buffer AND over cap: must report the cap, not capacity
      const writer = CarBufferWriter.createWriter(new ArrayBuffer(64), {
        roots: [],
        maxAllowedSectionSize: cap
      })
      const big = { cid, bytes: new Uint8Array(1 << 20) }
      assert.throws(() => writer.write(big), RangeError, 'maxAllowedSectionSize')
    })

    it('writes a block whose section is exactly at the cap without throwing', () => {
      const cid = rawBlocks[0].cid
      const cap = cid.bytes.length + 8
      const writer = CarBufferWriter.createWriter(new ArrayBuffer(1 << 16), { roots: [], maxAllowedSectionSize: cap })
      writer.write({ cid, bytes: new Uint8Array(cap - cid.bytes.length) })
      assert.strictEqual(CarBufferReader.fromBytes(writer.close()).blocks().length, 1)
    })

    it('defaults allow a normal block and the result round-trips', () => {
      const writer = CarBufferWriter.createWriter(new ArrayBuffer(1 << 16), { roots })
      writer.write(rawBlocks[0])
      const bytes = writer.close()
      const reader = CarBufferReader.fromBytes(bytes)
      assert.strictEqual(reader.blocks().length, 1)
    })

    it('close rejects a header over an explicit cap', () => {
      const writer = CarBufferWriter.createWriter(new ArrayBuffer(1 << 16), {
        roots,
        maxAllowedHeaderSize: 10
      })
      assert.throws(() => writer.close(), RangeError, 'maxAllowedHeaderSize')
    })
  })
})
