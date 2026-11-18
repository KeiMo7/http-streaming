/**
 * @file hdr.js
 *
 * HDR color metadata parsing, validation, and MP4 initialization segment
 * helpers. These utilities do not alter media samples.
 */

export const COLOR_PRIMARIES = {
  BT709: 1,
  UNSPECIFIED: 2,
  BT470M: 4,
  BT470BG: 5,
  SMPTE170M: 6,
  SMPTE240M: 7,
  FILM: 8,
  BT2020: 9,
  SMPTE428: 10,
  SMPTE431: 11,
  SMPTE432: 12,
  EBU3213: 22
};

export const TRANSFER_CHARACTERISTICS = {
  BT709: 1,
  UNSPECIFIED: 2,
  BT470M: 4,
  BT470BG: 5,
  SMPTE170M: 6,
  SMPTE240M: 7,
  LINEAR: 8,
  LOG100: 9,
  LOG316: 10,
  IEC61966_2_4: 11,
  BT1361E: 12,
  IEC61966_2_1: 13,
  BT2020_10: 14,
  BT2020_12: 15,
  SMPTE2084: 16,
  SMPTE428: 17,
  ARIB_STD_B67: 18
};

export const MATRIX_COEFFICIENTS = {
  RGB: 0,
  BT709: 1,
  UNSPECIFIED: 2,
  FCC: 4,
  BT470BG: 5,
  SMPTE170M: 6,
  SMPTE240M: 7,
  YCGCO: 8,
  BT2020_NCL: 9,
  BT2020_CL: 10,
  SMPTE2085: 11,
  CHROMANCL: 12,
  CHROMACL: 13,
  ICTCP: 14
};

const PRIMARIES_NAMES = {
  1: 'bt709',
  2: 'unspecified',
  4: 'bt470m',
  5: 'bt470bg',
  6: 'smpte170m',
  7: 'smpte240m',
  8: 'film',
  9: 'bt2020',
  10: 'smpte428',
  11: 'smpte431',
  12: 'smpte432',
  22: 'ebu3213'
};

const TRANSFER_NAMES = {
  1: 'bt709',
  2: 'unspecified',
  4: 'bt470m',
  5: 'bt470bg',
  6: 'smpte170m',
  7: 'smpte240m',
  8: 'linear',
  9: 'log100',
  10: 'log316',
  11: 'iec61966-2-4',
  12: 'bt1361e',
  13: 'iec61966-2-1',
  14: 'bt2020-10',
  15: 'bt2020-12',
  16: 'smpte2084',
  17: 'smpte428',
  18: 'arib-std-b67'
};

const MATRIX_NAMES = {
  0: 'rgb',
  1: 'bt709',
  2: 'unspecified',
  4: 'fcc',
  5: 'bt470bg',
  6: 'smpte170m',
  7: 'smpte240m',
  8: 'ycgco',
  9: 'bt2020nc',
  10: 'bt2020c',
  11: 'smpte2085',
  12: 'chromaticity-ncl',
  13: 'chromaticity-cl',
  14: 'ictcp'
};

const CHROMA_FORMATS = {
  0: 'monochrome',
  1: '4:2:0',
  2: '4:2:2',
  3: '4:4:4'
};

export const HDR_ERROR_CODES = {
  MISSING_METADATA: 'VHS_HDR_MISSING_METADATA',
  CONFLICTING_METADATA: 'VHS_HDR_CONFLICTING_METADATA',
  UNSUPPORTED_COLOR_SPACE: 'VHS_HDR_UNSUPPORTED_COLOR_SPACE',
  UNSUPPORTED_BIT_DEPTH: 'VHS_HDR_UNSUPPORTED_BIT_DEPTH',
  UNSUPPORTED_TONE_MAPPING: 'VHS_HDR_UNSUPPORTED_TONE_MAPPING',
  MIDSTREAM_SWITCH: 'VHS_HDR_MIDSTREAM_SWITCH'
};

export const DEFAULT_HDR_CONFIG = Object.freeze({
  enabled: true,
  missingMetadata: 'sdr',
  conflictPolicy: 'reject',
  minimumBitDepth: 10,
  warnOnMissingMetadata: false,
  toneMapping: {
    strategy: 'browser',
    targetPeakNits: null,
    sourcePeakNits: null,
    referenceWhiteNits: null
  }
});

