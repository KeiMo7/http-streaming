import QUnit from 'qunit';
import {Transmuxer} from 'mux.js/lib/mp4/transmuxer';
import {
  COLOR_PRIMARIES,
  TRANSFER_CHARACTERISTICS,
  HDR_ERROR_CODES,
  DEFAULT_HDR_CONFIG,
  getColorMetadataFromInitSegment,
  processHdrInitSegment,
  validateHdrMetadata,
  reconcileHdrMetadata,
  normalizeHdrConfig
} from '../../src/util/hdr';
import {
  hdr10 as hdr10Segment,
  hlg as hlgSegment,
  sdrHdrPath as sdrSegment,
  hevcHdr10Init as hevcHdr10InitSegment,
  hevcHlgInit as hevcHlgInitSegment
} from 'create-test-data!segments';

const transmux = (bytes) => new Promise((resolve) => {
  const transmuxer = new Transmuxer({
    remux: false,
    keepOriginalTimestamps: true
  });
  let initSegment;
  let data;

  transmuxer.on('data', (segment) => {
    initSegment = segment.initSegment;
    data = segment.data;
  });
  transmuxer.on('done', () => resolve({initSegment, data}));
  transmuxer.push(bytes);
  transmuxer.flush();
});

QUnit.module('HDR color metadata');

QUnit.test('detects HDR10 BT.2020 PQ metadata', async function(assert) {
  const {initSegment} = await transmux(hdr10Segment());
  const metadata = getColorMetadataFromInitSegment(initSegment);

  assert.equal(metadata.hdrType, 'hdr10', 'detected HDR10');
  assert.equal(metadata.primaries, COLOR_PRIMARIES.BT2020, 'BT.2020 primaries');
  assert.equal(metadata.transfer, TRANSFER_CHARACTERISTICS.SMPTE2084, 'PQ transfer');
  assert.equal(metadata.bitDepth, 10, '10-bit samples');
});

QUnit.test('detects HLG separately from HDR10', async function(assert) {
  const {initSegment} = await transmux(hlgSegment());
  const metadata = getColorMetadataFromInitSegment(initSegment);

  assert.equal(metadata.hdrType, 'hlg', 'detected HLG');
  assert.equal(metadata.primaries, COLOR_PRIMARIES.BT2020, 'BT.2020 primaries');
  assert.equal(metadata.transfer, TRANSFER_CHARACTERISTICS.ARIB_STD_B67, 'HLG transfer');
  assert.notEqual(metadata.hdrType, 'hdr10', 'HLG is not treated as HDR10');
});

QUnit.test('detects HDR10 and HLG from HEVC hvcC without a colr box', function(assert) {
  const hdr10 = getColorMetadataFromInitSegment(hevcHdr10InitSegment());
  const hlg = getColorMetadataFromInitSegment(hevcHlgInitSegment());

  assert.equal(hdr10.hdrType, 'hdr10', 'HEVC HDR10 detected from SPS VUI');
  assert.equal(hdr10.transfer, TRANSFER_CHARACTERISTICS.SMPTE2084, 'HEVC PQ transfer');
  assert.equal(hdr10.bitDepth, 10, 'HEVC 10-bit depth');
  assert.ok(hdr10.sources.includes('hvcC/SPS'), 'reports the HEVC source');
  assert.equal(hlg.hdrType, 'hlg', 'HEVC HLG detected from SPS VUI');
  assert.equal(hlg.transfer, TRANSFER_CHARACTERISTICS.ARIB_STD_B67, 'HEVC HLG transfer');
});

QUnit.test('injects colr for HDR and preserves the metadata', async function(assert) {
  const {initSegment} = await transmux(hdr10Segment());
  const result = processHdrInitSegment(initSegment, DEFAULT_HDR_CONFIG);
  const metadata = getColorMetadataFromInitSegment(result.initSegment);
  const repeated = processHdrInitSegment(result.initSegment, DEFAULT_HDR_CONFIG);

  assert.ok(result.initSegment.length > initSegment.length, 'init segment grew');
  assert.strictEqual(
    repeated.initSegment,
    result.initSegment,
    'existing colr metadata is not overwritten or duplicated'
  );
  assert.ok(metadata.sources.some((source) => source.indexOf('nclx') !== -1), 'has nclx');
  assert.equal(metadata.hdrType, 'hdr10', 'still HDR10');
  assert.equal(metadata.transfer, TRANSFER_CHARACTERISTICS.SMPTE2084, 'still PQ');
});

QUnit.test('SDR metadata and bytes are unchanged when HDR is enabled', async function(assert) {
  const {initSegment} = await transmux(sdrSegment());
  const disabled = processHdrInitSegment(initSegment);
  const enabled = processHdrInitSegment(initSegment, DEFAULT_HDR_CONFIG);

  assert.strictEqual(enabled.initSegment, initSegment, 'SDR init segment is not rewritten');
  assert.strictEqual(disabled.initSegment, initSegment, 'disabled path returns input');
  assert.equal(enabled.metadata.hdrType, 'sdr', 'detected SDR');
  assert.equal(enabled.metadata.transfer, TRANSFER_CHARACTERISTICS.BT709, 'BT.709 transfer');
  assert.equal(enabled.metadata.bitDepth, 8, '8-bit SDR remains valid');
});

QUnit.test('rejects HDR below the configured bit depth', function(assert) {
  const result = validateHdrMetadata({
    hdrType: 'hdr10',
    hdr: true,
    primaries: COLOR_PRIMARIES.BT2020,
    transfer: TRANSFER_CHARACTERISTICS.SMPTE2084,
    matrix: 9,
    bitDepth: 8,
    issues: []
  }, DEFAULT_HDR_CONFIG);

  assert.equal(result.action, 'reject', 'rejected');
  assert.equal(result.error.code, HDR_ERROR_CODES.UNSUPPORTED_BIT_DEPTH, 'bit depth error');
  assert.ok(
    result.error.message.includes('10-bit'),
    'message identifies the 10-bit requirement'
  );
  assert.equal(result.error.metadata.stage, 'transmux.hdr.bit-depth', 'names the failing stage');
});

