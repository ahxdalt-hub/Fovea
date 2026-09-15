//! Model registry + manager (Stage 05).
//!
//! The single owner of "where models live and whether they are usable".
//! No other module in the codebase hard-codes a model path: callers ask
//! [`ModelRegistry`] for a ready model and get either a validated path or
//! a precise [`ModelState`] (missing / corrupt) they can surface to the UI.
//!
//! Validation ladder per model, in order:
//! 1. locate — walk the search dirs in priority order (env override first,
//!    then bundled resources, then the user-editable app-data folder).
//! 2. size — exact expected byte count (cheap, catches truncated copies).
//! 3. SHA-256 — full content integrity (catches tampering/substitution).
//! 4. structure — the ONNX magic header; the authoritative parse happens
//!    when ONNX Runtime loads the graph during the first enhance job.
//!
//! The bundled model ships under `src-tauri/models/` (declared in
//! `tauri.conf.json` `bundle.resources`). Its license (BSD-3-Clause,
//! Real-ESRGAN upstream) is redistributed next to it.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// One known enhancement model. Adding a model means adding a spec here —
/// nowhere else in the codebase.
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    /// Stable machine id (also the UI's selection key).
    pub id: &'static str,
    /// File name to look for inside every search dir.
    pub file_name: &'static str,
    /// Human label for status surfaces ("Real-ESRGAN general · 4×").
    pub label: &'static str,
    /// Upscale factor the engine applies (verified against model output).
    pub scale: usize,
    /// Exact expected file size in bytes.
    pub size_bytes: u64,
    /// Lowercase hex SHA-256 of the expected file.
    pub sha256: &'static str,
}

/// The Stage 05 model set: Real-ESRGAN's general-purpose 4× upscaler
/// (`realesr-general-x4v3` — BSD-3-Clause, commercially redistributable;
/// same license as xinntao/Real-ESRGAN upstream).
pub const MODELS: &[ModelSpec] = &[ModelSpec {
    id: "realesrgan-general-4x",
    file_name: "realesr-general-x4v3.onnx",
    label: "Real-ESRGAN general",
    scale: 4,
    size_bytes: 4_871_181,
    sha256: "09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4",
}];

/// Where one model currently stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ModelState {
    /// Found, size + hash verified.
    Ready { path: PathBuf },
    /// Not present in any search directory.
    Missing,
    /// Present but wrong size, wrong hash, or not an ONNX file.
    Corrupt { reason: &'static str },
}

/// Serializable status of one known model — what `get_inference_status`
/// ships to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub scale: usize,
    /// "ready" | "missing" | "corrupt" — mirrors [`ModelState`].
    pub state: &'static str,
}

/// Resolves model files across ordered search directories.
///
/// Built once at app setup (see `lib.rs`) with:
/// 1. `PIXORA_MODELS_DIR` env override (dev/QA),
/// 2. the bundled resource `models/` directory,
/// 3. the dev manifest `src-tauri/models` (debug builds only),
/// 4. `<app_data>/models` (user-installable drop location).
///
/// The first directory containing the file wins — an earlier copy
/// deliberately shadows later ones (useful for staged model updates).
/// The shadowing candidate is still fully validated; a corrupt shadow is
/// reported as corrupt, never silently skipped.
pub struct ModelRegistry {
    search_dirs: Vec<PathBuf>,
    specs: Vec<ModelSpec>,
}

impl ModelRegistry {
    /// Production registry over the built-in [`MODELS`] list.
    pub fn new(search_dirs: Vec<PathBuf>) -> Self {
        ModelRegistry {
            search_dirs,
            specs: MODELS.to_vec(),
        }
    }

    /// Test/dev registry with an explicit spec set.
    #[cfg(test)]
    pub fn with_specs(search_dirs: Vec<PathBuf>, specs: Vec<ModelSpec>) -> Self {
        ModelRegistry { search_dirs, specs }
    }