const MP4_CONTAINER_TYPES = {
  moov: true,
  trak: true,
  mdia: true,
  minf: true,
  stbl: true,
  stsd: true,
  avc1: true,
  avc2: true,
  avc3: true,
  avc4: true,
  hvc1: true,
  hev1: true
};

const VISUAL_SAMPLE_ENTRY_TYPES = {
  avc1: true,
  avc2: true,
  avc3: true,
  avc4: true,
  hvc1: true,
  hev1: true
};

const readUint16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];

const now = () => (
  typeof performance !== 'undefined' && performance.now ?
    performance.now() :
    Date.now()
);

const readUint32 = (bytes, offset) => (
  (bytes[offset] * 0x1000000) +
  (bytes[offset + 1] << 16) +
  (bytes[offset + 2] << 8) +
  bytes[offset + 3]
);

const readType = (bytes, offset) => String.fromCharCode(
  bytes[offset],
  bytes[offset + 1],
  bytes[offset + 2],
  bytes[offset + 3]
);

/**
 * Reads bits from an RBSP byte array.
 */
class BitReader {
  /**
   * Creates a reader for the supplied RBSP bytes.
   *
   * @param {Uint8Array} bytes RBSP bytes
   */
  constructor(bytes) {
    this.bytes = bytes;
    this.bitOffset = 0;
  }

  /**
   * Reads an unsigned bit field.
   *
   * @param {number} count number of bits to read
   * @return {number} unsigned value
   */
  readBits(count) {
    let value = 0;

    for (let i = 0; i < count; i++) {
      const byteOffset = this.bitOffset >> 3;

      if (byteOffset >= this.bytes.length) {
        throw new Error('Unexpected end of bitstream');
      }

      const shift = 7 - (this.bitOffset & 7);

      value = (value * 2) + ((this.bytes[byteOffset] >> shift) & 1);
      this.bitOffset++;
    }

    return value;
  }

  /**
   * Reads an unsigned Exp-Golomb value.
   *
   * @return {number} unsigned Exp-Golomb value
   */
  readUE() {
    let leadingZeros = 0;

    while (this.readBits(1) === 0) {
      leadingZeros++;

      if (leadingZeros > 31) {
        throw new Error('Invalid Exp-Golomb value');
      }
    }

    if (!leadingZeros) {
      return 0;
    }

    return ((2 ** leadingZeros) - 1) + this.readBits(leadingZeros);
  }

  /**
   * Reads a signed Exp-Golomb value.
   *
   * @return {number} signed Exp-Golomb value
   */
  readSE() {
    const value = this.readUE();

    return (value & 1) ? (value + 1) / 2 : -(value / 2);
  }

  /**
   * Skips a bit field.
   *
   * @param {number} count number of bits to skip
   */
  skipBits(count) {
    this.readBits(count);
  }

  /**
   * Reports whether the reader reached the end.
   *
   * @return {boolean} whether the reader reached the end
   */
  get ended() {
    return (this.bitOffset >> 3) >= this.bytes.length;
  }
}

export const removeEmulationPrevention = (bytes) => {
  const result = [];

  for (let i = 0; i < bytes.length; i++) {
    if (i >= 2 && bytes[i] === 3 && bytes[i - 1] === 0 && bytes[i - 2] === 0) {
      continue;
    }
    result.push(bytes[i]);
  }

  return new Uint8Array(result);
};

