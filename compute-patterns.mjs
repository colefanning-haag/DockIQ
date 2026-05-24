import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, "dockiq.db");

// Bikes at or below this = station considered "empty"
const EMPTY_THRESHOLD = 2;

// Commute window we analyze (hour of day, inclusive)
const COMMUTE_START_HOUR = 6;
const COMMUTE_END_HOUR = 11;

const CHUNK = 500;

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

export async function computePatterns() {
  const supabaseUrl = process.env.SUPABASE_URL.trim().replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY.trim();
  console.log(`[patterns] Supabase URL: ${supabaseUrl}`);

  const db = new Database(DB_PATH, { readonly: true });

  console.log("[patterns] Reading commute-hour snapshots from SQLite…");
  const rows = db
    .prepare(
      `
      SELECT
        s.station_id,
        st.name                                        AS station_name,
        s.num_bikes_available,
        s.num_ebikes_available,
        CAST(strftime('%w', s.captured_at) AS INTEGER) AS dow,
        DATE(s.captured_at)                            AS day,
        CAST(strftime('%H', s.captured_at) AS INTEGER) * 60
          + CAST(strftime('%M', s.captured_at) AS INTEGER) AS minute_of_day,
        CAST(strftime('%H', s.captured_at) AS INTEGER) AS hour
      FROM snapshots s
      LEFT JOIN stations st ON st.station_id = s.station_id
      WHERE CAST(strftime('%H', s.captured_at) AS INTEGER)
            BETWEEN ? AND ?
      ORDER BY s.station_id, s.captured_at
    `
    )
    .all(COMMUTE_START_HOUR, COMMUTE_END_HOUR);

  db.close();
  console.log(`[patterns] Processing ${rows.length.toLocaleString()} rows…`);

  // Build: station → dow → day → snapshots[]
  const tree = new Map();
  for (const r of rows) {
    if (!tree.has(r.station_id)) {
      tree.set(r.station_id, { name: r.station_name, dows: new Map() });
    }
    const st = tree.get(r.station_id);
    if (!st.dows.has(r.dow)) st.dows.set(r.dow, new Map());
    const dw = st.dows.get(r.dow);
    if (!dw.has(r.day)) dw.set(r.day, []);
    dw.get(r.day).push(r);
  }

  const emptyPatterns = [];
  const hourlyPatterns = [];

  for (const [stationId, { name, dows }] of tree) {
    for (const [dow, days] of dows) {
      const emptyMinutes = [];
      const hourlyBikes = {};
      const hourlyEbikes = {};
      let totalDays = 0;

      for (const snapshots of days.values()) {
        totalDays++;

        // First snapshot in this day where bikes hit the empty threshold
        const firstEmpty = snapshots.find(
          (s) => s.num_bikes_available <= EMPTY_THRESHOLD
        );
        if (firstEmpty) emptyMinutes.push(firstEmpty.minute_of_day);

        for (const s of snapshots) {
          if (!hourlyBikes[s.hour]) {
            hourlyBikes[s.hour] = [];
            hourlyEbikes[s.hour] = [];
          }
          hourlyBikes[s.hour].push(s.num_bikes_available);
          hourlyEbikes[s.hour].push(s.num_ebikes_available);
        }
      }

      emptyMinutes.sort((a, b) => a - b);

      emptyPatterns.push({
        station_id: stationId,
        station_name: name,
        day_of_week: dow,
        median_empty_minute: emptyMinutes.length
          ? Math.round(percentile(emptyMinutes, 50))
          : null,
        p25_empty_minute: emptyMinutes.length
          ? Math.round(percentile(emptyMinutes, 25))
          : null,
        p75_empty_minute: emptyMinutes.length
          ? Math.round(percentile(emptyMinutes, 75))
          : null,
        earliest_empty_minute: emptyMinutes[0] ?? null,
        pct_days_empties:
          totalDays > 0 ? emptyMinutes.length / totalDays : 0,
        sample_days: totalDays,
        computed_at: new Date().toISOString(),
      });

      for (const [hour, bikes] of Object.entries(hourlyBikes)) {
        bikes.sort((a, b) => a - b);
        const ebikes = hourlyEbikes[hour].sort((a, b) => a - b);
        hourlyPatterns.push({
          station_id: stationId,
          day_of_week: dow,
          hour: parseInt(hour),
          p25_bikes: percentile(bikes, 25),
          median_bikes: percentile(bikes, 50),
          p75_bikes: percentile(bikes, 75),
          p25_ebikes: percentile(ebikes, 25),
          median_ebikes: percentile(ebikes, 50),
          p75_ebikes: percentile(ebikes, 75),
          sample_count: bikes.length,
          computed_at: new Date().toISOString(),
        });
      }
    }
  }

  await upsertChunked(supabaseUrl, supabaseKey, "station_empty_patterns", emptyPatterns);
  console.log(`[patterns] Wrote ${emptyPatterns.length} empty-pattern rows`);

  await upsertChunked(supabaseUrl, supabaseKey, "station_hourly_patterns", hourlyPatterns);
  console.log(`[patterns] Wrote ${hourlyPatterns.length} hourly-pattern rows`);
}

// Standalone: node compute-patterns.mjs
const isMain =
  process.argv[1] === fileURLToPath(import.meta.url);

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