    /// The default model id for single-model workflows (Stage 05): the
    /// first known model. Later stages expose selection in the UI.
    pub fn default_model_id(&self) -> &'static str {
        self.specs.first().map(|s| s.id).unwrap_or(MODELS[0].id)
    }

    /// Directories searched, in priority order (for status/diagnostics).
    pub fn search_dirs(&self) -> &[PathBuf] {
        &self.search_dirs
    }

    /// Locate + validate the model registered under `id`.
    pub fn locate_by_id(&self, id: &str) -> ModelState {
        let Some(spec) = self.specs.iter().find(|m| m.id == id) else {
            return ModelState::Missing;
        };
        self.locate(spec)
    }

    /// Locate + validate one spec across the search dirs. Never panics;
    /// every I/O failure becomes a `Missing`/`Corrupt` verdict so the UI
    /// can explain itself honestly.
    pub fn locate(&self, spec: &ModelSpec) -> ModelState {
        for dir in &self.search_dirs {
            let candidate = dir.join(spec.file_name);
            if !candidate.is_file() {
                continue;
            }
            return validate(&candidate, spec);
        }
        ModelState::Missing
    }

    /// The first ready model matching `id`: (spec, validated path).
    pub fn ready_model(&self, id: &str) -> Option<(ModelSpec, PathBuf)> {
        let spec = *self.specs.iter().find(|m| m.id == id)?;
        match self.locate(&spec) {
            ModelState::Ready { path } => Some((spec, path)),
            _ => None,
        }
    }

    /// Status pass over every known model (runs sha256 on candidates).
    pub fn status(&self) -> Vec<ModelStatus> {
        self.specs
            .iter()
            .map(|spec| {
                let state = match self.locate(spec) {
                    ModelState::Ready { .. } => "ready",
                    ModelState::Missing => "missing",
                    ModelState::Corrupt { .. } => "corrupt",
                };
                ModelStatus {
                    id: spec.id,
                    label: spec.label,
                    scale: spec.scale,
                    state,
                }
            })
            .collect()
    }
}

/// The validation ladder for one candidate file. `Corrupt` (never
/// `Missing`) whenever the file *exists* but fails a check — the
/// distinction the user needs to act on ("re-download it" vs "install
/// it").
fn validate(path: &Path, spec: &ModelSpec) -> ModelState {
    let meta = match std::fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        _ => return ModelState::Missing,
    };
    if meta.len() != spec.size_bytes {
        return ModelState::Corrupt {
            reason: "size differs from the expected model",
        };
    }
    match sha256_of(path) {
        Some(hex) if hex == spec.sha256 => {}
        Some(_) => {
            return ModelState::Corrupt {
                reason: "checksum mismatch",
            };
        }
        None => {
            return ModelState::Corrupt {
                reason: "file unreadable",
            };
        }
    }
    if !has_onnx_magic(path) {
        return ModelState::Corrupt {
            reason: "not an ONNX model file",
        };
    }
    ModelState::Ready {
        path: path.to_path_buf(),
    }
}

