const APP = {
  spreadsheetId: '11R4ScsR11CeQIsqu-LfwMQsZbsU-jUGwJxjbUYOia4g',
  apiVersion: '1.18.3',
  sheets: {
    users: 'Login',
    schedule: 'Raspored',
    settings: 'Podesavanja'
  },
  roles: {
    admin: 'administrator',
    employee: 'zaposleni'
  },
  shifts: [
    { id: 1, name: 'I smena', start: '07:00', end: '15:00' },
    { id: 2, name: 'II smena', start: '15:00', end: '23:00' },
    { id: 3, name: 'III smena', start: '23:00', end: '07:00' }
  ],
  scheduleHeaders: [
    'Datum', 'Dan', 'Smena', 'Pocetak', 'Kraj', 'Ime', 'User',
    'UlogaSmene', 'Mesec', 'CycleIndex', 'Kreirano', 'ZamenjenZa', 'ZamenjujeIme'
  ]
};

/**
 * Public JSON/JSONP API used by the standalone index.html.
 * Deploy as a web app that executes as you and is accessible to anyone.
 */
function doGet(event) { 
  const params = event && event.parameter ? event.parameter : {};
  const callback = safeCallback_(params.callback);
  let response;

  try {
    response = {
      ok: true,
      data: dispatchApi_(String(params.action || 'health'), params)
    };
  } catch (error) {
    console.error(error);
    response = {
      ok: false,
      error: error && error.message ? error.message : String(error),
      transient: isTransientApiError_(error)
    };
  }

  const json = JSON.stringify(response)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function dispatchApi_(action, params) {
  const args = parseApiArgs_(params.payload);
  return dispatchApiArgs_(action, args);
}

function dispatchApiArgs_(action, args) {
  switch (action) {
    case 'health':
      return {
        status: 'ok',
        version: APP.apiVersion,
        spreadsheetId: APP.spreadsheetId
      };
    case 'getBootstrap':
      return getBootstrap();
    case 'login':
      return login(args[0]);
    case 'logout':
      return logout(args[0]);
    case 'getSchedule':
      return getSchedule(args[0], args[1], args[2]);
    case 'getAllSchedule':
      return getAllSchedule(args[0]);
    case 'getMonthSchedule':
      requireSession_(args[0]);
      return readMonth_(Number(args[1]), Number(args[2]));
    case 'getAdminSchedule':
      requireAdmin_(args[0]);
      return readAdminTimeline_();
    case 'getAdminData':
      return getAdminData(args[0]);
    case 'exportData':
      return exportData(args[0]);
    case 'importData':
      return withWriteLock_(function () {
        return importData(args[0], args[1]);
      });
    case 'saveUsers':
      return withWriteLock_(function () {
        return saveUsers(args[0], args[1]);
      });
    case 'generateSchedule':
      return withWriteLock_(function () {
        return generateSchedule(args[0], args[1]);
      });
    case 'editSchedule':
      return withWriteLock_(function () {
        return editSchedule(args[0], args[1]);
      });
    case 'swapEmployees':
      return withWriteLock_(function () {
        return swapEmployees(args[0], args[1]);
      });
    case 'replaceEmployee':
      return withWriteLock_(function () {
        return replaceEmployee(args[0], args[1]);
      });
    case 'uploadChunk':
      return uploadChunk_(args[0], args[1], args[2], args[3]);
    case 'executeUpload':
      return executeUpload_(args[0], args[1], args[2]);
    case 'getUploadResult':
      return getUploadResult_(args[0]);
    default:
      throw new Error('Nepoznata API akcija: ' + action);
  }
}

function parseApiArgs_(payload) {
  if (!payload) return [];
  let value;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new Error('API podaci nisu ispravan JSON.');
  }
  if (!Array.isArray(value)) throw new Error('API payload mora biti niz argumenata.');
  return value;
}

function safeCallback_(callback) {
  const value = String(callback || '');
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(value) ? value : '';
}

function isTransientApiError_(error) {
  const message = String(
    error && error.message ? error.message : error || ''
  ).toLowerCase();
  return message.indexOf('lock') >= 0 ||
    message.indexOf('service invoked too many times') >= 0 ||
    message.indexOf('service unavailable') >= 0 ||
    message.indexOf('internal error') >= 0 ||
    message.indexOf('timed out') >= 0 ||
    message.indexOf('try again') >= 0 ||
    message.indexOf('pokušajte ponovo') >= 0;
}

function withWriteLock_(operation) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) {
    throw new Error(
      'API je zauzet drugim upisom. Pokušajte ponovo za nekoliko sekundi.'
    );
  }
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

function uploadChunk_(uploadId, index, total, data) {
  const id = validateUploadId_(uploadId);
  const part = Number(index);
  const count = Number(total);
  if (!Number.isInteger(part) || !Number.isInteger(count) ||
      part < 0 || count < 1 || part >= count || count > 200) {
    throw new Error('Neispravan deo API prenosa.');
  }

  const cache = CacheService.getScriptCache();
  cache.put('upload:' + id + ':' + part, String(data || ''), 21600);
  return { received: part + 1, total: count };
}

function executeUpload_(uploadId, total, action) {
  const id = validateUploadId_(uploadId);
  const count = Number(total);
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new Error('Neispravan broj delova API prenosa.');
  }
  if (action === 'uploadChunk' || action === 'executeUpload') {
    throw new Error('Neispravna API akcija za prenos.');
  }

  const cache = CacheService.getScriptCache();
  const resultKey = 'upload-result:' + id;
  const savedResult = cache.get(resultKey);
  if (savedResult) {
    return JSON.parse(savedResult);
  }

  const keys = [];
  for (let index = 0; index < count; index += 1) {
    keys.push('upload:' + id + ':' + index);
  }
  const cached = cache.getAll(keys);
  const encoded = keys.map(function (key, index) {
    if (!Object.prototype.hasOwnProperty.call(cached, key)) {
      throw new Error('Nedostaje deo prenosa ' + (index + 1) + '. Pokušajte ponovo.');
    }
    return cached[key];
  }).join('');

  const payload = Utilities.newBlob(
    Utilities.base64Decode(encoded)
  ).getDataAsString('UTF-8');
  const result = dispatchApiArgs_(
    String(action || ''), parseApiArgs_(payload)
  );
  cache.put(resultKey, JSON.stringify(result), 600);
  cache.removeAll(keys);
  return result;
}

function getUploadResult_(uploadId) {
  const id = validateUploadId_(uploadId);
  const savedResult = CacheService.getScriptCache().get(
    'upload-result:' + id
  );
  return savedResult
    ? { ready: true, result: JSON.parse(savedResult) }
    : { ready: false };
}

function validateUploadId_(uploadId) {
  const value = String(uploadId || '');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(value)) {
    throw new Error('Neispravan identifikator API prenosa.');
  }
  return value;
}

function setupApp() {
  ensureSheets_();
  return {
    ok: true,
    message: 'Tabovi Login, Raspored i Podesavanja su spremni.'
  };
}

function getBootstrap() {
  ensureSheets_();
  return {
    today: dateKey_(new Date()),
    shifts: getShifts_(),
    schedule: serializeSchedule_(readRawSchedule_(), null),
    appName: getSetting_('Naziv aplikacije') || 'Raspored App'
  };
}

function login(username) {
  ensureSheets_();
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) throw new Error('Unesite korisničko ime.');

  const user = getUsers_().find(function (item) {
    return item.user.toLowerCase() === normalized && item.active;
  });
  if (!user) throw new Error('Korisnik nije pronađen ili nije aktivan.');

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(
    'session:' + token,
    JSON.stringify(user),
    21600
  );

  return {
    token: token,
    user: user,
    schedule: serializeSchedule_(readRawSchedule_(), user.user)
  };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('session:' + token);
  return { ok: true };
}

function getAdminData(token) {
  const admin = requireAdmin_(token);
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    admin: admin,
    users: getUsers_(),
    shifts: getShifts_(),
    defaults: {
      year: nextMonth.getFullYear(),
      month: nextMonth.getMonth() + 1,
      staffing: {
        1: { min: 2, max: 3 },
        2: { min: 2, max: 3 },
        3: { min: 2, max: 3 }
      }
    }
  };
}

function exportData(token) {
  requireAdmin_(token);
  const settingsSheet = getSpreadsheet_().getSheetByName(APP.sheets.settings);
  const settings = settingsSheet && settingsSheet.getLastRow() > 1
    ? settingsSheet.getRange(
        2, 1, settingsSheet.getLastRow() - 1, 2
      ).getDisplayValues()
    : [];
  const properties = PropertiesService.getScriptProperties();
  return {
    version: APP.apiVersion,
    exportedAt: new Date().toISOString(),
    users: getUsers_(),
    settings: settings,
    properties: typeof properties.getProperties === 'function'
      ? properties.getProperties()
      : {},
    schedule: readRawSchedule_().map(function (row) {
      return {
        date: dateKey_(row.date),
        day: row.day,
        shift: row.shift,
        start: row.start,
        end: row.end,
        name: row.name,
        user: row.user,
        duty: row.duty,
        month: row.month,
        cycleIndex: row.cycleIndex,
        created: row.created,
        replacedUser: row.replacedUser,
        replacedName: row.replacedName
      };
    })
  };
}

function importData(token, data) {
  requireAdmin_(token);
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.schedule)) {
    throw new Error('Podaci za uvoz nisu ispravni.');
  }

  saveUsers(token, data.users);

  const settingsSheet = getSpreadsheet_().getSheetByName(APP.sheets.settings);
  const settings = Array.isArray(data.settings) ? data.settings : [];
  if (settingsSheet.getLastRow() > 1) {
    settingsSheet.getRange(
      2, 1, settingsSheet.getLastRow() - 1, 2
    ).clearContent();
  }
  if (settings.length) {
    settingsSheet.getRange(2, 1, settings.length, 2).setValues(settings);
  }

  const rows = data.schedule.map(function (row) {
    return {
      date: normalizeSheetDate_(row.date),
      day: String(row.day || ''),
      shift: Number(row.shift),
      start: String(row.start || ''),
      end: String(row.end || ''),
      name: String(row.name || ''),
      user: String(row.user || ''),
      duty: String(row.duty || ''),
      month: String(row.month || ''),
      cycleIndex: Number(row.cycleIndex) || 0,
      created: Number(row.created) || Date.now(),
      replacedUser: String(row.replacedUser || ''),
      replacedName: String(row.replacedName || '')
    };
  }).filter(function (row) {
    return row.name && !isNaN(row.date.getTime()) &&
      row.shift >= 1 && row.shift <= 3;
  });
  rewriteScheduleRows_(rows);

  const properties = PropertiesService.getScriptProperties();
  if (data.properties && typeof properties.setProperties === 'function') {
    properties.setProperties(data.properties, false);
  } else {
    Object.keys(data.properties || {}).forEach(function (key) {
      properties.setProperty(key, data.properties[key]);
    });
  }

  return {
    ok: true,
    usersImported: data.users.length,
    rowsImported: rows.length
  };
}

function saveUsers(token, users) {
  requireAdmin_(token);
  if (!Array.isArray(users) || !users.length) {
    throw new Error('Potrebno je uneti najmanje jednog korisnika.');
  }

  const clean = users.map(function (item) {
    const name = String(item.name || '').trim();
    const user = String(item.user || '').trim().toLowerCase();
    const role = normalizeRole_(item.role);
    const duty = role === APP.roles.admin ? 'off' : normalizeDuty_(item.duty);
    const monitorShift = Math.max(1, Math.min(3, Number(item.monitorShift) || 1));
    const slavaDate = normalizeOptionalDateKey_(item.slavaDate);
    const vacationStart = normalizeVacationStart_(item.vacationStart);
    const vacationWeeks = vacationStart
      ? Math.max(1, Math.min(2, Number(item.vacationWeeks) || 2))
      : 0;
    if (!name || !user) throw new Error('Svaki korisnik mora imati ime i user.');
    if (!role) throw new Error('Nepoznata rola za korisnika ' + user + '.');
    if (role !== APP.roles.admin && !duty) {
      throw new Error('Nepoznata funkcija za korisnika ' + user + '.');
    }
    return [
      name, user, role, item.active !== false, duty || 'off', monitorShift,
      slavaDate, vacationStart, vacationWeeks
    ];
  });

  const duplicates = clean.map(function (row) { return row[1]; })
    .filter(function (value, index, all) {
      return all.indexOf(value) !== index;
    });
  if (duplicates.length) {
    throw new Error('User mora biti jedinstven: ' + duplicates[0]);
  }

  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.users);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 9).clearContent();
  sheet.getRange(2, 1, clean.length, 9).setValues(clean);
  return { ok: true, users: getUsers_() };
}

function generateSchedule(token, request) {
  requireAdmin_(token);
  const year = Number(request && request.year);
  const month = Number(request && request.month);
  if (!year || month < 1 || month > 12) {
    throw new Error('Godina ili mesec nisu ispravni.');
  }

  const users = getUsers_().filter(function (user) {
    return user.active && user.role === APP.roles.employee;
  });
  const configByUser = {};
  (request.employeeConfig || []).forEach(function (config) {
    configByUser[String(config.user || '').toLowerCase()] = config;
  });

  const configs = users.map(function (user, index) {
    const source = configByUser[user.user.toLowerCase()] || {};
    const duty = source.duty || user.duty || 'radnik';
    const automaticConfig = automaticAbsenceConfig_(user, year, month, duty);
    const weekOverrides = Object.assign(
      {}, source.weekOverrides || {}, automaticConfig.weekOverrides
    );
    const freeDates = Array.isArray(source.freeDates)
      ? source.freeDates.slice()
      : [];
    if (automaticConfig.slavaDate &&
        freeDates.indexOf(automaticConfig.slavaDate) < 0) {
      freeDates.push(automaticConfig.slavaDate);
    }
    return {
      name: user.name,
      user: user.user,
      active: source.active !== false,
      duty: duty,
      monitorShift: Number(source.monitorShift) || user.monitorShift || ((index % 3) + 1),
      monitorShiftByWeek: {},
      leaderOrder: Number(source.leaderOrder) || index,
      weekOverrides: normalizeWeekOverrides_(weekOverrides, duty),
      replacementInfo: source.replacementInfo || {},
      eligibleForReplacement: source.eligibleForReplacement === true,
      freeDates: freeDates,
      freeDayType: automaticConfig.slavaDate
        ? 'slava'
        : normalizeFreeDayType_(source.freeDayType)
    };
  }).filter(function (item) { return item.active; });

  if (!configs.length) throw new Error('Nema aktivnih zaposlenih za raspored.');

  applyReplacementRoles_(configs);
  const staffing = normalizeStaffing_(request.staffing);
  configs.forEach(function (person) {
    person.targetShifts = calculateTargetShifts_(year, month, person);
  });
  validateLeaderCoverage_(year, month, configs);
  const result = buildMonth_(year, month, configs, staffing);
  
  // Apply replacement info to rows
  result.rows = applyReplacementInfo_(result.rows, configs);
  
  writeMonth_(year, month, result.rows);
  saveMonthStaffing_(year, month, staffing, configs);

  return {
    ok: true,
    monthKey: monthKey_(year, month),
    rowsCreated: result.rows.length,
    warnings: result.warnings || []
  };
}

function getSchedule(token, fromOffset, days) {
  const user = token ? requireSession_(token) : null;
  return readScheduleWindow_(user ? user.user : null, fromOffset || 0, days || 35);
}

function getAllSchedule(token) {
  const user = token ? requireSession_(token) : null;
  return serializeSchedule_(readRawSchedule_(), user ? user.user : null);
}

function readAdminTimeline_() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const schedule = serializeSchedule_(readRawSchedule_().filter(function (row) {
    return row.date >= start;
  }), null);
  const staffingByMonth = {};
  const coverageByMonth = {};
  schedule.forEach(function (day) {
    const month = day.date.slice(0, 7);
    if (!staffingByMonth[month]) {
      staffingByMonth[month] = getMonthStaffing_(month);
      coverageByMonth[month] = getMonthCoverageMinimums_(month);
    }
    const staffing = staffingByMonth[month];
    if (!staffing) return;
    const coverage = coverageByMonth[month] || {};
    const date = parseDateKey_(day.date);
    day.minimums = {};
    day.maximums = {};
    prioritizedShiftsForDate_(date).forEach(function (shift) {
      const coverageOverride = coverage[day.date] &&
        Number(coverage[day.date][shift]);
      day.minimums[shift] = coverageOverride
        ? coverageOverride
        : requiredWorkerMinimum_(date, shift, staffing);
      day.maximums[shift] = coverageOverride
        ? coverageOverride
        : allowedWorkerMaximum_(date, shift, staffing);
    });
  });
  return schedule;
}

function saveMonthStaffing_(year, month, staffing, configs) {
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(
    'staffing:' + monthKey_(year, month),
    JSON.stringify(normalizeStaffing_(staffing))
  );
  const coverage = {};
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const missing = missingLeaderShiftsForDate_(configs || [], date);
    if (!Object.keys(missing).length) continue;
    const key = dateKey_(date);
    coverage[key] = {};
    [1, 2, 3].forEach(function (shift) {
      if (missing[shift]) coverage[key][shift] = staffing[shift].max;
    });
  }
  properties.setProperty(
    'coverage:' + monthKey_(year, month),
    JSON.stringify(coverage)
  );
}

function getMonthStaffing_(month) {
  const raw = PropertiesService.getScriptProperties().getProperty(
    'staffing:' + month
  );
  if (!raw) return null;
  try {
    return normalizeStaffing_(JSON.parse(raw));
  } catch (error) {
    return null;
  }
}

function getMonthCoverageMinimums_(month) {
  const raw = PropertiesService.getScriptProperties().getProperty(
    'coverage:' + month
  );
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (error) {
    return {};
  }
}

