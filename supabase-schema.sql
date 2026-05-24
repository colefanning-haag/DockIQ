-- Full schema for StationIQ.
-- Run this in the Supabase SQL editor.
-- Safe to re-run — uses DROP IF EXISTS before creating.

-- ─── Commute patterns ────────────────────────────────────────────────────────
-- One row per station × day-of-week × pattern type.
-- pattern_type values:
--   morning_bikes_empty  → home station: when bikes run out (6–11 AM)
--   morning_docks_full   → work station: when docks fill up (6–11 AM)
--   evening_bikes_empty  → work station: when bikes run out (4–9 PM)
--   evening_docks_full   → home station: when docks fill up (4–9 PM)
-- minute values = minutes since midnight (e.g. 483 = 8:03 AM, 1023 = 5:03 PM)

drop table if exists station_empty_patterns;   -- replaced by station_commute_patterns

create table if not exists station_commute_patterns (
  station_id          text    not null,
  station_name        text,
  day_of_week         integer not null, -- 0=Sun 1=Mon … 6=Sat
  pattern_type        text    not null,
  median_minute       integer,
  p25_minute          integer,
  p75_minute          integer,
  earliest_minute     integer,
  pct_days_triggered  real,
  sample_days         integer,
  computed_at         timestamptz,
  primary key (station_id, day_of_week, pattern_type)
);

-- ─── Hourly availability ─────────────────────────────────────────────────────
-- One row per station × day-of-week × hour.
-- Covers 6–11 AM and 4–9 PM.
-- Bikes, ebikes, and docks all tracked so the app can show either side.

drop table if exists station_hourly_patterns;

create table station_hourly_patterns (
  station_id    text    not null,
  day_of_week   integer not null,
  hour          integer not null, -- 0–23
  p25_bikes     real,
  median_bikes  real,
  p75_bikes     real,
  p25_ebikes    real,
  median_ebikes real,
  p75_ebikes    real,
  p25_docks     real,
  median_docks  real,
  p75_docks     real,
  sample_count  integer,
  computed_at   timestamptz,
  primary key (station_id, day_of_week, hour)
);
