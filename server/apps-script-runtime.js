const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function encodeValue(value) {
  if (value instanceof Date) {
    return JSON.stringify({ type: 'date', value: value.toISOString() });
  }
  return JSON.stringify({ type: 'value', value });
}

function decodeValue(raw) {
  if (raw == null) return '';
  const parsed = JSON.parse(raw);
  return parsed.type === 'date' ? new Date(parsed.value) : parsed.value;
}

class SQLiteStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 60000;

      CREATE TABLE IF NOT EXISTS sheets (
        name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cells (
        sheet_name TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        column_number INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (sheet_name, row_number, column_number),
        FOREIGN KEY (sheet_name) REFERENCES sheets(name) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS properties (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS cells_sheet_row
        ON cells(sheet_name, row_number);
      CREATE INDEX IF NOT EXISTS cache_expiry
        ON cache(expires_at);
    `);

    this.insertSheetStatement = this.db.prepare(
      'INSERT OR IGNORE INTO sheets(name) VALUES (?)'
    );
    this.getCellStatement = this.db.prepare(`
      SELECT value_json FROM cells
      WHERE sheet_name = ? AND row_number = ? AND column_number = ?
    `);
    this.setCellStatement = this.db.prepare(`
      INSERT INTO cells(sheet_name, row_number, column_number, value_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sheet_name, row_number, column_number)
      DO UPDATE SET value_json = excluded.value_json
    `);
    this.deleteCellStatement = this.db.prepare(`
      DELETE FROM cells
      WHERE sheet_name = ? AND row_number = ? AND column_number = ?
    `);
  }

  hasSheet(name) {
    return Boolean(
      this.db.prepare('SELECT 1 FROM sheets WHERE name = ?').get(name)
    );
  }

  insertSheet(name) {
    this.insertSheetStatement.run(name);
  }

  getLastRow(name) {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(row_number), 0) AS value FROM cells WHERE sheet_name = ?'
    ).get(name);
    return Number(row.value);
  }

  getLastColumn(name) {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(column_number), 0) AS value FROM cells WHERE sheet_name = ?'
    ).get(name);
    return Number(row.value);
  }

  getValues(name, row, column, rowCount, columnCount) {
    const values = [];
    for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
      const current = [];
      for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
        const saved = this.getCellStatement.get(
          name, row + rowOffset, column + columnOffset
        );
        current.push(saved ? decodeValue(saved.value_json) : '');
      }
      values.push(current);
    }
    return values;
  }

  setValues(name, row, column, values) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      values.forEach((currentRow, rowOffset) => {
        currentRow.forEach((value, columnOffset) => {
          const targetRow = row + rowOffset;
          const targetColumn = column + columnOffset;
          if (value === '' || value == null) {
            this.deleteCellStatement.run(name, targetRow, targetColumn);
          } else {
            this.setCellStatement.run(
              name, targetRow, targetColumn, encodeValue(value)
            );
          }
        });
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  clear(name, row, column, rowCount, columnCount) {
    this.db.prepare(`
      DELETE FROM cells
      WHERE sheet_name = ?
        AND row_number BETWEEN ? AND ?
        AND column_number BETWEEN ? AND ?
    `).run(
      name,
      row,
      row + rowCount - 1,
      column,
      column + columnCount - 1
    );
  }

  getProperty(key) {
    const row = this.db.prepare(
      'SELECT value FROM properties WHERE key = ?'
    ).get(key);
    return row ? row.value : null;
  }

  setProperty(key, value) {
    this.db.prepare(`
      INSERT INTO properties(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getProperties() {
    const output = {};
    this.db.prepare('SELECT key, value FROM properties').all()
      .forEach((row) => {
        output[row.key] = row.value;
      });
    return output;
  }

  setProperties(values, deleteAllOthers) {
    if (deleteAllOthers) this.db.exec('DELETE FROM properties');
    Object.keys(values || {}).forEach((key) => {
      this.setProperty(key, values[key]);
    });
  }

  cacheGet(key) {
    this.db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(Date.now());
    const row = this.db.prepare(
      'SELECT value FROM cache WHERE key = ? AND expires_at > ?'
    ).get(key, Date.now());
    return row ? row.value : null;
  }

  cachePut(key, value, seconds) {
    this.db.prepare(`
      INSERT INTO cache(key, value, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        expires_at = excluded.expires_at
    `).run(key, String(value), Date.now() + Number(seconds || 600) * 1000);
  }

  cacheRemove(key) {
    this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
  }

  cacheGetAll(keys) {
    const output = {};
    keys.forEach((key) => {
      const value = this.cacheGet(key);
      if (value != null) output[key] = value;
    });
    return output;
  }
}

class RangeAdapter {
  constructor(store, sheetName, row, column, rowCount, columnCount) {
    this.store = store;
    this.sheetName = sheetName;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return this.store.getValues(
      this.sheetName, this.row, this.column, this.rowCount, this.columnCount
    );
  }

  getDisplayValues() {
    return this.getValues().map((row) => row.map((value) => {
      if (value instanceof Date) return formatDate(value, 'dd.MM.yyyy');
      return value == null ? '' : String(value);
    }));
  }

  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.rowCount) {
      throw new Error('Broj redova za upis nije ispravan.');
    }
    values.forEach((row) => {
      if (!Array.isArray(row) || row.length !== this.columnCount) {
        throw new Error('Broj kolona za upis nije ispravan.');
      }
    });
    this.store.setValues(this.sheetName, this.row, this.column, values);
    return this;
  }

  clearContent() {
    this.store.clear(
      this.sheetName, this.row, this.column, this.rowCount, this.columnCount
    );
    return this;
  }

  setNumberFormat() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
}

class SheetAdapter {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }

  getLastRow() { return this.store.getLastRow(this.name); }
  getLastColumn() { return this.store.getLastColumn(this.name); }
  getMaxRows() { return Math.max(this.getLastRow(), 1000); }
  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new RangeAdapter(
      this.store, this.name, row, column, rowCount, columnCount
    );
  }
  setFrozenRows() {}
  autoResizeColumns() {}
}