function editSchedule(token, request) {
  requireAdmin_(token);
  const action = String(request && request.action || '');
  const date = normalizeSheetDate_(request && request.date);
  const shift = Number(request && request.shift);
  const userKey = String(request && request.user || '').trim().toLowerCase();
  if (isNaN(date.getTime()) || shift < 1 || shift > 3 || !userKey) {
    throw new Error('Podaci za ručnu izmenu rasporeda nisu ispravni.');
  }

  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.schedule);
  if (!sheet) throw new Error('Tab Raspored nije pronađen.');
  const rows = readRawSchedule_();
  const dateKey = dateKey_(date);
  let changedPerson = null;
  let changedPeople = null;
  if (action === 'remove') {
    const matchingRows = rows.filter(function (row) {
      return dateKey_(row.date) === dateKey &&
        row.shift === shift && row.user.toLowerCase() === userKey;
    });
    if (!matchingRows.length) {
      throw new Error('Zaposleni nije pronađen u izabranoj smeni.');
    }
    changedPerson = {
      name: matchingRows[0].name,
      user: matchingRows[0].user,
      duty: matchingRows[0].duty
    };
    matchingRows.forEach(function (row) {
      sheet.getRange(
        row.rowIndex + 2, 1, 1, APP.scheduleHeaders.length
      ).clearContent();
    });
  } else if (action === 'add') {
    const user = getUsers_().find(function (item) {
      return item.active && item.role === APP.roles.employee &&
        item.user.toLowerCase() === userKey;
    });
    if (!user) throw new Error('Zaposleni nije pronađen ili nije aktivan.');
    const alreadyWorks = rows.some(function (row) {
      return dateKey_(row.date) === dateKey &&
        row.user.toLowerCase() === userKey;
    });
    if (alreadyWorks) {
      throw new Error(user.name + ' već ima smenu ' + formatDate_(date) + '.');
    }
    const selectedShift = getShifts_()[shift - 1];
    const savedCycle = rows.find(function (row) {
      return row.user.toLowerCase() === userKey &&
        row.date.getFullYear() === date.getFullYear() &&
        row.date.getMonth() === date.getMonth() &&
        Number.isFinite(row.cycleIndex);
    });
    changedPerson = {
      name: user.name,
      user: user.user,
      duty: 'Zaposleni'
    };
    const nextRow = Math.max(sheet.getLastRow() + 1, 2);
    sheet.getRange(nextRow, 1, 1, APP.scheduleHeaders.length).setValues([[
      date, dayName_(date), shift, selectedShift.start, selectedShift.end,
      user.name, user.user, 'Zaposleni',
      monthKey_(date.getFullYear(), date.getMonth() + 1),
      savedCycle ? savedCycle.cycleIndex : 0,
      new Date(), '', ''
    ]]);
    sheet.getRange(nextRow, 1).setNumberFormat('dd.MM.yyyy');
  } else if (action === 'assignLeader') {
    const shiftRows = rows.filter(function (row) {
      return dateKey_(row.date) === dateKey && row.shift === shift;
    });
    if (shiftRows.some(function (row) {
      return row.duty === 'Shift lider';
    })) {
      throw new Error('Izabrana smena već ima shift lidera.');
    }
    const matchingRow = shiftRows.find(function (row) {
      return row.user.toLowerCase() === userKey;
    });
    if (!matchingRow) {
      throw new Error('Zaposleni nije pronađen u izabranoj smeni.');
    }
    if (matchingRow.duty !== 'Zaposleni') {
      throw new Error('Za shift lidera može biti postavljen samo redovni zaposleni.');
    }
    const range = sheet.getRange(
      matchingRow.rowIndex + 2, 1, 1, APP.scheduleHeaders.length
    );
    const values = range.getValues()[0];
    values[7] = 'Shift lider';
    values[10] = new Date();
    range.setValues([values]);
    changedPerson = {
      name: matchingRow.name,
      user: matchingRow.user,
      duty: 'Shift lider'
    };
  } else if (action === 'assignMidShift') {
    if (shift !== 1 && shift !== 2) {
      throw new Error('Međusmena može biti postavljena samo u I ili II smeni.');
    }
    const shiftRows = rows.filter(function (row) {
      return dateKey_(row.date) === dateKey && row.shift === shift;
    });
    const matchingRow = shiftRows.find(function (row) {
      return row.user.toLowerCase() === userKey;
    });
    if (!matchingRow) {
      throw new Error('Zaposleni nije pronađen u izabranoj smeni.');
    }
    if (matchingRow.duty !== 'Zaposleni' && matchingRow.duty !== 'Međusmena') {
      throw new Error('Za međusmenu može biti postavljen samo redovni zaposleni.');
    }
    const activating = matchingRow.duty !== 'Međusmena';
    changedPeople = [];
    shiftRows.forEach(function (row) {
      if (row.duty !== 'Međusmena' && row.user.toLowerCase() !== userKey) {
        return;
      }
      const nextDuty = row.user.toLowerCase() === userKey && activating
        ? 'Međusmena'
        : 'Zaposleni';
      if (row.duty === nextDuty) return;
      const range = sheet.getRange(
        row.rowIndex + 2, 1, 1, APP.scheduleHeaders.length
      );
      const values = range.getValues()[0];
      values[7] = nextDuty;
      values[10] = new Date();
      range.setValues([values]);
      changedPeople.push({
        name: row.name,
        user: row.user,
        duty: nextDuty
      });
    });
    changedPerson = {
      name: matchingRow.name,
      user: matchingRow.user,
      duty: activating ? 'Međusmena' : 'Zaposleni'
    };
  } else {
    throw new Error('Nepoznata ručna izmena rasporeda.');
  }
  return {
    ok: true,
    change: {
      action: action,
      date: dateKey,
      shift: shift,
      person: changedPerson,
      people: changedPeople
    }
  };
}

function swapEmployees(token, request) {
  requireAdmin_(token);
  const date = normalizeSheetDate_(request && request.date);
  const firstUser = String(
    request && request.firstUser || ''
  ).trim().toLowerCase();
  const secondUser = String(
    request && request.secondUser || ''
  ).trim().toLowerCase();
  if (isNaN(date.getTime()) || !firstUser || !secondUser ||
      firstUser === secondUser) {
    throw new Error('Podaci za zamenu smena nisu ispravni.');
  }

  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.schedule);
  if (!sheet) throw new Error('Tab Raspored nije pronađen.');
  const key = dateKey_(date);
  const dayRows = readRawSchedule_().filter(function (row) {
    return dateKey_(row.date) === key;
  });
  const firstEmptyShift = parseEmptyShift_(firstUser);
  const secondEmptyShift = parseEmptyShift_(secondUser);
  if (firstEmptyShift || secondEmptyShift) {
    if (!firstEmptyShift === !secondEmptyShift) {
      throw new Error('Izaberite jedno prazno mesto i jednog zaposlenog.');
    }
    const targetShift = firstEmptyShift || secondEmptyShift;
    const employeeUser = firstEmptyShift ? secondUser : firstUser;
    return moveEmployeeToEmptyShift_(
      sheet, date, key, dayRows, employeeUser, targetShift
    );
  }

  const rows = dayRows.filter(function (row) {
    return row.user.toLowerCase() === firstUser ||
      row.user.toLowerCase() === secondUser;
  });
  const first = rows.find(function (row) {
    return row.user.toLowerCase() === firstUser;
  });
  const second = rows.find(function (row) {
    return row.user.toLowerCase() === secondUser;
  });
  if (!first || !second) {
    throw new Error('Oba zaposlena moraju raditi izabranog dana.');
  }
  if (first.duty !== 'Zaposleni' || second.duty !== 'Zaposleni') {
    throw new Error('Mogu se zameniti samo redovni zaposleni.');
  }
  if (first.shift === second.shift) {
    throw new Error('Izaberite zaposlene iz različitih smena.');
  }

  const firstShift = first.shift;
  const secondShift = second.shift;
  const firstRange = sheet.getRange(
    first.rowIndex + 2, 1, 1, APP.scheduleHeaders.length
  );
  const secondRange = sheet.getRange(
    second.rowIndex + 2, 1, 1, APP.scheduleHeaders.length
  );
  const firstValues = firstRange.getValues()[0];
  const secondValues = secondRange.getValues()[0];
  const firstShiftValues = firstValues.slice(2, 5);
  firstValues.splice(2, 3, secondValues[2], secondValues[3], secondValues[4]);
  secondValues.splice(
    2, 3, firstShiftValues[0], firstShiftValues[1], firstShiftValues[2]
  );
  firstValues[10] = new Date();
  secondValues[10] = new Date();
  firstRange.setValues([firstValues]);
  secondRange.setValues([secondValues]);

  return {
    ok: true,
    swap: {
      date: key,
      first: {
        user: first.user,
        name: first.name,
        fromShift: firstShift,
        toShift: secondShift
      },
      second: {
        user: second.user,
        name: second.name,
        fromShift: secondShift,
        toShift: firstShift
      }
    }
  };
}

function parseEmptyShift_(value) {
  const match = String(value || '').match(/^__empty_shift_([1-3])$/);
  return match ? Number(match[1]) : 0;
}

function moveEmployeeToEmptyShift_(
  sheet, date, key, dayRows, employeeUser, targetShift
) {
  const employee = dayRows.find(function (row) {
    return row.user.toLowerCase() === employeeUser;
  });
  if (!employee || employee.duty !== 'Zaposleni') {
    throw new Error('Izabrani zaposleni nije pronađen u rasporedu.');
  }
  if (employee.shift === targetShift) {
    throw new Error('Zaposleni je već u izabranoj smeni.');
  }

  const month = key.slice(0, 7);
  const staffing = getMonthStaffing_(month) || normalizeStaffing_(null);
  const coverage = getMonthCoverageMinimums_(month);
  const coverageOverride = coverage[key] && Number(coverage[key][targetShift]);
  const maximum = coverageOverride
    ? coverageOverride
    : allowedWorkerMaximum_(date, targetShift, staffing);
  const currentCount = dayRows.filter(function (row) {
    return row.shift === targetShift && row.duty === 'Zaposleni';
  }).length;
  if (currentCount >= maximum) {
    throw new Error('Izabrana smena je dostigla dozvoljeni maksimum.');
  }

  const selectedShift = getShifts_()[targetShift - 1];
  const range = sheet.getRange(
    employee.rowIndex + 2, 1, 1, APP.scheduleHeaders.length
  );
  const values = range.getValues()[0];
  const fromShift = employee.shift;
  values[2] = targetShift;
  values[3] = selectedShift.start;
  values[4] = selectedShift.end;
  values[10] = new Date();
  range.setValues([values]);

  return {
    ok: true,
    swap: {
      date: key,
      move: true,
      employee: {
        user: employee.user,
        name: employee.name,
        fromShift: fromShift,
        toShift: targetShift
      }
    }
  };
}

function replaceEmployee(token, request) {
  requireAdmin_(token);
  const fromUser = String(request && request.fromUser || '').trim().toLowerCase();
  const toUser = String(request && request.toUser || '').trim().toLowerCase();
  const fromDate = normalizeSheetDate_(request && request.fromDate);
  const toDate = normalizeSheetDate_(request && request.toDate);
  if (!fromUser || !toUser || fromUser === toUser ||
      isNaN(fromDate.getTime()) || isNaN(toDate.getTime()) ||
      fromDate > toDate) {
    throw new Error('Podaci za Replace nisu ispravni.');
  }

  const employees = getUsers_().filter(function (user) {
    return user.active && user.role === APP.roles.employee;
  });
  const firstEmployee = employees.find(function (user) {
    return user.user.toLowerCase() === fromUser;
  });
  const secondEmployee = employees.find(function (user) {
    return user.active && user.role === APP.roles.employee &&
      user.user.toLowerCase() === toUser;
  });
  if (!firstEmployee || !secondEmployee) {
    throw new Error('Izabrani zaposleni nisu pronađeni ili nisu aktivni.');
  }

  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.schedule);
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error('Raspored je prazan.');
  }
  const rowCount = sheet.getLastRow() - 1;
  const values = sheet.getRange(
    2, 1, rowCount, APP.scheduleHeaders.length
  ).getValues();
  let firstToSecond = 0;
  let secondToFirst = 0;
  const changedDates = {};
  values.forEach(function (row) {
    const date = normalizeSheetDate_(row[0]);
    if (isNaN(date.getTime()) || date < fromDate || date > toDate) return;

    const rowUser = String(row[6]).trim().toLowerCase();
    if (rowUser === fromUser) {
      row[5] = secondEmployee.name;
      row[6] = secondEmployee.user;
      firstToSecond += 1;
    } else if (rowUser === toUser) {
      row[5] = firstEmployee.name;
      row[6] = firstEmployee.user;
      secondToFirst += 1;
    } else {
      return;
    }

    row[10] = new Date();
    changedDates[dateKey_(date)] = true;
  });

  const rotated = firstToSecond + secondToFirst;
  if (!rotated) {
    throw new Error(
      'Nema smena izabranih zaposlenih u zadatom periodu.'
    );
  }

  sheet.getRange(2, 1, rowCount, APP.scheduleHeaders.length).setValues(values);
  return {
    ok: true,
    rotated: rotated,
    days: Object.keys(changedDates).length,
    firstToSecond: firstToSecond,
    secondToFirst: secondToFirst
  };
}

function ensureSheets_() {
  const ss = getSpreadsheet_();
  let users = ss.getSheetByName(APP.sheets.users);
  if (!users) users = ss.insertSheet(APP.sheets.users);
  if (users.getLastRow() === 0) {
    users.getRange(1, 1, 1, 9).setValues([
      [
        'Ime', 'User', 'Rola', 'Aktivan', 'Funkcija', 'MonitoringSmena',
        'SlavaDatum', 'OdmorOd', 'OdmorNedelje'
      ]
    ]);
    users.getRange(2, 1, 2, 9).setValues([
      ['Administrator', 'admin', APP.roles.admin, true, 'off', 1, '', '', ''],
      [
        'Primer Zaposlenog', 'zaposleni1', APP.roles.employee, true,
        'radnik', 1, '', '', ''
      ]
    ]);
    styleHeader_(users, 9);
    users.setFrozenRows(1);
  } else {
    if (users.getLastColumn() < 6) {
      users.getRange(1, 5, 1, 2)
        .setValues([['Funkcija', 'MonitoringSmena']]);
      if (users.getLastRow() > 1) {
        const roles = users.getRange(
          2, 3, users.getLastRow() - 1, 1
        ).getValues();
        const defaults = roles.map(function (row) {
          return [
            normalizeRole_(row[0]) === APP.roles.admin ? 'off' : 'radnik',
            1
          ];
        });
        users.getRange(2, 5, defaults.length, 2).setValues(defaults);
      }
    }
    if (users.getLastColumn() < 9) {
      users.getRange(1, 7, 1, 3)
        .setValues([['SlavaDatum', 'OdmorOd', 'OdmorNedelje']]);
    }
    styleHeader_(users, 9);
  }

  let schedule = ss.getSheetByName(APP.sheets.schedule);
  if (!schedule) schedule = ss.insertSheet(APP.sheets.schedule);
  if (schedule.getLastRow() === 0) {
    schedule.getRange(1, 1, 1, APP.scheduleHeaders.length)
      .setValues([APP.scheduleHeaders]);
    styleHeader_(schedule, APP.scheduleHeaders.length);
    schedule.setFrozenRows(1);
  } else if (schedule.getLastColumn() < APP.scheduleHeaders.length) {
    schedule.getRange(1, 1, 1, APP.scheduleHeaders.length)
      .setValues([APP.scheduleHeaders]);
    styleHeader_(schedule, APP.scheduleHeaders.length);
  }

  let settings = ss.getSheetByName(APP.sheets.settings);
  if (!settings) settings = ss.insertSheet(APP.sheets.settings);
  if (settings.getLastRow() === 0) {
    settings.getRange(1, 1, 1, 2).setValues([['Podesavanje', 'Vrednost']]);
    settings.getRange(2, 1, 7, 2).setValues([
      ['Naziv aplikacije', 'Raspored App'],
      ['I smena početak', '07:00'],
      ['I smena kraj', '15:00'],
      ['II smena početak', '15:00'],
      ['II smena kraj', '23:00'],
      ['III smena početak', '23:00'],
      ['III smena kraj', '07:00']
    ]);
    styleHeader_(settings, 2);
    settings.setFrozenRows(1);
  }
  migrateLegacyShiftTimes_(settings);
}

function migrateLegacyShiftTimes_(settings) {
  if (!settings || settings.getLastRow() < 2) return;
  const range = settings.getRange(2, 1, settings.getLastRow() - 1, 2);
  const values = range.getValues();
  const replacements = {
    'I smena početak|06:00': '07:00',
    'I smena kraj|14:00': '15:00',
    'II smena početak|14:00': '15:00',
    'II smena kraj|22:00': '23:00',
    'III smena početak|22:00': '23:00',
    'III smena kraj|06:00': '07:00'
  };
  let changed = false;
  values.forEach(function (row) {
    const key = String(row[0]) + '|' + String(row[1]);
    if (!Object.prototype.hasOwnProperty.call(replacements, key)) return;
    row[1] = replacements[key];
    changed = true;
  });
  if (changed) range.setValues(values);
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(APP.spreadsheetId);
}

function getUsers_() {
  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.users);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues()
    .filter(function (row) { return row[0] && row[1]; })
    .map(function (row) {
      return {
        name: String(row[0]).trim(),
        user: String(row[1]).trim(),
        role: normalizeRole_(row[2]) || APP.roles.employee,
        active: row[3] !== false && String(row[3]).toLowerCase() !== 'ne',
        duty: normalizeDuty_(row[4]) || (
          normalizeRole_(row[2]) === APP.roles.admin ? 'off' : 'radnik'
        ),
        monitorShift: Math.max(1, Math.min(3, Number(row[5]) || 1)),
        slavaDate: normalizeOptionalDateKey_(row[6]),
        vacationStart: normalizeVacationStart_(row[7]),
        vacationWeeks: row[7]
          ? Math.max(1, Math.min(2, Number(row[8]) || 2))
          : 0
      };
    });
}

function normalizeOptionalDateKey_(value) {
  if (!value) return '';
  const date = normalizeSheetDate_(value);
  return date instanceof Date && !isNaN(date.getTime()) ? dateKey_(date) : '';
}

function normalizeVacationStart_(value) {
  const key = normalizeOptionalDateKey_(value);
  if (!key) return '';
  const date = parseDateKey_(key);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return dateKey_(date);
}

