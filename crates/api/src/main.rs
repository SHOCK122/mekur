//! The API server binary: `mekur-api` serves; `mekur-api healthcheck` asks a
//! running server's `/health` (for the container's `HEALTHCHECK`, since the
//! runtime image has no curl).

use std::{process::ExitCode, time::Duration};

use mekur_api::{
    AppState, build_app,
    config::Config,
    db::{create_pool, run_migrations},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::FAILURE;
        }
    };
    let result = match std::env::args().nth(1).as_deref() {
        None => serve(config).await,
        Some("healthcheck") => healthcheck(&config.host, config.port).await,
        Some(other) => Err(format!(
            "unknown command {other:?} (expected none, or \"healthcheck\")"
        )),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: Config) -> Result<(), String> {
    let db = create_pool(&config.database_url).map_err(|e| e.to_string())?;
    let applied = run_migrations(&db).await.map_err(|e| e.to_string())?;
    if !applied.is_empty() {
        println!("Applied migrations: {}", applied.join(", "));
    }

    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|e| format!("listen on {}:{}: {e}", config.host, config.port))?;
    println!("API listening on http://{}:{}", config.host, config.port);
    axum::serve(listener, build_app(AppState { db }))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| e.to_string())
}

/// Ctrl+C, or SIGTERM from `docker stop`: finish in-flight requests, then exit.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

/// Succeeds if `GET /health` on this machine answers 200 within 3 seconds.
/// Asks the address the server listens on (`HOST`), or loopback when it
/// listens on every interface.
async fn healthcheck(host: &str, port: u16) -> Result<(), String> {
    let host = match host {
        "0.0.0.0" => "127.0.0.1",
        "::" | "[::]" => "::1",
        other => other,
    };
    let check = async {
        let mut stream = TcpStream::connect((host, port)).await?;
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await?;
        let mut status_line = [0u8; 12];
        stream.read_exact(&mut status_line).await?;
        Ok::<_, std::io::Error>(status_line)
    };
    match tokio::time::timeout(Duration::from_secs(3), check).await {
        Ok(Ok(status)) if &status == b"HTTP/1.1 200" => Ok(()),
        Ok(Ok(status)) => Err(format!("unhealthy: {}", String::from_utf8_lossy(&status))),
        Ok(Err(err)) => Err(format!("unhealthy: {err}")),
        Err(_) => Err("unhealthy: no answer within 3s".to_owned()),
    }
}