/// Streaming SHA-256 (lowercase hex). `None` on any read failure.
fn sha256_of(path: &Path) -> Option<String> {
    use std::io::{BufReader, Read};
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// ONNX protobuf files begin with field 1 (ir_version) — but every valid
/// ONNX file also carries the producer metadata near the end. The
/// cheapest reliable sniff: the first byte is a protobuf field tag
/// (`0x08` = varint field 1) *and* the file parses as protobuf-lite
/// enough for ORT to load it. We check the `0x08` tag plus a non-zero
/// size sanity; the authoritative structural test is ORT's session load
/// (reported as `engine_unavailable` with the graph error logged).
fn has_onnx_magic(path: &Path) -> bool {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut head = [0u8; 1];
    file.read_exact(&mut head).is_ok() && head[0] == 0x08
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha256_hex(bytes: &[u8]) -> &'static str {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            // Leaked to keep ModelSpec's &'static str ergonomic in tests
            // that build throwaway specs. Test-only; bounded by test count.
            .leak()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixora-model-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Plausible ONNX bytes: protobuf field-1 varint tag + payload.
    fn onnx_bytes() -> Vec<u8> {
        let mut b = vec![0x08, 0x40];
        b.extend_from_slice(&[7u8; 32]);
        b
    }

    fn spec_for(name: &'static str, bytes: &[u8]) -> ModelSpec {
        ModelSpec {
            id: "fake",
            file_name: name,
            label: "fake model",
            scale: 2,
            size_bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        }
    }

    #[test]
    fn ready_when_valid() {
        let dir = temp_dir("ready");
        let bytes = onnx_bytes();
        std::fs::write(dir.join("m.onnx"), &bytes).expect("write");
        let spec = spec_for("m.onnx", &bytes);
        let reg = ModelRegistry::with_specs(vec![dir.clone()], vec![spec]);
        assert_eq!(
            reg.locate_by_id("fake"),
            ModelState::Ready {
                path: dir.join("m.onnx")
            }
        );
        let (found, path) = reg.ready_model("fake").expect("ready");
        assert_eq!(found.scale, 2);
        assert_eq!(path, dir.join("m.onnx"));
    }

    #[test]
    fn missing_when_absent_everywhere() {
        let dir = temp_dir("absent");
        let spec = ModelSpec {
            id: "x",
            file_name: "nope.onnx",
            label: "x",
            scale: 2,
            size_bytes: 10,
            sha256: "00",
        };
        let reg = ModelRegistry::with_specs(vec![dir], vec![spec]);
        assert_eq!(reg.locate_by_id("x"), ModelState::Missing);
        assert!(reg.ready_model("x").is_none());
        // Unknown ids are also "missing", never a panic.
        assert_eq!(reg.locate_by_id("who"), ModelState::Missing);
    }

    #[test]
    fn corrupt_on_size_mismatch() {
        let dir = temp_dir("size");
        std::fs::write(dir.join("m.onnx"), onnx_bytes()).expect("write");
        let spec = ModelSpec {
            id: "x",
            file_name: "m.onnx",
            label: "x",
            scale: 2,
            size_bytes: 999_999,
            sha256: "00",
        };
        let reg = ModelRegistry::with_specs(vec![dir], vec![spec]);
        assert!(matches!(reg.locate_by_id("x"), ModelState::Corrupt { .. }));
    }

    #[test]
    fn corrupt_on_hash_mismatch() {
        let dir = temp_dir("hash");
        let bytes = onnx_bytes();
        std::fs::write(dir.join("m.onnx"), &bytes).expect("write");
        let spec = ModelSpec {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            ..spec_for("m.onnx", &bytes)
        };
        let reg = ModelRegistry::with_specs(vec![dir], vec![spec]);
        assert!(matches!(
            reg.locate_by_id("fake"),
            ModelState::Corrupt {
                reason: "checksum mismatch"
            }
        ));
    }

    #[test]
    fn corrupt_on_bad_magic() {
        let dir = temp_dir("magic");
        // Correct size + hash, but not an ONNX protobuf.
        let bytes = b"NOT AN ONNX FILE, WRONG FIRST BYTE!".to_vec();
        std::fs::write(dir.join("m.onnx"), &bytes).expect("write");
        let spec = spec_for("m.onnx", &bytes);
        let reg = ModelRegistry::with_specs(vec![dir], vec![spec]);
        assert!(matches!(
            reg.locate_by_id("fake"),
            ModelState::Corrupt {
                reason: "not an ONNX model file"
            }
        ));
    }

    #[test]
    fn first_search_dir_wins_and_is_not_skipped_when_corrupt() {
        let a = temp_dir("shadow-a");
        let b = temp_dir("shadow-b");
        let good = onnx_bytes();
        let bad = vec![0x08u8, 0x01]; // wrong size + hash: corrupt
        std::fs::write(a.join("m.onnx"), &bad).expect("a");
        std::fs::write(b.join("m.onnx"), &good).expect("b");
        // The spec describes the *good* bytes; the corrupt earlier copy
        // must be reported as corrupt — silently falling back to dir b
        // would hide a tampered install.
        let spec = spec_for("m.onnx", &good);
        let reg = ModelRegistry::with_specs(vec![a, b], vec![spec]);
        assert!(matches!(
            reg.locate_by_id("fake"),
            ModelState::Corrupt { .. }
        ));
    }

    #[test]
    fn status_covers_every_known_model() {
        let reg = ModelRegistry::new(vec![temp_dir("status")]);
        let list = reg.status();
        assert_eq!(list.len(), MODELS.len());
        assert!(list.iter().all(|m| m.state == "missing"));
        let json = serde_json::to_string(&list).expect("serialize");
        assert!(json.contains("realesrgan-general-4x"));
    }

    #[test]
    fn bundled_model_file_matches_its_spec() {
        // The repo copy of the model is the ground truth the spec claims.
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("models");
        let spec = &MODELS[0];
        let path = manifest.join(spec.file_name);
        if !path.is_file() {
            // Only when models/ genuinely absent (e.g. trimmed checkout).
            return;
        }
        let reg = ModelRegistry::new(vec![manifest]);
        assert_eq!(
            reg.locate_by_id(spec.id),
            ModelState::Ready { path },
            "bundled model must hash-match its registry spec"
        );
    }
}