function automaticAbsenceConfig_(user, year, month, duty) {
  const output = { slavaDate: '', weekOverrides: {} };
  if (user.slavaDate) {
    const slavaParts = user.slavaDate.split('-').map(Number);
    const slava = new Date(year, slavaParts[1] - 1, slavaParts[2], 12);
    if (slava.getFullYear() === year && slava.getMonth() + 1 === month &&
        slava.getDate() === slavaParts[2]) {
      output.slavaDate = dateKey_(slava);
    }
  }
  if (!user.vacationStart || !user.vacationWeeks) return output;

  const vacationStart = parseDateKey_(user.vacationStart);
  const vacationEnd = new Date(vacationStart);
  vacationEnd.setDate(
    vacationEnd.getDate() + Number(user.vacationWeeks) * 7 - 1
  );
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    if (date < vacationStart || date > vacationEnd) continue;
    output.weekOverrides[String(mondayWeekIndex_(date))] = 'off';
  }
  return output;
}

function normalizeRole_(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === APP.roles.admin || value === 'admin') return APP.roles.admin;
  if (value === APP.roles.employee || value === 'employee') return APP.roles.employee;
  return '';
}

function normalizeDuty_(duty) {
  const value = String(duty || '').trim().toLowerCase();
  return ['radnik', 'shift_lider', 'monitoring', 'off'].indexOf(value) >= 0
    ? value
    : '';
}

function normalizeWeekOverrides_(overrides, baseDuty) {
  const output = {};
  Object.keys(overrides || {}).forEach(function (week) {
    const duty = String(overrides[week] || '').trim().toLowerCase();
    const allowed = ['radnik', 'shift_lider', 'monitoring', 'off'];
    if (baseDuty === 'radnik') allowed.push('zamena');
    if (allowed.indexOf(duty) >= 0 && duty !== baseDuty) output[week] = duty;
  });
  return output;
}

function normalizeFreeDayType_(type) {
  const value = String(type || '').trim().toLowerCase();
  return value === 'slava' ? 'slava' : 'drugo';
}

function applyReplacementRoles_(configs) {
  const byUser = {};
  configs.forEach(function (person) {
    byUser[person.user.toLowerCase()] = person;
  });
  configs.forEach(function (replacement) {
    Object.keys(replacement.replacementInfo || {}).forEach(function (week) {
      const absent = byUser[
        String(replacement.replacementInfo[week] || '').toLowerCase()
      ];
      if (!absent) return;
      if (absent.duty === 'monitoring') {
        delete replacement.replacementInfo[week];
        return;
      }
      if (absent.duty === 'shift_lider') {
        replacement.weekOverrides[week] = 'zamena';
      } else {
        replacement.weekOverrides[week] = 'radnik';
      }
    });
  });
}

function monitorShiftForWeek_(person, weekIndex) {
  return Number(
    person.monitorShiftByWeek &&
    person.monitorShiftByWeek[String(weekIndex)]
  ) || person.monitorShift;
}

function validateLeaderCoverage_(year, month, configs) {
  const baseLeaders = configs.filter(function (person) {
    return person.duty === 'shift_lider';
  }).sort(function (a, b) {
    return a.leaderOrder - b.leaderOrder;
  });
  if (!baseLeaders.length) return;

  configs.forEach(function (person) {
    person.replacedLeaderByWeek = {};
  });
  const replacementOwner = {};
  const checkedWeeks = {};
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const weekIndex = mondayWeekIndex_(date);
    if (checkedWeeks[weekIndex]) continue;
    checkedWeeks[weekIndex] = true;

    const missing = baseLeaders.filter(function (person) {
      return effectiveDuty_(person, weekIndex) !== 'shift_lider';
    });
    const replacements = leaderReplacementsForWeek_(configs, weekIndex);
    if (replacements.length > missing.length) {
      throw new Error(
        'Nedelja ' + (weekIndex + 1) + ': postavljeno je više zamena nego ' +
        'odsutnih shift lidera.'
      );
    }

    const remainingMissing = missing.slice();
    replacements.forEach(function (replacement) {
      const requestedOwner = String(
        replacement.replacementInfo[String(weekIndex)] || ''
      ).toLowerCase();
      if (requestedOwner) {
        const requestedIndex = remainingMissing.findIndex(function (leader) {
          return leader.user.toLowerCase() === requestedOwner;
        });
        if (requestedIndex >= 0) {
          replacementOwner[replacement.user] =
            remainingMissing[requestedIndex].user;
          replacement.replacedLeaderByWeek[String(weekIndex)] =
            remainingMissing[requestedIndex].user;
          remainingMissing.splice(requestedIndex, 1);
          return;
        }
      }
      const owner = replacementOwner[replacement.user];
      if (!owner) return;
      const missingIndex = remainingMissing.findIndex(function (leader) {
        return leader.user === owner;
      });
      if (missingIndex < 0) {
        throw new Error(
          'Nedelja ' + (weekIndex + 1) + ': ' + replacement.name +
          ' je ranije menjao drugog shift lidera. Ista zamena mora naslediti ' +
          'istog lidera kroz ceo mesec.'
        );
      }
      replacement.replacedLeaderByWeek[String(weekIndex)] = owner;
      remainingMissing.splice(missingIndex, 1);
    });

    replacements.filter(function (replacement) {
      return !replacementOwner[replacement.user];
    }).forEach(function (replacement) {
      const leader = remainingMissing.shift();
      replacementOwner[replacement.user] = leader.user;
      replacement.replacedLeaderByWeek[String(weekIndex)] = leader.user;
    });
  }
}

function leaderReplacementsForWeek_(configs, weekIndex) {
  return configs.filter(function (person) {
    const duty = effectiveDuty_(person, weekIndex);
    return person.duty === 'radnik' &&
      (duty === 'zamena' || duty === 'shift_lider');
  }).sort(function (a, b) {
    return a.leaderOrder - b.leaderOrder;
  });
}

function leaderAssignmentsForDate_(configs, date) {
  const weekIndex = mondayWeekIndex_(date);
  const baseLeaders = configs.filter(function (person) {
    return person.duty === 'shift_lider';
  }).sort(function (a, b) {
    return a.leaderOrder - b.leaderOrder;
  });
  const replacements = leaderReplacementsForWeek_(configs, weekIndex);

  return baseLeaders.map(function (leader, slotIndex) {
    const available = effectiveDuty_(leader, weekIndex) === 'shift_lider';
    const replacement = replacements.find(function (person) {
      return person.replacedLeaderByWeek &&
        person.replacedLeaderByWeek[String(weekIndex)] === leader.user;
    });
    return {
      person: available ? leader : replacement,
      shift: leaderShiftForDate_(date, slotIndex),
      replacedLeader: available ? '' : leader.user
    };
  }).filter(function (assignment) {
    return Boolean(assignment.person);
  });
}

function missingLeaderShiftsForDate_(configs, date) {
  if (date.getDay() === 0 || date.getDay() === 6) return {};
  const weekIndex = mondayWeekIndex_(date);
  const baseLeaders = configs.filter(function (person) {
    return person.duty === 'shift_lider';
  }).sort(function (a, b) {
    return a.leaderOrder - b.leaderOrder;
  });
  const replacements = leaderReplacementsForWeek_(configs, weekIndex);
  const missing = {};
  baseLeaders.forEach(function (leader, slotIndex) {
    if (effectiveDuty_(leader, weekIndex) === 'shift_lider') return;
    const replacement = replacements.find(function (person) {
      return person.replacedLeaderByWeek &&
        person.replacedLeaderByWeek[String(weekIndex)] === leader.user;
    });
    if (!replacement) {
      missing[leaderShiftForDate_(date, slotIndex)] = true;
    }
  });
  return missing;
}

function leaderShiftForDate_(date, slotIndex) {
  const rotation = [3, 2, 1];
  const position = (mondayWeekIndex_(date) + slotIndex) % 3;
  return rotation[position];
}

function requireSession_(token) {
  const raw = token && CacheService.getScriptCache().get('session:' + token);
  if (!raw) throw new Error('Sesija je istekla. Prijavite se ponovo.');
  return JSON.parse(raw);
}

function requireAdmin_(token) {
  const user = requireSession_(token);
  if (user.role !== APP.roles.admin) {
    throw new Error('Ova opcija je dostupna samo administratoru.');
  }
  return user;
}

function getSetting_(key) {
  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.settings);
  if (!sheet || sheet.getLastRow() < 2) return '';
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  const found = rows.find(function (row) { return row[0] === key; });
  return found ? found[1] : '';
}

function getShifts_() {
  return APP.shifts.map(function (shift) {
    const roman = shift.id === 1 ? 'I' : shift.id === 2 ? 'II' : 'III';
    return {
      id: shift.id,
      name: shift.name,
      start: getSetting_(roman + ' smena početak') || shift.start,
      end: getSetting_(roman + ' smena kraj') || shift.end
    };
  });
}

function normalizeStaffing_(staffing) {
  const output = {};
  [1, 2, 3].forEach(function (shift) {
    const source = staffing && (staffing[shift] || staffing[String(shift)]);
    const min = Math.max(2, Math.min(4, Number(source && source.min) || 2));
    const max = Math.max(min + 1, Math.min(5, Number(source && source.max) || min + 1));
    output[shift] = { min: min, max: max };
  });
  return output;
}

function baseTargetShifts_(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  return daysInMonth === 31 ? 21 : daysInMonth === 30 ? 20 : 19;
}

function calculateTargetShifts_(year, month, person) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const baseTarget = baseTargetShifts_(year, month);
  let unavailableDays = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    if (effectiveDuty_(person, mondayWeekIndex_(date)) === 'off') {
      unavailableDays += 1;
    }
  }
  let target = Math.round(
    (daysInMonth - unavailableDays) / (daysInMonth / baseTarget)
  );
  if (person.freeDayType === 'slava' && (person.freeDates || []).length) {
    target -= 1;
  }
  return Math.max(0, target);
}

function targetFor_(person, fallback) {
  return Number.isFinite(person.targetShifts) ? person.targetShifts : fallback;
}

function targetWithinTolerance_(count, target) {
  return Math.abs(count - target) <= 1;
}

function buildMonth_(year, month, configs, staffing) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const target = daysInMonth === 31 ? 21 : daysInMonth === 30 ? 20 : 19;
  const shifts = getShifts_();
  const warnings = [];
  const targetWorkers = configs.filter(function (person) {
    return person.duty === 'radnik';
  });
  if (!targetWorkers.length) throw new Error('Nema zaposlenih sa osnovnom rolom Radnik.');

  const cycle = getCycleTemplate_(staffing);
  [1, 2, 3].forEach(function (shift) {
    const eligiblePositions = cycle.filter(function (plannedShift, position) {
      return plannedShift === shift ||
        getCycleCorrectionShift_(cycle, position) === shift;
    }).length;
    const requiredWorkers = Math.ceil(
      staffing[shift].min * cycle.length / eligiblePositions
    );
    if (targetWorkers.length < requiredWorkers) {
      warnings.push(
        'Za minimum od ' + staffing[shift].min + ' radnika u ' +
        roman_(shift) + ' smeni potrebno je najmanje ' +
        requiredWorkers + ' zaposlenih zbog obaveznih odmora; raspored će ' +
        'ipak biti napravljen i manjak će biti označen.'
      );
    }
  });

  let totalMinimum = 0;
  let totalCapacity = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const missingLeaderShifts = missingLeaderShiftsForDate_(configs, date);
    for (let shift = 1; shift <= 3; shift += 1) {
      totalMinimum += missingLeaderShifts[shift]
        ? staffing[shift].max
        : requiredWorkerMinimum_(date, shift, staffing);
      totalCapacity += missingLeaderShifts[shift]
        ? staffing[shift].max
        : allowedWorkerMaximum_(date, shift, staffing);
    }
  }
  const specialTargetShifts = countTargetWorkerSpecialShifts_(
    year, month, configs, targetWorkers
  );
  totalMinimum += specialTargetShifts;
  totalCapacity += specialTargetShifts;
  const totalTarget = targetWorkers.reduce(function (sum, person) {
    return sum + person.targetShifts;
  }, 0);
  if (totalTarget < totalMinimum) {
    warnings.push(
      'Nema dovoljno ukupnih smena za zadati minimum: dostupno je ' +
      totalTarget + ', a potrebno najmanje ' + totalMinimum + '.'
    );
  }
  if (totalTarget > totalCapacity) {
    warnings.push(
      'Tačan fond nije moguć: zbir fondova je ' + totalTarget +
      ' smena, a pravila praznika, vikenda i ponedeljka dozvoljavaju najviše ' +
      totalCapacity + ' smena. Raspored će biti napravljen sa napomenama.'
    );
  }

  const scheduleRows = readRawSchedule_();
  const initialStates = {};
  configs.forEach(function (person, index) {
    initialStates[person.user] = monthStartState_(
      getPreviousState_(
        person.user, year, month, index, scheduleRows
      )
    );
  });

  let lastFailure = 'Nije pronađena kombinacija koja ispunjava sva pravila.';
  let bestResult = null;
  let bestWarningCount = Infinity;
  let attemptsWithoutImprovement = 0;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (Date.now() - startedAt > 240000) {
      if (bestResult) return bestResult;
      throw new Error(
        'Generator nije pronašao rešenje u dozvoljenom vremenu. ' +
        lastFailure + ' Promenite raspon ili slobodne datume.'
      );
    }
    const result = tryBuildMonth_(
      year, month, daysInMonth, configs, targetWorkers, staffing, target,
      shifts, attempt, initialStates
    );
    if (result.ok) {
      const candidate = {
        rows: result.rows,
        warnings: warnings.concat(result.warnings || [])
      };
      if (result.complete) return candidate;
      if (candidate.warnings.length < bestWarningCount) {
        bestResult = candidate;
        bestWarningCount = candidate.warnings.length;
        attemptsWithoutImprovement = 0;
      } else {
        attemptsWithoutImprovement += 1;
      }
      if (bestResult && attemptsWithoutImprovement >= 30) return bestResult;
      continue;
    }
    attemptsWithoutImprovement += 1;
    if (bestResult && attemptsWithoutImprovement >= 30) return bestResult;
    lastFailure = result.error || lastFailure;
  }
  if (bestResult) return bestResult;
  throw new Error(lastFailure + ' Promenite raspon broja ljudi ili obavezne slobodne datume.');
}

function countTargetWorkerSpecialShifts_(
  year, month, configs, targetWorkers
) {
  const targetUsers = {};
  targetWorkers.forEach(function (person) {
    targetUsers[person.user] = true;
  });
  let count = 0;
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const weekIndex = mondayWeekIndex_(date);
    configs.forEach(function (person) {
      if (!targetUsers[person.user]) return;
      const duty = effectiveDuty_(person, weekIndex);
      if (duty === 'zamena' || duty === 'shift_lider' ||
          duty === 'monitoring') {
        count += 1;
      }
    });
  }
  return count;
}

function tryBuildMonth_(
  year, month, daysInMonth, configs, targetWorkers, staffing,
  target, shifts, attempt, initialStates
) {
  const cycleResult = tryBuildCyclePhased_(
    year, month, daysInMonth, configs, targetWorkers, staffing,
    target, shifts, attempt, initialStates
  );
  return cycleResult;
}

