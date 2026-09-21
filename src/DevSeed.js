/**
 * 動作確認用のサンプルデータ投入。開発時だけ使う。
 * 本運用を始めたら clearAllData() で消して、このファイルごと削除してよい。
 *
 * 登録記号はそれらしく作った「サンプル」で、実在の機体とは限らない。
 */

/** サンプルの搭乗履歴。同じ機体に複数回乗った履歴を意図的に混ぜてある */
var SAMPLE_FLIGHTS = [
  // date,        flight_no, dep,   arr,   type,       registration
  ['2024-08-11', 'NH15',   'HND', 'ITM', 'B787-8',   'JA813A'],
  ['2024-08-14', 'NH28',   'ITM', 'HND', 'B787-8',   'JA813A'], // 往復で同じ機材
  ['2024-11-02', 'NH63',   'HND', 'FUK', 'B777-200', 'JA745A'],
  ['2024-11-05', 'NH72',   'FUK', 'HND', 'B787-9',   'JA873A'],
  ['2025-01-12', 'JL107',  'HND', 'ITM', 'B767-300', 'JA656J'],
  ['2025-01-15', 'JL120',  'ITM', 'HND', 'A350-900', 'JA04XJ'],
  ['2025-03-20', 'NH67',   'HND', 'FUK', 'B787-9',   'JA873A'], // JA873A 2回目
  ['2025-05-04', 'BC21',   'HND', 'KOJ', 'B737-800', 'JA73NY'],
  ['2025-05-07', 'BC28',   'KOJ', 'HND', 'B737-800', 'JA73NY'], // JA73NY 2回目
  ['2025-07-18', 'JL317',  'HND', 'FUK', 'B787-8',   'JA824J'],
  ['2025-09-01', '6J51',   'HND', 'KMI', 'B737-800', 'JA806X'],
  ['2025-12-28', 'NH985',  'HND', 'OKA', 'B787-9',   'JA873A'], // JA873A 3回目
  ['2026-02-14', 'JL904',  'HND', 'OKA', 'B777-200', 'JA8979'],
  ['2026-05-03', 'NH19',   'HND', 'ITM', 'A321neo',  'JA131A'],
  ['2026-08-09', 'JL110',  'HND', 'ITM', 'A350-900', 'JA04XJ']  // JA04XJ 2回目
];

/**
 * サンプルデータを投入する。GAS エディタから手動実行する。
 * 既にデータがある場合は何もしない（二重投入を防ぐため）。
 */
function seedSampleData() {
  var sheet = getSheet_(SHEET_FLIGHTS, FLIGHT_COLUMNS);
  if (sheet.getLastRow() >= 2) {
    var msg = '中止: flights に既にデータがあります。入れ直すなら先に clearAllData() を実行してください';
    Logger.log(msg);
    return msg;
  }

  SAMPLE_FLIGHTS.forEach(function (r) {
    var flightNo = r[1];
    var airline = airlineFromFlightNo_(flightNo);

    appendFlight_({
      date: r[0],
      flight_no: flightNo,
      airline: airline,
      dep: r[2],
      arr: r[3],
      aircraft_type: r[4],
      registration: r[5],
      note: ''
    });

    upsertAircraft_({
      registration: r[5],
      aircraft_type: r[4],
      airline: airline
    });
  });

  var aircraftCount = getSheet_(SHEET_AIRCRAFT, AIRCRAFT_COLUMNS).getLastRow() - 1;
  var result = '投入完了: ' + SAMPLE_FLIGHTS.length + '件のフライト / ' + aircraftCount + '機の機体';
  Logger.log(result);
  return result;
}

/**
 * flights と aircraft の中身を全部消す（ヘッダは残す）。
 *
 * 誤実行を防ぐため、下の CONFIRM を true に書き換えてから実行すること。
 * 消したデータは戻らない。
 */
function clearAllData() {
  var CONFIRM = false;

  if (!CONFIRM) {
    var msg = '中止しました。実行するには clearAllData() 内の CONFIRM を true に書き換えてください';
    Logger.log(msg);
    return msg;
  }

  var cleared = [];
  [[SHEET_FLIGHTS, FLIGHT_COLUMNS], [SHEET_AIRCRAFT, AIRCRAFT_COLUMNS]].forEach(function (pair) {
    var sheet = getSheet_(pair[0], pair[1]);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.deleteRows(2, lastRow - 1);
      cleared.push(pair[0] + ': ' + (lastRow - 1) + '行');
    }
  });

  var result = cleared.length ? '削除しました — ' + cleared.join(' / ') : '消すデータがありませんでした';
  Logger.log(result);
  return result;
}