const skipScalingList = (reader, size) => {
  let lastScale = 8;
  let nextScale = 8;

  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      nextScale = (lastScale + reader.readSE() + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
};

const parseColorDescription = (reader) => {
  if (!reader.readBits(1)) {
    return {};
  }

  return {
    primaries: reader.readBits(8),
    transfer: reader.readBits(8),
    matrix: reader.readBits(8)
  };
};

export const parseAvcSps = (spsBytes) => {
  if (!spsBytes || spsBytes.length < 4) {
    return null;
  }

  try {
    const nal = spsBytes[0] & 0x1f;
    const rbsp = removeEmulationPrevention(nal === 7 ? spsBytes.subarray(1) : spsBytes);
    const reader = new BitReader(rbsp);
    const profileIdc = reader.readBits(8);
    const profileCompatibility = reader.readBits(8);
    const levelIdc = reader.readBits(8);
    let chromaFormatIdc = 1;
    let bitDepth = 8;

    reader.readUE();

    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
      chromaFormatIdc = reader.readUE();

      if (chromaFormatIdc === 3) {
        reader.skipBits(1);
      }

      bitDepth = reader.readUE() + 8;
      reader.readUE();
      reader.skipBits(1);

      if (reader.readBits(1)) {
        const scalingListCount = chromaFormatIdc === 3 ? 12 : 8;

        for (let i = 0; i < scalingListCount; i++) {
          if (reader.readBits(1)) {
            skipScalingList(reader, i < 6 ? 16 : 64);
          }
        }
      }
    }

    reader.readUE();
    const picOrderCntType = reader.readUE();

    if (picOrderCntType === 0) {
      reader.readUE();
    } else if (picOrderCntType === 1) {
      reader.skipBits(1);
      reader.readSE();
      reader.readSE();

      const numRefFrames = reader.readUE();

      for (let i = 0; i < numRefFrames; i++) {
        reader.readSE();
      }
    }

    reader.readUE();
    reader.skipBits(1);

    const picWidthInMbs = reader.readUE() + 1;
    const picHeightInMapUnits = reader.readUE() + 1;
    const frameMbsOnly = reader.readBits(1);

    if (!frameMbsOnly) {
      reader.skipBits(1);
    }

    reader.skipBits(1);

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;

    if (reader.readBits(1)) {
      cropLeft = reader.readUE();
      cropRight = reader.readUE();
      cropTop = reader.readUE();
      cropBottom = reader.readUE();
    }

    const metadata = {
      profileIdc,
      profileCompatibility,
      levelIdc,
      width: ((picWidthInMbs * 16) - (cropLeft * 2) - (cropRight * 2)),
      height: ((2 - frameMbsOnly) * picHeightInMapUnits * 16) -
        (cropTop * 2) - (cropBottom * 2),
      bitDepth,
      chromaFormat: CHROMA_FORMATS[chromaFormatIdc] || 'unknown'
    };

    if (!reader.readBits(1)) {
      return metadata;
    }

    if (reader.readBits(1)) {
      const aspectRatioIdc = reader.readBits(8);

      if (aspectRatioIdc === 255) {
        reader.skipBits(32);
      }
    }

    if (reader.readBits(1)) {
      reader.skipBits(1);
    }

    if (reader.readBits(1)) {
      reader.skipBits(3);
      metadata.fullRange = Boolean(reader.readBits(1));
      Object.assign(metadata, parseColorDescription(reader));
    }

    return metadata;
  } catch (e) {
    return null;
  }
};

const skipHevcProfileTierLevel = (reader, maxSubLayersMinus1) => {
  reader.skipBits(2);
  reader.skipBits(1);
  reader.skipBits(5);
  reader.skipBits(32);
  reader.skipBits(48);
  reader.skipBits(8);

  const subLayerProfilePresent = [];
  const subLayerLevelPresent = [];

  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subLayerProfilePresent[i] = reader.readBits(1);
    subLayerLevelPresent[i] = reader.readBits(1);
  }

  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) {
      reader.skipBits(2);
    }

    for (let i = 0; i < maxSubLayersMinus1; i++) {
      if (subLayerProfilePresent[i]) {
        reader.skipBits(2);
        reader.skipBits(1);
        reader.skipBits(5);
        reader.skipBits(32);
        reader.skipBits(48);
      }

      if (subLayerLevelPresent[i]) {
        reader.skipBits(8);
      }
    }
  }
};

const skipHevcScalingListData = (reader) => {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    const matrixCount = sizeId === 3 ? 2 : 6;

    for (let matrixId = 0; matrixId < matrixCount; matrixId++) {
      if (!reader.readBits(1)) {
        reader.readUE();
        continue;
      }

      const coefNum = Math.min(64, 2 ** (4 + (sizeId * 2)));

      if (sizeId > 1) {
        reader.readSE();
      }

      for (let i = 0; i < coefNum; i++) {
        reader.readSE();
      }
    }
  }
};