function tryBuildCyclePhased_(
  year, month, daysInMonth, configs, targetWorkers, staffing,
  target, shifts, attempt, initialStates
) {
  const cycle = getCycleTemplate_(staffing);
  const fullMonthTarget = baseTargetShifts_(year, month);
  const assignments = {};
  const counts = {};
  const states = {};
  const targetUsers = {};
  const cyclePositions = {};
  const monthStartShifts = {};
  targetWorkers.forEach(function (person, index) {
    targetUsers[person.user] = true;
    const fallbackPosition = initialStates[person.user].hasPrevious
      ? Number(initialStates[person.user].cycleIndex || 0) % cycle.length
      : (index + attempt) % cycle.length;
    cyclePositions[person.user] = cyclePositionFromRecentHistory_(
      cycle, initialStates[person.user], fallbackPosition
    );
    monthStartShifts[person.user] = monthStartShiftsFromRecentHistory_(
      initialStates[person.user]
    );
  });
  configs.forEach(function (person) {
    counts[person.user] = 0;
    states[person.user] = Object.assign({}, initialStates[person.user]);
  });

  // Priprema praznog meseca.
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    assignments[key] = {
      1: [],
      2: [],
      3: [],
      missingLeaderShifts: missingLeaderShiftsForDate_(configs, date)
    };
  }

  // Faza 1: osnovni shift lideri i njihove određene zamene.
  const baseLeaders = configs.filter(function (person) {
    return person.duty === 'shift_lider';
  }).sort(function (a, b) {
    return a.leaderOrder - b.leaderOrder;
  });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    baseLeaders.forEach(function (leader, slotIndex) {
      const shift = leaderShiftForDate_(date, slotIndex);
      assignFixedPerson_(
        assignments[key][shift], leader, 'Shift lider',
        states, counts, shift
      );
      if (effectiveDuty_(leader, weekIndex) === 'shift_lider') return;
      const replacement = targetWorkers.find(function (person) {
        return person.replacedLeaderByWeek &&
          person.replacedLeaderByWeek[String(weekIndex)] === leader.user;
      });
      if (replacement && !isAssigned_(assignments[key], replacement.user)) {
        assignFixedPerson_(
          assignments[key][shift], replacement, 'Shift lider',
          states, counts, shift
        );
      }
    });
  }

  // Faza 2: monitoring i svi radnici dobijaju osnovni šablon. Odsustva i
  // zamene se još ne primenjuju, pa osnovni raspored ostaje netaknut.
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    if (date.getDay() >= 1 && date.getDay() <= 5) {
      configs.filter(function (person) {
        return person.duty === 'monitoring' ||
          (person.duty === 'radnik' &&
            effectiveDuty_(person, weekIndex) === 'monitoring');
      }).forEach(function (person) {
        if (isAssigned_(assignments[key], person.user)) return;
        const shift = monitorShiftForWeek_(person, weekIndex);
        assignFixedPerson_(
          assignments[key][shift], person, 'Monitoring ' + roman_(shift),
          states, counts, shift
        );
      });
    }
    targetWorkers.forEach(function (person) {
      if (isAssigned_(assignments[key], person.user)) return;
      if (day <= Number(initialStates[person.user].restRemaining || 0)) {
        return;
      }
      const position = (cyclePositions[person.user] + day - 1) % cycle.length;
      const boundaryShifts = monthStartShifts[person.user];
      const shift = day <= 4 && boundaryShifts
        ? boundaryShifts[day - 1]
        : cycle[position];
      if (!shift || counts[person.user] >= fullMonthTarget) return;
      assignments[key][shift].push({ person: person, duty: 'Zaposleni' });
      counts[person.user] += 1;
    });
  }
  trimAllMaximumCoverage_(
    year, month, daysInMonth, assignments, staffing, counts
  );

  // Faza 3: minimum se dopunjava kao da zamene ne postoje. Prvo se koristi
  // treći slobodan dan uz narednu I/II smenu ili uz prethodnu III smenu.
  fillMinimumFromThreeDayRest_(
    year, month, daysInMonth, assignments, targetWorkers, staffing,
    counts, target, initialStates, attempt, true
  );
  fillAllMinimumCoverage_(
    year, month, daysInMonth, assignments, targetWorkers, staffing,
    counts, target, initialStates, attempt, true
  );

  // Faza 4: obavezni slobodni datumi brišu se tek iz napravljenog šablona,
  // zatim vikendom III smena ostaje na dva redovna radnika.
  removePreselectedFreeDates_(
    year, month, daysInMonth, assignments, configs, counts
  );
  trimWeekendThirdShift_(year, month, daysInMonth, assignments, counts);

  // Faza 5: uklanjaju se svi koji te nedelje ne rade, a njihovu stvarnu
  // smenu preuzima unapred povezana zamena.
  applyWeeklyAbsencesAndReplacements_(
    year, month, daysInMonth, assignments, configs, counts
  );

  // Zamena shift lidera ne radi subotu i nedelju u nedelji zamene.
  removeLeaderReplacementWeekends_(
    year, month, daysInMonth, assignments, targetWorkers, counts
  );

  // Faza 6: zameni se brišu samo suvišne redovne smene iznad njenog fonda.
  trimReplacementRestConflicts_(
    year, month, daysInMonth, assignments, targetWorkers, counts
  );
  trimReplacementOvertime_(
    year, month, daysInMonth, assignments, targetWorkers, staffing,
    counts, target
  );

  // Faza 7: svako ko je ispod fonda dopunjava se po istom principu odmora.
  fillMinimumFromThreeDayRest_(
    year, month, daysInMonth, assignments, targetWorkers, staffing,
    counts, target, initialStates, attempt, false
  );
  const quotaError = fillExactQuota_(
    year, month, daysInMonth, assignments, targetWorkers, staffing,
    counts, target, cycle, cyclePositions, initialStates, attempt
  );

  rebalanceAllCoverage_(
    year, month, daysInMonth, assignments, staffing, initialStates, attempt
  );

  // Faza 8: ukloni prelaze iz II smene u I smenu narednog dana. Radnik se
  // menja sa nekim iz II smene ko prethodnog dana nije radio II smenu.
  removeSecondToFirstTransitions_(
    year, month, daysInMonth, assignments, initialStates, attempt
  );

  // Završna zaštita ako je neka kasnija korekcija ipak vratila zamenu na vikend.
  removeLeaderReplacementWeekends_(
    year, month, daysInMonth, assignments, targetWorkers, counts
  );
  trimReplacementRestConflicts_(
    year, month, daysInMonth, assignments, targetWorkers, counts
  );
  repairNightRestForAllWorkers_(
    year, month, daysInMonth, assignments, targetWorkers, staffing,
    counts, initialStates, attempt
  );
  fillQuotaTolerance_(
    year, month, daysInMonth, assignments, targetWorkers, staffing,
    counts, target, initialStates, attempt
  );
  rebalanceQuotaDeficits_(
    year, month, daysInMonth, assignments, targetWorkers, counts,
    target, initialStates
  );
  removeSecondToFirstTransitions_(
    year, month, daysInMonth, assignments, initialStates, attempt
  );
  removeMonthStartNightRest_(
    year, month, assignments, targetWorkers, counts, initialStates
  );
  removeAllPlannedAbsences_(
    year, month, daysInMonth, assignments, configs, counts
  );

  const warnings = validateAllMinimumCoverage_(
    year, month, daysInMonth, assignments, staffing
  );
  const hasQuotaDeficit = targetWorkers.some(function (person) {
    return counts[person.user] < targetFor_(person, target) - 1;
  });
  if (quotaError && hasQuotaDeficit) warnings.push(quotaError);

  const validation = validateScheduleWithWarnings_(
    year, month, daysInMonth, assignments, targetWorkers, staffing, target
  );
  if (validation.error) return { ok: false, error: validation.error };
  targetWorkers.forEach(function (person) {
    states[person.user].cycleIndex = (
      cyclePositions[person.user] + daysInMonth
    ) % cycle.length;
  });
  const finalWarnings = unique_(warnings.concat(validation.warnings));
  const incomplete = finalWarnings.some(function (warning) {
    return warning.indexOf('ispod minimuma') >= 0 ||
      warning.indexOf('jer nije pronađena dostupna zamena') >= 0 ||
      warning.indexOf('planirani fond') >= 0 ||
      warning.indexOf('tačan fond') >= 0 ||
      warning.indexOf('nema dva slobodna dana posle') >= 0 ||
      warning.indexOf('Manje od 80% početaka') >= 0;
  });
  return {
    ok: true,
    complete: !incomplete,
    rows: assignmentsToRows_(
      year, month, assignments, shifts, states
    ),
    warnings: finalWarnings
  };
}

function removeMonthStartNightRest_(
  year, month, assignments, workers, counts, initialStates
) {
  workers.forEach(function (person) {
    const restDays = Number(
      initialStates[person.user] &&
      initialStates[person.user].restRemaining
    ) || 0;
    for (let day = 1; day <= restDays; day += 1) {
      removePersonAssignment_(
        day, year, month, assignments, person.user, counts
      );
    }
  });
}

function candidateKeepsTimelineValid_(
  year, month, daysInMonth, assignments, person, key, shift, initialState,
  ignorePlannedAbsences
) {
  assignments[key][shift].push({ person: person, duty: 'Zaposleni' });
  const valid = workerTimelineValid_(
    year, month, daysInMonth, person, assignments, initialState,
    ignorePlannedAbsences
  );
  assignments[key][shift].pop();
  return valid;
}

function fillMinimumFromThreeDayRest_(
  year, month, daysInMonth, assignments, workers, staffing,
  counts, target, initialStates, attempt, ignorePlannedAbsences
) {
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    prioritizedShiftsForDate_(date).forEach(function (shift) {
      const minimum = priorityCoverageTarget_(
        date, shift, staffing, assignments[key]
      );
      while (workerCount_(assignments[key][shift]) < minimum) {
        const candidates = workers.filter(function (person) {
          if ((!ignorePlannedAbsences &&
                effectiveDuty_(person, weekIndex) !== 'radnik') ||
              (!ignorePlannedAbsences && isFreeDate_(person, key)) ||
              (!ignorePlannedAbsences &&
                !canWorkSpecialBoundary_(person, date, shift)) ||
              isAssigned_(assignments[key], person.user) ||
              counts[person.user] >= targetFor_(person, target)) {
            return false;
          }
          if (!matchesThreeDayRestRule_(
            day, shift, year, month, daysInMonth,
            assignments, person.user
          )) {
            return false;
          }
          return candidateKeepsTimelineValid_(
            year, month, daysInMonth, assignments, person, key, shift,
            initialStates[person.user], ignorePlannedAbsences
          );
        }).sort(function (a, b) {
          const aDeficit = targetFor_(a, target) - counts[a.user];
          const bDeficit = targetFor_(b, target) - counts[b.user];
          return bDeficit - aDeficit ||
            pseudoRandom_(a.user + '|' + key + '|' + shift + '|' + attempt) -
            pseudoRandom_(b.user + '|' + key + '|' + shift + '|' + attempt);
        });
        if (!candidates.length) break;
        assignments[key][shift].push({
          person: candidates[0],
          duty: 'Zaposleni'
        });
        counts[candidates[0].user] += 1;
      }
    });
  }
}

function matchesThreeDayRestRule_(
  day, shift, year, month, daysInMonth, assignments, user
) {
  if (shift === 1 || shift === 2) {
    if (day + 1 > daysInMonth) return false;
    if (assignedShiftOnDay_(
      day + 1, year, month, assignments, user
    ) !== shift) {
      return false;
    }
    return [day - 2, day - 1, day].every(function (checkDay) {
      return checkDay >= 1 &&
        assignedShiftOnDay_(checkDay, year, month, assignments, user) === 0;
    });
  }
  if (day <= 1 || day + 2 > daysInMonth) return false;
  if (assignedShiftOnDay_(
    day - 1, year, month, assignments, user
  ) !== 3) {
    return false;
  }
  return [day, day + 1, day + 2].every(function (checkDay) {
    return assignedShiftOnDay_(
      checkDay, year, month, assignments, user
    ) === 0;
  });
}

function assignedShiftOnDay_(day, year, month, assignments, user) {
  const key = dateKey_(new Date(year, month - 1, day, 12));
  if (!assignments[key]) return 0;
  for (let shift = 1; shift <= 3; shift += 1) {
    if (assignments[key][shift].some(function (item) {
      return item.person.user === user;
    })) {
      return shift;
    }
  }
  return 0;
}

function removePreselectedFreeDates_(
  year, month, daysInMonth, assignments, configs, counts
) {
  const byUser = {};
  configs.forEach(function (person) {
    byUser[person.user] = person;
  });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKey_(new Date(year, month - 1, day, 12));
    [1, 2, 3].forEach(function (shift) {
      assignments[key][shift] = assignments[key][shift].filter(function (item) {
        const person = byUser[item.person.user] || item.person;
        if (!isFreeDate_(person, key)) return true;
        counts[item.person.user] -= 1;
        return false;
      });
    });
  }
}

function removeLeaderReplacementWeekends_(
  year, month, daysInMonth, assignments, workers, counts
) {
  const replacements = {};
  workers.forEach(function (person) {
    if (person.replacedLeaderByWeek &&
        Object.keys(person.replacedLeaderByWeek).length) {
      replacements[person.user] = person;
    }
  });

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    if (date.getDay() !== 0 && date.getDay() !== 6) continue;
    const key = dateKey_(date);

    [1, 2, 3].forEach(function (shift) {
      assignments[key][shift] = assignments[key][shift].filter(function (item) {
        const person = replacements[item.person.user];
        if (!person || !isLeaderReplacementWeekend_(person, date)) return true;
        counts[item.person.user] -= 1;
        return false;
      });
    });
  }
}

function applyWeeklyAbsencesAndReplacements_(
  year, month, daysInMonth, assignments, configs, counts
) {
  const replacements = {};
  configs.forEach(function (person) {
    Object.keys(person.replacementInfo || {}).forEach(function (week) {
      replacements[
        week + '|' + String(person.replacementInfo[week]).toLowerCase()
      ] = person;
    });
  });

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    configs.forEach(function (absent) {
      if (effectiveDuty_(absent, weekIndex) !== 'off') return;
      for (let shift = 1; shift <= 3; shift += 1) {
        const removed = assignments[key][shift].filter(function (item) {
          return item.person.user === absent.user;
        });
        if (!removed.length) continue;
        assignments[key][shift] = assignments[key][shift].filter(function (item) {
          return item.person.user !== absent.user;
        });
        counts[absent.user] -= removed.length;

        const replacement = replacements[
          String(weekIndex) + '|' + absent.user.toLowerCase()
        ];
        if (!replacement || isFreeDate_(replacement, key)) continue;
        const existingShift = assignedShiftOnDay_(
          day, year, month, assignments, replacement.user
        );
        if (existingShift === shift) continue;
        if (existingShift) {
          const existing = assignments[key][existingShift];
          const existingIndex = existing.findIndex(function (item) {
            return item.person.user === replacement.user;
          });
          if (existingIndex >= 0) {
            existing.splice(existingIndex, 1);
            counts[replacement.user] -= 1;
          }
        }
        const duty = removed[0].duty === 'Shift lider'
          ? 'Shift lider'
          : String(removed[0].duty).indexOf('Monitoring') === 0
            ? removed[0].duty
            : 'Zaposleni';
        assignments[key][shift].push({
          person: replacement,
          duty: duty,
          replacementFor: absent.user
        });
        counts[replacement.user] += 1;
      }
    });
  }
}

function removeAllPlannedAbsences_(
  year, month, daysInMonth, assignments, configs, counts
) {
  const byUser = {};
  configs.forEach(function (person) {
    byUser[person.user] = person;
  });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    for (let shift = 1; shift <= 3; shift += 1) {
      assignments[key][shift] = assignments[key][shift].filter(function (item) {
        const person = byUser[item.person.user];
        if (!person || effectiveDuty_(person, weekIndex) !== 'off') {
          return true;
        }
        counts[item.person.user] -= 1;
        return false;
      });
    }
  }
}

function trimReplacementOvertime_(
  year, month, daysInMonth, assignments, workers, staffing,
  counts, target
) {
  workers.forEach(function (person) {
    const personTarget = targetFor_(person, target);
    while (counts[person.user] > personTarget) {
      const candidates = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month - 1, day, 12);
        const key = dateKey_(date);
        for (let shift = 1; shift <= 3; shift += 1) {
          const list = assignments[key][shift];
          const index = list.findIndex(function (item) {
            return item.person.user === person.user &&
              item.duty === 'Zaposleni' &&
              !item.replacementFor;
          });
          if (index < 0 ||
              workerCount_(list) <= requiredCoverageMinimum_(
                date, shift, staffing, assignments[key]
              )) {
            continue;
          }
          const linked = Number(assignedShiftOnDay_(
            day - 1, year, month, assignments, person.user
          ) > 0) + Number(assignedShiftOnDay_(
            day + 1, year, month, assignments, person.user
          ) > 0);
          candidates.push({
            key: key,
            shift: shift,
            index: index,
            linked: linked
          });
        }
      }
      candidates.sort(function (a, b) {
        return b.linked - a.linked;
      });
      if (!candidates.length) break;
      const selected = candidates[0];
      assignments[selected.key][selected.shift].splice(selected.index, 1);
      counts[person.user] -= 1;
    }
  });
}

function trimReplacementRestConflicts_(
  year, month, daysInMonth, assignments, workers, counts
) {
  workers.filter(function (person) {
    return Object.keys(person.replacementInfo || {}).length > 0;
  }).forEach(function (person) {
    for (let day = 1; day <= daysInMonth; day += 1) {
      const shift = assignedShiftOnDay_(
        day, year, month, assignments, person.user
      );
      if (shift !== 3 || assignedShiftOnDay_(
        day + 1, year, month, assignments, person.user
      ) === 3) {
        continue;
      }
      const item = assignedItemOnDay_(
        day, year, month, assignments, person.user
      );
      const fixedNight = item && (
        item.duty !== 'Zaposleni' || item.replacementFor
      );
      for (let offset = 1; offset <= 2; offset += 1) {
        const nextDay = day + offset;
        if (nextDay > daysInMonth) continue;
        const nextItem = assignedItemOnDay_(
          nextDay, year, month, assignments, person.user
        );
        if (!nextItem) continue;
        if (nextItem.replacementFor && !fixedNight) {
          removePersonAssignment_(
            day, year, month, assignments, person.user, counts
          );
          break;
        }
        if (nextItem.duty === 'Zaposleni' && !nextItem.replacementFor) {
          removePersonAssignment_(
            nextDay, year, month, assignments, person.user, counts
          );
        } else if (!fixedNight) {
          removePersonAssignment_(
            day, year, month, assignments, person.user, counts
          );
          break;
        }
      }
    }
  });
}

function assignedItemOnDay_(day, year, month, assignments, user) {
  const key = dateKey_(new Date(year, month - 1, day, 12));
  if (!assignments[key]) return null;
  for (let shift = 1; shift <= 3; shift += 1) {
    const item = assignments[key][shift].find(function (entry) {
      return entry.person.user === user;
    });
    if (item) return item;
  }
  return null;
}

function removePersonAssignment_(
  day, year, month, assignments, user, counts
) {
  const key = dateKey_(new Date(year, month - 1, day, 12));
  if (!assignments[key]) return false;
  for (let shift = 1; shift <= 3; shift += 1) {
    const index = assignments[key][shift].findIndex(function (item) {
      return item.person.user === user;
    });
    if (index >= 0) {
      assignments[key][shift].splice(index, 1);
      counts[user] -= 1;
      return true;
    }
  }
  return false;
}

function trimAllMaximumCoverage_(
  year, month, daysInMonth, assignments, staffing, counts
) {
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    for (let shift = 1; shift <= 3; shift += 1) {
      const list = assignments[key][shift];
      const maximum = allowedCoverageMaximum_(
        date, shift, staffing, assignments[key]
      );
      while (workerCount_(list) > maximum) {
        let removeIndex = -1;
        let highestCount = -1;
        list.forEach(function (item, index) {
          if (item.duty !== 'Zaposleni') return;
          const personCount = counts[item.person.user] || 0;
          if (personCount > highestCount) {
            highestCount = personCount;
            removeIndex = index;
          }
        });
        if (removeIndex < 0) break;
        const removed = list.splice(removeIndex, 1)[0];
        counts[removed.person.user] -= 1;
      }
    }
  }
}

function trimWeekendThirdShift_(
  year, month, daysInMonth, assignments, counts
) {
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    if (date.getDay() !== 0 && date.getDay() !== 6) continue;
    const list = assignments[dateKey_(date)][3];
    while (workerCount_(list) > 2) {
      let removeIndex = -1;
      let highestCount = -1;
      list.forEach(function (item, index) {
        if (item.duty !== 'Zaposleni') return;
        const personCount = counts[item.person.user] || 0;
        if (personCount > highestCount) {
          highestCount = personCount;
          removeIndex = index;
        }
      });
      if (removeIndex < 0) break;
      const removed = list.splice(removeIndex, 1)[0];
      counts[removed.person.user] -= 1;
    }
  }
}

