//! VCP Hi-Fi Audio Engine - Library Root
//!
//! This module exposes the audio engine as a library for direct Rust integration
//! or communication with the JS frontend via the server module.

pub mod decoder;
pub mod player;
pub mod processor;
pub mod server;
pub mod config;

// Re-exports for convenience
pub use decoder::StreamingDecoder;
pub use player::{AudioPlayer, PlayerState, AudioDeviceInfo};
pub use processor::{Resampler, Equalizer, VolumeController, NoiseShaper, SpectrumAnalyzer, FFTConvolver};

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// Note: Python bindings have been removed as the engine now communicates 
// directly with the JS frontend via WebSocket/HTTP.