const skipHevcShortTermRefPicSet = (reader, index, numDeltaPocs) => {
  let interPrediction = false;

  if (index > 0) {
    interPrediction = Boolean(reader.readBits(1));
  }

  if (interPrediction) {
    if (index === numDeltaPocs.length) {
      reader.readUE();
    }

    reader.skipBits(1);
    reader.readUE();

    let usedCount = 0;
    const refIndex = index - 1;

    for (let i = 0; i <= numDeltaPocs[refIndex]; i++) {
      const used = reader.readBits(1);

      if (used) {
        usedCount++;
      } else {
        reader.readBits(1);
      }
    }

    numDeltaPocs[index] = usedCount;
    return;
  }

  const negativePics = reader.readUE();
  const positivePics = reader.readUE();

  for (let i = 0; i < negativePics; i++) {
    reader.readUE();
    reader.readBits(1);
  }

  for (let i = 0; i < positivePics; i++) {
    reader.readUE();
    reader.readBits(1);
  }

  numDeltaPocs[index] = negativePics + positivePics;
};

export const parseHevcSps = (spsBytes) => {
  if (!spsBytes || spsBytes.length < 6) {
    return null;
  }

  try {
    const rbsp = removeEmulationPrevention(spsBytes.subarray(2));
    const reader = new BitReader(rbsp);

    reader.skipBits(4);

    const maxSubLayersMinus1 = reader.readBits(3);

    reader.skipBits(1);
    skipHevcProfileTierLevel(reader, maxSubLayersMinus1);
    reader.readUE();

    const chromaFormatIdc = reader.readUE();

    if (chromaFormatIdc === 3) {
      reader.skipBits(1);
    }

    const width = reader.readUE();
    const height = reader.readUE();

    if (reader.readBits(1)) {
      reader.readUE();
      reader.readUE();
      reader.readUE();
      reader.readUE();
    }

    const bitDepth = reader.readUE() + 8;

    reader.readUE();
    reader.readUE();

    const subLayerOrderingInfoPresent = reader.readBits(1);
    const firstLayer = subLayerOrderingInfoPresent ? 0 : maxSubLayersMinus1;

    for (let i = firstLayer; i <= maxSubLayersMinus1; i++) {
      reader.readUE();
      reader.readUE();
      reader.readUE();
    }

    reader.readUE();
    reader.readUE();
    reader.readUE();
    reader.readUE();
    reader.readUE();
    reader.readUE();

    if (reader.readBits(1) && reader.readBits(1)) {
      skipHevcScalingListData(reader);
    }

    reader.skipBits(1);
    reader.skipBits(1);

    if (reader.readBits(1)) {
      reader.readBits(4);
      reader.readBits(4);
      reader.readUE();
      reader.readUE();
      reader.skipBits(1);
    }

    const numShortTermRefPicSets = reader.readUE();
    const numDeltaPocs = [];

    for (let i = 0; i < numShortTermRefPicSets; i++) {
      skipHevcShortTermRefPicSet(reader, i, numDeltaPocs);
    }

    if (reader.readBits(1)) {
      const numLongTermRefPics = reader.readUE();

      for (let i = 0; i < numLongTermRefPics; i++) {
        reader.readBits(16);
        reader.readBits(1);
      }
    }

    reader.skipBits(1);
    reader.skipBits(1);

    const metadata = {
      width,
      height,
      bitDepth,
      chromaFormat: CHROMA_FORMATS[chromaFormatIdc] || 'unknown'
    };

    if (!reader.readBits(1)) {
      return metadata;
    }

    if (reader.readBits(1)) {
      const aspectRatioIdc = reader.readBits(8);

      if (aspectRatioIdc === 255) {
        reader.skipBits(32);
      }
    }

    if (reader.readBits(1)) {
      reader.skipBits(1);
    }

    if (reader.readBits(1)) {
      reader.skipBits(3);
      metadata.fullRange = Boolean(reader.readBits(1));
      Object.assign(metadata, parseColorDescription(reader));
    }

    return metadata;
  } catch (e) {
    return null;
  }
};

const parseBoxes = (bytes, start = 0, end = bytes.length) => {
  const boxes = [];
  let offset = start;

  while (offset + 8 <= end) {
    let size = readUint32(bytes, offset);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > end) {
        break;
      }

      const high = readUint32(bytes, offset + 8);
      const low = readUint32(bytes, offset + 12);

      if (high > 0x1fffff) {
        break;
      }

      size = (high * 0x100000000) + low;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) {
      break;
    }

    boxes.push({
      type: readType(bytes, offset + 4),
      start: offset,
      end: offset + size,
      headerSize,
      payloadStart: offset + headerSize
    });
    offset += size;
  }

  return boxes;
};