function getCycleTemplate_(staffing) {
  const firstMinimum = Number(staffing[1].min);
  const secondMinimum = Number(staffing[2].min);
  const thirdMinimum = Number(staffing[3].min);

  // 3 PRVA, 2 TREĆA, 3 SLOBODNA, 3 DRUGA, 2 TREĆA, 2 SLOBODNA.
  if (firstMinimum >= 3 && secondMinimum >= 3 && thirdMinimum >= 4) {
    return [1, 1, 1, 3, 3, 0, 0, 0, 2, 2, 2, 3, 3, 0, 0];
  }
  // 3 PRVA, 2 TREĆA, 3 SLOBODNA, 3 DRUGA, 1 TREĆA, 3 SLOBODNA.
  if (firstMinimum >= 3 && secondMinimum >= 3 && thirdMinimum >= 3) {
    return [1, 1, 1, 3, 3, 0, 0, 0, 2, 2, 2, 3, 0, 0, 0];
  }
  // 2 PRVA, 2 TREĆA, 3 SLOBODNA, 3 DRUGA, 1 TREĆA, 3 SLOBODNA.
  if (secondMinimum >= 3 && thirdMinimum >= 3) {
    return [1, 1, 3, 3, 0, 0, 0, 2, 2, 2, 3, 0, 0, 0];
  }
  // 2 PRVA, 2 TREĆA, 3 SLOBODNA, 2 DRUGA, 1 TREĆA, 3 SLOBODNA.
  if (thirdMinimum >= 3) {
    return [1, 1, 3, 3, 0, 0, 0, 2, 2, 3, 0, 0, 0];
  }
  // 2 PRVA, 2 TREĆA, 3 SLOBODNA, 2 DRUGA, 2 SLOBODNA.
  return [1, 1, 3, 3, 0, 0, 0, 2, 2, 0, 0];
}

function cyclePositionFromRecentHistory_(cycle, initialState, fallbackPosition) {
  const recent = initialState && initialState.recentShifts;
  if (!initialState || !initialState.hasPrevious ||
      !Array.isArray(recent) || recent.length !== 4) {
    return fallbackPosition;
  }

  const weights = [1, 4, 16, 64];
  const candidates = cycle.map(function (_, position) {
    let score = 0;
    let matches = 0;
    recent.forEach(function (shift, index) {
      const cycleShift = cycle[
        (position - recent.length + index + cycle.length) % cycle.length
      ];
      if (cycleShift === shift) {
        score += weights[index];
        matches += 1;
      }
    });

    const distance = Math.min(
      (position - fallbackPosition + cycle.length) % cycle.length,
      (fallbackPosition - position + cycle.length) % cycle.length
    );
    return {
      position: position,
      score: score,
      matches: matches,
      distance: distance,
      validStart: cycleStartValid_(
        cycle, position, initialState
      )
    };
  }).sort(function (a, b) {
    return Number(b.validStart) - Number(a.validStart) ||
      b.score - a.score ||
      b.matches - a.matches ||
      a.distance - b.distance ||
      a.position - b.position;
  });

  return candidates[0].validStart
    ? candidates[0].position
    : fallbackPosition;
}

function monthStartShiftsFromRecentHistory_(initialState) {
  const recent = initialState && initialState.recentShifts;
  if (!initialState || !initialState.hasPrevious ||
      !Array.isArray(recent) || recent.length !== 4) {
    return null;
  }

  const transitions = {
    '1-1-1-1': [3, 0, 0, 2],
    '0-1-1-1': [3, 3, 0, 0],
    '0-0-1-1': [1, 3, 3, 0],
    '3-0-0-1': [1, 1, 3, 3],
    '2-0-0-1': [1, 1, 3, 3],
    '2-0-1-1': [1, 3, 3, 0],
    '2-2-0-1': [1, 1, 3, 0],
    '2-2-2-2': [3, 0, 0, 1],
    '0-2-2-2': [3, 3, 0, 0],
    '0-0-2-2': [3, 3, 0, 0],
    '1-0-0-2': [2, 2, 3, 3],
    '1-1-0-2': [2, 3, 3, 0],
    '1-1-3-3': [0, 0, 2, 2],
    '2-2-3-3': [0, 0, 1, 1],
    '1-1-1-3': [3, 0, 0, 2],
    '2-2-2-3': [0, 0, 1, 1],
    '0-1-1-3': [3, 0, 0, 2],
    '0-2-2-3': [3, 0, 0, 1],
    '0-0-1-3': [3, 0, 0, 2],
    '0-0-2-3': [3, 0, 0, 1],
    '0-0-3-3': [0, 0, 1, 1]
  };
  const match = transitions[recent.map(Number).join('-')];
  return match ? match.slice() : null;
}

function cycleStartValid_(cycle, position, initialState) {
  const state = Object.assign({}, initialState);
  const daysToCheck = Math.min(cycle.length, 7);
  for (let offset = 0; offset < daysToCheck; offset += 1) {
    const shift = cycle[(position + offset) % cycle.length];
    if (!shift) {
      registerDayOff_(state);
      continue;
    }
    if (!canAssignShift_(state, shift)) return false;
    state.consecutive += 1;
    state.lastShift = shift;
    state.restRemaining = 0;
    state.nightStreak = shift === 3 ? state.nightStreak + 1 : 0;
  }
  return true;
}

function hasSpecialWeek_(person) {
  return Object.keys(person.weekOverrides || {}).some(function (week) {
    return person.weekOverrides[week] !== 'radnik';
  });
}

function getCycleCorrectionShift_(cycle, position) {
  if (cycle[position] !== 0) return 0;

  const length = cycle.length;
  const previous = cycle[(position - 1 + length) % length];
  const beforePrevious = cycle[(position - 2 + length) % length];

  // Jedna treća + prvi slobodan dan postaju dve treće + dva slobodna.
  if (previous === 3 && beforePrevious !== 3) return 3;

  const next = cycle[(position + 1) % length];
  const afterNext = cycle[(position + 2) % length];
  const previousNightCount = countPreviousCycleShift_(cycle, position);

  // Poslednji slobodan dan prati naredni blok prve ili druge smene.
  if ((next === 1 || next === 2) &&
      afterNext === next &&
      previousNightCount >= 1) {
    return next;
  }
  return 0;
}

function countPreviousCycleShift_(cycle, position) {
  const length = cycle.length;
  let cursor = (position - 1 + length) % length;
  let checked = 0;
  while (cycle[cursor] === 0 && checked < length) {
    cursor = (cursor - 1 + length) % length;
    checked += 1;
  }

  let count = 0;
  while (cycle[cursor] === 3 && count < length) {
    count += 1;
    cursor = (cursor - 1 + length) % length;
  }
  return count;
}

function fillCoverageFromExtraRest_(
  year, month, daysInMonth, assignments, workers, staffing,
  counts, target, cycle, cyclePositions, initialStates, weekendsOnly, attempt
) {
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    if (weekend !== weekendsOnly) continue;
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    prioritizedShiftsForDate_(date).forEach(function (shift) {
      const requiredMinimum = priorityCoverageTarget_(
        date, shift, staffing, assignments[key]
      );
      while (workerCount_(assignments[key][shift]) < requiredMinimum) {
        const rebalanced = rebalanceShiftCoverage_(
          day, key, shift, year, month, assignments, staffing,
          initialStates, attempt
        );
        if (rebalanced) continue;

        const candidates = extraRestCandidates_(
          day, key, shift, year, month, daysInMonth, assignments,
          workers, counts, target, cycle, cyclePositions, initialStates,
          weekIndex, attempt
        );
        if (!candidates.length) {
          break;
        }
        assignments[key][shift].push({
          person: candidates[0],
          duty: 'Zaposleni'
        });
        counts[candidates[0].user] += 1;
      }
    });
  }
  return '';
}

function rebalanceAllCoverage_(
  year, month, daysInMonth, assignments, staffing, initialStates, attempt
) {
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    prioritizedShiftsForDate_(date).forEach(function (shift) {
      const requiredMinimum = priorityCoverageTarget_(
        date, shift, staffing, assignments[key]
      );
      while (workerCount_(assignments[key][shift]) < requiredMinimum) {
        if (!rebalanceShiftCoverage_(
          day, key, shift, year, month, assignments, staffing,
          initialStates, attempt
        )) {
          break;
        }
      }
    });
  }
}

function rebalanceShiftCoverage_(
  day, key, targetShift, year, month, assignments, staffing,
  initialStates, attempt
) {
  const donorOrder = [3, 1, 2].filter(function (shift) {
    const date = new Date(year, month - 1, day, 12);
    return shift !== targetShift &&
      workerCount_(assignments[key][shift]) >
        priorityCoverageTarget_(date, shift, staffing, assignments[key]);
  });
  const candidates = [];

  donorOrder.forEach(function (sourceShift) {
    assignments[key][sourceShift].forEach(function (item, itemIndex) {
      if (item.duty !== 'Zaposleni') return;

      const person = item.person;
      const previousShift = previousWorkerShift_(
        day, year, month, assignments, person.user,
        initialStates[person.user]
      );
      if (sourceShift === 3) {
        if (previousShift === 3) return;
        if (previousShift === 1 && targetShift !== 1 && targetShift !== 2) return;
        if (previousShift === 2 && targetShift !== 2) return;
        if (previousShift !== 1 && previousShift !== 2) return;
      }

      assignments[key][sourceShift].splice(itemIndex, 1);
      assignments[key][targetShift].push(item);
      const valid = workerTimelineValid_(
        year, month, new Date(year, month, 0).getDate(),
        person, assignments, initialStates[person.user]
      );
      assignments[key][targetShift].pop();
      assignments[key][sourceShift].splice(itemIndex, 0, item);
      if (!valid) return;

      candidates.push({
        sourceShift: sourceShift,
        itemIndex: itemIndex,
        item: item,
        sequencePriority: previousShift === sourceShift ? 1 : 0,
        thirdPriority: sourceShift === 3 ? 0 : 1,
        score: pseudoRandom_(
          person.user + '|' + key + '|' + targetShift + '|' + attempt
        )
      });
    });
  });

  candidates.sort(function (a, b) {
    return a.sequencePriority - b.sequencePriority ||
      a.thirdPriority - b.thirdPriority ||
      a.score - b.score;
  });
  if (!candidates.length) return false;

  const selected = candidates[0];
  assignments[key][selected.sourceShift].splice(selected.itemIndex, 1);
  assignments[key][targetShift].push(selected.item);
  return true;
}

function previousWorkerShift_(
  day, year, month, assignments, user, initialState
) {
  if (day === 1) return Number(initialState && initialState.lastShift) || 0;

  const previousKey = dateKey_(new Date(year, month - 1, day - 1, 12));
  for (let shift = 1; shift <= 3; shift += 1) {
    if (assignments[previousKey][shift].some(function (item) {
      return item.person.user === user;
    })) {
      return shift;
    }
  }
  return 0;
}

function removeSecondToFirstTransitions_(
  year, month, daysInMonth, assignments, initialStates, attempt
) {
  for (let day = 2; day <= daysInMonth; day += 1) {
    const key = dateKey_(new Date(year, month - 1, day, 12));
    let corrected = true;

    while (corrected) {
      corrected = false;
      const firstShift = assignments[key][1];
      const secondShift = assignments[key][2];
      const offenders = firstShift.filter(function (item) {
        return item.duty === 'Zaposleni' &&
          previousWorkerShift_(
            day, year, month, assignments, item.person.user,
            initialStates[item.person.user]
          ) === 2;
      });

      for (let offenderIndex = 0;
           offenderIndex < offenders.length && !corrected;
           offenderIndex += 1) {
        const offender = offenders[offenderIndex];
        const firstIndex = firstShift.indexOf(offender);
        if (firstIndex < 0) continue;

        const candidates = secondShift.map(function (item, itemIndex) {
          return {
            item: item,
            itemIndex: itemIndex,
            previousShift: previousWorkerShift_(
              day, year, month, assignments, item.person.user,
              initialStates[item.person.user]
            ),
            score: pseudoRandom_(
              offender.person.user + '|' + item.person.user + '|' +
              key + '|' + attempt
            )
          };
        }).filter(function (candidate) {
          return candidate.item.duty === 'Zaposleni' &&
            candidate.previousShift !== 2;
        }).sort(function (a, b) {
          return a.score - b.score;
        });

        for (let candidateIndex = 0;
             candidateIndex < candidates.length && !corrected;
             candidateIndex += 1) {
          const candidate = candidates[candidateIndex];
          firstShift[firstIndex] = candidate.item;
          secondShift[candidate.itemIndex] = offender;
          corrected = true;
        }
      }
    }
  }
}

function repairNightRestForAllWorkers_(
  year, month, daysInMonth, assignments, workers, staffing,
  counts, initialStates, attempt
) {
  workers.forEach(function (person) {
    let changed = true;
    let corrections = 0;
    while (changed && corrections < daysInMonth * 2) {
      changed = false;
      for (let day = 1; day <= daysInMonth && !changed; day += 1) {
        if (assignedShiftOnDay_(
          day, year, month, assignments, person.user
        ) !== 3 || assignedShiftOnDay_(
          day + 1, year, month, assignments, person.user
        ) === 3) {
          continue;
        }
        for (let offset = 1; offset <= 2 && !changed; offset += 1) {
          const conflictDay = day + offset;
          if (conflictDay > daysInMonth) continue;
          const conflictItem = assignedItemOnDay_(
            conflictDay, year, month, assignments, person.user
          );
          if (!conflictItem) continue;

          if (conflictItem.duty === 'Zaposleni') {
            removePersonAssignment_(
              conflictDay, year, month, assignments, person.user, counts
            );
            relocateRegularAssignment_(
              year, month, daysInMonth, assignments, person, staffing,
              counts, initialStates[person.user], attempt, conflictDay
            );
            changed = true;
            corrections += 1;
          } else {
            const nightItem = assignedItemOnDay_(
              day, year, month, assignments, person.user
            );
            if (nightItem && nightItem.duty === 'Zaposleni') {
              removePersonAssignment_(
                day, year, month, assignments, person.user, counts
              );
              relocateRegularAssignment_(
                year, month, daysInMonth, assignments, person, staffing,
                counts, initialStates[person.user], attempt, day
              );
              changed = true;
              corrections += 1;
            }
          }
        }
      }
    }
  });
}

function relocateRegularAssignment_(
  year, month, daysInMonth, assignments, person, staffing,
  counts, initialState, attempt, removedDay
) {
  const options = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    if (effectiveDuty_(person, weekIndex) !== 'radnik' ||
        isFreeDate_(person, key) ||
        isAssigned_(assignments[key], person.user)) {
      continue;
    }
    for (let shift = 1; shift <= 3; shift += 1) {
      if (!canWorkSpecialBoundary_(person, date, shift) ||
          workerCount_(assignments[key][shift]) >=
            allowedCoverageMaximum_(
              date, shift, staffing, assignments[key]
            )) {
        continue;
      }
      assignments[key][shift].push({
        person: person,
        duty: 'Zaposleni'
      });
      const valid = workerFinalRulesValid_(
        year, month, daysInMonth, assignments, person
      );
      assignments[key][shift].pop();
      if (!valid) continue;
      options.push({
        key: key,
        shift: shift,
        stablePenalty: stablePenaltyIfAssigned_(
          year, month, daysInMonth, assignments, key, shift, person,
          initialState
        ),
        coverageNeeded: workerCount_(assignments[key][shift]) <
          requiredCoverageMinimum_(
            date, shift, staffing, assignments[key]
          ),
        distance: Math.abs(day - removedDay),
        score: pseudoRandom_(
          person.user + '|rest|' + key + '|' + shift + '|' + attempt
        )
      });
    }
  }
  options.sort(function (a, b) {
    return Number(b.coverageNeeded) - Number(a.coverageNeeded) ||
      a.stablePenalty - b.stablePenalty ||
      a.distance - b.distance || a.score - b.score;
  });
  if (!options.length) return false;
  assignments[options[0].key][options[0].shift].push({
    person: person,
    duty: 'Zaposleni'
  });
  counts[person.user] += 1;
  return true;
}

function extraRestCandidates_(
  day, key, shift, year, month, daysInMonth, assignments,
  workers, counts, target, cycle, cyclePositions, initialStates,
  weekIndex, attempt
) {
  return workers.filter(function (person) {
    const position = (cyclePositions[person.user] + day - 1) % cycle.length;
    const correctionShift = getCycleCorrectionShift_(cycle, position);
    const duty = effectiveDuty_(person, weekIndex);
    if (correctionShift !== shift ||
        duty !== 'radnik' ||
        isFreeDate_(person, key) ||
        !canWorkSpecialBoundary_(
          person, new Date(year, month - 1, day, 12), shift
        ) ||
        isAssigned_(assignments[key], person.user) ||
        counts[person.user] >= targetFor_(person, target)) {
      return false;
    }
    assignments[key][shift].push({ person: person, duty: 'Zaposleni' });
    const valid = workerTimelineValid_(
      year, month, daysInMonth, person, assignments, initialStates[person.user]
    );
    assignments[key][shift].pop();
    return valid;
  }).sort(function (a, b) {
    return stablePenaltyIfAssigned_(
        year, month, daysInMonth, assignments, key, shift, a,
        initialStates[a.user]
      ) - stablePenaltyIfAssigned_(
        year, month, daysInMonth, assignments, key, shift, b,
        initialStates[b.user]
      ) ||
      counts[a.user] - counts[b.user] ||
      pseudoRandom_(a.user + '|' + key + '|' + shift + '|' + attempt) -
      pseudoRandom_(b.user + '|' + key + '|' + shift + '|' + attempt);
  });
}

