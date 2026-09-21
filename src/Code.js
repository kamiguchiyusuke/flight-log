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
    logos: airlineLogos(),
    carriers: carriersByName(),
    today: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

/**
 * 航空会社コード → ロゴ の対応表。
 *
 * 行ごとではなくマップで返す。同じ会社が何行あっても base64 は 1 つで済み、
 * 台帳が育っても送信量が増えない。
 * ここに載らなかった会社は、台帳では 2 レターコードの枠で出る。
 */
function airlineLogos() {
  var out = {};
  readAll_(SHEET_AIRLINES, AIRLINE_COLUMNS).forEach(function (a) {
    var code = String(a.code || '').trim().toUpperCase();
    var logo = String(a.logo || '').trim();
    // 画像として成立する値だけ通す。AIRLINE_LOGO_NONE やセルの打ち間違いが
    // そのまま <img src> に流れ込むのを防ぐ
    if (code && /^(data:|https?:)/.test(logo)) out[code] = logo;
  });
  return out;
}

/**
 * 登録記号を照合する。このアプリの中核。
 * 機体マスタと過去の搭乗履歴の両方を見て、搭乗回数と前回フライトを返す。
 *
 * 搭乗回数は aircraft シートに保存せず flights から都度数える。
 * ログを手で消しても数がズレないため。
 *
 * excludeId を渡すと、その id の記録を数えない。編集中に「その記録自身」を
 * past として数えてしまうと、3 回目の記録を直しているのに 4 回目と出る。
 */