const walkBoxes = (bytes, start, end, visitor) => {
  parseBoxes(bytes, start, end).forEach((box) => {
    visitor(box);

    if (!MP4_CONTAINER_TYPES[box.type] || box.headerSize === 16) {
      return;
    }

    let childStart = box.payloadStart;

    if (box.type === 'stsd') {
      childStart += 8;
    } else if (VISUAL_SAMPLE_ENTRY_TYPES[box.type]) {
      childStart += 78;
    }

    if (childStart < box.end) {
      walkBoxes(bytes, childStart, box.end, visitor);
    }
  });
};

const parseAvcC = (bytes, box) => {
  const payload = bytes.subarray(box.payloadStart, box.end);

  if (payload.length < 7) {
    return null;
  }

  let offset = 5;
  const spsCount = payload[offset++] & 0x1f;

  for (let i = 0; i < spsCount; i++) {
    if (offset + 2 > payload.length) {
      return null;
    }

    const length = readUint16(payload, offset);

    offset += 2;

    if (!length || offset + length > payload.length) {
      return null;
    }

    const metadata = parseAvcSps(payload.subarray(offset, offset + length));

    if (metadata) {
      return metadata;
    }

    offset += length;
  }

  return null;
};

const parseHvcC = (bytes, box) => {
  const payload = bytes.subarray(box.payloadStart, box.end);

  if (payload.length < 23) {
    return null;
  }

  const fallback = {
    bitDepth: (payload[17] & 0x07) + 8,
    chromaFormat: CHROMA_FORMATS[payload[16] & 0x03] || 'unknown'
  };
  const numArrays = payload[22];
  let offset = 23;

  for (let i = 0; i < numArrays; i++) {
    if (offset + 3 > payload.length) {
      return fallback;
    }

    const nalType = payload[offset] & 0x3f;
    const numNalus = readUint16(payload, offset + 1);

    offset += 3;

    for (let j = 0; j < numNalus; j++) {
      if (offset + 2 > payload.length) {
        return fallback;
      }

      const length = readUint16(payload, offset);

      offset += 2;

      if (!length || offset + length > payload.length) {
        return fallback;
      }

      if (nalType === 33) {
        const metadata = parseHevcSps(payload.subarray(offset, offset + length));

        if (metadata) {
          return metadata;
        }
      }

      offset += length;
    }
  }

  return fallback;
};

const parseColr = (bytes, box) => {
  const payload = bytes.subarray(box.payloadStart, box.end);
  const type = payload.length >= 4 ? readType(payload, 0) : null;

  if ((type !== 'nclx' && type !== 'nclc') || payload.length < 10) {
    return null;
  }

  return {
    primaries: readUint16(payload, 4),
    transfer: readUint16(payload, 6),
    matrix: readUint16(payload, 8),
    fullRange: type === 'nclx' && payload.length > 10 ? Boolean(payload[10] & 0x80) : undefined,
    source: [type]
  };
};

export const classifyHdrType = (metadata) => {
  if (!metadata) {
    return 'unknown';
  }

  const { primaries, transfer } = metadata;

  if (typeof primaries === 'undefined' || typeof transfer === 'undefined') {
    return 'unknown';
  }

  if (transfer === TRANSFER_CHARACTERISTICS.SMPTE2084 ||
      transfer === TRANSFER_CHARACTERISTICS.ARIB_STD_B67) {
    if (primaries !== COLOR_PRIMARIES.BT2020) {
      return 'invalid';
    }

    return transfer === TRANSFER_CHARACTERISTICS.SMPTE2084 ? 'hdr10' : 'hlg';
  }

  if (!TRANSFER_NAMES[transfer] || !PRIMARIES_NAMES[primaries]) {
    return 'unknown';
  }

  return 'sdr';
};

const metadataFieldNames = ['primaries', 'transfer', 'matrix', 'fullRange', 'bitDepth', 'chromaFormat'];

