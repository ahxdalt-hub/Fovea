//! Monthly processing meter (Stage 20) — the free plan's counter, local only.
//!
//! Why a counter and not a server: Fovea's engine makes zero network
//! calls, and a metered free plan must not be the reason that changes.
//! The count lives in app data, one JSON file, in a calendar-month bucket.
//!
//! What this is *not*: a security control. Anyone determined can edit a
//! local file; the Ed25519 license signature is the only thing here that
//! is actually unforgeable. The meter exists so the free plan means what
//! it says by default — an honest ceiling for an honest user, priced in
//! enhancements actually produced, and cheap enough to reset with a
//! reinstall for anyone who never intended to pay at all.
//!
//! Rules this module owns:
//! - **Count on success.** Credits are taken when an image is written,
//!   never when a job is asked for, so a failed decode, an out-of-disk
//!   export, or a cancelled run costs nothing.
//! - **One calendar month.** The bucket key is derived from the clock;
//!   crossing into next month resets the count by itself, no scheduler.
//! - **Rollback cannot rewind it.** The same high-water mark discipline
//!   `services::license` uses for expired keys: the bucket is derived
//!   from `max(now, highest time ever seen)`, so winding the clock back
//!   to the first of the month does not refill the month you already
//!   used.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// The free plan's allowance: enhancements per calendar month, counted
/// across manual Enhance and Batch alike (a batch of 10 is ten images).
pub const FREE_MONTHLY_ENHANCEMENTS: u32 = 10;

const QUOTA_FILE: &str = "quota.json";
const VERSION: u32 = 1;

/// The persisted bucket. `period` is `"YYYY-MM"`; `max_seen_at` is the
/// anti-rollback watermark this module keeps for itself (deliberately not
/// the license's — a machine can be metered with no license stored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    version: u32,
    period: String,
    used: u32,
    max_seen_at: u64,
}

impl Persisted {
    fn fresh(now: u64) -> Self {
        Self {
            version: VERSION,
            period: period_key(now),
            used: 0,
            max_seen_at: now,
        }
    }
}

/// The meter as the UI sees it (camelCase, like every DTO). Absent for a
/// plan that is not metered at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// The calendar month being counted, `"YYYY-MM"`.
    pub period: String,
    pub limit: u32,
    pub used: u32,
    pub remaining: u32,
}

/// The bucket `now` falls into, ignoring any time travel: a UTC calendar
/// month, no timezone table and no DST surprises.
fn period_key(now: u64) -> String {
    let (year, month) = year_month(now);
    format!("{year:04}-{month:02}")
}

/// Days-since-epoch → (year, month). Howard Hinnant's `civil_from_days`,
/// which is exact over the whole range a sane clock reports; a few lines
/// is a better trade than a date crate for one string key.
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

fn read(app_data: &Path, now: u64) -> Persisted {
    let path = app_data.join(QUOTA_FILE);
    let stored = match std::fs::read(&path) {
        Ok(raw) => match serde_json::from_slice::<Persisted>(&raw) {
            Ok(p) if p.version == VERSION => p,
            Ok(p) => {
                log::warn!("quota file unknown version {} — starting fresh", p.version);
                Persisted::fresh(now)
            }
            Err(e) => {
                // A corrupt meter is a lost count, not a locked app. It
                // re-establishes itself from this moment forward.
                log::warn!("quota file corrupt: {e}");
                Persisted::fresh(now)
            }
        },
        Err(_) => Persisted::fresh(now),
    };
    advance(stored, now)
}

