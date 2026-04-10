import Database from '@tauri-apps/plugin-sql';

let db = null;

export async function getDb() {
  if (db) return db;
  db = await Database.load('sqlite:rou_tools.db');
  return db;
}

export async function initDb() {
  const connection = await getDb();
  
  // Create Task table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_wavelength REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'PENDING_REVIEW'
    )
  `);

  // Create File Records table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS file_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks (id)
    )
  `);

  // Create Data Points table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS data_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      x_index INTEGER NOT NULL,
      original_value REAL,
      filtered_value REAL,
      is_deleted INTEGER DEFAULT 0,
      FOREIGN KEY (file_id) REFERENCES file_records (id)
    )
  `);

  // Create indexes for performance
  await connection.execute(`CREATE INDEX IF NOT EXISTS idx_file_id ON data_points(file_id)`);
  
  return connection;
}
