//! Monthly processing meter (Stage 20) — the free plan's allowance, counted
//! on Fovea's server and cached on this machine.
//!
//! Why the server holds the number: a counter that lives in app data has two
//! obvious editors. The Windows clock decides which calendar month you are
//! in, and one JSON file decides what you have used. Neither belongs to the
//! plan. So the month (`YYYY-MM`), the ceiling and the balance all come from
//! `/api/usage` on the marketing site, which reads them out of Postgres —
//! `now()` for the month, `free_monthly_limit()` for the ceiling, and a row
//! keyed by this install. A request cannot raise a limit it never receives.
//! See `website/app/api/usage/route.ts` for the other half.
//!
//! Why a cache at all: Fovea's engine makes no network calls, and a metered
//! free plan must not be the reason that changes. The cache is what lets a
//! machine on a train keep working — it holds the balance the server last
//! reported, and the app spends down *that* with no connection.
//!
//! The rules this module owns:
//! - **The reply is the truth.** `period`, `limit` and `used` are only ever
//!   written from a meter response. Nothing here refills a month, so winding
//!   the clock back — or forward — changes nothing at all.
//! - **One conversation before the first image.** A brand-new install has
//!   never been counted anywhere, and only the server can say what its
//!   balance is, so [`check`] asks once. After that the app is offline-safe.
//! - **Count on success.** Credits move when an image is written, never when
//!   a job is asked for: a failed decode, a full disk or a cancelled run
//!   costs nothing.
//! - **A spend the meter has not accepted stays owed.** Images written
//!   offline are deducted locally at once and recorded in `pending`, then
//!   posted on the next successful contact — so a month spent on a plane
//!   cannot buy enhancements the server never heard about.
//! - **Never undo finished work, never blame an outage.** If the meter cannot
//!   be reached the cached balance stands, and a job that already wrote its
//!   images still returns success.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::services::http::{self, Reply};
use crate::services::license::machine;

/// The advertised free allowance: enhancements per calendar month, counted
/// across manual Enhance and Batch alike (a batch of 10 is ten images). The
/// live ceiling is the server's (`free_monthly_limit()` in its schema); this
/// is the number shown before the first reply, and the number the paid plans
/// are measured against when deciding *whether* to count at all.
pub const FREE_MONTHLY_ENHANCEMENTS: u32 = 10;

const QUOTA_FILE: &str = "quota.json";
/// Version 2 is the server-authoritative cache. A version 1 file was a
/// clock-derived count, so it is discarded rather than trusted: the install
/// simply has to speak to the meter once.
const VERSION: u32 = 2;

/// Where the allowance is counted. Overridable for development only, so the
/// meter can be exercised against `next dev`; [`crate::services::http`]
/// refuses plain http to any host that is not a loopback address.
const METER_URL: &str = "https://fovea.caelmont.in/api/usage";
const METER_URL_ENV: &str = "FOVEA_METER_URL";

fn meter_base() -> String {
    match std::env::var(METER_URL_ENV) {
        Ok(url) if !url.trim().is_empty() => url.trim().trim_end_matches('?').to_string(),
        _ => METER_URL.to_string(),
    }
}

/// The cache. Every field is either a copy of a meter reply or a local record
/// of work the meter has not accepted yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Persisted {
    version: u32,
    /// What this install is called at the meter: this machine's fingerprint
    /// when it has one (see [`machine`]), otherwise an id minted once and
    /// kept here. Sent over the network — it names a machine, not a person.
    meter_id: String,
    /// The server's calendar month, `"YYYY-MM"`. Empty until the first reply.
    period: String,
    limit: u32,
    used: u32,
    /// Enhancements written here that the meter has not yet been told about.
    pending: u32,
    /// The meter's own verdict at the last reply. `false` means this machine
    /// still has install credit but the network ceiling behind it is spent.
    allowed: bool,
    /// The server's clock at the last successful reply. `0` = never synced,
    /// which is the one state that cannot grant an allowance offline.
    synced_at: u64,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            version: VERSION,
            meter_id: String::new(),
            period: String::new(),
            limit: FREE_MONTHLY_ENHANCEMENTS,
            used: 0,
            pending: 0,
            allowed: true,
            synced_at: 0,
        }
    }
}

