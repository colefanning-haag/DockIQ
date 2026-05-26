import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, "dockiq.db");

const EMPTY_THRESHOLD = 5; // bikes  ≤ this → station running low
const DOCK_THRESHOLD  = 5; // docks  ≤ this → station nearly full

const MORNING_START = 6;
const MORNING_END   = 11;
const EVENING_START = 16;
const EVENING_END   = 21;

// Upsert to Supabase every N stations to keep memory flat
const FLUSH_EVERY   = 100;
const CHUNK         = 500;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi
    ? sorted[lo]
    : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function upsertChunked(supabaseUrl, supabaseKey, table, rows) {
  if (!rows.length) return;
  const endpoint = `${supabaseUrl}/rest/v1/${table}`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows.slice(i, i + CHUNK)),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${table} upsert failed: HTTP ${res.status} — ${text}`);
    }
  }
}

function makePattern(stationId, name, dow, minutes, type, totalDays) {
  minutes.sort((a, b) => a - b);
  return {
    station_id:         stationId,
    station_name:       name,
    day_of_week:        parseInt(dow),
    pattern_type:       type,
    median_minute:      minutes.length ? Math.round(percentile(minutes, 50)) : null,
    p25_minute:         minutes.length ? Math.round(percentile(minutes, 25)) : null,
    p75_minute:         minutes.length ? Math.round(percentile(minutes, 75)) : null,
    earliest_minute:    minutes[0] ?? null,
    pct_days_triggered: totalDays > 0 ? minutes.length / totalDays : 0,
    sample_days:        totalDays,
    computed_at:        new Date().toISOString(),
  };
}

function processStation(stationId, name, rows) {
  // Group: dow → day → { morning[], evening[] }
  const dows = new Map();
  for (const r of rows) {
    if (!dows.has(r.dow)) dows.set(r.dow, new Map());
    const dw = dows.get(r.dow);
    if (!dw.has(r.day)) dw.set(r.day, { morning: [], evening: [] });
    const isMorning = r.hour >= MORNING_START && r.hour <= MORNING_END;
    dw.get(r.day)[isMorning ? "morning" : "evening"].push(r);
  }

  const commutePatterns = [];
  const hourlyPatterns  = [];

  for (const [dow, days] of dows) {
    const mBikeEmpty = [], mDockFull = [], eBikeEmpty = [], eDockFull = [];
    const hourlyData = {};
    let totalDays = 0;

    for (const { morning, evening } of days.values()) {
      totalDays++;

      const s1 = morning.find(s => s.num_bikes_available <= EMPTY_THRESHOLD);
      if (s1) mBikeEmpty.push(s1.minute_of_day);

      const s2 = morning.find(s => s.num_docks_available <= DOCK_THRESHOLD);
      if (s2) mDockFull.push(s2.minute_of_day);

      const s3 = evening.find(s => s.num_bikes_available <= EMPTY_THRESHOLD);
      if (s3) eBikeEmpty.push(s3.minute_of_day);

      const s4 = evening.find(s => s.num_docks_available <= DOCK_THRESHOLD);
      if (s4) eDockFull.push(s4.minute_of_day);

      for (const s of [...morning, ...evening]) {
        if (!hourlyData[s.hour]) hourlyData[s.hour] = { bikes: [], ebikes: [], docks: [] };
        hourlyData[s.hour].bikes.push(s.num_bikes_available);
        hourlyData[s.hour].ebikes.push(s.num_ebikes_available);
        hourlyData[s.hour].docks.push(s.num_docks_available);
      }
    }

    commutePatterns.push(
      makePattern(stationId, name, dow, mBikeEmpty, "morning_bikes_empty", totalDays),
      makePattern(stationId, name, dow, mDockFull,  "morning_docks_full",  totalDays),
      makePattern(stationId, name, dow, eBikeEmpty, "evening_bikes_empty", totalDays),
      makePattern(stationId, name, dow, eDockFull,  "evening_docks_full",  totalDays)
    );

    for (const [hour, data] of Object.entries(hourlyData)) {
      data.bikes.sort((a, b) => a - b);
      data.ebikes.sort((a, b) => a - b);
      data.docks.sort((a, b) => a - b);
      hourlyPatterns.push({
        station_id:    stationId,
        day_of_week:   parseInt(dow),
        hour:          parseInt(hour),
        p25_bikes:     percentile(data.bikes,  25),
        median_bikes:  percentile(data.bikes,  50),
        p75_bikes:     percentile(data.bikes,  75),
        p25_ebikes:    percentile(data.ebikes, 25),
        median_ebikes: percentile(data.ebikes, 50),
        p75_ebikes:    percentile(data.ebikes, 75),
        p25_docks:     percentile(data.docks,  25),
        median_docks:  percentile(data.docks,  50),
        p75_docks:     percentile(data.docks,  75),
        sample_count:  data.bikes.length,
        computed_at:   new Date().toISOString(),
      });
    }
  }

  return { commutePatterns, hourlyPatterns };
}

export async function computePatterns() {
  const supabaseUrl = process.env.SUPABASE_URL.trim().replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY.trim();
  console.log(`[patterns] Supabase URL: ${supabaseUrl}`);

  const db = new Database(DB_PATH, { readonly: true });

  const stations = db.prepare(`SELECT station_id, name FROM stations ORDER BY station_id`).all();
  console.log(`[patterns] Processing ${stations.length} stations one at a time…`);

  // Prepared query for a single station's commute-window rows
  const stationQuery = db.prepare(`
    SELECT
      s.num_bikes_available,
      s.num_ebikes_available,
      s.num_docks_available,
      CAST(strftime('%w', s.captured_at) AS INTEGER)     AS dow,
      DATE(s.captured_at)                                AS day,
      CAST(strftime('%H', s.captured_at) AS INTEGER) * 60
        + CAST(strftime('%M', s.captured_at) AS INTEGER) AS minute_of_day,
      CAST(strftime('%H', s.captured_at) AS INTEGER)     AS hour
    FROM snapshots s
    WHERE s.station_id = ?
      AND (
        CAST(strftime('%H', s.captured_at) AS INTEGER) BETWEEN ? AND ?
        OR
        CAST(strftime('%H', s.captured_at) AS INTEGER) BETWEEN ? AND ?
      )
    ORDER BY s.captured_at
  `);

  let pendingCommute  = [];
  let pendingHourly   = [];
  let totalCommute    = 0;
  let totalHourly     = 0;

  for (let i = 0; i < stations.length; i++) {
    const { station_id, name } = stations[i];
    const rows = stationQuery.all(station_id, MORNING_START, MORNING_END, EVENING_START, EVENING_END);

    if (rows.length === 0) continue;

    const { commutePatterns, hourlyPatterns } = processStation(station_id, name, rows);
    pendingCommute.push(...commutePatterns);
    pendingHourly.push(...hourlyPatterns);

    // Flush to Supabase every FLUSH_EVERY stations to keep memory flat
    if ((i + 1) % FLUSH_EVERY === 0 || i === stations.length - 1) {
      await upsertChunked(supabaseUrl, supabaseKey, "station_commute_patterns", pendingCommute);
      await upsertChunked(supabaseUrl, supabaseKey, "station_hourly_patterns",  pendingHourly);
      totalCommute += pendingCommute.length;
      totalHourly  += pendingHourly.length;
      console.log(`[patterns] ${i + 1}/${stations.length} stations — flushed ${totalCommute} commute + ${totalHourly} hourly rows so far`);
      pendingCommute = [];
      pendingHourly  = [];
    }
  }

  db.close();
  console.log(`[patterns] Done — ${totalCommute} commute-pattern rows, ${totalHourly} hourly-pattern rows`);
}

// Standalone: node compute-patterns.mjs
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
  }
  computePatterns()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[patterns] Failed:", err);
      process.exit(1);
    });
}
