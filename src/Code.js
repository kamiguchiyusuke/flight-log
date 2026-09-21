/**
 * ウェブアプリのエントリポイントと、画面から google.script.run で呼ぶ API 群。
 */

/** ウェブアプリを開いたときに index.html を返す */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('搭乗機材ログ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * 画面の初期表示に必要なものを1回のリクエストでまとめて返す。
 * 通信の往復を減らすため、入力候補と直近ログを同時に取る。
 */
function bootstrap() {
  return {
    suggestions: suggestions(),
    log: flightLog(),
    today: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

/**
 * 登録記号を照合する。このアプリの中核。
 * 機体マスタと過去の搭乗履歴の両方を見て、搭乗回数と前回フライトを返す。
 *
 * 搭乗回数は aircraft シートに保存せず flights から都度数える。
 * ログを手で消しても数がズレないため。
 */
function lookupAircraft(registration) {
  var key = regKey_(registration);
  if (!key) return { found: false, type: '', airline: '', timesFlown: 0, lastFlight: null };

  var master = readAll_(SHEET_AIRCRAFT, AIRCRAFT_COLUMNS).filter(function (a) {
    return regKey_(a.registration) === key;
  })[0];

  var flights = readAll_(SHEET_FLIGHTS, FLIGHT_COLUMNS)
    .filter(function (f) { return regKey_(f.registration) === key; })
    .map(function (f) {
      return {
        date: toDateString_(f.date),
        flightNo: String(f.flight_no || ''),
        dep: String(f.dep || ''),
        arr: String(f.arr || ''),
        type: String(f.aircraft_type || ''),
        airline: String(f.airline || '')
      };
    })
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });

  var last = flights[0] || null;

  return {
    found: !!(master || last),
    type: (master && master.aircraft_type) || (last && last.type) || '',
    airline: (master && master.airline) || (last && last.airline) || '',
    timesFlown: flights.length,
    lastFlight: last ? {
      date: last.date,
      flightNo: last.flightNo,
      dep: last.dep,
      arr: last.arr,
      depLabel: airportLabel_(last.dep),
      arrLabel: airportLabel_(last.arr)
    } : null
  };
}

/**
 * 便名から航空会社を判定し、過去に同じ便名で飛んでいれば区間と型式を推定して返す。
 */
function lookupFlightNo(flightNo) {
  var norm = normalizeFlightNo_(flightNo);
  var result = { airline: airlineFromFlightNo_(norm), dep: '', arr: '', type: '', timesFlown: 0 };
  if (!norm) return result;

  var past = readAll_(SHEET_FLIGHTS, FLIGHT_COLUMNS)
    .filter(function (f) { return normalizeFlightNo_(f.flight_no) === norm; })
    .map(function (f) {
      return {
        date: toDateString_(f.date),
        dep: String(f.dep || ''),
        arr: String(f.arr || ''),
        type: String(f.aircraft_type || ''),
        airline: String(f.airline || '')
      };
    })
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });

  result.timesFlown = past.length;
  if (past.length) {
    result.dep = past[0].dep;
    result.arr = past[0].arr;
    result.type = past[0].type;
    if (!result.airline) result.airline = past[0].airline;
  }
  return result;
}

/**
 * 1フライトを保存する。flights に追記し、機体マスタを upsert する。
 * 戻り値の timesFlown は「今回を含めて何回目か」。
 */
function saveFlight(payload) {
  var p = payload || {};
  var date = toDateString_(p.date);
  var reg = String(p.registration || '').trim().toUpperCase();
  var flightNo = normalizeFlightNo_(p.flightNo);
  var airline = String(p.airline || '').trim();
  var type = String(p.aircraftType || '').trim();

  var dep = String(p.dep || '').trim().toUpperCase();
  var arr = String(p.arr || '').trim().toUpperCase();

  // 画面でも弾いているが、ウェブアプリは URL を知っていれば誰でも叩けるので
  // ここでも確かめる
  if (!date) throw new Error('搭乗日を入力してください');
  if (!dep) throw new Error('出発空港を入力してください');
  if (!arr) throw new Error('到着空港を入力してください');
  if (!reg) throw new Error('登録記号を入力してください');

  // 同時実行でidが重複しないようロックを取る
  var lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    var before = lookupAircraft(reg).timesFlown;

    var id = appendFlight_({
      date: date,
      flight_no: flightNo,
      airline: airline,
      dep: dep,
      arr: arr,
      aircraft_type: type,
      registration: reg,
      note: String(p.note || '').trim()
    });

    upsertAircraft_({
      registration: reg,
      aircraft_type: type,
      airline: airline
    });

    return {
      ok: true,
      id: id,
      registration: reg,
      timesFlown: before + 1,
      log: flightLog(),
      suggestions: suggestions()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 搭乗ログを全件、搭乗日の新しい順に返す。
 * 同じ日に複数レグ乗った場合は、後から入力した方を上に出す。
 */
function flightLog() {
  return readAll_(SHEET_FLIGHTS, FLIGHT_COLUMNS)
    .map(function (f) {
      return {
        id: Number(f.id) || 0,
        date: toDateString_(f.date),
        flightNo: String(f.flight_no || ''),
        carrier: carrierCode_(f.flight_no),
        airline: String(f.airline || ''),
        dep: String(f.dep || ''),
        arr: String(f.arr || ''),
        depLabel: airportLabel_(f.dep),
        arrLabel: airportLabel_(f.arr),
        type: String(f.aircraft_type || ''),
        registration: String(f.registration || '')
      };
    })
    .sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.id - a.id;
    });
}

