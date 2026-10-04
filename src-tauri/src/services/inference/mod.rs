//! Local AI inference (Stage 05) — the replacement-ready engine layer.
//!
//! Layout of this module (each file owns exactly one concern):
//!
//! - [`model`]   — the model registry + manager: locating, validating
//!   (size + SHA-256), and reporting missing/corrupt models. Every path
//!   the engine takes to a model file goes through here; no other module
//!   knows where models live.
//! - [`backend`] — the [`Backend`] trait plus the ONNX (ort)
//!   implementation. This is the seam the product rule points at: the
//!   runtime/model can be swapped without touching pipeline, service, or
//!   UI code.
//! - [`engine`]  — the pure image pipeline: preprocess → tiled inference
//!   → postprocess → streamed row output. Generic over [`Backend`] so it
//!   is testable with a fake runtime.
//! - [`finish`]  — the passes that run on model output: the mode's
//!   post-pass and the user's filter at their chosen intensity. Pure
//!   pixel math, so every look is unit-testable without a runtime.
//! - [`service`] — the application-level orchestrator the commands call:
//!   decodes the source, wires progress/cancellation, writes the output
//!   file atomically.
//!
//! Privacy: inference runs entirely in-process on this machine. ONNX
//! Runtime telemetry is explicitly disabled at initialization, and the
//! only network activity ever associated with this feature is the
//! *build-time* download of the MIT-licensed runtime binaries by the
//! `ort` build script. The finished application opens no sockets here.

pub mod backend;
pub mod engine;
pub mod finish;
pub mod model;
pub mod service;

// The command layer consumes this module through `service::` and
// `model::` paths directly — no wildcard re-exports, so "what does the
// engine expose" has one obvious answer.
