//! mekur's browser client logic, compiled to WebAssembly.
//!
//! Takes over from `apps/web/src/lib` module by module (fractional ranks,
//! zoned time, recurrence, timeline geometry, then the network and crypto
//! call sites), exposed to the React app through wasm-bindgen until the
//! UI itself is ported. All decryption happens here, in the browser.
//! Nothing is ported yet; see `docs/RUST_MIGRATION.md`.
