import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, "dockiq.db");

// Thresholds for "empty" / "full"
const EMPTY_THRESHOLD = 2; // bikes  ≤ this → station empty
const DOCK_THRESHOLD  = 2; // docks  ≤ this → station full

// Time windows (hour of day, inclusive)
const MORNING_START = 6;
const MORNING_END   = 11;
const EVENING_START = 16;
const EVENING_END   = 21;

const CHUNK = 500;

// Four pattern types — the app picks the right one per station role
// morning_bikes_empty  → home station AM depart
// morning_docks_full   → work station AM arrive
// evening_bikes_empty  → work station PM depart
// evening_docks_full   → home station PM arrive

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
    station_id:          stationId,
    station_name:        name,
    day_of_week:         parseInt(dow),
    pattern_type:        type,
    median_minute:       minutes.length ? Math.round(percentile(minutes, 50)) : null,
    p25_minute:          minutes.length ? Math.round(percentile(minutes, 25)) : null,
    p75_minute:          minutes.length ? Math.round(percentile(minutes, 75)) : null,
    earliest_minute:     minutes[0] ?? null,
    pct_days_triggered:  totalDays > 0 ? minutes.length / totalDays : 0,
    sample_days:         totalDays,
    computed_at:         new Date().toISOString(),
  };
}

export async function computePatterns() {
  const supabaseUrl = process.env.SUPABASE_URL.trim().replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY.trim();
  console.log(`[patterns] Supabase URL: ${supabaseUrl}`);

  const db = new Database(DB_PATH, { readonly: true });

  console.log("[patterns] Reading morning + evening snapshots from SQLite…");
  const rows = db
    .prepare(
      `
      SELECT
        s.station_id,
        st.name                                          AS station_name,
        s.num_bikes_available,
        s.num_ebikes_available,
        s.num_docks_available,
        CAST(strftime('%w', s.captured_at) AS INTEGER)   AS dow,
        DATE(s.captured_at)                              AS day,
        CAST(strftime('%H', s.captured_at) AS INTEGER) * 60
          + CAST(strftime('%M', s.captured_at) AS INTEGER) AS minute_of_day,
        CAST(strftime('%H', s.captured_at) AS INTEGER)   AS hour
      FROM snapshots s
      LEFT JOIN stations st ON st.station_id = s.station_id
      WHERE (
        CAST(strftime('%H', s.captured_at) AS INTEGER) BETWEEN ? AND ?
        OR
        CAST(strftime('%H', s.captured_at) AS INTEGER) BETWEEN ? AND ?
      )
      ORDER BY s.station_id, s.captured_at
      `
    )
    .all(MORNING_START, MORNING_END, EVENING_START, EVENING_END);

  db.close();
  console.log(`[patterns] Processing ${rows.length.toLocaleString()} rows…`);

  // Group: station → dow → day → { morning[], evening[] }
  const tree = new Map();
  for (const r of rows) {
    if (!tree.has(r.station_id)) {
      tree.set(r.station_id, { name: r.station_name, dows: new Map() });
    }
    const st = tree.get(r.station_id);
    if (!st.dows.has(r.dow)) st.dows.set(r.dow, new Map());
    const dw = st.dows.get(r.dow);
    if (!dw.has(r.day)) dw.set(r.day, { morning: [], evening: [] });
    const isMorning = r.hour >= MORNING_START && r.hour <= MORNING_END;
    dw.get(r.day)[isMorning ? "morning" : "evening"].push(r);
  }

  const commutePatterns = [];
  const hourlyPatterns  = [];

  for (const [stationId, { name, dows }] of tree) {
    for (const [dow, days] of dows) {
      const mBikeEmptyMinutes = [];
      const mDockFullMinutes  = [];
      const eBikeEmptyMinutes = [];
      const eDockFullMinutes  = [];
      const hourlyData = {}; // hour → { bikes[], ebikes[], docks[] }
      let totalDays = 0;

      for (const { morning, evening } of days.values()) {
        totalDays++;

        // Morning: first snapshot where bikes hit empty threshold
        const mBikeEmpty = morning.find(s => s.num_bikes_available <= EMPTY_THRESHOLD);
        if (mBikeEmpty) mBikeEmptyMinutes.push(mBikeEmpty.minute_of_day);

        // Morning: first snapshot where docks hit full threshold
        const mDockFull = morning.find(s => s.num_docks_available <= DOCK_THRESHOLD);
        if (mDockFull) mDockFullMinutes.push(mDockFull.minute_of_day);

        // Evening: first snapshot where bikes hit empty threshold
        const eBikeEmpty = evening.find(s => s.num_bikes_available <= EMPTY_THRESHOLD);
        if (eBikeEmpty) eBikeEmptyMinutes.push(eBikeEmpty.minute_of_day);

        // Evening: first snapshot where docks hit full threshold
        const eDockFull = evening.find(s => s.num_docks_available <= DOCK_THRESHOLD);
        if (eDockFull) eDockFullMinutes.push(eDockFull.minute_of_day);

        // Hourly stats — both windows combined
        for (const s of [...morning, ...evening]) {
          if (!hourlyData[s.hour]) {
            hourlyData[s.hour] = { bikes: [], ebikes: [], docks: [] };
          }
          hourlyData[s.hour].bikes.push(s.num_bikes_available);
          hourlyData[s.hour].ebikes.push(s.num_ebikes_available);
          hourlyData[s.hour].docks.push(s.num_docks_available);
        }
      }

      commutePatterns.push(
        makePattern(stationId, name, dow, mBikeEmptyMinutes, "morning_bikes_empty", totalDays),
        makePattern(stationId, name, dow, mDockFullMinutes,  "morning_docks_full",  totalDays),
        makePattern(stationId, name, dow, eBikeEmptyMinutes, "evening_bikes_empty", totalDays),
        makePattern(stationId, name, dow, eDockFullMinutes,  "evening_docks_full",  totalDays)
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
  }

  await upsertChunked(supabaseUrl, supabaseKey, "station_commute_patterns", commutePatterns);
  console.log(`[patterns] Wrote ${commutePatterns.length} commute-pattern rows`);

  await upsertChunked(supabaseUrl, supabaseKey, "station_hourly_patterns", hourlyPatterns);
  console.log(`[patterns] Wrote ${hourlyPatterns.length} hourly-pattern rows`);
}

// Standalone: node compute-patterns.mjs
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
  }
  computePatterns()
    .then(() => {
      console.log("[patterns] Done");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[patterns] Failed:", err);
      process.exit(1);
    });
}