const mergeMetadata = (sps, colr) => {
  const merged = {
    primaries: undefined,
    transfer: undefined,
    matrix: undefined,
    fullRange: undefined,
    bitDepth: undefined,
    chromaFormat: undefined,
    width: sps && sps.width,
    height: sps && sps.height,
    profileIdc: sps && sps.profileIdc,
    levelIdc: sps && sps.levelIdc,
    profileCompatibility: sps && sps.profileCompatibility,
    sources: [],
    issues: []
  };
  const sources = [
    sps && Object.assign({ source: 'avcC/SPS' }, sps),
    colr && Object.assign({ source: colr.source.join('/') }, colr)
  ].filter(Boolean);

  sources.forEach((source) => {
    merged.sources.push(source.source);

    metadataFieldNames.forEach((field) => {
      if (typeof source[field] === 'undefined') {
        return;
      }

      if (typeof merged[field] === 'undefined') {
        merged[field] = source[field];
        return;
      }

      if (merged[field] !== source[field]) {
        merged.issues.push({
          field,
          values: [merged[field], source[field]],
          sources: merged.sources.slice()
        });
      }
    });
  });

  if (typeof merged.primaries === 'undefined' &&
      typeof merged.transfer === 'undefined' &&
      typeof merged.matrix === 'undefined') {
    return null;
  }

  merged.primariesName = PRIMARIES_NAMES[merged.primaries] || 'unknown';
  merged.transferName = TRANSFER_NAMES[merged.transfer] || 'unknown';
  merged.matrixName = MATRIX_NAMES[merged.matrix] || 'unknown';
  merged.hdrType = classifyHdrType(merged);
  merged.hdr = merged.hdrType === 'hdr10' || merged.hdrType === 'hlg';

  return merged;
};

export const getColorMetadataFromInitSegment = (initSegment) => {
  if (!initSegment || !initSegment.length) {
    return null;
  }

  let codecMetadata = null;
  let colrMetadata = null;

  walkBoxes(initSegment, 0, initSegment.length, (box) => {
    if (box.type === 'avcC' && !codecMetadata) {
      codecMetadata = parseAvcC(initSegment, box);

      if (codecMetadata) {
        codecMetadata.source = 'avcC/SPS';
      }
    }

    if (box.type === 'hvcC' && !codecMetadata) {
      codecMetadata = parseHvcC(initSegment, box);

      if (codecMetadata) {
        codecMetadata.source = 'hvcC/SPS';
      }
    }

    if (box.type === 'colr' && !colrMetadata) {
      colrMetadata = parseColr(initSegment, box);
    }
  });

  return mergeMetadata(codecMetadata, colrMetadata);
};

export const normalizeHdrConfig = (config = {}) => {
  const supplied = config || {};
  const toneMapping = Object.assign(
    {},
    DEFAULT_HDR_CONFIG.toneMapping,
    supplied.toneMapping || {}
  );

  if (!['browser', 'passthrough', 'sdr'].includes(toneMapping.strategy)) {
    throw new TypeError(`Unsupported HDR toneMapping.strategy "${toneMapping.strategy}". ` +
      'Use "browser", "passthrough", or "sdr".');
  }

  if (supplied.missingMetadata &&
      !['sdr', 'reject'].includes(supplied.missingMetadata)) {
    throw new TypeError(`Unsupported HDR missingMetadata policy "${supplied.missingMetadata}". ` +
      'Use "sdr" or "reject".');
  }

  if (supplied.conflictPolicy &&
      !['sdr', 'reject'].includes(supplied.conflictPolicy)) {
    throw new TypeError(`Unsupported HDR conflictPolicy "${supplied.conflictPolicy}". ` +
      'Use "sdr" or "reject".');
  }

  return Object.assign({}, DEFAULT_HDR_CONFIG, supplied, {
    enabled: supplied.enabled !== false,
    toneMapping
  });
};

const createMetadataError = (code, message, stage, metadata) => {
  const error = new Error(`${message} (stage: ${stage})`);

  error.code = code;
  error.metadata = {
    stage,
    colorMetadata: metadata || null
  };

  return error;
};