QUnit.test('missing metadata defaults to SDR with a warning and never guesses', function(assert) {
  const result = validateHdrMetadata(null, DEFAULT_HDR_CONFIG);

  assert.equal(result.action, 'pass', 'legacy SDR path continues');
  assert.equal(result.kind, 'sdr', 'treated as SDR');
  assert.equal(result.metadata, null, 'no metadata was invented');
  assert.ok(result.warnings.length, 'warning recorded');
});

QUnit.test('missing metadata can be configured as a rejection', function(assert) {
  const result = validateHdrMetadata(null, {
    missingMetadata: 'reject'
  });

  assert.equal(result.action, 'reject', 'rejected');
  assert.equal(result.error.code, HDR_ERROR_CODES.MISSING_METADATA, 'missing metadata error');
});

QUnit.test('rejects conflicting color metadata instead of guessing', function(assert) {
  const result = validateHdrMetadata({
    hdrType: 'hdr10',
    hdr: true,
    primaries: COLOR_PRIMARIES.BT2020,
    transfer: TRANSFER_CHARACTERISTICS.SMPTE2084,
    matrix: 9,
    bitDepth: 10,
    issues: [{field: 'transfer', values: [16, 18]}]
  }, DEFAULT_HDR_CONFIG);

  assert.equal(result.action, 'reject', 'rejected');
  assert.equal(
    result.error.code,
    HDR_ERROR_CODES.CONFLICTING_METADATA,
    'reports conflicting metadata'
  );
  assert.equal(result.error.metadata.stage, 'transmux.hdr.metadata', 'names the metadata stage');
});

QUnit.test('rejects an unsupported HDR color space with an actionable stage', function(assert) {
  const result = validateHdrMetadata({
    hdrType: 'invalid',
    hdr: false,
    primaries: COLOR_PRIMARIES.BT709,
    transfer: TRANSFER_CHARACTERISTICS.SMPTE2084,
    matrix: 9,
    bitDepth: 10,
    issues: []
  }, DEFAULT_HDR_CONFIG);

  assert.equal(result.action, 'reject', 'rejected');
  assert.equal(
    result.error.code,
    HDR_ERROR_CODES.UNSUPPORTED_COLOR_SPACE,
    'reports unsupported color space'
  );
  assert.equal(
    result.error.metadata.stage,
    'transmux.hdr.color-space',
    'identifies the color-space stage'
  );
});

QUnit.test('rejects unsupported software tone mapping', function(assert) {
  const result = validateHdrMetadata({
    hdrType: 'hlg',
    hdr: true,
    primaries: COLOR_PRIMARIES.BT2020,
    transfer: TRANSFER_CHARACTERISTICS.ARIB_STD_B67,
    matrix: 9,
    bitDepth: 10,
    issues: []
  }, {
    toneMapping: {
      strategy: 'sdr'
    }
  });

  assert.equal(result.action, 'reject', 'rejected');
  assert.equal(
    result.error.code,
    HDR_ERROR_CODES.UNSUPPORTED_TONE_MAPPING,
    'reports unsupported tone mapping'
  );
  assert.equal(
    result.error.metadata.stage,
    'transmux.hdr.tone-mapping',
    'identifies the tone-mapping stage'
  );
});

QUnit.test(
  'rendition switches retain the HDR marker when the next segment omits metadata',
  function(assert) {
    const previous = {
      hdr: true,
      hdrType: 'hdr10',
      primaries: COLOR_PRIMARIES.BT2020,
      transfer: TRANSFER_CHARACTERISTICS.SMPTE2084
    };
    const result = reconcileHdrMetadata(previous, null, DEFAULT_HDR_CONFIG);

    assert.equal(result.error, null, 'no error');
    assert.equal(result.metadata.hdrType, 'hdr10', 'kept HDR10');
    assert.ok(result.metadata.carriedForward, 'marked as carried forward');
    assert.ok(result.warnings.length, 'warns about the missing rendition metadata');
  }
);

QUnit.test('rejects an explicit HDR to SDR rendition switch', function(assert) {
  const previous = {
    hdr: true,
    hdrType: 'hlg',
    primaries: COLOR_PRIMARIES.BT2020,
    transfer: TRANSFER_CHARACTERISTICS.ARIB_STD_B67
  };
  const result = reconcileHdrMetadata(previous, {
    hdr: false,
    hdrType: 'sdr',
    primaries: COLOR_PRIMARIES.BT709,
    transfer: TRANSFER_CHARACTERISTICS.BT709
  }, DEFAULT_HDR_CONFIG);

  assert.equal(result.error.code, HDR_ERROR_CODES.MIDSTREAM_SWITCH, 'switch rejected');
  assert.equal(
    result.error.metadata.stage,
    'segment-loader.hdr.rendition-switch',
    'identifies the session switch stage'
  );
});

QUnit.test('normalizes new options without changing existing defaults', function(assert) {
  const config = normalizeHdrConfig();

  assert.equal(config.enabled, true, 'HDR detection enabled by default');
  assert.equal(config.missingMetadata, 'sdr', 'missing metadata remains SDR');
  assert.equal(config.conflictPolicy, 'reject', 'conflicts are rejected');
  assert.equal(config.minimumBitDepth, 10, '10-bit minimum');
  assert.equal(config.toneMapping.strategy, 'browser', 'display mapping by default');
});
