//! Native services.
//!
//! Services hold the real logic. Commands are thin wrappers that validate
//! input, call a service, and map failures to `AppError`. Future services
//! (licensing, batch queue) are added as sibling modules here — the
//! command layer and UI never change shape.

pub mod batch;
pub mod export;
pub mod hardware;
pub mod history;
pub mod import;
pub mod inference;
pub mod system;