class SpreadsheetAdapter {
  constructor(store) {
    this.store = store;
  }

  getSheetByName(name) {
    return this.store.hasSheet(name)
      ? new SheetAdapter(this.store, name)
      : null;
  }

  insertSheet(name) {
    this.store.insertSheet(name);
    return new SheetAdapter(this.store, name);
  }
}

function formatDate(date, pattern) {
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  if (pattern === 'yyyy-MM-dd') return `${year}-${month}-${day}`;
  if (pattern === 'dd.MM.yyyy') return `${day}.${month}.${year}`;
  return value.toISOString();
}

function createRuntime(options) {
  const store = new SQLiteStore(options.databasePath);
  const spreadsheet = new SpreadsheetAdapter(store);
  const source = fs.readFileSync(options.appsScriptPath, 'utf8');

  const cache = {
    get: (key) => store.cacheGet(key),
    put: (key, value, seconds) => store.cachePut(key, value, seconds),
    remove: (key) => store.cacheRemove(key),
    getAll: (keys) => store.cacheGetAll(keys),
    removeAll: (keys) => keys.forEach((key) => store.cacheRemove(key))
  };

  const context = vm.createContext({
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Map,
    Set,
    Buffer,
    SpreadsheetApp: {
      openById: () => spreadsheet
    },
    CacheService: {
      getScriptCache: () => cache
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => store.getProperty(key),
        setProperty: (key, value) => store.setProperty(key, value),
        getProperties: () => store.getProperties(),
        setProperties: (values, deleteAllOthers) =>
          store.setProperties(values, deleteAllOthers)
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {}
      })
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Decode: (value) => Buffer.from(String(value), 'base64'),
      newBlob: (value) => ({
        getDataAsString: () => Buffer.from(value).toString('utf8')
      }),
      formatDate: (date, _timezone, pattern) => formatDate(date, pattern)
    },
    Session: {
      getScriptTimeZone: () => 'Europe/Belgrade'
    },
    ContentService: {
      MimeType: { JAVASCRIPT: 'text/javascript', JSON: 'application/json' },
      createTextOutput: (body) => ({
        body,
        setMimeType() { return this; }
      })
    }
  });

  vm.runInContext(source, context, {
    filename: options.appsScriptPath,
    displayErrors: true
  });
  context.setupApp();

  return {
    dispatch(action, args) {
      return context.dispatchApiArgs_(String(action || ''), args || []);
    },
    close() {
      store.db.close();
    }
  };
}

module.exports = { createRuntime };
