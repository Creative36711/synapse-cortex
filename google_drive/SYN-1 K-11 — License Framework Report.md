# SYN-1 / K-11 — License framework for the core

- Dispatch: `40d6f0cf-5705-81ec-8169-f494e123c9a9`
- Run: `35e2883d-0960-4129-aad2-7c988d2c3816`
- Task card: https://app.notion.com/p/SYN-1-K-11-40d6f0cf570581ec8169f494e123c9a9
- Branch: `arena/280f0677-synapse`
- PR: https://github.com/Creative36711/synapse/pull/7 (merged, squash)
- Scope changed: root `LICENSE`, `NOTICE`, `README.md` only.

## Outcome

The root `LICENSE` now contains the full MIT grant and disclaimer for the Synapse core. `README.md` identifies that scope, explicitly says the core MIT grant permits exporting and distributing games without a separate Synapse-core royalty, and distinguishes game/user materials and third-party terms. `NOTICE` preserves the existing six vendored npm license texts, adds the complete upstream Godot 4.7.2 `COPYRIGHT.txt` inventory, the SwiftShader Apache-2.0 license text, and a separate disclosure for external tools fetched on demand.

**Verification status:** all documentary/inventory commands below passed (`rc=0`). This report does **not** declare an unconditional O-9 legal pass: the `Creative36711` copyright line is a disclosed, reversible provenance-based attribution, not independent evidence of legal ownership or assignment. The reported SwiftShader source package is documented in `AGENTS.md` and its official upstream license was verified, but the npm package was not unpacked here to byte-match the bundled library. These limitations are explicit; no ownership claim is made over third-party materials. The full final SYN-1 suite was not run (it is separate from K-11), and this work does not claim final SYN-1 acceptance.

## Baseline and workflow

Before the first edit, `AGENTS.md` was read and the required Godot check was run. Initial checkout was clean:

- `HEAD`: `6955e341ff1d923900bb0bc736e7658f396b4a9b`
- tree: `db9e6e284874ca25fe455bb7d260248abe8f13fb`
- branch: `arena/280f0677-synapse`

Git history is shallow/grafted. The locally available author is `Creative36711`; the GitHub contributors endpoint returned only `Creative36711` (15 contributions). These are the evidence for the MIT notice attribution, but neither Git author metadata nor a contributor list proves legal ownership/assignment. Correct the holder line if the rights holder supplies contrary evidence. No other files, code, dependencies, examples, schemas, contracts, tests, or decision statuses were changed.

## Dependency/license inventory

### Redistributed or vendored

| Component | Evidence and license | Notice treatment |
|---|---|---|
| Godot Engine 4.7.2 | Installed version `4.7.2.stable.custom_build.ed1daf0bf`; upstream tag commit `ed1daf0bf001b61586d9930840f2f1394092c079`. Upstream Godot license is MIT/Expat. | Full upstream `COPYRIGHT.txt` for the matching commit is reproduced in `NOTICE`; it contains upstream copyright and component-license inventory. It is explicitly identified as the source-tree inventory, so entries for components disabled in a particular build may appear. SHA-256: `cb1980c88089573bcacd7221d777c689bb8bbd778799f24c27fca0fe5f774d6d`. Source: https://github.com/godotengine/godot/blob/4.7.2-stable/COPYRIGHT.txt |
| SwiftShader bundle | Archive hash matches the repository manifest; archive contains `libvulkan.so.1`, `libvk_swiftshader.so`, and `vk_swiftshader_icd.json`. Upstream SwiftShader `LICENSE.txt` is Apache-2.0. | Full upstream license text is in `NOTICE`. License-text SHA-256: `3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5`. The `AGENTS.md` provenance records `@sparticuz/chromium@153.0.0`; npm metadata identifies that package as MIT. The package wrapper itself is not included as a dependency; the bundled component's upstream license is separately stated. |
| `ajv@8.20.0` | Direct devDependency; MIT. Archive and `LICENSE` file checked. | Full package license copied in `NOTICE`. |
| `fast-deep-equal@3.1.3` | Transitive npm package; MIT. Archive and `LICENSE` checked. | Full package license copied in `NOTICE`. |
| `fast-uri@3.1.9` | Transitive npm package; BSD-3-Clause. Archive and `LICENSE` checked. | Full package license copied in `NOTICE`. |
| `json-schema-traverse@1.0.0` | Transitive npm package; MIT. Archive and `LICENSE` checked. | Full package license copied in `NOTICE`. |
| `require-from-string@2.0.2` | Transitive npm package; MIT. Archive and `license` file checked. | Full package license copied in `NOTICE`. |
| `yaml@2.9.1` | Direct devDependency; ISC. Archive and `LICENSE` checked. | Full package license copied in `NOTICE`. |

Each of the six npm license files was extracted from its repository archive and compared against `NOTICE`; every full text was present. All archive checksums passed. This retains the earlier notices and attributions rather than replacing them.

### External tools fetched at setup time (not bundled)

`NOTICE` distinguishes these from redistributed components. The media setup installs unpinned Pillow; PyPI metadata at inventory time (2026-11-03) reported Pillow 13.0.0 and license expression `MIT-CMU`, which is a moving version and must be rechecked for any actual install. The modeling setup defaults to `bpy` 4.5.3, allows an environment override, and PyPI reports `GPL-3.0`; its transitive packages are resolved dynamically. The media script can also use a host-provided ImageMagick `convert` fallback, which is not bundled or version-pinned. These external tool licenses are not claimed to be MIT.

## Reproducible checks

### Godot check (required before any edit)

Command: `tools/godot/install.sh --check > /tmp/k11-godot-check.log 2>&1; rc=$?; cat /tmp/k11-godot-check.log; echo RC=$rc`