function fillAllMinimumCoverage_(
  year, month, daysInMonth, assignments, workers, staffing,
  counts, target, initialStates, attempt, ignorePlannedAbsences
) {
  const warnings = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const weekIndex = mondayWeekIndex_(date);
    prioritizedShiftsForDate_(date).forEach(function (shift) {
      const requiredMinimum = priorityCoverageTarget_(
        date, shift, staffing, assignments[key]
      );
      while (workerCount_(assignments[key][shift]) < requiredMinimum) {
        const candidates = workers.filter(function (person) {
          if ((!ignorePlannedAbsences &&
                effectiveDuty_(person, weekIndex) !== 'radnik') ||
              (!ignorePlannedAbsences && isFreeDate_(person, key)) ||
              (!ignorePlannedAbsences &&
                !canWorkSpecialBoundary_(person, date, shift)) ||
              isAssigned_(assignments[key], person.user) ||
              counts[person.user] >= targetFor_(person, target)) {
            return false;
          }
          assignments[key][shift].push({ person: person, duty: 'Zaposleni' });
          const valid = workerTimelineValid_(
            year, month, daysInMonth, person,
            assignments, initialStates[person.user],
            ignorePlannedAbsences
          );
          assignments[key][shift].pop();
          return valid;
        }).sort(function (a, b) {
          const aDeficit = targetFor_(a, target) - counts[a.user];
          const bDeficit = targetFor_(b, target) - counts[b.user];
          return bDeficit - aDeficit ||
            stablePenaltyIfAssigned_(
              year, month, daysInMonth, assignments, key, shift, a,
              initialStates[a.user]
            ) - stablePenaltyIfAssigned_(
              year, month, daysInMonth, assignments, key, shift, b,
              initialStates[b.user]
            ) ||
            pseudoRandom_(a.user + '|' + key + '|' + shift + '|' + attempt) -
            pseudoRandom_(b.user + '|' + key + '|' + shift + '|' + attempt);
        });
        if (!candidates.length) {
          warnings.push(
            formatDate_(date) + ': ' + roman_(shift) +
            ' smena ostaje ispod minimuma ' + requiredMinimum +
            ' i treba je ručno popuniti.'
          );
          break;
        }
        assignments[key][shift].push({
          person: candidates[0],
          duty: 'Zaposleni'
        });
        counts[candidates[0].user] += 1;
      }
    });
  }
  return unique_(warnings);
}

function validateAllMinimumCoverage_(
  year, month, daysInMonth, assignments, staffing
) {
  const warnings = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    for (let shift = 1; shift <= 3; shift += 1) {
      const minimum = requiredCoverageMinimum_(
        date, shift, staffing, assignments[key]
      );
      if (workerCount_(assignments[key][shift]) < minimum) {
        warnings.push(
          formatDate_(date) + ': ' + roman_(shift) +
          ' smena ostaje ispod minimuma ' + minimum +
          ' i treba je ručno popuniti.'
        );
      }
    }
  }
  return unique_(warnings);
}

function fillExactQuota_(
  year, month, daysInMonth, assignments, workers, staffing,
  counts, target, cycle, cyclePositions, initialStates, attempt
) {
  let remaining = workers.reduce(function (sum, person) {
    return sum + Math.max(0, targetFor_(person, target) - counts[person.user]);
  }, 0);
  while (remaining > 0) {
    const people = workers.filter(function (person) {
      return counts[person.user] < targetFor_(person, target);
    }).sort(function (a, b) {
      return counts[a.user] - counts[b.user];
    });
    let inserted = false;
    for (let personIndex = 0; personIndex < people.length && !inserted; personIndex += 1) {
      const person = people[personIndex];
      const options = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month - 1, day, 12);
        const key = dateKey_(date);
        const weekIndex = mondayWeekIndex_(date);
        const position = (cyclePositions[person.user] + day - 1) % cycle.length;
        const plannedShift = cycle[position];
        const correctionShift = getCycleCorrectionShift_(cycle, position);
        if (effectiveDuty_(person, weekIndex) !== 'radnik' ||
            isFreeDate_(person, key) ||
            isAssigned_(assignments[key], person.user)) {
          continue;
        }
        const shiftsToTry = unique_(
          (plannedShift ? [plannedShift] : [])
            .concat(correctionShift ? [correctionShift] : [])
            .concat(prioritizedShiftsForDate_(date))
        );
        for (let shiftIndex = 0; shiftIndex < shiftsToTry.length; shiftIndex += 1) {
          const shift = shiftsToTry[shiftIndex];
          if (!canWorkSpecialBoundary_(person, date, shift)) continue;
          if (workerCount_(assignments[key][shift]) >=
              allowedCoverageMaximum_(
                date, shift, staffing, assignments[key]
              )) {
            continue;
          }
          assignments[key][shift].push({ person: person, duty: 'Zaposleni' });
          const valid = workerTimelineValid_(
            year, month, daysInMonth, person, assignments, initialStates[person.user]
          );
          assignments[key][shift].pop();
          if (valid) {
            options.push({
              key: key,
              shift: shift,
              load: workerCount_(assignments[key][shift]),
              planned: Boolean(plannedShift),
              correction: correctionShift === shift,
              stablePenalty: stablePenaltyIfAssigned_(
                year, month, daysInMonth, assignments, key, shift, person,
                initialStates[person.user]
              ),
              coverageNeeded: workerCount_(assignments[key][shift]) <
                priorityCoverageTarget_(
                  date, shift, staffing, assignments[key]
                ),
              quotaPriority: quotaDayPriority_(date, shift),
              score: pseudoRandom_(person.user + '|' + key + '|' + attempt)
            });
          }
        }
      }
      options.sort(function (a, b) {
        return Number(b.coverageNeeded) - Number(a.coverageNeeded) ||
          a.stablePenalty - b.stablePenalty ||
          a.quotaPriority - b.quotaPriority ||
          Number(b.planned) - Number(a.planned) ||
          a.load - b.load ||
          Number(a.correction) - Number(b.correction) ||
          a.score - b.score;
      });
      if (options.length) {
        const selected = options[0];
        assignments[selected.key][selected.shift].push({
          person: person,
          duty: 'Zaposleni'
        });
        counts[person.user] += 1;
        remaining -= 1;
        inserted = true;
      }
    }
    if (!inserted) {
      return 'Nema dovoljno dozvoljenih korekcija odmora za tačan fond od ' +
        'individualno obračunatog broja smena.';
    }
  }
  return '';
}

function rebalanceQuotaDeficits_(
  year, month, daysInMonth, assignments, workers, counts,
  target, initialStates
) {
  const byUser = {};
  workers.forEach(function (person) {
    byUser[person.user] = person;
  });

  workers.slice().sort(function (a, b) {
    return (counts[a.user] - targetFor_(a, target)) -
      (counts[b.user] - targetFor_(b, target));
  }).forEach(function (person) {
    const minimumAccepted = targetFor_(person, target) - 1;
    while (counts[person.user] < minimumAccepted) {
      const candidates = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month - 1, day, 12);
        const key = dateKey_(date);
        const weekIndex = mondayWeekIndex_(date);
        if (effectiveDuty_(person, weekIndex) !== 'radnik' ||
            isFreeDate_(person, key) ||
            isAssigned_(assignments[key], person.user)) {
          continue;
        }
        for (let shift = 1; shift <= 3; shift += 1) {
          if (!canWorkSpecialBoundary_(person, date, shift)) continue;
          assignments[key][shift].forEach(function (item, itemIndex) {
            if (item.duty !== 'Zaposleni') return;
            const donor = byUser[item.person.user];
            if (!donor || donor.user === person.user ||
                counts[donor.user] <= targetFor_(donor, target) - 1) {
              return;
            }
            assignments[key][shift][itemIndex] = {
              person: person,
              duty: 'Zaposleni'
            };
            const valid = workerFinalRulesValid_(
              year, month, daysInMonth, assignments, person
            );
            const donorValid = workerFinalRulesValid_(
              year, month, daysInMonth, assignments, donor
            );
            const stablePenalty =
              workerStableStartViolationCount_(
                year, month, daysInMonth, assignments, person.user,
                initialStates[person.user]
              ) +
              workerStableStartViolationCount_(
                year, month, daysInMonth, assignments, donor.user,
                initialStates[donor.user]
              );
            assignments[key][shift][itemIndex] = item;
            if (!valid || !donorValid) return;
            candidates.push({
              key: key,
              shift: shift,
              itemIndex: itemIndex,
              donor: donor,
              donorSurplus: counts[donor.user] - targetFor_(donor, target),
              stablePenalty: stablePenalty,
              score: pseudoRandom_(
                person.user + '|' + donor.user + '|' + key + '|' + shift
              )
            });
          });
        }
      }
      candidates.sort(function (a, b) {
        return b.donorSurplus - a.donorSurplus ||
          a.stablePenalty - b.stablePenalty ||
          a.score - b.score;
      });
      if (!candidates.length) break;
      const selected = candidates[0];
      assignments[selected.key][selected.shift][selected.itemIndex] = {
        person: person,
        duty: 'Zaposleni'
      };
      counts[selected.donor.user] -= 1;
      counts[person.user] += 1;
    }
  });
}

function fillQuotaTolerance_(
  year, month, daysInMonth, assignments, workers, staffing,
  counts, target, initialStates, attempt
) {
  workers.slice().sort(function (a, b) {
    return (counts[a.user] - targetFor_(a, target)) -
      (counts[b.user] - targetFor_(b, target));
  }).forEach(function (person) {
    const minimumAccepted = targetFor_(person, target) - 1;
    while (counts[person.user] < minimumAccepted) {
      const options = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month - 1, day, 12);
        const key = dateKey_(date);
        const weekIndex = mondayWeekIndex_(date);
        if (effectiveDuty_(person, weekIndex) !== 'radnik' ||
            isFreeDate_(person, key) ||
            isAssigned_(assignments[key], person.user)) {
          continue;
        }
        for (let shift = 1; shift <= 3; shift += 1) {
          if (!canWorkSpecialBoundary_(person, date, shift) ||
              workerCount_(assignments[key][shift]) >=
                allowedCoverageMaximum_(
                  date, shift, staffing, assignments[key]
                )) {
            continue;
          }
          assignments[key][shift].push({
            person: person,
            duty: 'Zaposleni'
          });
          const valid = workerFinalRulesValid_(
            year, month, daysInMonth, assignments, person
          );
          assignments[key][shift].pop();
          if (!valid) continue;
          options.push({
            key: key,
            shift: shift,
            stablePenalty: stablePenaltyIfAssigned_(
              year, month, daysInMonth, assignments, key, shift, person,
              initialStates[person.user]
            ),
            coverageNeeded: workerCount_(assignments[key][shift]) <
              requiredCoverageMinimum_(
                date, shift, staffing, assignments[key]
              ),
            load: workerCount_(assignments[key][shift]),
            score: pseudoRandom_(
              person.user + '|quota|' + key + '|' + shift + '|' + attempt
            )
          });
        }
      }
      options.sort(function (a, b) {
        return Number(b.coverageNeeded) - Number(a.coverageNeeded) ||
          a.stablePenalty - b.stablePenalty ||
          a.load - b.load || a.score - b.score;
      });
      if (!options.length) break;
      assignments[options[0].key][options[0].shift].push({
        person: person,
        duty: 'Zaposleni'
      });
      counts[person.user] += 1;
    }
  });
}

function quotaDayPriority_(date, shift) {
  return prioritizedShiftsForDate_(date).indexOf(shift);
}

function prioritizedShiftsForDate_(date) {
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  return weekend ? [2, 1, 3] : [3, 1, 2];
}

function priorityCoverageTarget_(date, shift, staffing, dayAssignments) {
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  if (!weekend && shift === 3) {
    return allowedCoverageMaximum_(date, shift, staffing, dayAssignments);
  }
  return requiredCoverageMinimum_(date, shift, staffing, dayAssignments);
}

function dayHasAllMinimums_(date, dayAssignments, staffing) {
  return [1, 2, 3].every(function (shift) {
    return workerCount_(dayAssignments[shift]) >=
      requiredCoverageMinimum_(date, shift, staffing, dayAssignments);
  });
}

function requiredCoverageMinimum_(date, shift, staffing, dayAssignments) {
  if (dayAssignments && dayAssignments.missingLeaderShifts &&
      dayAssignments.missingLeaderShifts[shift]) {
    return staffing[shift].max;
  }
  return requiredWorkerMinimum_(date, shift, staffing);
}

function allowedCoverageMaximum_(date, shift, staffing, dayAssignments) {
  if (dayAssignments && dayAssignments.missingLeaderShifts &&
      dayAssignments.missingLeaderShifts[shift]) {
    return staffing[shift].max;
  }
  return allowedWorkerMaximum_(date, shift, staffing);
}

function requiredWorkerMinimum_(date, shift, staffing) {
  if (date.getDay() === 0 || date.getDay() === 6) return 2;
  return staffing[shift].min;
}

function allowedWorkerMaximum_(date, shift, staffing) {
  const minimum = requiredWorkerMinimum_(date, shift, staffing);
  if (isMinimumStaffingHoliday_(date)) return minimum;
  if (date.getDay() === 1 && shift === 1) return minimum;
  if (date.getDay() === 0 || date.getDay() === 6) {
    return shift === 1 ? 2 : 3;
  }
  return staffing[shift].max;
}

function isMinimumStaffingHoliday_(date) {
  const year = date.getFullYear();
  const key = dateKey_(date);
  const holidays = {};
  const add = function (holiday, observeSunday) {
    holidays[dateKey_(holiday)] = true;
    if (observeSunday && holiday.getDay() === 0) {
      const observed = new Date(holiday);
      observed.setDate(observed.getDate() + 1);
      holidays[dateKey_(observed)] = true;
    }
  };

  [
    lastWeekdayOfMonth_(year, 4, 1),    // Memorial Day
    nthWeekdayOfMonth_(year, 8, 1, 1),  // Labor Day
    nthWeekdayOfMonth_(year, 10, 4, 4)  // Thanksgiving
  ].forEach(function (holiday) {
    add(holiday, false);
  });

  [
    new Date(year, 0, 1, 12),   // New Year
    new Date(year, 6, 4, 12),   // Independence Day
    new Date(year, 11, 25, 12)  // Christmas Day
  ].forEach(function (holiday) {
    add(holiday, true);
  });

  add(new Date(year, 0, 7, 12), false); // Orthodox Christmas
  add(westernEaster_(year), false);
  add(orthodoxEaster_(year), false);
  return Boolean(holidays[key]);
}

function nthWeekdayOfMonth_(year, monthIndex, weekday, occurrence) {
  const first = new Date(year, monthIndex, 1, 12);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, monthIndex, 1 + offset + (occurrence - 1) * 7, 12);
}

function lastWeekdayOfMonth_(year, monthIndex, weekday) {
  const last = new Date(year, monthIndex + 1, 0, 12);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, monthIndex, last.getDate() - offset, 12);
}

function westernEaster_(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day, 12);
}

function orthodoxEaster_(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const julianMonth = Math.floor((d + e + 114) / 31);
  const julianDay = ((d + e + 114) % 31) + 1;
  const calendarOffset =
    Math.floor(year / 100) - Math.floor(year / 400) - 2;
  return new Date(
    year, julianMonth - 1, julianDay + calendarOffset, 12
  );
}

function assignmentsToRows_(year, month, assignments, shifts, states) {
  const rows = [];
  Object.keys(assignments).sort().forEach(function (key) {
    const date = parseDateKey_(key);
    [1, 2, 3].forEach(function (shiftId) {
      assignments[key][shiftId].forEach(function (item) {
        const shift = shifts[shiftId - 1];
        rows.push([
          date, dayName_(date), shiftId, shift.start, shift.end,
          item.person.name, item.person.user, item.duty,
          monthKey_(year, month),
          states[item.person.user] ? states[item.person.user].cycleIndex : 0,
          new Date()
        ]);
      });
    });
  });
  return rows;
}

