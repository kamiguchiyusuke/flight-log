/**
 * スプレッドシートへのアクセス層。
 * 末尾が _ の関数は内部用（ウェブアプリから直接呼べない）。
 */

/**
 * 初回セットアップ。GAS エディタから1回だけ手動実行する。
 * flights / aircraft シートとヘッダ行を生成する。
 * 既にシートがある場合は何も壊さない。
 */
function setup() {
  getSheet_(SHEET_FLIGHTS, FLIGHT_COLUMNS);
  getSheet_(SHEET_AIRCRAFT, AIRCRAFT_COLUMNS);
  getSheet_(SHEET_AIRLINES, AIRLINE_COLUMNS);
  var msg = 'セットアップ完了: flights / aircraft / airlines シートを用意しました';
  Logger.log(msg);
  return msg;
}

/** シートを取得する。無ければ作成し、空ならヘッダを入れる */
function getSheet_(name, columns) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length)
      .setValues([columns])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** シート全行をオブジェクト配列で返す（ヘッダ行は除く） */
function readAll_(name, columns) {
  var sheet = getSheet_(name, columns);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, columns.length).getValues();
  return values.map(function (row) {
    var obj = {};
    columns.forEach(function (col, i) {
      obj[col] = row[i];
    });
    return obj;
  });
}

/**
 * flights に1行追記して、採番した id を返す。
 * id と created_at はここで埋めるので呼び出し側は渡さなくてよい。
 */
function appendFlight_(obj) {
  var sheet = getSheet_(SHEET_FLIGHTS, FLIGHT_COLUMNS);
  var id = nextId_(sheet);
  var tz = Session.getScriptTimeZone();

  var record = {};
  Object.keys(obj).forEach(function (k) { record[k] = obj[k]; });
  record.id = id;
  record.created_at = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX");

  var row = FLIGHT_COLUMNS.map(function (col) {
    return record[col] === undefined || record[col] === null ? '' : record[col];
  });
  sheet.appendRow(row);
  return id;
}

/** flights の id 最大値 + 1 */
function nextId_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var max = 0;
  ids.forEach(function (r) {
    var n = Number(r[0]);
    if (!isNaN(n) && n > max) max = n;
  });
  return max + 1;
}

/**
 * 機体マスタを upsert する。
 * 既存行がある場合は「空欄だけ」を埋める。シート上で手修正した内容を上書きしないため。
 */
function upsertAircraft_(obj) {
  var reg = String(obj.registration || '').trim().toUpperCase();
  if (!reg) return;

  var sheet = getSheet_(SHEET_AIRCRAFT, AIRCRAFT_COLUMNS);
  var key = regKey_(reg);
  var lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    var regs = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < regs.length; i++) {
      if (regKey_(regs[i][0]) !== key) continue;

      var rowNum = i + 2;
      var range = sheet.getRange(rowNum, 1, 1, AIRCRAFT_COLUMNS.length);
      var current = range.getValues()[0];
      var changed = false;
      AIRCRAFT_COLUMNS.forEach(function (col, idx) {
        var filled = String(current[idx] === null || current[idx] === undefined ? '' : current[idx]).trim();
        if (!filled && obj[col]) {
          current[idx] = obj[col];
          changed = true;
        }
      });
      if (changed) range.setValues([current]);
      return;
    }
  }

  sheet.appendRow(AIRCRAFT_COLUMNS.map(function (col) {
    if (col === 'registration') return reg;
    return obj[col] || '';
  }));
}

/**
 * 航空会社のロゴマスタを upsert する。機体マスタと同じく「空欄だけ」を埋める。
 *
 * 注意: 「ロゴ列を空にした」＝この会社はコード表示でよい、という意思表示だが、
 * この関数はそれを区別できない（空欄なら埋めてしまう）。
 * その判断は呼び出し側が持つ。Logos.js の ensureAirlineLogo_() は
 * 行が既にあれば何もしないので、一度消したロゴは復活しない。
 */
function upsertAirline_(obj) {
  var code = String(obj.code || '').trim().toUpperCase();
  if (!code) return;

  var sheet = getSheet_(SHEET_AIRLINES, AIRLINE_COLUMNS);
  var lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    var codes = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < codes.length; i++) {
      if (String(codes[i][0] || '').trim().toUpperCase() !== code) continue;

      var rowNum = i + 2;
      var range = sheet.getRange(rowNum, 1, 1, AIRLINE_COLUMNS.length);
      var current = range.getValues()[0];
      var changed = false;
      AIRLINE_COLUMNS.forEach(function (col, idx) {
        var filled = String(current[idx] === null || current[idx] === undefined ? '' : current[idx]).trim();
        if (!filled && obj[col]) {
          current[idx] = obj[col];
          changed = true;
        }
      });
      if (changed) range.setValues([current]);
      return;
    }
  }

  sheet.appendRow(AIRLINE_COLUMNS.map(function (col) {
    if (col === 'code') return code;
    return obj[col] || '';
  }));
}

/**
 * 登録記号の比較用キー。
 * 大文字化して英数字以外を落とす。JA873A と ja-873a を同一機体として扱うため。
 * シートに保存するのは大文字化しただけの元の表記（D-AIMA のハイフンを残す）。
 */
function regKey_(v) {
  return String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Date でも文字列でも 'yyyy-MM-dd' に正規化する */
function toDateString_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v === null || v === undefined ? '' : v).trim();
}
