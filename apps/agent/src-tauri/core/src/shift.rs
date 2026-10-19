//! Shift windows (SHF-01): days of the week and start/end times in the employee's
//! IANA time zone. A shift may cross midnight (end before start), in which case it
//! belongs to the day it starts on.

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

#[derive(Clone, Debug, PartialEq)]
pub struct Shift {
    /// ISO weekdays the shift starts on: 1 = Monday … 7 = Sunday.
    pub days: Vec<u8>,
    pub start: NaiveTime,
    pub end: NaiveTime,
    pub tz: Tz,
}

impl Shift {
    /// The (start, end) of the shift occurrence that starts on local `date`, if
    /// the shift runs that weekday.
    fn occurrence(&self, date: NaiveDate) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        let weekday = date.weekday().number_from_monday() as u8;
        if !self.days.contains(&weekday) {
            return None;
        }
        let end_date = if self.end > self.start {
            date
        } else {
            date.succ_opt()?
        };
        Some((
            local(self.tz, date, self.start)?,
            local(self.tz, end_date, self.end)?,
        ))
    }

    /// Occurrences that start within a day of `around`, earliest first.
    fn occurrences_near(&self, around: DateTime<Utc>) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
        let today = around.with_timezone(&self.tz).date_naive();
        (-2..=1)
            .filter_map(|offset| self.occurrence(today + Duration::days(offset)))
            .collect()
    }
}

/// Resolves a local wall time; on a DST gap takes the later instant, on an overlap
/// the earlier one.
fn local(tz: Tz, date: NaiveDate, time: NaiveTime) -> Option<DateTime<Utc>> {
    let naive = date.and_time(time);
    tz.from_local_datetime(&naive)
        .earliest()
        .or_else(|| {
            tz.from_local_datetime(&(naive + Duration::hours(1)))
                .earliest()
        })
        .map(|t| t.with_timezone(&Utc))
}

/// The shift occurrence `now` falls inside, if any.
pub fn window_containing(
    shifts: &[Shift],
    now: DateTime<Utc>,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    shifts
        .iter()
        .flat_map(|s| s.occurrences_near(now))
        .find(|(start, end)| *start <= now && now < *end)
}

/// The end of the most recent shift occurrence that ended at or before `now`.
pub fn last_end_before(shifts: &[Shift], now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    shifts
        .iter()
        .flat_map(|s| s.occurrences_near(now))
        .map(|(_, end)| end)
        .filter(|end| *end <= now)
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn nine_to_five_la() -> Shift {
        Shift {
            days: vec![1, 2, 3, 4, 5],
            start: NaiveTime::from_hms_opt(9, 0, 0).unwrap(),
            end: NaiveTime::from_hms_opt(17, 0, 0).unwrap(),
            tz: chrono_tz::America::Los_Angeles,
        }
    }

    #[test]
    fn finds_the_window_in_the_employees_time_zone() {
        // Monday 2026-10-19, 10:00 in Los Angeles = 17:00 UTC.
        let (start, end) =
            window_containing(&[nine_to_five_la()], t("2026-10-19T17:00:00Z")).unwrap();
        assert_eq!(start, t("2026-10-19T16:00:00Z"));
        assert_eq!(end, t("2026-10-20T00:00:00Z"));
    }

    #[test]
    fn no_window_on_a_day_off_or_after_hours() {
        // Saturday.
        assert!(window_containing(&[nine_to_five_la()], t("2026-10-24T17:00:00Z")).is_none());
        // Monday 18:00 in LA.
        assert!(window_containing(&[nine_to_five_la()], t("2026-10-20T01:00:00Z")).is_none());
    }

    #[test]
    fn a_night_shift_crosses_midnight_and_belongs_to_its_start_day() {
        let night = Shift {
            days: vec![1], // starts Monday only
            start: NaiveTime::from_hms_opt(22, 0, 0).unwrap(),
            end: NaiveTime::from_hms_opt(6, 0, 0).unwrap(),
            tz: chrono_tz::America::Chicago,
        };
        // Tuesday 02:00 Chicago (07:00 UTC) is inside Monday's shift.
        let (start, end) =
            window_containing(std::slice::from_ref(&night), t("2026-10-20T07:00:00Z")).unwrap();
        assert_eq!(start, t("2026-10-20T03:00:00Z"));
        assert_eq!(end, t("2026-10-20T11:00:00Z"));
        // Tuesday 23:00 Chicago is not: the shift doesn't start on Tuesday.
        assert!(window_containing(&[night], t("2026-10-21T04:00:00Z")).is_none());
    }

    #[test]
    fn last_end_before_finds_the_shift_that_just_ended() {
        // Monday 17:40 in LA.
        assert_eq!(
            last_end_before(&[nine_to_five_la()], t("2026-10-20T00:40:00Z")),
            Some(t("2026-10-20T00:00:00Z"))
        );
    }
}