/// The meter as the UI sees it (camelCase, like every DTO). Absent for a plan
/// that is not metered at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// The calendar month being counted, `"YYYY-MM"` — the server's, and
    /// empty on an install that has yet to hear from it.
    pub period: String,
    pub limit: u32,
    /// Enhancements used, including any this machine owes the meter.
    pub used: u32,
    pub remaining: u32,
    /// Has this install ever been counted by the meter? `false` means the
    /// numbers above are the plan's shape, not a balance it may spend: the
    /// first enhancement needs one connection. The UI says so rather than
    /// showing a full allowance it would then refuse.
    pub counted: bool,
}

// ── The cache file ───────────────────────────────────────────────────

/// Serialises every read-modify-write of the cache. Three writers reach it:
/// the enhancement command, the batch relay, and the meter's own pump thread.
fn gate() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read(app_data: &Path) -> Persisted {
    let path = app_data.join(QUOTA_FILE);
    match std::fs::read(&path) {
        Ok(raw) => match serde_json::from_slice::<Persisted>(&raw) {
            Ok(p) if p.version == VERSION => p,
            Ok(p) => {
                log::warn!("quota file unknown version {} — counting anew", p.version);
                Persisted::default()
            }
            Err(e) => {
                // A corrupt meter is a lost count, not a locked app: the
                // install re-establishes itself from the next reply.
                log::warn!("quota file corrupt: {e}");
                Persisted::default()
            }
        },
        Err(_) => Persisted::default(),
    }
}

fn write(app_data: &Path, state: &Persisted) -> AppResult<()> {
    let path = app_data.join(QUOTA_FILE);
    let json = serde_json::to_vec_pretty(state)
        .map_err(|e| AppError::unexpected(format!("encode quota: {e}")))?;
    write_atomic(&path, &json).map_err(|e| AppError::unexpected(format!("write quota: {e}")))
}

/// temp + rename, the discipline every other local store in this app uses.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, bytes)?;
    let commit = || {
        #[cfg(windows)]
        {
            if path.exists() {
                std::fs::remove_file(path)?;
            }
            std::fs::rename(&tmp, path)
        }
        #[cfg(not(windows))]
        std::fs::rename(&tmp, path)
    };
    commit().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

fn remaining_of(p: &Persisted) -> u32 {
    p.limit.saturating_sub(p.used.saturating_add(p.pending))
}

fn snapshot_of(p: &Persisted) -> Snapshot {
    Snapshot {
        // Empty until the meter names the month; the caller that shows this
        // to a user labels it (see `display_period`).
        period: p.period.clone(),
        limit: p.limit,
        used: p.used.saturating_add(p.pending).min(p.limit),
        remaining: remaining_of(p),
        counted: p.synced_at > 0,
    }
}

/// Does this cache cover `count` more enhancements? `synced_at` is in here on
/// purpose: an install that has never been counted has no balance to spend.
fn covers(p: &Persisted, count: u32) -> bool {
    p.synced_at > 0 && p.allowed && count <= remaining_of(p)
}

// ── The meter id ─────────────────────────────────────────────────────

/// The id this install is counted under, chosen once and kept in the cache.
///
/// Normally the machine fingerprint, so wiping app data cannot mint a fresh
/// allowance. A machine that will not report its identity gets a random id
/// instead — a weaker guarantee, but the alternative is refusing to run the
/// free plan at all, and this module's job is to count, not to lock anyone out.
fn meter_id(app_data: &Path) -> String {
    let _g = gate();
    let mut p = read(app_data);
    if p.meter_id.is_empty() {
        p.meter_id = machine::id().map(str::to_string).unwrap_or_else(mint_id);
        if let Err(err) = write(app_data, &p) {
            log::warn!("meter id could not be stored: {}", err.code());
        }
    }
    p.meter_id.clone()
}

