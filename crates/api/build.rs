//! Embeds the SQL migrations into the binary, in the order the TS runner
//! applies them (file names sorted). They are read from
//! `apps/api/src/db/migrations` -- the same files the TS server runs --
//! until step 3g of docs/RUST_MIGRATION.md moves them into this crate.

use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("set by cargo"));
    let dir = manifest_dir.join("../../apps/api/src/db/migrations");
    println!("cargo::rerun-if-changed={}", dir.display());

    let mut files: Vec<(String, PathBuf)> = fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("reading migrations from {}: {err}", dir.display()))
        .map(|entry| entry.expect("readable directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .expect("migration file names are UTF-8")
                .to_owned();
            let path = path.canonicalize().expect("migration path resolves");
            (name, path)
        })
        .collect();
    // Byte order, as JavaScript's default `.sort()` gives for ASCII names.
    files.sort();

    let mut out = String::from("&[\n");
    for (name, path) in &files {
        out.push_str(&format!(
            "    ({name:?}, include_str!({:?})),\n",
            path.display().to_string()
        ));
    }
    out.push(']');

    let dest = PathBuf::from(env::var_os("OUT_DIR").expect("set by cargo")).join("migrations.rs");
    fs::write(dest, out).expect("write generated migration list");
}