export const validateHdrMetadata = (metadata, config = {}) => {
  const normalized = normalizeHdrConfig(config);
  const result = {
    action: 'pass',
    kind: metadata && metadata.hdrType || 'unknown',
    metadata: metadata || null,
    warnings: [],
    error: null
  };

  if (!normalized.enabled) {
    result.kind = 'disabled';
    return result;
  }

  if (!metadata || metadata.hdrType === 'unknown') {
    result.kind = 'sdr';
    result.warnings.push('HDR color metadata is absent or incomplete; treating input as SDR.');

    if (normalized.missingMetadata === 'reject') {
      result.action = 'reject';
      result.error = createMetadataError(
        HDR_ERROR_CODES.MISSING_METADATA,
        'HDR color metadata is absent or incomplete and missingMetadata is "reject".',
        'transmux.hdr.metadata',
        metadata
      );
    }

    return result;
  }

  if (metadata.issues && metadata.issues.length) {
    result.kind = 'invalid';
    result.warnings.push('HDR color metadata contains conflicting values.');

    if (normalized.conflictPolicy === 'reject') {
      result.action = 'reject';
      result.error = createMetadataError(
        HDR_ERROR_CODES.CONFLICTING_METADATA,
        `Conflicting color metadata for ${metadata.issues.map((issue) => issue.field).join(', ')}.`,
        'transmux.hdr.metadata',
        metadata
      );
      return result;
    }

    result.kind = 'sdr';
    result.metadata = null;
    return result;
  }

  if (metadata.hdrType === 'invalid') {
    result.kind = 'invalid';
    result.action = 'reject';
    result.error = createMetadataError(
      HDR_ERROR_CODES.UNSUPPORTED_COLOR_SPACE,
      `Unsupported HDR color space: primaries=${metadata.primaries}, ` +
        `transfer=${metadata.transfer}, matrix=${metadata.matrix}.`,
      'transmux.hdr.color-space',
      metadata
    );
    return result;
  }

  if (metadata.hdr) {
    if (typeof metadata.bitDepth === 'number' &&
        metadata.bitDepth < normalized.minimumBitDepth) {
      result.action = 'reject';
      result.error = createMetadataError(
        HDR_ERROR_CODES.UNSUPPORTED_BIT_DEPTH,
        `${metadata.hdrType} input is ${metadata.bitDepth}-bit, but the HDR pipeline ` +
          `requires at least ${normalized.minimumBitDepth}-bit samples.`,
        'transmux.hdr.bit-depth',
        metadata
      );
      return result;
    }

    if (normalized.toneMapping.strategy === 'sdr') {
      result.action = 'reject';
      result.error = createMetadataError(
        HDR_ERROR_CODES.UNSUPPORTED_TONE_MAPPING,
        'The configured SDR tone-mapping strategy requires a pixel-processing stage, ' +
          'which this MSE transport does not provide. Use "browser" or "passthrough".',
        'transmux.hdr.tone-mapping',
        metadata
      );
      return result;
    }
  }

  result.kind = metadata.hdrType;
  return result;
};

export const reconcileHdrMetadata = (previous, current, config = {}) => {
  const normalized = normalizeHdrConfig(config);
  const result = {
    metadata: current || null,
    warnings: [],
    error: null
  };

  if (!normalized.enabled) {
    return result;
  }

  const previousHdr = previous && previous.hdr;
  const currentMissing = !current || current.hdrType === 'unknown';

  if (previousHdr && currentMissing) {
    result.metadata = Object.assign({}, previous, {
      carriedForward: true
    });
    result.warnings.push('HDR color metadata was not present on the new rendition; ' +
      'retaining the session HDR marker.');
    return result;
  }

  if (previousHdr && current && current.hdrType === 'sdr') {
    result.error = createMetadataError(
      HDR_ERROR_CODES.MIDSTREAM_SWITCH,
      `Refusing to switch from ${previous.hdrType} to SDR within one playback session.`,
      'segment-loader.hdr.rendition-switch',
      current
    );
    return result;
  }

  if (previousHdr && current && current.hdr &&
      previous.hdrType !== current.hdrType) {
    result.error = createMetadataError(
      HDR_ERROR_CODES.MIDSTREAM_SWITCH,
      `Refusing to switch HDR mode from ${previous.hdrType} to ${current.hdrType} ` +
        'within one playback session.',
      'segment-loader.hdr.rendition-switch',
      current
    );
  }

  return result;
};

export const createColrBox = (metadata) => {
  const box = new Uint8Array(20);
  const view = new DataView(box.buffer);

  view.setUint32(0, 20);
  box.set([0x63, 0x6f, 0x6c, 0x72, 0x6e, 0x63, 0x6c, 0x78], 4);
  view.setUint16(12, metadata.primaries);
  view.setUint16(14, metadata.transfer);
  view.setUint16(16, metadata.matrix);
  box[18] = metadata.fullRange ? 0x80 : 0;

  return box;
};

const concatBytes = (chunks) => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });

  return result;
};