/// 128 bits of hard-to-predict, kept for the life of the cache file. Nothing
/// about it has to be unguessable — only unlikely to collide with another
/// install.
fn mint_id() -> String {
    use sha2::{Digest as _, Sha256};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(COUNTER.fetch_add(1, Ordering::SeqCst).to_le_bytes());
    hasher.update(machine::display_id().as_bytes());
    let digest = hasher.finalize();
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

// ── The round trip ───────────────────────────────────────────────────

/// The transport this module uses. Production passes [`http::call`]; with a
/// canned stand-in the cache rules below are testable without a socket and
/// without waiting on one. `body: Some(json)` is a POST, `None` a GET.
type Call<'a> = &'a dyn Fn(&str, Option<&str>) -> AppResult<Reply>;

/// The balance as the meter describes it. Unknown extra fields (the network
/// meter's own numbers) are ignored — these five are the contract.
#[derive(Debug, Deserialize)]
struct Reading {
    period: String,
    used: u32,
    remaining: u32,
    limit: u32,
    allowed: Option<bool>,
    server_time: Option<u64>,
}

/// One request and its parsed answer. Every failure to get a usable answer is
/// [`AppError::MeterUnreachable`], never a quota verdict: a server outage must
/// not cost a user the images they were granted.
fn exchange(call: Call, url: &str, body: Option<&str>) -> AppResult<Reading> {
    let reply = call(url, body)?;
    if reply.status != 200 {
        return Err(AppError::meter_unreachable(format!(
            "meter answered {}",
            reply.status
        )));
    }
    let reading: Reading = serde_json::from_str(&reply.body)
        .map_err(|e| AppError::meter_unreachable(format!("meter reply unreadable: {e}")))?;
    if !valid_period(&reading.period) {
        return Err(AppError::meter_unreachable("meter named no calendar month"));
    }
    Ok(reading)
}

fn valid_period(period: &str) -> bool {
    let bytes = period.as_bytes();
    bytes.len() == 7
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..].iter().all(u8::is_ascii_digit)
}

/// Write a reply into the cache. Only the meter's numbers land here; a local
/// backlog is settled by its own caller.
fn merge(p: &mut Persisted, r: &Reading) {
    p.version = VERSION;
    p.period = r.period.clone();
    p.limit = r.limit;
    p.used = r.used.min(r.limit);
    p.allowed = r.allowed.unwrap_or(r.remaining > 0);
    // `max(1)`: a reply is what lifts an install out of never-counted, and 0
    // is that sentinel — so even a reply without a clock still counts as one.
    p.synced_at = r.server_time.unwrap_or(0).max(1);
}

fn get_url(base: &str, id: &str) -> String {
    // The meter id is hex by construction (see `meter_id`), so it needs no
    // escaping — and nothing else about this machine is ever sent.
    debug_assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    format!("{base}?install_id={id}")
}

