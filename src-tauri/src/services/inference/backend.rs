//! Inference backend abstraction — the replaceable runtime seam.
//!
//! The product rule ("the inference engine is a replaceable service")
//! lands here: everything above this file talks to the [`Backend`] trait
//! (tile in → tile out + a device name). [`OnnxBackend`] is the Stage 05
//! implementation on ONNX Runtime via `ort`, preferring the DirectML GPU
//! execution provider and falling back to CPU. A future CUDA/TensorRT or
//! fully separate runtime swaps in here without touching the pipeline,
//! the service, the commands, or the UI.
//!
//! Cancellation: [`CancelToken`] carries an AtomicBool checked at tile
//! boundaries *plus* an optional terminate closure the runtime registers
//! per in-flight tile — ONNX Runtime's `RunOptions::terminate` aborts a
//! running inference promptly. The token lives in the service, so a cancel
//! command from the UI reaches a job on the worker thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// One inferred tile: planar CHW float in [0,1].
#[derive(Debug, Clone)]
pub struct TileOutput {
    pub width: usize,
    pub height: usize,
    /// length == 3 * width * height, channel-major (c*h*w + y*w + x)
    pub data: Vec<f32>,
}

/// Runtime-level failures, mapped to `AppError` by the service layer.
#[derive(Debug, Clone)]
pub enum EngineError {
    /// The user asked to stop; nothing is corrupted, just stop.
    Cancelled,
    /// The runtime could not run this tile (bad model, EP fault, bug).
    Failed(String),
    /// The runtime could not allocate for this tile/size.
    OutOfMemory(String),
}

impl EngineError {
    fn is_oom(text: &str) -> bool {
        let t = text.to_ascii_lowercase();
        t.contains("out of memory")
            || t.contains("insufficient")
            || t.contains("allocation")
            || t.contains("failed to allocate")
            || t.contains("d3d")
            || t.contains("device removed")
    }
}

/// Cooperative + hard cancellation handle shared between the UI thread
/// (which calls `cancel`) and the worker (which checks / registers).
#[derive(Default)]
pub struct CancelToken {
    flag: AtomicBool,
    terminate_run: Mutex<Option<Arc<dyn Fn() + Send + Sync + 'static>>>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Flag cancellation and abort the in-flight runtime operation (if
    /// any). Safe to call multiple times and after completion.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        let cb = self.terminate_run.lock().ok().and_then(|g| g.clone());
        if let Some(cb) = cb {
            cb();
        }
    }

    fn begin_run(&self, terminate: impl Fn() + Send + Sync + 'static) {
        if let Ok(mut guard) = self.terminate_run.lock() {
            *guard = Some(Arc::new(terminate));
        }
    }

    fn end_run(&self) {
        if let Ok(mut guard) = self.terminate_run.lock() {
            *guard = None;
        }
    }
}

/// The replaceable engine seam. Implementations must be Send; a single
/// session is serialized behind a mutex by the service, so `run_tile`
/// takes `&mut self` for exclusive use.
pub trait Backend: Send {
    /// Human-readable device/EP for status surfaces ("DirectML GPU",
    /// "CPU"). Purely informational — the UI never branches on it.
    fn device_name(&self) -> &'static str;

    /// Infer one tile. `chw` must be exactly 3*h*w planar floats in
    /// [0,1]; the output is 3*(h*scale)*(w*scale) for the model's scale.
    fn run_tile(
        &mut self,
        chw: Vec<f32>,
        width: usize,
        height: usize,
        cancel: &CancelToken,
    ) -> Result<TileOutput, EngineError>;
}

/// ONNX Runtime backend (`ort`) with DirectML preference and CPU fallback.
///
/// Telemetry is disabled at environment init — ONNX Runtime ships ETW
/// telemetry enabled by default on Windows, and Pixora's privacy promise
/// requires it off.
pub struct OnnxBackend {
    session: ort::session::Session,
    device: &'static str,
}

/// One-time, process-global runtime configuration. Called before any
/// session or EP probe so telemetry is off for the whole process lifetime.
pub(crate) fn init_environment() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        // `false` return means another environment was already committed
        // (never happens in this app; ort's default env would apply).
        let _ok = ort::init().with_telemetry(false).commit();
    });
}

