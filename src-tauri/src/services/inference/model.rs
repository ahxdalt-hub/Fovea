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
    /// The user-facing enhancement behavior this model provides. None for
    /// models not wired to a visible mode.
    pub mode: Option<EnhanceMode>,
}

/// The enhancement modes the UI may offer. Each one must change the pixels
/// it produces (Stage 06 rule: every visible option has a real effect, or
/// it doesn't exist):
/// - **Standard** — Real-ESRGAN general: reconstructs texture/detail.
/// - **Natural** — the WDN (wavelet denoise) variant of the same net:
///   genuinely different trained weights; suppresses noise and compression
///   artifacts and keeps the photo's character instead of rebuilding it.
/// - **Detail** — the general model plus the engine's real unsharp pass
///   (`PostPass::Sharpen`): extra local contrast on flat reconstruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnhanceMode {
    Standard,
    Natural,
    Detail,
}

impl EnhanceMode {
    pub const ALL: [EnhanceMode; 3] = [
        EnhanceMode::Standard,
        EnhanceMode::Natural,
        EnhanceMode::Detail,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Natural => "natural",
            Self::Detail => "detail",
        }
    }

    /// Parse the wire form a command receives (`mode` is untrusted input).
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "standard" => Some(Self::Standard),
            "natural" => Some(Self::Natural),
            "detail" => Some(Self::Detail),
            _ => None,
        }
    }

    /// The mode's user-facing name (kept identical across the boundary so
    /// labels can never drift).
    pub fn label(self) -> &'static str {
        match self {
            Self::Standard => "Standard",
            Self::Natural => "Natural",
            Self::Detail => "Detail",
        }
    }

    /// One-line description surfaced in the UI — factual about what the
    /// model (or model + pass) does, no marketing.
    pub fn description(self) -> &'static str {
        match self {
            Self::Standard => "Reconstructs detail — best for clean photos",
            Self::Natural => "Denoise-first — calmer, keeps the original grain",
            Self::Detail => "Standard plus a real sharpening pass — crisp edges",
        }
    }

    /// Which model-backed mode actually provides the model for this mode.
    /// (Detail shares the general model; the difference is the post-pass.)
    pub fn model_backing(self) -> EnhanceMode {
        match self {
            Self::Detail => Self::Standard,
            other => other,
        }
    }
}

/// The known model set (Stage 06):
/// - `realesr-general-x4v3` — Real-ESRGAN's general-purpose 4× upscaler
///   (BSD-3-Clause, commercially redistributable; xinntao/Real-ESRGAN).
/// - `realesr-general-wdn-x4v3` — the WDN denoising variant of the same
///   architecture: same graph, different trained weights; upstream
///   recommends it for noisy/compressed photos (officially *blended* with
///   the general model — Pixora exposes the two pure behaviors instead of
///   a fake blend knob).
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "realesrgan-general-4x",
        file_name: "realesr-general-x4v3.onnx",
        label: "Real-ESRGAN general",
        scale: 4,
        size_bytes: 4_871_181,
        sha256: "09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4",
        mode: Some(EnhanceMode::Standard),
    },
    ModelSpec {
        id: "realesrgan-general-wdn-4x",
        file_name: "realesr-general-wdn-x4v3.onnx",
        label: "Real-ESRGAN WDN",
        scale: 4,
        size_bytes: 4_866_499,
        sha256: "7132e99f7bc09342e31cfee9276cb4c77b6d94d0ed2acc2c9586398b334d4792",
        mode: Some(EnhanceMode::Natural),
    },
];