fn post_body(id: &str, count: u32) -> String {
    format!(r#"{{"install_id":"{id}","count":{count}}}"#)
}

/// Read the balance and make it the cache's.
fn read_meter(app_data: &Path, call: Call) -> AppResult<Snapshot> {
    let id = meter_id(app_data);
    let reading = exchange(call, &get_url(&meter_base(), &id), None)?;
    let mut forgiven = 0u32;
    let snapshot = {
        let _g = gate();
        let mut p = read(app_data);
        // A month the cache has not seen closes the books on the last one.
        // Enhancements owed from a closed month are not this month's debt:
        // the meter either counted them under the old period or lost them
        // with the install, and posting them now would charge a fresh
        // allowance for an old month's work.
        if !p.period.is_empty() && p.period != reading.period {
            forgiven = p.pending;
            p.pending = 0;
        }
        merge(&mut p, &reading);
        write(app_data, &p)?;
        snapshot_of(&p)
    };
    if forgiven > 0 {
        log::info!("{forgiven} owed enhancement(s) belonged to a closed month");
    }
    Ok(snapshot)
}

/// Hand `owed` enhancements to the meter and believe its answer.
fn post_owed(app_data: &Path, owed: u32, call: Call) -> AppResult<()> {
    let id = meter_id(app_data);
    let reading = exchange(call, &meter_base(), Some(&post_body(&id, owed)))?;
    let _g = gate();
    let mut p = read(app_data);
    merge(&mut p, &reading);
    // Re-read under the lock: anything recorded while this request was in
    // flight is still owed, and rides on the next post.
    p.pending = p.pending.saturating_sub(owed);
    write(app_data, &p)
}

/// Post the backlog until the meter has heard about every image.
fn flush(app_data: &Path, call: Call) -> AppResult<()> {
    loop {
        let owed = {
            let _g = gate();
            read(app_data).pending
        };
        if owed == 0 {
            return Ok(());
        }
        post_owed(app_data, owed, call)?;
    }
}

// ── The pump thread ──────────────────────────────────────────────────

/// The meter's own thread. A spend hands it the work rather than making the
/// call itself, because both callers are user-facing: the batch relay streams
/// progress events through the loop it would block, and an enhancement command
/// has already written the user's image. Neither should stall on a network
/// timeout to report a count.
static PUMP: OnceLock<Sender<()>> = OnceLock::new();

fn kick(app_data: &Path) {
    let dir = app_data.to_path_buf();
    let tx = PUMP.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        if let Err(err) = std::thread::Builder::new()
            .name("fovea-meter".to_string())
            .spawn(move || {
                for _wake in rx {
                    if let Err(err) = flush(&dir, &http::call) {
                        log::warn!("meter backlog could not be posted: {}", err.code());
                    }
                }
            })
        {
            log::warn!("meter pump could not start: {err}");
        }
        tx
    });
    let _ = tx.send(());
}

// ── Service API ──────────────────────────────────────────────────────

/// The meter as this machine last heard it. Read-only: the status command
/// calls it on every poll, so it must never touch the network. The balance it
/// reports is refreshed at startup, before the first job, and after every
/// spend the meter accepted.
pub fn peek(app_data: &Path) -> Snapshot {
    let _g = gate();
    snapshot_of(&read(app_data))
}

/// Are `count` more enhancements possible this month? Says no without
/// spending anything — the spend happens in [`take`], after the work.
///
/// Refusal is not a local decision: an exhausted cache asks the meter once,
/// because a new calendar month is the server's to declare and this app may
/// run for weeks without a restart. That ask is the only blocking network
/// call on a user-facing path, and it happens where the answer was already
/// going to be "no".
pub fn check(app_data: &Path, count: u32) -> AppResult<()> {
    check_with(app_data, count, &http::call)
}

pub fn check_with(app_data: &Path, count: u32, call: Call) -> AppResult<()> {
    let state = {
        let _g = gate();
        read(app_data)
    };
    if covers(&state, count) {
        return Ok(());
    }
    // A queue bigger than the whole allowance is refused on the spot: no
    // calendar month grants eleven images out of ten, so this needs no
    // opinion from the meter and an offline machine still hears the truth.
    if state.synced_at > 0 && count > state.limit {
        return Err(refused(&state, count));
    }
    match read_meter(app_data, call) {
        Ok(_) => {}
        Err(err) if state.synced_at == 0 => return Err(err),
        Err(err) => {
            log::warn!(
                "meter unreachable, keeping the cached balance: {}",
                err.code()
            );
        }
    }
    let state = {
        let _g = gate();
        read(app_data)
    };
    if covers(&state, count) {
        return Ok(());
    }
    if state.synced_at == 0 {
        return Err(AppError::meter_unreachable(
            "this install has never been counted",
        ));
    }
    Err(refused(&state, count))
}

fn refused(p: &Persisted, count: u32) -> AppError {
    AppError::QuotaExceeded {
        detail: format!(
            "{count} requested, {} of {} left in {}",
            remaining_of(p),
            p.limit,
            if p.period.is_empty() {
                "an uncounted month"
            } else {
                &p.period
            }
        ),
    }
}

/// Record `count` enhancements as written. Call *after* the images exist.
///
/// The local deduction is synchronous (a crash must not lose a count), the
/// report to the meter is not. An error here means the cache file could not be
/// written — an unreachable meter is never a refusal, and never turns
/// finished work into a failure.
pub fn take(app_data: &Path, count: u32) -> AppResult<()> {
    bump(app_data, count)?;
    kick(app_data);
    Ok(())
}