impl OnnxBackend {
    /// Load a validated model file. Tries the DirectML GPU EP first and
    /// falls back to CPU when it is unavailable (old drivers, no DX12
    /// adapter, EP missing from the binary).
    pub fn load(model_path: &std::path::Path) -> Result<Self, EngineError> {
        init_environment();
        let build = |dml: bool| -> Result<ort::session::Session, ort::Error> {
            let mut builder = ort::session::Session::builder()?;
            if dml {
                builder =
                    builder.with_execution_providers([ort::ep::DirectML::default().build()])?;
            }
            let session = builder.commit_from_file(model_path)?;
            // The Stage 05 models are single-input; assert early with a
            // clear internal message instead of failing at first tile.
            if session.inputs().is_empty() || session.outputs().is_empty() {
                return Err(ort::Error::new("model exposes no input/output tensors"));
            }
            Ok(session)
        };
        match build(true) {
            Ok(session) => Ok(OnnxBackend {
                session,
                device: "DirectML GPU",
            }),
            Err(dml_err) => {
                log::info!("DirectML unavailable for inference, falling back to CPU: {dml_err}");
                match build(false) {
                    Ok(session) => Ok(OnnxBackend {
                        session,
                        device: "CPU",
                    }),
                    Err(cpu_err) => Err(EngineError::Failed(format!(
                        "session load failed (dml: {dml_err}; cpu: {cpu_err})"
                    ))),
                }
            }
        }
    }
}

impl Backend for OnnxBackend {
    fn device_name(&self) -> &'static str {
        self.device
    }

    fn run_tile(
        &mut self,
        chw: Vec<f32>,
        width: usize,
        height: usize,
        cancel: &CancelToken,
    ) -> Result<TileOutput, EngineError> {
        if cancel.is_cancelled() {
            return Err(EngineError::Cancelled);
        }
        use ort::session::RunOptions;
        use ort::value::Tensor;

        let input = Tensor::from_array(([1usize, 3, height, width], chw.into_boxed_slice()))
            .map_err(|e| EngineError::Failed(format!("tensor build: {e}")))?;
        let run_options = Arc::new(
            RunOptions::new().map_err(|e| EngineError::Failed(format!("run options: {e}")))?,
        );
        cancel.begin_run({
            let ro = Arc::clone(&run_options);
            move || {
                let _ = ro.terminate();
            }
        });
        let result = self
            .session
            .run_with_options(ort::inputs![&input], &*run_options);
        cancel.end_run();
        let outputs = match result {
            Ok(o) => o,
            Err(err) => {
                let text = err.to_string();
                if cancel.is_cancelled() || text.contains("terminate flag") {
                    return Err(EngineError::Cancelled);
                }
                if EngineError::is_oom(&text) {
                    return Err(EngineError::OutOfMemory(text));
                }
                return Err(EngineError::Failed(text));
            }
        };
        let (shape, buf) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| EngineError::Failed(format!("output extract: {e}")))?;
        let dims: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
        if dims.len() != 4 || dims[0] != 1 || dims[1] != 3 {
            return Err(EngineError::Failed(format!(
                "unexpected output shape {dims:?}"
            )));
        }
        let (oh, ow) = (dims[2], dims[3]);
        if buf.len() != 3 * oh * ow {
            return Err(EngineError::Failed(format!(
                "output buffer {} != 3*{oh}*{ow}",
                buf.len()
            )));
        }
        Ok(TileOutput {
            width: ow,
            height: oh,
            data: buf.to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_token_flags_and_fires_callback_once_registered() {
        let token = CancelToken::new();
        // Cancel before any run is registered: just flags.
        token.cancel();
        assert!(token.is_cancelled());
        let fired = Arc::new(AtomicBool::new(false));
        token.begin_run({
            let f = Arc::clone(&fired);
            move || {
                f.store(true, Ordering::SeqCst);
            }
        });
        token.cancel();
        assert!(fired.load(Ordering::SeqCst));
        token.end_run();
        // After the run ends, cancel still flags but has no callback.
        token.cancel();
    }

    #[test]
    fn oom_heuristic_catches_runtime_wording() {
        assert!(EngineError::is_oom("DML: out of memory"));
        assert!(EngineError::is_oom("Failed to allocate 4 GB"));
        assert!(!EngineError::is_oom("invalid graph node"));
    }
}