/// Product upscale factors genuinely deliverable from a model with native
/// `scale`: the native factor itself, plus half of it when even (the 2×
/// path runs the model at full factor and box-downsamples the AI output —
/// a real two-stage pipeline, not a relabel). 1× is never a product option
/// (there would be nothing to enhance). Later factors follow the same
/// rule.
pub fn product_scales_for(model_scale: usize) -> Vec<usize> {
    let mut scales = Vec::new();
    if model_scale >= 4 && model_scale % 2 == 0 {
        scales.push(model_scale / 2);
    }
    scales.push(model_scale.max(2));
    scales
}

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
    /// The enhancement mode this model backs ("standard" | "natural"),
    /// or null for models not wired to a visible mode.
    pub mode: &'static str,
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

    /// Every known model spec (for surfaces that explain *which* model a
    /// mode maps to — status, error detail).
    pub fn specs(&self) -> &[ModelSpec] {
        &self.specs
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
    /// Production resolves by mode (`ready_model_for_mode`); this lookup
    /// by id serves status/diagnostic paths and tests.
    #[allow(
        dead_code,
        reason = "diagnostic id-lookup kept beside the mode-based production path"
    )]
    pub fn ready_model(&self, id: &str) -> Option<(ModelSpec, PathBuf)> {
        let spec = *self.specs.iter().find(|m| m.id == id)?;
        match self.locate(&spec) {
            ModelState::Ready { path } => Some((spec, path)),
            _ => None,
        }
    }

    /// The first ready model providing `mode` (Stage 06: the UI selects a
    /// mode, not a file — the registry answers which model backs it).
    /// Detail runs on the model behind its `model_backing`; the sharpening
    /// pass is the service's job.
    pub fn ready_model_for_mode(&self, mode: EnhanceMode) -> Option<(ModelSpec, PathBuf)> {
        let backed = mode.model_backing();
        for spec in self.specs.iter().filter(|m| m.mode == Some(backed)) {
            if let ModelState::Ready { path } = self.locate(spec) {
                return Some((*spec, path));
            }
        }
        None
    }

    /// Whether the model backing `mode` is installed and valid.
    pub fn mode_available(&self, mode: EnhanceMode) -> bool {
        self.ready_model_for_mode(mode).is_some()
    }

    /// Product upscale factors the installed models can genuinely deliver
    /// (sorted, deduplicated). Empty when no model is ready — the UI then
    /// shows no scale control rather than options that would fail.
    pub fn available_scales(&self) -> Vec<usize> {
        let mut scales: Vec<usize> = self
            .specs
            .iter()
            .filter(|m| m.mode.is_some())
            .filter(|spec| matches!(self.locate(spec), ModelState::Ready { .. }))
            .flat_map(|spec| product_scales_for(spec.scale))
            .collect();
        scales.sort_unstable();
        scales.dedup();
        scales
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
                    mode: spec.mode.map(|m| m.key()).unwrap_or("none"),
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
            mode: None,
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
            mode: None,
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
            mode: None,
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
        assert!(json.contains("realesrgan-general-wdn-4x"));
        assert!(json.contains("\"mode\":\"standard\""));
        assert!(json.contains("\"mode\":\"natural\""));
    }

    #[test]
    fn modes_map_to_distinct_ready_models() {
        let dir = temp_dir("modes");
        // Two fake model files with matching size + hash — one per mode.
        let good = onnx_bytes();
        let other = vec![0x08, 0x41, 0x09, 0x10];
        std::fs::write(dir.join("std.onnx"), &good).expect("write std");
        std::fs::write(dir.join("nat.onnx"), &other).expect("write nat");
        let specs = vec![
            ModelSpec {
                id: "std",
                file_name: "std.onnx",
                label: "std",
                scale: 4,
                size_bytes: good.len() as u64,
                sha256: sha256_hex(&good),
                mode: Some(EnhanceMode::Standard),
            },
            ModelSpec {
                id: "nat",
                file_name: "nat.onnx",
                label: "nat",
                scale: 4,
                size_bytes: other.len() as u64,
                sha256: sha256_hex(&other),
                mode: Some(EnhanceMode::Natural),
            },
        ];
        let reg = ModelRegistry::with_specs(vec![dir], specs);
        let (s, _) = reg
            .ready_model_for_mode(EnhanceMode::Standard)
            .expect("std");
        assert_eq!(s.id, "std");
        let (n, _) = reg.ready_model_for_mode(EnhanceMode::Natural).expect("nat");
        assert_eq!(n.id, "nat");
        assert!(reg.mode_available(EnhanceMode::Standard));
        assert!(reg.mode_available(EnhanceMode::Natural));
        // Both 4× models → scales {2, 4} once, deduped.
        assert_eq!(reg.available_scales(), vec![2, 4]);
    }

    #[test]
    fn unavailable_mode_reports_false_and_offers_no_scales() {
        let reg = ModelRegistry::new(vec![temp_dir("no-modes")]);
        assert!(!reg.mode_available(EnhanceMode::Standard));
        assert!(!reg.mode_available(EnhanceMode::Natural));
        assert!(reg.ready_model_for_mode(EnhanceMode::Standard).is_none());
        assert!(reg.available_scales().is_empty());
    }

    #[test]
    fn product_scales_follow_model_scale_rule() {
        assert_eq!(product_scales_for(4), vec![2, 4]);
        // A native 2× model offers 2× only — halving would reach 1×, which
        // is not enhancement.
        assert_eq!(product_scales_for(2), vec![2]);
        // Odd native factors deliver only themselves.
        assert_eq!(product_scales_for(3), vec![3]);
    }

    #[test]
    fn bundled_model_files_match_their_specs() {
        // The repo copies of the models are the ground truth the registry
        // claims (one per enhancement mode).
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("models");
        let reg = ModelRegistry::new(vec![manifest.clone()]);
        for spec in MODELS {
            let path = manifest.join(spec.file_name);
            if !path.is_file() {
                // Only when models/ genuinely absent (e.g. trimmed checkout).
                continue;
            }
            assert_eq!(
                reg.locate_by_id(spec.id),
                ModelState::Ready { path },
                "bundled model {} must hash-match its registry spec",
                spec.id
            );
        }
        // Both bundled models are ready from the manifest dir → the product
        // offers 2× and 4× in both modes.
        assert_eq!(reg.available_scales(), vec![2, 4]);
        assert!(reg.mode_available(EnhanceMode::Standard));
        assert!(reg.mode_available(EnhanceMode::Natural));
    }
}