/// Deduct locally and post the backlog in the same call. What [`take`] and
/// [`sync`] do through the pump; the tests drive this directly so no test
/// ever reaches the real meter.
pub fn take_with(app_data: &Path, count: u32, call: Call) -> AppResult<Snapshot> {
    bump(app_data, count)?;
    flush(app_data, call)?;
    Ok(peek(app_data))
}

fn bump(app_data: &Path, count: u32) -> AppResult<()> {
    let _g = gate();
    let mut p = read(app_data);
    p.pending = p.pending.saturating_add(count).min(p.limit);
    write(app_data, &p)
}

/// The whole server conversation in one call: read the balance, then post
/// whatever this machine owes. Run at startup from a background thread, which
/// is why the reported balance is current before the user's first job.
pub fn sync(app_data: &Path) -> AppResult<Snapshot> {
    sync_with(app_data, &http::call)
}

pub fn sync_with(app_data: &Path, call: Call) -> AppResult<Snapshot> {
    read_meter(app_data, call)?;
    if let Err(err) = flush(app_data, call) {
        log::warn!("meter backlog could not be posted: {}", err.code());
    }
    Ok(peek(app_data))
}

/// Has this install ever heard from the meter? `false` means the free plan is
/// not usable yet, and the network is the reason.
pub fn counted(app_data: &Path) -> bool {
    let _g = gate();
    read(app_data).synced_at > 0
}

// ── Display helper ───────────────────────────────────────────────────

/// The calendar month `now` falls into. For labelling the meter *before* the
/// first reply — see [`Snapshot::period`], which is empty until the server
/// names it — and nothing about an allowance is decided from the local clock.
pub fn display_period(now: u64) -> String {
    let (year, month) = year_month(now);
    format!("{year:04}-{month:02}")
}