function lookupAircraft(registration, excludeId) {
  var key = regKey_(registration);
  if (!key) return { found: false, type: '', airline: '', timesFlown: 0, lastFlight: null };

  var skip = Number(excludeId) || 0;

  var master = readAll_(SHEET_AIRCRAFT, AIRCRAFT_COLUMNS).filter(function (a) {
    return regKey_(a.registration) === key;
  })[0];

  var flights = readAll_(SHEET_FLIGHTS, FLIGHT_COLUMNS)
    .filter(function (f) { return regKey_(f.registration) === key && Number(f.id) !== skip; })
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
  var carrier = carrierCode_(norm);
  var result = {
    airline: airlineFromFlightNo_(norm),
    carrier: carrier,
    logo: '',
    dep: '', arr: '', type: '', timesFlown: 0
  };
  if (!norm) return result;

  // 記入の時点でロゴを揃えておく。保存まで待たせると、台帳に出るまで
  // ロゴが無いのかどうか分からない。
  // この関数の本業は区間と航空会社の補完なので、取得の失敗で
  // そちらまで巻き込まないよう握り潰す
  if (carrier) {
    try {
      ensureAirlineLogo_(carrier);
      result.logo = airlineLogos()[carrier] || '';
    } catch (e) {
      Logger.log('便名入力時のロゴ取得を飛ばしました: ' + e.message);
    }
  }

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
 * payload.id があれば追記ではなくその行を書き換える（台帳からの編集）。
 * 戻り値の timesFlown は「この記録が何回目の搭乗か」。
 */
function saveFlight(payload) {
  var p = payload || {};
  var editId = Number(p.id) || 0;
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

  // 登録記号は任意。機体が分からないまま記録したい場面があるため。
  // 空なら lookupAircraft_ が 0 回を返し、upsertAircraft_ は何もしない

  // 同時実行でidが重複しないようロックを取る
  var lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    // 編集中は自分自身を past から外す。でないと 3 回目を直しているのに 4 回目と出る
    var before = lookupAircraft(reg, editId).timesFlown;

    var record = {
      date: date,
      flight_no: flightNo,
      airline: airline,
      dep: dep,
      arr: arr,
      aircraft_type: type,
      registration: reg,
      note: String(p.note || '').trim()
    };

    var id;
    if (editId) {
      if (!updateFlight_(editId, record)) throw new Error('書き換える記録が見つかりませんでした');
      id = editId;
    } else {
      id = appendFlight_(record);
    }

    upsertAircraft_({
      registration: reg,
      aircraft_type: type,
      airline: airline
    });

    // 初めて乗る航空会社ならロゴを取りに行く。機体マスタと同じく
    // 「空から育てる」。UrlFetchApp は同期なので、配信元が落ちていたり
    // 遅かったりしても保存そのものは絶対に巻き込まないよう握り潰す
    try {
      ensureAirlineLogo_(carrierOf_(flightNo, airline));
    } catch (e) {
      Logger.log('ロゴの取得を飛ばしました: ' + e.message);
    }

    return {
      ok: true,
      id: id,
      edited: !!editId,
      registration: reg,
      timesFlown: before + 1,
      log: flightLog(),
      logos: airlineLogos(),
      suggestions: suggestions()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 記録を 1 件消す。台帳からその記録を開いて削除したときに呼ぶ。
 *
 * 戻り値は saveFlight と同じ顔ぶれ。画面はこれをそのまま流し込めば
 * 台帳・候補・ロゴが一度に描き変わる。
 */
function deleteFlight(id) {
  var target = Number(id) || 0;
  if (!target) throw new Error('消す記録が指定されていません');

  var lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    if (!deleteFlight_(target)) throw new Error('消す記録が見つかりませんでした');

    return {
      ok: true,
      id: target,
      log: flightLog(),
      logos: airlineLogos(),
      suggestions: suggestions()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 航空会社名 → コード の対応表。画面が便名なしでもコードを出せるようにする。
 * 32 件なので送っても 2KB 程度。
 */
function carriersByName() {
  var out = {};
  Object.keys(AIRLINE_CODES).forEach(function (c) { out[AIRLINE_CODES[c]] = c; });
  return out;
}

/**
 * この会社のロゴがまだ無ければ取りに行き、結果を返す。
 * 航空会社欄を直接編集したときに画面から呼ぶ。
 */
function ensureLogo(code) {
  var c = String(code || '').trim().toUpperCase();
  if (!c) return { code: '', logo: '' };

  try {
    ensureAirlineLogo_(c);
  } catch (e) {
    Logger.log('ロゴの取得を飛ばしました: ' + e.message);
  }
  return { code: c, logo: airlineLogos()[c] || '' };
}

/**
 * 自分で用意した画像をその航空会社のロゴにする。
 *
 * 取得元のロゴが無い・おかしいときの逃げ道。画面側で PNG に縮小済みの
 * data URI が渡ってくる前提で、ここでは形だけ確かめる。
 */
function setAirlineLogoImage(code, dataUrl) {
  var c = String(code || '').trim().toUpperCase();
  if (!c) throw new Error('航空会社コードがありません');

  var url = String(dataUrl || '').trim();
  if (url.indexOf('data:image/') !== 0) throw new Error('画像として受け取れませんでした');

  setAirlineLogoValue_(c, url);
  return { ok: true, code: c, logo: url };
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
        carrier: carrierOf_(f.flight_no, f.airline),
        airline: String(f.airline || ''),
        dep: String(f.dep || ''),
        arr: String(f.arr || ''),
        depLabel: airportLabel_(f.dep),
        arrLabel: airportLabel_(f.arr),
        type: String(f.aircraft_type || ''),
        registration: String(f.registration || ''),
        // 編集で備考が消えないよう、台帳にも載せて持ち回る
        note: String(f.note || '')
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

/**
 * 航空会社名からコードを引く。AIRLINE_CODES の逆引き。
 *
 * 便名を入れずに航空会社だけ書く記入が普通にあるので、
 * コードの手がかりを便名だけに頼らない。
 */
function carrierFromAirlineName_(name) {
  var n = String(name === null || name === undefined ? '' : name).trim();
  if (!n) return '';

  var codes = Object.keys(AIRLINE_CODES);
  for (var i = 0; i < codes.length; i++) {
    if (AIRLINE_CODES[codes[i]] === n) return codes[i];
  }
  return '';
}

/**
 * その記録の航空会社コード。便名を優先し、無ければ航空会社名から引く。
 */
function carrierOf_(flightNo, airline) {
  return carrierCode_(flightNo) || carrierFromAirlineName_(airline);
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