function tryBuildMonthPhased_(
  year, month, daysInMonth, configs, targetWorkers, staffing,
  target, shifts, attempt, initialStates
) {
  const assignments = {};
  const counts = {};
  const states = {};
  const targetUsers = {};
  targetWorkers.forEach(function (person) { targetUsers[person.user] = true; });
  configs.forEach(function (person) {
    counts[person.user] = 0;
    states[person.user] = Object.assign({}, initialStates[person.user]);
  });

  // Faza 1: postavi fiksne uloge i minimalan broj radnika u svakoj smeni.
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const dateKey = dateKey_(date);
    const businessDay = date.getDay() >= 1 && date.getDay() <= 5;
    const weekIndex = mondayWeekIndex_(date);
    assignments[dateKey] = { 1: [], 2: [], 3: [] };

    const leaders = configs.filter(function (person) {
      return businessDay && effectiveDuty_(person, weekIndex) === 'shift_lider';
    }).sort(function (a, b) { return a.leaderOrder - b.leaderOrder; });
    const monitors = configs.filter(function (person) {
      return businessDay && effectiveDuty_(person, weekIndex) === 'monitoring';
    });

    for (let leaderIndex = 0; leaderIndex < leaders.length; leaderIndex += 1) {
      const person = leaders[leaderIndex];
      const shift = ((leaderIndex + weekIndex) % 3) + 1;
      const error = assignFixed_(person, shift, 'Shift lider', dateKey, assignments, states, counts, targetUsers, target);
      if (error) return { ok: false, error: error };
    }
    for (let monitorIndex = 0; monitorIndex < monitors.length; monitorIndex += 1) {
      const person = monitors[monitorIndex];
      const shift = monitorShiftForWeek_(person, weekIndex);
      const error = assignFixed_(
        person, shift, 'Monitoring ' + roman_(shift), dateKey,
        assignments, states, counts, targetUsers, target
      );
      if (error) return { ok: false, error: error };
    }

    const slots = [];
    [3, 1, 2].forEach(function (shift) {
      for (let index = 0; index < staffing[shift].min; index += 1) {
        slots.push(shift);
      }
    });

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const shift = slots[slotIndex];
      const candidates = targetWorkers.filter(function (person) {
        return effectiveDuty_(person, weekIndex) === 'radnik' &&
          !isFreeDate_(person, dateKey) &&
          !isAssigned_(assignments[dateKey], person.user) &&
          counts[person.user] < target &&
          canAssignShift_(states[person.user], shift);
      }).sort(function (a, b) {
        return candidateScore_(
          b, shift, counts, states, target, daysInMonth - day,
          attempt * 101 + day * 997
        ) - candidateScore_(
          a, shift, counts, states, target, daysInMonth - day,
          attempt * 101 + day * 997
        );
      });
      if (!candidates.length) {
        return {
          ok: false,
          error: formatDate_(date) + ': nema dostupnog radnika za ' + roman_(shift) + ' smenu.'
        };
      }
      assignPerson_(
        assignments[dateKey][shift], candidates[0], 'Zaposleni',
        states, counts, shift
      );
    }

    configs.forEach(function (person) {
      if (!isAssigned_(assignments[dateKey], person.user)) {
        registerDayOff_(states[person.user]);
      }
    });
  }

  // Faza 2: potvrdi minimalnu pokrivenost, posebno vikende.
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    for (let shift = 1; shift <= 3; shift += 1) {
      if (workerCount_(assignments[key][shift]) < staffing[shift].min) {
        return {
          ok: false,
          error: formatDate_(date) + ': ' + roman_(shift) +
            ' smena nema minimalno ' + staffing[shift].min + ' radnika.'
        };
      }
    }
  }

  // Faza 3: dopuni svakog radnika do tačnog fonda, bez rušenja odmora.
  let additions = targetWorkers.reduce(function (sum, person) {
    return sum + Math.max(0, target - counts[person.user]);
  }, 0);
  while (additions > 0) {
    const people = targetWorkers.filter(function (person) {
      return counts[person.user] < target;
    }).sort(function (a, b) {
      const deficitDifference =
        (target - counts[b.user]) - (target - counts[a.user]);
      return deficitDifference || (
        pseudoRandom_(a.user + '|' + attempt + '|' + additions) -
        pseudoRandom_(b.user + '|' + attempt + '|' + additions)
      );
    });
    if (!people.length) break;

    let inserted = false;
    for (let personIndex = 0; personIndex < people.length && !inserted; personIndex += 1) {
      const person = people[personIndex];
      const options = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month - 1, day, 12);
        const key = dateKey_(date);
        const weekIndex = mondayWeekIndex_(date);
        if (effectiveDuty_(person, weekIndex) !== 'radnik' ||
            isFreeDate_(person, key) ||
            isAssigned_(assignments[key], person.user)) {
          continue;
        }
        for (let shift = 1; shift <= 3; shift += 1) {
          if (workerCount_(assignments[key][shift]) >= staffing[shift].max) continue;
          assignments[key][shift].push({ person: person, duty: 'Zaposleni' });
          const valid = workerTimelineValid_(
            year, month, daysInMonth, person, assignments, initialStates[person.user]
          );
          assignments[key][shift].pop();
          if (valid) {
            options.push({
              day: day,
              key: key,
              shift: shift,
              load: workerCount_(assignments[key][shift]),
              score: pseudoRandom_(
                person.user + '|' + key + '|' + shift + '|' + attempt
              )
            });
          }
        }
      }
      options.sort(function (a, b) {
        return a.load - b.load ||
          (a.shift === 3 ? 1 : 0) - (b.shift === 3 ? 1 : 0) ||
          a.score - b.score;
      });
      if (options.length) {
        const selected = options[0];
        assignments[selected.key][selected.shift].push({
          person: person,
          duty: 'Zaposleni'
        });
        counts[person.user] += 1;
        additions -= 1;
        inserted = true;
      }
    }
    if (!inserted) {
      return {
        ok: false,
        error: 'Minimalna pokrivenost je napravljena, ali nije moguće dopuniti ' +
          'sve zaposlene do ' + target + ' smena bez kršenja odmora.'
      };
    }
  }

  const validation = validateStrictSchedule_(
    year, month, daysInMonth, assignments, targetWorkers, staffing, target
  );
  if (validation) return { ok: false, error: validation };

  const rows = [];
  Object.keys(assignments).sort().forEach(function (dateKey) {
    const date = parseDateKey_(dateKey);
    [1, 2, 3].forEach(function (shiftId) {
      assignments[dateKey][shiftId].forEach(function (item) {
        const shift = shifts[shiftId - 1];
        rows.push([
          date, dayName_(date), shiftId, shift.start, shift.end,
          item.person.name, item.person.user, item.duty,
          monthKey_(year, month), states[item.person.user].cycleIndex, new Date()
        ]);
      });
    });
  });
  return { ok: true, rows: rows };
}

function tryBuildQuotaAware_(
  year, month, daysInMonth, configs, targetWorkers, staffing,
  target, shifts, attempt, initialStates
) {
  const assignments = {};
  const counts = {};
  const states = {};
  const targetUsers = {};
  const futureSpecial = buildFutureSpecial_(year, month, daysInMonth, targetWorkers);
  targetWorkers.forEach(function (person) { targetUsers[person.user] = true; });
  configs.forEach(function (person) {
    counts[person.user] = 0;
    states[person.user] = Object.assign({}, initialStates[person.user]);
  });

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const businessDay = date.getDay() >= 1 && date.getDay() <= 5;
    const weekIndex = mondayWeekIndex_(date);
    assignments[key] = { 1: [], 2: [], 3: [] };

    const leaders = configs.filter(function (person) {
      return businessDay && effectiveDuty_(person, weekIndex) === 'shift_lider';
    }).sort(function (a, b) { return a.leaderOrder - b.leaderOrder; });
    const monitors = configs.filter(function (person) {
      return businessDay && effectiveDuty_(person, weekIndex) === 'monitoring';
    });

    for (let index = 0; index < leaders.length; index += 1) {
      const shift = ((index + weekIndex) % 3) + 1;
      const error = assignFixed_(
        leaders[index], shift, 'Shift lider', key,
        assignments, states, counts, targetUsers, target
      );
      if (error) return { ok: false, error: error };
    }
    for (let index = 0; index < monitors.length; index += 1) {
      const shift = monitorShiftForWeek_(monitors[index], weekIndex);
      const error = assignFixed_(
        monitors[index], shift, 'Monitoring ' + roman_(shift), key,
        assignments, states, counts, targetUsers, target
      );
      if (error) return { ok: false, error: error };
    }

    const remainingDays = daysInMonth - day;
    const futureMin = remainingDays * (
      staffing[1].min + staffing[2].min + staffing[3].min
    );
    const futureMax = remainingDays * (
      staffing[1].max + staffing[2].max + staffing[3].max
    );
    const remainingQuota = targetWorkers.reduce(function (sum, person) {
      return sum + Math.max(
        0, target - counts[person.user] - futureSpecial[person.user][day]
      );
    }, 0);
    const dayMin = staffing[1].min + staffing[2].min + staffing[3].min;
    const dayMax = staffing[1].max + staffing[2].max + staffing[3].max;
    const low = Math.max(dayMin, remainingQuota - futureMax);
    const high = Math.min(dayMax, remainingQuota - futureMin);
    if (low > high) {
      return { ok: false, error: formatDate_(date) + ': fond nije moguće završiti.' };
    }
    const planned = Math.max(
      low,
      Math.min(high, Math.round(remainingQuota / (remainingDays + 1)))
    );
    const slots = buildShiftSlots_(staffing, planned, attempt + day);

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const shift = slots[slotIndex];
      const candidates = targetWorkers.filter(function (person) {
        return effectiveDuty_(person, weekIndex) === 'radnik' &&
          !isFreeDate_(person, key) &&
          !isAssigned_(assignments[key], person.user) &&
          counts[person.user] < target &&
          counts[person.user] + futureSpecial[person.user][day] < target &&
          canAssignShift_(states[person.user], shift) &&
          canFinishQuota_(
            states[person.user], shift, counts[person.user],
            target, remainingDays, futureSpecial[person.user][day]
          );
      }).sort(function (a, b) {
        return candidateScore_(
          b, shift, counts, states, target, remainingDays,
          attempt * 101 + day * 997
        ) - candidateScore_(
          a, shift, counts, states, target, remainingDays,
          attempt * 101 + day * 997
        );
      });
      if (!candidates.length) {
        return {
          ok: false,
          error: formatDate_(date) + ': nema dostupnog radnika za ' +
            roman_(shift) + ' smenu.'
        };
      }
      assignPerson_(
        assignments[key][shift], candidates[0], 'Zaposleni',
        states, counts, shift
      );
    }

    configs.forEach(function (person) {
      if (!isAssigned_(assignments[key], person.user)) {
        registerDayOff_(states[person.user]);
      }
    });
  }

  const validation = validateStrictSchedule_(
    year, month, daysInMonth, assignments, targetWorkers, staffing, target
  );
  if (validation) return { ok: false, error: validation };

  const rows = [];
  Object.keys(assignments).sort().forEach(function (key) {
    const date = parseDateKey_(key);
    [1, 2, 3].forEach(function (shiftId) {
      assignments[key][shiftId].forEach(function (item) {
        const shift = shifts[shiftId - 1];
        rows.push([
          date, dayName_(date), shiftId, shift.start, shift.end,
          item.person.name, item.person.user, item.duty,
          monthKey_(year, month), states[item.person.user].cycleIndex, new Date()
        ]);
      });
    });
  });
  return { ok: true, rows: rows };
}

function assignFixed_(person, shift, duty, dateKey, assignments, states, counts, targetUsers, target) {
  if (isFreeDate_(person, dateKey)) {
    return '';
  }
  if (targetUsers[person.user] && counts[person.user] >= target) {
    return person.name + ' prelazi obavezni fond od ' + target + ' smena.';
  }
  assignFixedPerson_(
    assignments[dateKey][shift], person, duty, states, counts, shift
  );
  return '';
}

function assignFixedPerson_(list, person, duty, states, counts, shift) {
  list.push({ person: person, duty: duty });
  counts[person.user] += 1;
  const state = states[person.user];
  state.consecutive += 1;
  state.lastShift = shift;
  state.restRemaining = 0;
  state.nightStreak = shift === 3 ? 1 : 0;
  state.cycleIndex = (state.cycleIndex + 1) % 14;
}

function assignPerson_(list, person, duty, states, counts, shift) {
  list.push({ person: person, duty: duty });
  counts[person.user] += 1;
  const state = states[person.user];
  state.consecutive += 1;
  state.lastShift = shift;
  state.restRemaining = 0;
  if (shift === 3) {
    state.nightStreak += 1;
  } else {
    state.nightStreak = 0;
  }
  state.cycleIndex = (state.cycleIndex + 1) % 14;
}

function canAssignShift_(state, shift) {
  if (state.restRemaining > 0 || state.consecutive >= 5) return false;
  if (state.lastShift === 3) {
    return shift === 3 && state.nightStreak === 1;
  }
  if (state.nightStreak >= 2) return false;
  return true;
}

function canFinishQuota_(state, shift, count, target, remainingDays, futureSpecial) {
  const remainingAfterToday = target - count - 1 - futureSpecial;
  if (shift === 3) {
    const futureWorkCapacity = state.lastShift === 3
      ? Math.max(0, remainingDays - 2)
      : (remainingDays > 0 ? 1 + Math.max(0, remainingDays - 3) : 0);
    return remainingAfterToday <= futureWorkCapacity;
  }
  const forcedDaysOff = state.consecutive + 1 >= 5
    ? Math.min(2, remainingDays)
    : 0;
  return remainingAfterToday <= remainingDays - forcedDaysOff;
}

function registerDayOff_(state) {
  if (state.lastShift === 3 || state.nightStreak > 0 || state.consecutive >= 5) {
    state.restRemaining = Math.max(state.restRemaining, 1);
  } else if (state.restRemaining > 0) {
    state.restRemaining -= 1;
  }
  if (state.restRemaining > 0 && state.lastShift === 0) {
    state.restRemaining -= 1;
  }
  state.lastShift = 0;
  state.nightStreak = 0;
  state.consecutive = 0;
  state.cycleIndex = (state.cycleIndex + 1) % 14;
}

function buildShiftSlots_(staffing, total, seed) {
  const counts = {
    1: staffing[1].min,
    2: staffing[2].min,
    3: staffing[3].min
  };
  let remaining = total - counts[1] - counts[2] - counts[3];
  const order = seed % 2 ? [3, 1, 2] : [3, 2, 1];
  while (remaining > 0) {
    for (let index = 0; index < order.length && remaining > 0; index += 1) {
      const shift = order[index];
      if (counts[shift] < staffing[shift].max) {
        counts[shift] += 1;
        remaining -= 1;
      }
    }
  }
  const slots = [];
  [3, 1, 2].forEach(function (shift) {
    for (let index = 0; index < counts[shift]; index += 1) slots.push(shift);
  });
  return slots;
}

function candidateScore_(person, shift, counts, states, target, remainingDays, attempt) {
  const state = states[person.user];
  const remaining = target - counts[person.user];
  let score = shift === 3
    ? (remainingDays + 1 - remaining) * 12
    : remaining * 100 / Math.max(1, remainingDays + 1);
  if (state.lastShift === shift) score += shift === 3 ? 100 : 12;
  if ((shift === 1 || shift === 2) && state.lastShift &&
      state.lastShift !== shift && state.lastShift !== 3) score -= 10;
  if (shift === 3 && state.consecutive >= 2 && state.consecutive <= 3) score += 35;
  if (shift !== 3) score -= state.consecutive * 12;
  if (state.consecutive >= 4) score -= 60;
  score += pseudoRandom_(person.user + '|' + shift + '|' + attempt) * 24;
  return score;
}

function pseudoRandom_(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function isFreeDate_(person, dateKey) {
  return (person.freeDates || []).indexOf(dateKey) >= 0;
}

function canWorkSpecialBoundary_(person, date, shift) {
  if (isLeaderReplacementWeekend_(person, date)) return false;

  const tomorrow = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12);
  if (tomorrow.getMonth() === date.getMonth() &&
      shift === 3 &&
      effectiveDuty_(person, mondayWeekIndex_(tomorrow)) === 'off' &&
      effectiveDuty_(person, mondayWeekIndex_(date)) !== 'off') {
    return false;
  }

  const day = date.getDay();
  if (day === 0 || day === 6) {
    const daysUntilMonday = day === 6 ? 2 : 1;
    const monday = new Date(
      date.getFullYear(), date.getMonth(), date.getDate() + daysUntilMonday, 12
    );
    const mondayDuty = effectiveDuty_(person, mondayWeekIndex_(monday));
    const currentDuty = effectiveDuty_(person, mondayWeekIndex_(date));
    if (monday.getMonth() === date.getMonth() &&
        (mondayDuty === 'shift_lider' || mondayDuty === 'zamena') &&
        currentDuty !== 'shift_lider' && currentDuty !== 'zamena') {
      return false;
    }
  }
  return true;
}

function isLeaderReplacementWeekend_(person, date) {
  if (date.getDay() !== 0 && date.getDay() !== 6) return false;
  return Boolean(
    person.replacedLeaderByWeek &&
    person.replacedLeaderByWeek[String(mondayWeekIndex_(date))]
  );
}

function workerTimelineValid_(
  year, month, daysInMonth, person, assignments, initialState,
  ignorePlannedAbsences
) {
  const state = Object.assign({}, initialState);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKey_(new Date(year, month - 1, day, 12));
    let shift = 0;
    let fixedDuty = false;
    for (let shiftId = 1; shiftId <= 3 && !shift; shiftId += 1) {
      const found = assignments[key][shiftId].find(function (item) {
        return item.person.user === person.user;
      });
      if (found) {
        shift = shiftId;
        fixedDuty = found.duty !== 'Zaposleni';
      }
    }
    if (shift) {
      const date = new Date(year, month - 1, day, 12);
      if ((!ignorePlannedAbsences && isFreeDate_(person, key)) ||
          (!ignorePlannedAbsences &&
            !canWorkSpecialBoundary_(person, date, shift)) ||
          state.restRemaining > 0 ||
          (!fixedDuty && !canAssignShift_(state, shift))) {
        return false;
      }
      state.consecutive += 1;
      state.lastShift = shift;
      state.restRemaining = 0;
      state.nightStreak = shift === 3
        ? (fixedDuty ? 1 : state.nightStreak + 1)
        : 0;
    } else {
      registerDayOff_(state);
    }
  }
  return true;
}

function workerNightRestValid_(
  year, month, daysInMonth, assignments, user
) {
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (assignedShiftOnDay_(
      day, year, month, assignments, user
    ) !== 3 || assignedShiftOnDay_(
      day + 1, year, month, assignments, user
    ) === 3) {
      continue;
    }
    if (assignedShiftOnDay_(
      day + 1, year, month, assignments, user
    ) || assignedShiftOnDay_(
      day + 2, year, month, assignments, user
    )) {
      return false;
    }
  }
  return true;
}

function workerFinalRulesValid_(
  year, month, daysInMonth, assignments, person
) {
  let consecutive = 0;
  let previousShift = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    const shift = assignedShiftOnDay_(
      day, year, month, assignments, person.user
    );
    if (!shift) {
      consecutive = 0;
      previousShift = 0;
      continue;
    }
    if (isFreeDate_(person, key) ||
        effectiveDuty_(person, mondayWeekIndex_(date)) === 'off' ||
        (previousShift === 2 && shift === 1)) {
      return false;
    }
    consecutive += 1;
    if (consecutive > 5) return false;
    previousShift = shift;
  }
  return workerNightRestValid_(
    year, month, daysInMonth, assignments, person.user
  );
}

function workerStableStartValid_(
  year, month, daysInMonth, assignments, user, initialState
) {
  return workerStableStartViolationCount_(
    year, month, daysInMonth, assignments, user, initialState
  ) === 0;
}

function stablePenaltyIfAssigned_(
  year, month, daysInMonth, assignments, key, shift, person, initialState
) {
  assignments[key][shift].push({ person: person, duty: 'Zaposleni' });
  const penalty = workerStableStartViolationCount_(
    year, month, daysInMonth, assignments, person.user, initialState
  );
  assignments[key][shift].pop();
  return penalty;
}

function workerStableStartViolationCount_(
  year, month, daysInMonth, assignments, user, initialState
) {
  return workerStableStartStats_(
    year, month, daysInMonth, assignments, user, initialState
  ).violations;
}

function workerStableStartStats_(
  year, month, daysInMonth, assignments, user, initialState
) {
  const recent = initialState && Array.isArray(initialState.recentShifts)
    ? initialState.recentShifts
    : [];
  let offStreak = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (Number(recent[index]) !== 0) break;
    offStreak += 1;
  }

  let blockShift = 0;
  let blockCount = 0;
  let stableTarget = 0;
  let starts = 0;
  let violations = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const shift = assignedShiftOnDay_(
      day, year, month, assignments, user
    );
    if (!shift) {
      offStreak += 1;
      blockShift = 0;
      blockCount = 0;
      stableTarget = 0;
      continue;
    }

    if (!blockCount) {
      blockShift = shift;
      blockCount = 1;
      stableTarget = offStreak >= 2 && (shift === 1 || shift === 2) ? 2 : 0;
      if (stableTarget) starts += 1;
      offStreak = 0;
      continue;
    }

    if (stableTarget && blockCount < stableTarget && shift !== blockShift) {
      violations += 1;
    }
    blockCount += 1;
    offStreak = 0;
  }
  return {
    starts: starts,
    violations: violations
  };
}