/// Days-since-epoch → (year, month). Howard Hinnant's `civil_from_days`,
/// which is exact over the whole range a sane clock reports; a few lines
/// is a better trade than a date crate for one string label.
fn year_month(unix_secs: u64) -> (i64, u32) {
    let days = (unix_secs / 86_400) as i64;
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year, month as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::PathBuf;

    /// 2025-10-09T00:00:00Z — same fixed instant the license suite uses.
    const T0: u64 = 1_760_000_000;

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("fovea-quota-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// A fake meter: canned replies in the order they will be asked for, and
    /// a record of what was asked. `offline()` answers the way a dead network
    /// does — no reply at all.
    struct Meter {
        replies: RefCell<VecDeque<AppResult<Reply>>>,
        seen: RefCell<Vec<(String, Option<String>)>>,
    }

    fn answered(body: &str) -> AppResult<Reply> {
        Ok(Reply {
            status: 200,
            body: body.to_string(),
        })
    }

    impl Meter {
        fn ok(body: &str) -> Self {
            Self {
                replies: RefCell::new(vec![answered(body)].into()),
                seen: RefCell::new(Vec::new()),
            }
        }
        fn queue(bodies: &[&str]) -> Self {
            let replies: Vec<AppResult<Reply>> = bodies.iter().map(|b| answered(b)).collect();
            Self {
                replies: RefCell::new(replies.into()),
                seen: RefCell::new(Vec::new()),
            }
        }
        fn offline() -> Self {
            Self {
                replies: RefCell::new(
                    vec![Err(AppError::meter_unreachable("no route to host"))].into(),
                ),
                seen: RefCell::new(Vec::new()),
            }
        }
        fn call(&self) -> impl Fn(&str, Option<&str>) -> AppResult<Reply> {
            |url, body| {
                self.seen
                    .borrow_mut()
                    .push((url.to_string(), body.map(str::to_string)));
                self.replies
                    .borrow_mut()
                    .pop_front()
                    .unwrap_or_else(|| answered("{}"))
            }
        }
        fn requests(&self) -> Vec<(String, Option<String>)> {
            self.seen.borrow().clone()
        }
    }

    fn reply(period: &str, used: u32, allowed: bool) -> String {
        format!(
            r#"{{"period":"{period}","used":{used},"remaining":{},"limit":10,"allowed":{allowed},"server_time":{T0}}}"#,
            10u32.saturating_sub(used)
        )
    }

    /// Get the install into a known, server-confirmed balance.
    fn balance(dir: &Path, used: u32) {
        let meter = Meter::ok(&reply("2025-10", used, true));
        sync_with(dir, &meter.call()).unwrap();
    }

    /// The same state, written straight to the cache — for the tests that
    /// need a counted install and a meter that never answers.
    fn cache(dir: &Path, period: &str, used: u32, pending: u32, allowed: bool) {
        let p = Persisted {
            version: VERSION,
            meter_id: "a".repeat(32),
            period: period.to_string(),
            limit: 10,
            used,
            pending,
            allowed,
            synced_at: T0,
        };
        write(dir, &p).unwrap();
    }

    #[test]
    fn an_uncounted_install_asks_the_meter_before_refusing_or_granting() {
        let dir = scratch("first-run");
        let meter = Meter::ok(&reply("2025-10", 3, true));
        // Three already used — the server knows, this machine had no idea.
        assert!(!counted(&dir));
        assert_eq!(peek(&dir).used, 0);
        check_with(&dir, 7, &meter.call()).expect("seven fit in ten");
        assert_eq!(peek(&dir).remaining, 7);
        let requests = meter.requests();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .0
                .ends_with(&format!("install_id={}", read(&dir).meter_id))
        );
        assert_eq!(requests[0].1, None, "a check must not spend");
    }

    #[test]
    fn a_brand_new_install_with_no_network_does_not_get_an_allowance() {
        let dir = scratch("offline-first-run");
        let meter = Meter::offline();
        assert_eq!(
            check_with(&dir, 1, &meter.call())
                .expect_err("uncounted")
                .code(),
            "meter_unreachable"
        );
        assert_eq!(peek(&dir).used, 0, "refusing spends nothing");
        assert!(!counted(&dir));
    }

    #[test]
    fn a_counted_install_works_offline_on_the_cached_balance() {
        let dir = scratch("offline-after-sync");
        balance(&dir, 0);
        let dark = Meter::offline();
        check_with(&dir, 10, &dark.call()).expect("the cached ten are spendable");
        for _ in 0..8 {
            bump(&dir, 1).unwrap();
        }
        assert_eq!(peek(&dir).remaining, 2);
        assert_eq!(
            check_with(&dir, 3, &dark.call())
                .expect_err("two left")
                .code(),
            "quota_exceeded"
        );
        // Those eight are owed; the meter has never heard of them.
        assert_eq!(read(&dir).pending, 8);
        assert_eq!(peek(&dir).used, 8);
    }

    /// The whole point of moving the count: the month belongs to the server.
    #[test]
    fn the_server_turns_the_month_over_not_this_machine() {
        let dir = scratch("rollover-refill");
        let meter = Meter::queue(&[&reply("2025-10", 10, false), &reply("2025-11", 0, true)]);
        let out = sync_with(&dir, &meter.call()).unwrap();
        assert_eq!((out.period.as_str(), out.remaining), ("2025-10", 0));
        // The next answer names November and a full ten. Nothing local
        // decided either fact.
        let fresh = sync_with(&dir, &meter.call()).unwrap();
        assert_eq!(
            (fresh.period.as_str(), fresh.used, fresh.remaining),
            ("2025-11", 0, 10)
        );
        check_with(&dir, 10, &Meter::offline().call()).expect("spendable in November");
    }

    #[test]
    fn the_local_clock_has_no_say_about_the_balance() {
        let dir = scratch("no-clock-involvement");
        cache(&dir, "2025-10", 4, 0, true);
        let dark = Meter::offline();
        assert_eq!(peek(&dir).remaining, 6);
        assert_eq!(
            check_with(&dir, 7, &dark.call())
                .expect_err("still six")
                .code(),
            "quota_exceeded"
        );
        assert_eq!(peek(&dir).period, "2025-10");
        assert_eq!(peek(&dir).limit, 10);
    }

    #[test]
    fn a_spend_is_posted_and_the_reply_becomes_the_balance() {
        let dir = scratch("spend-post");
        balance(&dir, 7);
        let meter = Meter::ok(&reply("2025-10", 8, true));
        let s = take_with(&dir, 1, &meter.call()).unwrap();
        let requests = meter.requests();
        assert_eq!(requests.len(), 1, "one post for one image");
        assert!(
            requests[0].0.starts_with("http"),
            "POST target: {requests:?}"
        );
        let body = requests[0].1.as_deref().expect("a spend posts a body");
        assert!(body.contains("\"count\":1"), "body was {body}");
        assert!(body.contains(&read(&dir).meter_id), "body was {body}");
        assert_eq!((s.used, s.remaining), (8, 2));
        assert_eq!(read(&dir).pending, 0, "the meter has it now");
    }

    #[test]
    fn the_whole_backlog_rides_on_the_next_spend() {
        let dir = scratch("backlog");
        balance(&dir, 0);
        let dark = Meter::offline();
        assert!(
            take_with(&dir, 1, &dark.call()).is_err(),
            "no route to host"
        );
        assert!(take_with(&dir, 1, &dark.call()).is_err());
        assert_eq!(read(&dir).pending, 2, "both stayed owed");
        assert_eq!(peek(&dir).remaining, 8, "and both were deducted");
        // Back online: the post carries all three.
        let meter = Meter::ok(&reply("2025-10", 3, true));
        let s = take_with(&dir, 1, &meter.call()).unwrap();
        let requests = meter.requests();
        let body = requests[0].1.as_deref().expect("a spend posts");
        assert!(body.contains("\"count\":3"), "body was {body}");
        assert_eq!((s.used, s.remaining), (3, 7));
        assert_eq!(read(&dir).pending, 0);
    }

    #[test]
    fn an_unreachable_meter_never_undoes_finished_work() {
        let dir = scratch("bump-stands-alone");
        cache(&dir, "2025-10", 1, 0, true);
        // A recorded count needs no network: the report is the pump's job.
        bump(&dir, 1).expect("an image written is an image counted");
        assert_eq!(peek(&dir).used, 2);
        assert_eq!(read(&dir).pending, 1);
        check_with(&dir, 8, &Meter::offline().call())
            .expect("eight of the cached ten are still spendable");
    }

    #[test]
    fn a_closed_month_forgives_the_backlog_it_was_never_told_about() {
        let dir = scratch("rollover-forgives");
        cache(&dir, "2025-10", 10, 4, true);
        let meter = Meter::ok(&reply("2025-11", 0, true));
        let s = sync_with(&dir, &meter.call()).unwrap();
        assert_eq!((s.period.as_str(), s.used, s.remaining), ("2025-11", 0, 10));
        assert_eq!(read(&dir).pending, 0, "October's debt is not November's");
        // And nothing was posted: forgiven, not charged to the new month.
        assert_eq!(meter.requests().len(), 1);
        assert_eq!(meter.requests()[0].1, None);
    }

    #[test]
    fn the_network_ceiling_refuses_even_with_install_credit_left() {
        let dir = scratch("ceiling");
        // The meter's own verdict: this install has 8 of its ten left, and
        // the network behind it does not.
        sync_with(&dir, &Meter::ok(&reply("2025-10", 2, false)).call()).unwrap();
        assert_eq!(peek(&dir).remaining, 8);
        let dark = Meter::offline();
        assert_eq!(
            check_with(&dir, 1, &dark.call())
                .expect_err("network spent")
                .code(),
            "quota_exceeded"
        );
        // A refusal always re-asks, because the ceiling is monthly too: this
        // answer says the network has room again, and the job is allowed.
        let back = Meter::ok(&reply("2025-10", 2, true));
        check_with(&dir, 1, &back.call()).expect("ceiling lifted");
        assert!(counted(&dir));
    }

    #[test]
    fn a_batch_larger_than_the_allowance_is_refused_whole() {
        let dir = scratch("batch");
        balance(&dir, 5);
        let dark = Meter::offline();
        assert_eq!(
            check_with(&dir, 6, &dark.call())
                .expect_err("too big")
                .code(),
            "quota_exceeded"
        );
        // Refusing spends nothing — the queue never started.
        assert_eq!(peek(&dir).used, 5);
        assert_eq!(read(&dir).pending, 0);
        check_with(&dir, 5, &dark.call()).expect("five fit");
    }

    #[test]
    fn a_malformed_reply_leaves_the_balance_alone() {
        let dir = scratch("malformed");
        balance(&dir, 4);
        for body in [
            "{}",
            r#"{"period":"nonsense","used":0,"remaining":9,"limit":10}"#,
        ] {
            let meter = Meter::ok(body);
            assert_eq!(
                sync_with(&dir, &meter.call())
                    .expect_err("no usable answer")
                    .code(),
                "meter_unreachable"
            );
        }
        let s = peek(&dir);
        assert_eq!((s.period.as_str(), s.used, s.remaining), ("2025-10", 4, 6));
    }

    #[test]
    fn an_old_clock_derived_meter_is_discarded_not_believed() {
        let dir = scratch("v1");
        // The version 1 shape: a count this machine's clock owned.
        std::fs::write(
            dir.join(QUOTA_FILE),
            r#"{"version":1,"period":"2025-09","used":3,"maxSeenAt":1760000000}"#,
        )
        .unwrap();
        assert!(!counted(&dir), "a clock's word is not a balance");
        assert_eq!(peek(&dir).period, "", "only the meter names the month");
        assert_eq!(display_period(T0), "2025-10", "for labelling");
        let meter = Meter::ok(&reply("2025-10", 9, true));
        check_with(&dir, 1, &meter.call()).expect("the server says one fits");
        assert_eq!(peek(&dir).used, 9);
    }

    #[test]
    fn corrupt_meter_degrades_to_a_fresh_count_not_a_locked_app() {
        let dir = scratch("corrupt");
        balance(&dir, 3);
        std::fs::write(dir.join(QUOTA_FILE), b"{ not json").unwrap();
        assert!(!counted(&dir));
        assert_eq!(peek(&dir).limit, FREE_MONTHLY_ENHANCEMENTS);
        let meter = Meter::ok(&reply("2025-10", 0, true));
        check_with(&dir, 10, &meter.call()).expect("full allowance again");
    }

    #[test]
    fn a_used_up_install_that_cannot_ask_the_meter_stays_used_up() {
        let dir = scratch("out-and-offline");
        cache(&dir, "2025-10", 10, 0, false);
        let dark = Meter::offline();
        // Refusing is the safe answer when the month cannot be re-checked.
        assert_eq!(
            check_with(&dir, 1, &dark.call()).expect_err("empty").code(),
            "quota_exceeded"
        );
    }

    #[test]
    fn error_detail_never_reaches_the_frontend() {
        let dir = scratch("dto");
        cache(&dir, "2025-10", 10, 0, true);
        let dark = Meter::offline();
        let err = check_with(&dir, 1, &dark.call()).expect_err("empty");
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"quota_exceeded\""));
        assert!(!json.contains("2025-10"), "internal detail leaked: {json}");
        assert!(!json.contains(&"a".repeat(32)), "meter id leaked: {json}");
    }

    #[test]
    fn period_labels_are_gregorian_for_the_uncounted_display() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(T0), (2025, 10));
        assert_eq!(year_month(1_709_208_000), (2024, 2)); // 2024-02-29
        assert_eq!(year_month(1_735_689_600), (2025, 1)); // 2025-01-01
        assert_eq!(year_month(4_102_444_800), (2100, 1));
        assert!(valid_period("2025-10"));
        assert!(!valid_period("2025-1"));
        assert!(!valid_period(""));
    }

    #[test]
    fn an_id_is_chosen_once_and_kept() {
        let dir = scratch("meter-id");
        let first = meter_id(&dir);
        assert_eq!(first.len(), 32, "128 bits as hex");
        assert!(
            first
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        );
        assert_eq!(meter_id(&dir), first, "stable across calls");
        assert_eq!(read(&dir).meter_id, first, "and persisted");
        assert!(
            get_url("https://meter.test/api", &first).ends_with(&format!("install_id={first}"))
        );
    }
}
