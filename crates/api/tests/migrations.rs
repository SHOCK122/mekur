//! Port of `apps/api/test/migrationConcurrency.test.ts`, plus the runner's
//! other guarantees. Each test uses its own database: they drop tables and
//! databases, so they must not touch the one the rest of the suite shares.

mod common;

use common::{database_url, drop_database, recreate_database, with_database};
use mekur_api::db::{MIGRATIONS, MigrationError, create_pool, run_migrations, run_migrations_from};
use sqlx::PgPool;

async fn fresh(suffix: &str) -> (String, PgPool) {
    let name = format!("scheduleapp_rust_migrations_{suffix}");
    recreate_database(&name).await;
    let pool = create_pool(&with_database(&database_url(), &name)).unwrap();
    (name, pool)
}

async fn table_exists(db: &PgPool, table: &str) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)",
    )
    .bind(table)
    .fetch_one(db)
    .await
    .unwrap()
}

/// Regression test for a real bug found while load-testing the TS server:
/// instances starting simultaneously against a shared, fresh database raced
/// on `CREATE TABLE IF NOT EXISTS schema_migrations` and crashed.
#[tokio::test]
async fn is_safe_to_call_concurrently_from_multiple_pools_against_a_fresh_database() {
    let (name, _) = fresh("concurrency").await;
    let url = with_database(&database_url(), &name);
    let pools: Vec<PgPool> = (0..3).map(|_| create_pool(&url).unwrap()).collect();

    let (a, b, c) = tokio::join!(
        run_migrations(&pools[0]),
        run_migrations(&pools[1]),
        run_migrations(&pools[2])
    );
    let all: Vec<String> = [a, b, c].into_iter().flat_map(|r| r.unwrap()).collect();

    // Every file applied exactly once across the three callers: not zero
    // times (silently skipped), not twice (the lock didn't work).
    let mut unique = all.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique.len(),
        all.len(),
        "a migration was applied twice: {all:?}"
    );
    let expected: Vec<String> = MIGRATIONS.iter().map(|(n, _)| (*n).to_owned()).collect();
    assert_eq!(unique, expected);
    assert!(table_exists(&pools[0], "users").await);

    for pool in pools {
        pool.close().await;
    }
    drop_database(&name).await;
}

#[tokio::test]
async fn records_file_names_as_the_ts_runner_does_and_applies_nothing_twice() {
    let (name, db) = fresh("rerun").await;
    let first = run_migrations(&db).await.unwrap();
    assert_eq!(first.len(), MIGRATIONS.len());
    assert!(run_migrations(&db).await.unwrap().is_empty());

    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM schema_migrations ORDER BY id")
        .fetch_all(&db)
        .await
        .unwrap();
    assert_eq!(
        ids, first,
        "ids are the file names, so either runner sees the other's work"
    );

    db.close().await;
    drop_database(&name).await;
}

#[tokio::test]
async fn picks_up_where_another_runner_left_off() {
    let (name, db) = fresh("partial").await;
    // As if an older server had applied only the first three.
    let applied = run_migrations_from(&db, &MIGRATIONS[..3]).await.unwrap();
    assert_eq!(applied.len(), 3);
    let rest = run_migrations(&db).await.unwrap();
    let expected: Vec<String> = MIGRATIONS[3..]
        .iter()
        .map(|(n, _)| (*n).to_owned())
        .collect();
    assert_eq!(rest, expected);

    db.close().await;
    drop_database(&name).await;
}

#[tokio::test]
async fn a_failing_migration_rolls_back_is_not_recorded_and_releases_the_lock() {
    let (name, db) = fresh("failure").await;
    let mut migrations = MIGRATIONS.to_vec();
    migrations.push((
        "999_broken.sql",
        "CREATE TABLE half_done (id int); SELECT * FROM no_such_table;",
    ));

    let err = run_migrations_from(&db, &migrations).await.unwrap_err();
    assert!(matches!(err, MigrationError::Failed { ref file, .. } if file == "999_broken.sql"));
    assert!(
        err.to_string()
            .starts_with("Migration 999_broken.sql failed: "),
        "{err}"
    );

    // Earlier files stay applied; the broken one left nothing behind.
    assert!(table_exists(&db, "users").await);
    assert!(!table_exists(&db, "half_done").await);
    let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM schema_migrations")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(recorded, i64::try_from(MIGRATIONS.len()).unwrap());

    // The lock was released: no session on this database holds it (other
    // tests take it on their own databases at the same time), and a later
    // run proceeds.
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid::bigint = $1 \
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    )
    .bind(mekur_api::db::MIGRATION_LOCK_KEY)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(held, 0);
    assert!(run_migrations(&db).await.unwrap().is_empty());

    db.close().await;
    drop_database(&name).await;
}