function buildFutureSpecial_(year, month, daysInMonth, workers) {
  const output = {};
  workers.forEach(function (person) {
    const flags = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month - 1, day, 12);
      const duty = effectiveDuty_(person, mondayWeekIndex_(date));
      flags[day] = date.getDay() >= 1 && date.getDay() <= 5 &&
        (duty === 'shift_lider' || duty === 'monitoring') &&
        !isFreeDate_(person, dateKey_(date)) ? 1 : 0;
    }
    const future = [];
    future[daysInMonth] = 0;
    for (let day = daysInMonth - 1; day >= 0; day -= 1) {
      future[day] = future[day + 1] + (flags[day + 1] || 0);
    }
    output[person.user] = future;
  });
  return output;
}

function validateScheduleWithWarnings_(
  year, month, daysInMonth, assignments, workers, staffing, target
) {
  const warnings = [];
  const counts = {};
  const workByUser = {};
  const regularWorkByUser = {};
  const stableStats = { starts: 0, violations: 0 };
  workers.forEach(function (person) {
    counts[person.user] = 0;
    workByUser[person.user] = {};
    regularWorkByUser[person.user] = {};
  });

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day, 12);
    const key = dateKey_(date);
    for (let shift = 1; shift <= 3; shift += 1) {
      const workerCount = workerCount_(assignments[key][shift]);
      const minimum = requiredCoverageMinimum_(
        date, shift, staffing, assignments[key]
      );
      const maximum = allowedCoverageMaximum_(
        date, shift, staffing, assignments[key]
      );
      if (workerCount > maximum) {
        return {
          error: key + ': broj radnika u ' + roman_(shift) +
            ' smeni prelazi dozvoljeni maksimum od ' + maximum + '.',
          warnings: warnings
        };
      }
      if (workerCount < minimum) {
        warnings.push(
          formatDate_(date) + ': ' + roman_(shift) + ' smena ima ' +
          workerCount + ' radnika jer nije pronađena dostupna zamena; minimum je ' +
          minimum + '.'
        );
      }
      assignments[key][shift].forEach(function (item) {
        if (Object.prototype.hasOwnProperty.call(counts, item.person.user)) {
          counts[item.person.user] += 1;
          workByUser[item.person.user][day] = shift;
          if (item.duty === 'Zaposleni') {
            regularWorkByUser[item.person.user][day] = shift;
          }
        }
      });
    }
  }

  for (let index = 0; index < workers.length; index += 1) {
    const person = workers[index];
    const personTarget = targetFor_(person, target);
    if (!targetWithinTolerance_(counts[person.user], personTarget)) {
      warnings.push(
        person.name + ' ima ' + counts[person.user] + ' smena, planirani fond je ' +
        personTarget + ' (dozvoljeno odstupanje je jedna smena).'
      );
    }
    for (let freeIndex = 0; freeIndex < (person.freeDates || []).length; freeIndex += 1) {
      const parts = person.freeDates[freeIndex].split('-').map(Number);
      if (parts[0] === year && parts[1] === month && workByUser[person.user][parts[2]]) {
        return {
          error: person.name + ' radi na obavezni slobodan datum ' +
            person.freeDates[freeIndex] + '.',
          warnings: warnings
        };
      }
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month - 1, day, 12);
      if (workByUser[person.user][day] &&
          effectiveDuty_(person, mondayWeekIndex_(date)) === 'off') {
        return {
          error: person.name + ' radi ' + formatDate_(date) +
            ' iako je ta nedelja označena kao Ne radi.',
          warnings: warnings
        };
      }
    }
    for (let day = 2; day <= daysInMonth; day += 1) {
      if (workByUser[person.user][day - 1] === 2 &&
          workByUser[person.user][day] === 1) {
        return {
          error: person.name + ' prelazi iz II smene direktno u I smenu.',
          warnings: warnings
        };
      }
    }
    if (!workerNightRestValid_(
      year, month, daysInMonth, assignments, person.user
    )) {
      warnings.push(
        person.name +
          ' nema dva slobodna dana posle poslednje treće smene.'
      );
    }
    if (isReplacementWorker_(person)) {
      const replacementRestError = replacementNightRestError_(
        person, workByUser[person.user], daysInMonth
      );
      if (replacementRestError) {
        warnings.push(replacementRestError);
      }
      continue;
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      if (regularWorkByUser[person.user][day] !== 3) continue;
      const secondNight = regularWorkByUser[person.user][day + 1] === 3;
      const endNight = secondNight ? day + 1 : day;
      if (workByUser[person.user][endNight + 1] ||
          workByUser[person.user][endNight + 2]) {
        warnings.push(person.name + ' nema dva slobodna dana posle treće smene.');
      }
      if (secondNight) day += 1;
    }
    const personStableStats = workerStableStartStats_(
      year, month, daysInMonth, assignments, person.user, null
    );
    stableStats.starts += personStableStats.starts;
    stableStats.violations += personStableStats.violations;
  }
  if (stableStats.starts > 0 &&
      (stableStats.starts - stableStats.violations) / stableStats.starts < 0.8) {
    warnings.push(
      'Manje od 80% početaka posle dva slobodna dana nastavlja istu smenu.'
    );
  }
  return { error: '', warnings: warnings };
}

function validateStrictSchedule_(year, month, daysInMonth, assignments, workers, staffing, target) {
  const counts = {};
  const workByUser = {};
  const regularWorkByUser = {};
  workers.forEach(function (person) { counts[person.user] = 0; });
  workers.forEach(function (person) { workByUser[person.user] = {}; });
  workers.forEach(function (person) { regularWorkByUser[person.user] = {}; });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKey_(new Date(year, month - 1, day, 12));
    const date = new Date(year, month - 1, day, 12);
    for (let shift = 1; shift <= 3; shift += 1) {
      const workerCount = workerCount_(assignments[key][shift]);
      const minimum = requiredWorkerMinimum_(date, shift, staffing);
      const maximum = allowedWorkerMaximum_(date, shift, staffing);
      if (workerCount < minimum || workerCount > maximum) {
        return key + ': broj radnika u ' + roman_(shift) + ' smeni nije u zadatom rasponu.';
      }
      assignments[key][shift].forEach(function (item) {
        if (Object.prototype.hasOwnProperty.call(counts, item.person.user)) {
          counts[item.person.user] += 1;
          workByUser[item.person.user][day] = shift;
          if (item.duty === 'Zaposleni') {
            regularWorkByUser[item.person.user][day] = shift;
          }
        }
      });
    }
  }
  for (let index = 0; index < workers.length; index += 1) {
    const person = workers[index];
    const personTarget = targetFor_(person, target);
    if (!targetWithinTolerance_(counts[person.user], personTarget)) {
      return person.name + ' nema fond ' + personTarget +
        ' uz dozvoljeno odstupanje od jedne smene.';
    }
    for (let freeIndex = 0; freeIndex < (person.freeDates || []).length; freeIndex += 1) {
      const parts = person.freeDates[freeIndex].split('-').map(Number);
      if (parts[0] === year && parts[1] === month && workByUser[person.user][parts[2]]) {
        return person.name + ' radi na obavezni slobodan datum ' + person.freeDates[freeIndex] + '.';
      }
    }
    if (isReplacementWorker_(person)) {
      const replacementRestError = replacementNightRestError_(
        person, workByUser[person.user], daysInMonth
      );
      if (replacementRestError) return replacementRestError;
      continue;
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      if (regularWorkByUser[person.user][day] !== 3) continue;
      const secondNight = regularWorkByUser[person.user][day + 1] === 3;
      const endNight = secondNight ? day + 1 : day;
      if (workByUser[person.user][endNight + 1] ||
          workByUser[person.user][endNight + 2]) {
        return person.name + ' nema dva slobodna dana posle treće smene.';
      }
      if (secondNight) day += 1;
    }
  }
  return '';
}

function isReplacementWorker_(person) {
  return Object.keys(person.replacementInfo || {}).length > 0;
}

function replacementNightRestError_(person, workByDay, daysInMonth) {
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (workByDay[day] !== 3 || workByDay[day + 1] === 3) continue;
    if ((day + 1 <= daysInMonth && workByDay[day + 1]) ||
        (day + 2 <= daysInMonth && workByDay[day + 2])) {
      return person.name +
        ' kao zamena nema dva slobodna dana posle poslednje treće smene.';
    }
  }
  return '';
}

function workerCount_(list) {
  return list.filter(function (item) { return item.duty === 'Zaposleni'; }).length;
}

function isAssigned_(dayAssignments, user) {
  return [1, 2, 3].some(function (shift) {
    return dayAssignments[shift].some(function (item) {
      return item.person.user === user;
    });
  });
}

function getPreviousState_(user, year, month, index, scheduleRows) {
  const previous = new Date(year, month - 2, 1);
  const previousYear = previous.getFullYear();
  const previousMonth = previous.getMonth() + 1;
  const previousDays = new Date(previousYear, previousMonth, 0).getDate();
  const rows = (scheduleRows || readRawSchedule_()).filter(function (row) {
    return row.user === user &&
      row.date.getFullYear() === previousYear &&
      row.date.getMonth() + 1 === previousMonth;
  }).sort(function (a, b) { return a.date - b.date; });
  const last = rows.length ? rows.reduce(function (latest, row) {
    if (!latest || row.date > latest.date) return row;
    if (row.date.getTime() === latest.date.getTime() &&
        row.created > latest.created) {
      return row;
    }
    return latest;
  }, null) : null;
  const state = {
    cycleIndex: last && Number.isFinite(last.cycleIndex)
      ? last.cycleIndex
      : (index * 3) % 14,
    hasPrevious: Boolean(last),
    consecutive: 0,
    nightStreak: 0,
    restRemaining: 0,
    lastShift: 0
  };
  const savedCycleIndex = state.cycleIndex;
  const byDate = {};
  rows.forEach(function (row) { byDate[dateKey_(row.date)] = row.shift; });
  for (let day = 1; day <= previousDays; day += 1) {
    const key = dateKey_(new Date(previousYear, previousMonth - 1, day, 12));
    const shift = byDate[key];
    if (shift) {
      state.consecutive += 1;
      state.lastShift = shift;
      state.restRemaining = 0;
      state.nightStreak = shift === 3 ? state.nightStreak + 1 : 0;
    } else {
      registerDayOff_(state);
    }
  }
  state.recentShifts = [];
  for (let day = Math.max(1, previousDays - 3);
       day <= previousDays;
       day += 1) {
    const key = dateKey_(new Date(previousYear, previousMonth - 1, day, 12));
    state.recentShifts.push(Number(byDate[key]) || 0);
  }
  while (state.recentShifts.length < 4) state.recentShifts.unshift(0);
  state.restRemaining = monthBoundaryNightRestDays_(state.recentShifts);
  state.cycleIndex = savedCycleIndex;
  return state;
}

function monthBoundaryNightRestDays_(recentShifts) {
  const recent = Array.isArray(recentShifts)
    ? recentShifts.map(Number)
    : [];
  let daysOff = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index] === 0) {
      daysOff += 1;
      continue;
    }
    return recent[index] === 3 ? Math.max(0, 2 - daysOff) : 0;
  }
  return 0;
}

function monthStartState_(previousState) {
  return {
    cycleIndex: Number(previousState && previousState.cycleIndex) || 0,
    hasPrevious: Boolean(previousState && previousState.hasPrevious),
    consecutive: Number(previousState && previousState.consecutive) || 0,
    nightStreak: Number(previousState && previousState.nightStreak) || 0,
    restRemaining: Number(previousState && previousState.restRemaining) || 0,
    lastShift: Number(previousState && previousState.lastShift) || 0,
    recentShifts: previousState &&
      Array.isArray(previousState.recentShifts)
      ? previousState.recentShifts.slice(-4)
      : [0, 0, 0, 0]
  };
}

function effectiveDuty_(person, weekIndex) {
  const override = person.weekOverrides[String(weekIndex)];
  return override || person.duty;
}

function mondayWeekIndex_(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  const offset = (first.getDay() + 6) % 7;
  return Math.floor((date.getDate() + offset - 1) / 7);
}

function writeMonth_(year, month, rows) {
  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.schedule);
  const key = monthKey_(year, month);
  const monthStart = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month, 1);
  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.scheduleHeaders.length).getValues()
    : [];
  const keep = existing.filter(function (row) {
    const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
    const belongsToMonth = !isNaN(date.getTime()) &&
      date >= monthStart && date < nextMonth;
    return !belongsToMonth && String(row[8]) !== key;
  });
  const combined = keep.concat(rows);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.scheduleHeaders.length).clearContent();
  }
  if (combined.length) {
    sheet.getRange(2, 1, combined.length, APP.scheduleHeaders.length).setValues(combined);
    sheet.getRange(2, 1, combined.length, 1).setNumberFormat('dd.MM.yyyy');
  }
}

function rewriteScheduleRows_(rows) {
  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.schedule);
  const values = rows.sort(function (a, b) {
    return a.date - b.date || a.shift - b.shift ||
      a.name.localeCompare(b.name);
  }).map(function (row) {
    return [
      row.date, row.day || dayName_(row.date), row.shift, row.start, row.end,
      row.name, row.user, row.duty, row.month ||
        monthKey_(row.date.getFullYear(), row.date.getMonth() + 1),
      Number(row.cycleIndex) || 0,
      row.created ? new Date(row.created) : new Date(),
      row.replacedUser || '',
      row.replacedName || ''
    ];
  });
  if (sheet.getLastRow() > 1) {
    sheet.getRange(
      2, 1, sheet.getLastRow() - 1, APP.scheduleHeaders.length
    ).clearContent();
  }
  if (values.length) {
    sheet.getRange(2, 1, values.length, APP.scheduleHeaders.length)
      .setValues(values);
    sheet.getRange(2, 1, values.length, 1).setNumberFormat('dd.MM.yyyy');
  }
}

function readRawSchedule_() {
  const sheet = getSpreadsheet_().getSheetByName(APP.sheets.schedule);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const parsed = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.scheduleHeaders.length)
    .getValues()
    .map(function (row, index) {
      const date = normalizeSheetDate_(row[0]);
      return {
        date: date,
        day: String(row[1]),
        shift: Number(row[2]),
        start: String(row[3]),
        end: String(row[4]),
        name: String(row[5]),
        user: String(row[6]),
        duty: String(row[7]),
        month: String(row[8]),
        cycleIndex: Number(row[9]),
        created: row[10] instanceof Date ? row[10].getTime() : 0,
        replacedUser: String(row[11] || ''),
        replacedName: String(row[12] || ''),
        rowIndex: index
      };
    })
    .filter(function (row) {
      return row.name && row.date instanceof Date && !isNaN(row.date.getTime()) &&
        row.shift >= 1 && row.shift <= 3;
    });

  const latest = {};
  parsed.forEach(function (row) {
    const key = dateKey_(row.date) + '|' + row.shift + '|' + row.user.toLowerCase();
    const current = latest[key];
    if (!current || row.created > current.created ||
        (row.created === current.created && row.rowIndex > current.rowIndex)) {
      latest[key] = row;
    }
  });
  return Object.keys(latest).map(function (key) { return latest[key]; });
}

function readScheduleWindow_(currentUser, fromOffset, days) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + Number(fromOffset || 0));
  const end = new Date(start);
  end.setDate(end.getDate() + Number(days || 35));
  return serializeSchedule_(readRawSchedule_().filter(function (row) {
    return row.date >= start && row.date < end;
  }), currentUser);
}

function readMonth_(year, month) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0, 0);
  return serializeSchedule_(readRawSchedule_().filter(function (row) {
    return row.date >= start && row.date < end;
  }), null);
}

function normalizeSheetDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(
      value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0
    );
  }

  const text = String(value || '').trim();
  let match = text.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if (match) {
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12);
  }
  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  }

  const parsed = new Date(value);
  return isNaN(parsed.getTime())
    ? new Date(NaN)
    : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12);
}

function serializeSchedule_(rows, currentUser) {
  const groups = {};
  rows.forEach(function (row) {
    const key = dateKey_(row.date);
    if (!groups[key]) {
      groups[key] = {
        date: key,
        day: dayName_(row.date),
        shifts: { 1: [], 2: [], 3: [] }
      };
    }
    groups[key].shifts[row.shift].push({
      name: row.name,
      user: row.user,
      duty: row.duty,
      replacedUser: row.replacedUser,
      replacedName: row.replacedName,
      mine: currentUser ? row.user === currentUser : false
    });
  });
  return Object.keys(groups).sort().map(function (key) { return groups[key]; });
}

function styleHeader_(sheet, columns) {
  sheet.getRange(1, 1, 1, columns)
    .setBackground('#173f3a')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.autoResizeColumns(1, columns);
}

function monthKey_(year, month) {
  return year + '-' + String(month).padStart(2, '0');
}

function dateKey_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function parseDateKey_(value) {
  const parts = value.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 12);
}

function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy');
}

function dayName_(date) {
  return ['Nedelja', 'Ponedeljak', 'Utorak', 'Sreda', 'Četvrtak', 'Petak', 'Subota'][date.getDay()];
}

function roman_(shift) {
  return shift === 1 ? 'I' : shift === 2 ? 'II' : 'III';
}

function applyReplacementInfo_(rows, configs) {
  const namesByUser = {};
  const replacementByWeekAndUser = {};
  configs.forEach(function (person) {
    namesByUser[person.user.toLowerCase()] = person.name;
    Object.keys(person.replacementInfo).forEach(function (weekStr) {
      replacementByWeekAndUser[
        weekStr + '|' + person.user.toLowerCase()
      ] = String(person.replacementInfo[weekStr] || '').toLowerCase();
    });
  });

  return rows.map(function (row) {
    const weekIndex = mondayWeekIndex_(row[0]);
    const replacedUser = replacementByWeekAndUser[
      String(weekIndex) + '|' + String(row[6]).toLowerCase()
    ] || '';
    row[11] = replacedUser;
    row[12] = replacedUser ? namesByUser[replacedUser] || replacedUser : '';
    return row;
  });
}

function unique_(items) {
  return items.filter(function (item, index) { return items.indexOf(item) === index; });
}