const createBox = (type, payload) => {
  const box = new Uint8Array(8 + payload.length);
  const view = new DataView(box.buffer);

  view.setUint32(0, box.length);
  box.set([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3)
  ], 4);
  box.set(payload, 8);

  return box;
};

const rewriteBox = (bytes, box, colr) => {
  if (!MP4_CONTAINER_TYPES[box.type] || box.headerSize === 16) {
    return bytes.slice(box.start, box.end);
  }

  let childStart = box.payloadStart;

  if (box.type === 'stsd') {
    childStart += 8;
  } else if (VISUAL_SAMPLE_ENTRY_TYPES[box.type]) {
    childStart += 78;
  }

  const children = parseBoxes(bytes, childStart, box.end);

  if (!children.length) {
    return bytes.slice(box.start, box.end);
  }

  const prefix = bytes.slice(box.payloadStart, childStart);
  const childChunks = children.map((child) => rewriteBox(bytes, child, colr));
  const hasColr = children.some((child) => child.type === 'colr');

  if (VISUAL_SAMPLE_ENTRY_TYPES[box.type] && !hasColr && colr) {
    childChunks.push(createColrBox(colr));
  }

  return createBox(box.type, concatBytes([prefix].concat(childChunks)));
};

export const injectColrIntoInitSegment = (initSegment, metadata) => {
  if (!initSegment || !metadata ||
      typeof metadata.primaries !== 'number' ||
      typeof metadata.transfer !== 'number' ||
      typeof metadata.matrix !== 'number') {
    return initSegment;
  }

  const existing = getColorMetadataFromInitSegment(initSegment);

  if (existing && existing.sources.some((source) => source.indexOf('ncl') !== -1)) {
    return initSegment;
  }

  let hasColr = false;

  walkBoxes(initSegment, 0, initSegment.length, (box) => {
    if (box.type === 'colr') {
      hasColr = true;
    }
  });

  if (hasColr) {
    return initSegment;
  }

  try {
    const chunks = parseBoxes(initSegment, 0, initSegment.length).map((box) => {
      return rewriteBox(initSegment, box, metadata);
    });

    if (!chunks.length) {
      return initSegment;
    }

    return concatBytes(chunks);
  } catch (e) {
    return initSegment;
  }
};

export const processHdrInitSegment = (initSegment, config) => {
  const startedAt = now();
  const normalized = normalizeHdrConfig(config || {});
  const enabled = typeof config !== 'undefined' && normalized.enabled;
  const result = {
    initSegment,
    metadata: null,
    action: enabled ? 'pass' : 'disabled',
    kind: enabled ? 'unknown' : 'disabled',
    warnings: [],
    error: null,
    timingMs: 0
  };

  if (!enabled) {
    return result;
  }

  const metadata = getColorMetadataFromInitSegment(initSegment);
  const validation = validateHdrMetadata(metadata, normalized);

  result.metadata = metadata;
  result.action = validation.action;
  result.kind = validation.kind;
  result.warnings = validation.warnings;
  result.error = validation.error;

  if (validation.action === 'pass' && metadata && metadata.hdr) {
    result.initSegment = injectColrIntoInitSegment(initSegment, metadata);
  }

  result.timingMs = now() - startedAt;

  return result;
};

export const hdrMetadataSummary = (metadata) => {
  if (!metadata) {
    return 'none';
  }

  return [
    `type=${metadata.hdrType || 'unknown'}`,
    `primaries=${metadata.primariesName || metadata.primaries || 'unknown'}`,
    `transfer=${metadata.transferName || metadata.transfer || 'unknown'}`,
    `matrix=${metadata.matrixName || metadata.matrix || 'unknown'}`,
    `bitDepth=${typeof metadata.bitDepth === 'number' ? metadata.bitDepth : 'unknown'}`,
    `fullRange=${Boolean(metadata.fullRange)}`
  ].join(' ');
};

export default {
  COLOR_PRIMARIES,
  TRANSFER_CHARACTERISTICS,
  MATRIX_COEFFICIENTS,
  HDR_ERROR_CODES,
  DEFAULT_HDR_CONFIG,
  parseAvcSps,
  getColorMetadataFromInitSegment,
  classifyHdrType,
  validateHdrMetadata,
  reconcileHdrMetadata,
  injectColrIntoInitSegment,
  processHdrInitSegment,
  normalizeHdrConfig,
  hdrMetadataSummary
};