Full output:

```text
Installing Godot to /tmp/synapse-godot ...
4.7.2.stable.custom_build.ed1daf0bf

OK. Use:  export PATH="/tmp/synapse-godot/bin:$PATH"   then   godot ...
== import
== run (log: /tmp/synapse-smoke/run.log)
ack: done 1
Godot Engine v4.7.2.stable.custom_build.ed1daf0bf (2026-08-17 01:18:38 UTC) - https://godotengine.org
Vulkan 1.3.0 - Forward+ - Using Device #0: Unknown - SwiftShader Device (Subzero)
Offscreen display server: 640x360, rendering with vulkan.
SMOKE TEST OK -> /tmp/synapse-smoke/shot_1.png, /tmp/synapse-smoke/shot_2.png (check visually: textured cube, sky, text; cube rotated in shot_2)
RC=0
```

### License documents, vendored npm text, archive and diff checks

- Content assertions: `LICENSE` has the full standard MIT grant/disclaimer; `README.md` contains the core-MIT/export/no-royalty and third-party-boundary text; `NOTICE` contains the Godot inventory, SwiftShader Apache license, external-tool disclosures, and all six archive-extracted npm license texts. **Output: all assertions passed, `DOC_AND_NOTICE_RC=0`.**
- Command: `(cd vendor && sha256sum -c SHA256SUMS)` — all six npm archives `OK`; `NPM_SHA256_RC=0`.
- Command: `(cd tools/godot/dist && grep -v '^#\\|godot (uncompressed)' SHA256SUMS | sha256sum -c)` — Godot archive parts and SwiftShader archive `OK`; `GODOT_BUNDLE_SHA256_RC=0`.
- Command: `sha256sum /tmp/synapse-godot/godot.bin` compared with the `godot (uncompressed)` entry in `tools/godot/dist/SHA256SUMS` — both `9769392ea210a6a517722f72f8109442d0c5739e95b3d72b72a1f88dbc8c4b9b`; `GODOT_UNCOMPRESSED_COMPARE_RC=0`.
- Command: `git diff --check` — no output; `GIT_DIFF_CHECK_RC=0`.

Full captured audit output follows:

```text
=== K-11 license/document checks ===
LICENSE: full MIT grant/disclaimer present; copyright attribution recorded
README: core MIT, game export/no royalty for core, third-party boundary and NOTICE link present
NOTICE: Godot upstream inventory and SwiftShader Apache-2.0 text reproduced; external tooling versions/limits disclosed
  ajv-8.20.0.tgz: LICENSE present in NOTICE
  fast-deep-equal-3.1.3.tgz: LICENSE present in NOTICE
  fast-uri-3.1.9.tgz: LICENSE present in NOTICE
  json-schema-traverse-1.0.0.tgz: LICENSE present in NOTICE
  require-from-string-2.0.2.tgz: license present in NOTICE
  yaml-2.9.1.tgz: LICENSE present in NOTICE
ALL_ARCHIVED_LICENSE_TEXTS_PRESENT=YES
DOC_AND_NOTICE_RC=0

=== npm archive checks ===
npm/json-schema-traverse-1.0.0.tgz: OK
npm/yaml-2.9.1.tgz: OK
npm/fast-uri-3.1.9.tgz: OK
npm/fast-deep-equal-3.1.3.tgz: OK
npm/ajv-8.20.0.tgz: OK
npm/require-from-string-2.0.2.tgz: OK
NPM_SHA256_RC=0

=== Godot / SwiftShader archive checks ===
godot-linux-x86_64.xz.part-00: OK
godot-linux-x86_64.xz.part-01: OK
swiftshader-linux-x86_64.tar.xz: OK
GODOT_BUNDLE_SHA256_RC=0
9769392ea210a6a517722f72f8109442d0c5739e95b3d72b72a1f88dbc8c4b9b  /tmp/synapse-godot/godot.bin
9769392ea210a6a517722f72f8109442d0c5739e95b3d72b72a1f88dbc8c4b9b  godot (uncompressed)
GODOT_UNCOMPRESSED_COMPARE_RC=0

=== diff whitespace check ===
GIT_DIFF_CHECK_RC=0

=== scope and baseline identity ===
arena/280f0677-synapse
6955e341ff1d923900bb0bc736e7658f396b4a9b
db9e6e284874ca25fe455bb7d260248abe8f13fb
 M NOTICE
 M README.md
?? LICENSE

AUDIT_CAPTURE_RC=0
```

At merge verification, the tested PR head and squash-merge tree were identical: PR head `61cae1ba93b8da4aef5519b0f9f897d098c2599c`, merge commit `0b680a38188c55d07dca0b9d88843972880cf7f5`, both tree `81b955fcb784b6c4af003336c2acae8520ae18e8`. `git diff --check 0b680a38188c55d07dca0b9d88843972880cf7f5^ 0b680a38188c55d07dca0b9d88843972880cf7f5` produced no output (rc=0). No repeat of the other checks was needed because the trees matched.

## Merge result

- PR #7: https://github.com/Creative36711/synapse/pull/7 — `MERGED` by squash.
- Verified merge SHA: `0b680a38188c55d07dca0b9d88843972880cf7f5`
- Verified merge tree: `81b955fcb784b6c4af003336c2acae8520ae18e8`
- PR head SHA/tree: `61cae1ba93b8da4aef5519b0f9f897d098c2599c` / `81b955fcb784b6c4af003336c2acae8520ae18e8`
- Final merge diff check: rc=0; changed paths: `LICENSE`, `NOTICE`, `README.md`.
- K-6 and K-15 states/results were not modified. Full final SYN-1 suite remains separate and unrun.
