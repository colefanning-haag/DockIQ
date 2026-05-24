-- Run this in the Supabase SQL editor before deploying the updated poller.

-- Hero stat: when does a station typically empty during morning commute?
-- minute values are minutes since midnight (e.g. 483 = 8:03 AM)
create table station_empty_patterns (
  station_id            text    not null,
  station_name          text,
  day_of_week           integer not null, -- 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  median_empty_minute   integer,          -- 50th percentile empty time
  p25_empty_minute      integer,          -- 25th percentile (emptied earlier than this 25% of days)
  p75_empty_minute      integer,          -- 75th percentile (the "safe window" upper bound)
  earliest_empty_minute integer,          -- worst case ever recorded
  pct_days_empties      real,             -- fraction of observed days where it emptied at all
  sample_days           integer,
  computed_at           timestamptz,
  primary key (station_id, day_of_week)
);

-- Hourly bar chart: typical bike availability by hour
create table station_hourly_patterns (
  station_id   text    not null,
  day_of_week  integer not null,
  hour         integer not null, -- 0-23
  p25_bikes    real,
  median_bikes real,
  p75_bikes    real,
  p25_ebikes   real,
  median_ebikes real,
  p75_ebikes   real,
  sample_count integer,
  computed_at  timestamptz,
  primary key (station_id, day_of_week, hour)
);
