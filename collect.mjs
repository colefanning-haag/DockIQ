import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "dockiq.db");

const STATION_INFORMATION_URL =
  "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json";
const STATION_STATUS_URL =
  "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json";

const POLL_MS = 5 * 60 * 1000;

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      station_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      capacity INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL,
      num_bikes_available INTEGER NOT NULL,
      num_docks_available INTEGER NOT NULL,
      num_ebikes_available INTEGER NOT NULL,
      is_renting INTEGER NOT NULL,
      is_returning INTEGER NOT NULL,
      last_reported INTEGER NOT NULL,
      captured_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at
      ON snapshots (captured_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_station_id
      ON snapshots (station_id);
  `);
  return db;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

function loadStations(db, stations) {
  const upsert = db.prepare(`
    INSERT INTO stations (station_id, name, lat, lon, capacity)
    VALUES (@station_id, @name, @lat, @lon, @capacity)
    ON CONFLICT(station_id) DO UPDATE SET
      name = excluded.name,
      lat = excluded.lat,
      lon = excluded.lon,
      capacity = excluded.capacity
  `);

  const tx = db.transaction((rows) => {
    for (const s of rows) {
      upsert.run({
        station_id: String(s.station_id),
        name: String(s.name ?? ""),
        lat: Number(s.lat),
        lon: Number(s.lon),
        capacity: Number(s.capacity ?? 0) | 0,
      });
    }
  });

  tx(stations);
}

function pollAndStore(db) {
  return fetchJson(STATION_STATUS_URL).then((payload) => {
    const stations = payload?.data?.stations;
    if (!Array.isArray(stations)) {
      throw new Error("station_status: missing data.stations array");
    }

    const capturedAt = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO snapshots (
        station_id,
        num_bikes_available,
        num_docks_available,
        num_ebikes_available,
        is_renting,
        is_returning,
        last_reported,
        captured_at
      ) VALUES (
        @station_id,
        @num_bikes_available,
        @num_docks_available,
        @num_ebikes_available,
        @is_renting,
        @is_returning,
        @last_reported,
        @captured_at
      )
    `);

    const tx = db.transaction((rows) => {
      for (const s of rows) {
        insert.run({
          station_id: String(s.station_id),
          num_bikes_available: Number(s.num_bikes_available ?? 0) | 0,
          num_docks_available: Number(s.num_docks_available ?? 0) | 0,
          num_ebikes_available: Number(s.num_ebikes_available ?? 0) | 0,
          is_renting: Number(s.is_renting ?? 0) | 0,
          is_returning: Number(s.is_returning ?? 0) | 0,
          last_reported: Number(s.last_reported ?? 0) | 0,
          captured_at: capturedAt,
        });
      }
    });

    tx(stations);
    return { count: stations.length, capturedAt };
  });
}

async function main() {
  const db = openDb();

  console.log("Loading station information…");
  const info = await fetchJson(STATION_INFORMATION_URL);
  const infoStations = info?.data?.stations;
  if (!Array.isArray(infoStations)) {
    throw new Error("station_information: missing data.stations array");
  }
  loadStations(db, infoStations);
  console.log(`Stored ${infoStations.length} stations in stations table.`);

  const runPoll = async () => {
    try {
      const { count, capturedAt } = await pollAndStore(db);
      console.log(
        `[${capturedAt}] Poll: captured ${count} station status rows.`,
      );
    } catch (err) {
      console.error("Poll failed:", err);
    }
  };

  await runPoll();
  setInterval(runPoll, POLL_MS);
  console.log(`Polling every ${POLL_MS / 60000} minutes. Press Ctrl+C to stop.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
