import { strict as assert } from 'node:assert';

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const METADATA_VERSION = /^\/\/ @version\s+(\S+)\s*$/gm;
const METADATA_VERSION_SINGLE = /^\/\/ @version\s+(\S+)\s*$/m;
const RUNTIME_FALLBACK = /const\s+SCRIPT_VERSION\s*=\s*\(\s*typeof\s+GM_info\s*!==\s*["']undefined["']\s*&&\s*GM_info\?\.script\?\.version\s*\)\s*\|\|\s*["']([^"']+)["']\s*;/g;

const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

export function readUserscriptVersionFields(source) {
  const metadataMatches = [...source.matchAll(METADATA_VERSION)];
  assert.equal(metadataMatches.length, 1, 'relay.user.js must declare exactly one @version metadata field');

  const runtimeMatches = [...source.matchAll(RUNTIME_FALLBACK)];
  assert.equal(runtimeMatches.length, 1, 'relay.user.js must declare exactly one SCRIPT_VERSION runtime fallback');

  const metadataMatch = metadataMatches[0];
  const runtimeMatch = runtimeMatches[0];
  return {
    metadataVersion: metadataMatch[1],
    metadataLine: lineAt(source, metadataMatch.index),
    runtimeFallback: runtimeMatch[1],
    runtimeLine: lineAt(source, runtimeMatch.index + runtimeMatch[0].lastIndexOf(runtimeMatch[1])),
  };
}

export function assertIndependentVersionSources(expectedSource, observedSource) {
  assert.notEqual(
    expectedSource,
    observedSource,
    `version oracle must compare independent sources; both refer to ${expectedSource}`,
  );
}

export function assertUserscriptVersionContract(source, { expectedVersion } = {}) {
  const fields = readUserscriptVersionFields(source);
  const metadataSource = 'relay.user.js @version metadata';
  const runtimeSource = 'relay.user.js SCRIPT_VERSION runtime fallback';
  assertIndependentVersionSources(metadataSource, runtimeSource);
  assert.notEqual(fields.metadataLine, fields.runtimeLine, 'metadata and runtime fallback must be read from separate source lines');

  assert.match(
    fields.metadataVersion,
    SEMVER,
    `relay.user.js @version metadata at line ${fields.metadataLine} must be plain MAJOR.MINOR.PATCH`,
  );
  assert.match(
    fields.runtimeFallback,
    SEMVER,
    `relay.user.js runtime fallback at line ${fields.runtimeLine} must be plain MAJOR.MINOR.PATCH`,
  );
  assert.equal(
    fields.metadataVersion,
    fields.runtimeFallback,
    `version mismatch: @version metadata at line ${fields.metadataLine} (${fields.metadataVersion}) differs from SCRIPT_VERSION runtime fallback at line ${fields.runtimeLine} (${fields.runtimeFallback})`,
  );

  if (expectedVersion !== undefined) {
    assert.match(expectedVersion, SEMVER, 'independent expected version must be plain MAJOR.MINOR.PATCH');
    assert.equal(
      fields.metadataVersion,
      expectedVersion,
      `independent expected version ${expectedVersion} differs from @version metadata at line ${fields.metadataLine} (${fields.metadataVersion})`,
    );
  }

  return source.match(METADATA_VERSION_SINGLE);
}