/// Roll the bucket forward to the effective month, and the watermark
/// forward to the latest time seen. Never rewinds `used` except on a real
/// month change.
fn advance(mut stored: Persisted, now: u64) -> Persisted {
    let effective = now.max(stored.max_seen_at);
    let key = period_key(effective);
    if key != stored.period {
        stored.period = key;
        stored.used = 0;
    }
    stored.max_seen_at = effective;
    stored
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

/// The meter as it stands right now — read-only, no write, so the status
/// command can call it on every poll.
pub fn peek(app_data: &Path, limit: u32, now: u64) -> Snapshot {
    let state = read(app_data, now);
    Snapshot {
        period: state.period,
        limit,
        used: state.used,
        remaining: limit.saturating_sub(state.used),
    }
}

/// Are `count` more enhancements possible this month? Says no without
/// spending anything — the spend happens in [`take`], after the work.
pub fn check(app_data: &Path, limit: u32, now: u64, count: u32) -> AppResult<()> {
    let state = read(app_data, now);
    if state.used.saturating_add(count) > limit {
        return Err(AppError::QuotaExceeded {
            detail: format!(
                "{} requested, {} of {} left in {}",
                count,
                limit.saturating_sub(state.used),
                limit,
                state.period
            ),
        });
    }
    Ok(())
}

/// Spend `count` credits. Call only once the images are actually written;
/// a spend for work that did not happen would charge the user for a bug.
pub fn take(app_data: &Path, limit: u32, now: u64, count: u32) -> AppResult<()> {
    let mut state = read(app_data, now);
    state.used = state.used.saturating_add(count).min(limit);
    write(app_data, &state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const LIMIT: u32 = FREE_MONTHLY_ENHANCEMENTS;
    /// 2025-10-09T00:00:00Z — same fixed instant the license suite uses.
    const T0: u64 = 1_760_000_000;
    const DAY: u64 = 86_400;

    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("fovea-quota-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn period_keys_match_the_gregorian_calendar() {
        assert_eq!(period_key(0), "1970-01");
        assert_eq!(period_key(T0), "2025-10");
        // The leap-day and the year it sits in.
        assert_eq!(period_key(1_709_208_000), "2024-02"); // 2024-02-29
        assert_eq!(period_key(1_735_689_600), "2025-01"); // 2025-01-01
        assert_eq!(period_key(1_767_225_600), "2026-01"); // 2026-01-01
        assert_eq!(period_key(4_102_444_800), "2100-01"); // a long way out
    }

    #[test]
    fn empty_meter_is_a_full_allowance() {
        let dir = scratch("fresh");
        let s = peek(&dir, LIMIT, T0);
        assert_eq!((s.limit, s.used, s.remaining), (10, 0, 10));
        assert_eq!(s.period, "2025-10");
    }

    #[test]
    fn spends_accumulate_and_the_last_credit_is_spent_not_borrowed() {
        let dir = scratch("spend");
        for _ in 0..9 {
            take(&dir, LIMIT, T0, 1).unwrap();
        }
        assert_eq!(peek(&dir, LIMIT, T0).remaining, 1);
        check(&dir, LIMIT, T0, 1).expect("one left is enough");
        assert_eq!(
            check(&dir, LIMIT, T0, 2).expect_err("over").code(),
            "quota_exceeded"
        );
        take(&dir, LIMIT, T0, 1).unwrap();
        assert_eq!(peek(&dir, LIMIT, T0).remaining, 0);
        // A spend the meter has no room for is clamped, not negative:
        // the caller already refused the job, this is bookkeeping.
        take(&dir, LIMIT, T0, 3).unwrap();
        assert_eq!(peek(&dir, LIMIT, T0).used, LIMIT);
    }

    #[test]
    fn a_new_calendar_month_refills_without_being_asked() {
        let dir = scratch("month");
        take(&dir, LIMIT, T0, 10).unwrap();
        assert_eq!(peek(&dir, LIMIT, T0).remaining, 0);
        let next_month = T0 + 23 * DAY; // 2025-11-01
        let s = peek(&dir, LIMIT, next_month);
        assert_eq!(s.period, "2025-11");
        assert_eq!(s.used, 0);
        assert_eq!(s.remaining, LIMIT);
    }

    #[test]
    fn winding_the_clock_back_cannot_refill_the_month() {
        let dir = scratch("rollback");
        take(&dir, LIMIT, T0, 4).unwrap();
        // Two months of clock surgery: the meter stays where the watermark
        // put it, because the watermark is the largest time seen.
        let earlier = T0 - 60 * DAY;
        assert_eq!(peek(&dir, LIMIT, earlier).used, 4);
        assert_eq!(peek(&dir, LIMIT, earlier).period, "2025-10");
        check(&dir, LIMIT, earlier, 6).expect("6 left is still 6 left");
        assert_eq!(
            check(&dir, LIMIT, earlier, 7).expect_err("no reset").code(),
            "quota_exceeded"
        );
        // Honest time forward behaves normally.
        assert_eq!(peek(&dir, LIMIT, T0 + DAY).period, "2025-10");
    }

    #[test]
    fn corrupt_meter_degrades_to_a_full_allowance_not_a_crash() {
        let dir = scratch("corrupt");
        take(&dir, LIMIT, T0, 3).unwrap();
        std::fs::write(dir.join(QUOTA_FILE), b"{ not json").unwrap();
        assert_eq!(peek(&dir, LIMIT, T0).used, 0);
        take(&dir, LIMIT, T0, 1).expect("writable again");
        assert_eq!(peek(&dir, LIMIT, T0).used, 1);
    }

    #[test]
    fn a_batch_larger_than_the_allowance_is_refused_whole() {
        let dir = scratch("batch");
        assert_eq!(
            check(&dir, LIMIT, T0, 12).expect_err("too big").code(),
            "quota_exceeded"
        );
        // Refusing spends nothing — the queue never started.
        assert_eq!(peek(&dir, LIMIT, T0).used, 0);
    }

    #[test]
    fn error_detail_never_reaches_the_frontend() {
        let dir = scratch("dto");
        take(&dir, LIMIT, T0, 10).unwrap();
        let err = check(&dir, LIMIT, T0, 1).expect_err("empty");
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"quota_exceeded\""));
        assert!(!json.contains("2025-10"), "internal detail leaked: {json}");
    }
}