/** datalist 用の入力候補。過去に入力した値から作る */
function suggestions() {
  var flights = readAll_(SHEET_FLIGHTS, FLIGHT_COLUMNS);
  var master = readAll_(SHEET_AIRCRAFT, AIRCRAFT_COLUMNS);

  var pick = function (rows, col) {
    return rows.map(function (r) { return r[col]; });
  };

  return {
    flightNos: uniqSorted_(pick(flights, 'flight_no')),
    airports: airportOptions_(pick(flights, 'dep').concat(pick(flights, 'arr'))),
    types: withMaster_(pick(flights, 'aircraft_type').concat(pick(master, 'aircraft_type')), AIRCRAFT_TYPES),
    airlines: withMaster_(pick(flights, 'airline').concat(pick(master, 'airline')), airlineNames_()),
    registrations: uniqSorted_(pick(master, 'registration').concat(pick(flights, 'registration')))
  };
}

/** 空を除いて重複を潰し、ソートして返す */
function uniqSorted_(arr) {
  var seen = {};
  var out = [];
  arr.forEach(function (v) {
    var s = String(v === null || v === undefined ? '' : v).trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out.sort();
}

/** 便名を正規化する（大文字化・空白除去）。NH 262 と nh262 を同一扱いにする */
function normalizeFlightNo_(v) {
  return String(v === null || v === undefined ? '' : v).toUpperCase().replace(/\s+/g, '').trim();
}

/** 便名の頭2文字（IATA の航空会社コード）。取れなければ空文字 */
function carrierCode_(flightNo) {
  var m = normalizeFlightNo_(flightNo).match(/^([A-Z0-9]{2})\d/);
  return m ? m[1] : '';
}

/** 便名の頭2文字から航空会社名を引く。表になければ空文字 */
function airlineFromFlightNo_(flightNo) {
  return AIRLINE_CODES[carrierCode_(flightNo)] || '';
}

/** 空港コードを「羽田(HND)」形式にする。対照表にないコードはそのまま返す */
function airportLabel_(code) {
  var c = String(code === null || code === undefined ? '' : code).trim().toUpperCase();
  if (!c) return '';
  var name = AIRPORT_NAMES[c];
  return name ? name + '(' + c + ')' : c;
}

/**
 * 空港の入力候補。過去に使ったコードを先頭に、続けて対照表の全空港を並べる。
 * 初めて行く空港でもサジェストが効くようにするため、過去の入力だけに絞らない。
 */
function airportOptions_(usedCodes) {
  var seen = {};
  var out = [];

  var push = function (code) {
    var c = String(code === null || code === undefined ? '' : code).trim().toUpperCase();
    if (!c || seen[c]) return;
    seen[c] = true;
    out.push({ code: c, name: AIRPORT_NAMES[c] || '' });
  };

  uniqSorted_(usedCodes).forEach(push);
  Object.keys(AIRPORT_NAMES).sort().forEach(push);
  return out;
}

/**
 * 過去に入力した値を先に、続けて対照表の全件を並べる。
 * よく乗るものが上に来るようにしつつ、まだ乗っていないものも選べるようにする。
 */
function withMaster_(used, master) {
  var seen = {};
  var out = [];

  var push = function (v) {
    var s = String(v === null || v === undefined ? '' : v).trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  };

  uniqSorted_(used).forEach(push);
  (master || []).forEach(push);
  return out;
}

/** 航空会社コード表に載っている会社名の一覧 */
function airlineNames_() {
  return Object.keys(AIRLINE_CODES)
    .map(function (code) { return AIRLINE_CODES[code]; })
    .sort();
}
