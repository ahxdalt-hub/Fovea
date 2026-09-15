//! Native services.
//!
//! Services hold the real logic. Commands are thin wrappers that validate
//! input, call a service, and map failures to `AppError`. Future services
//! (hardware detection, licensing) are added as sibling modules here —
//! the command layer and UI never change shape.

pub mod import;
pub mod inference;
pub mod system;
