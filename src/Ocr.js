/**
 * 画像から搭乗情報を読み取る。
 *
 * Google ドライブの OCR を使う。画像を Google ドキュメントに変換すると
 * OCR が走るという仕組みで、API キーも追加費用も要らない。
 * ただし読めるのは「文字」だけなので、対象は搭乗券や航空会社アプリの
 * 画面のように印字されたもの。機体の写真から登録記号を読むのは不得手。
 */

/**
 * 画面から呼ぶ入口。data URL 形式の画像を受け取り、読み取れた項目を返す。
 * 見つからなかった項目は空文字で返し、画面側では空欄のままにする。
 */
function scanImage(dataUrl) {
  var parsed = parseDataUrl_(dataUrl);
  if (!parsed) throw new Error('画像の形式を認識できませんでした');

  var blob = Utilities.newBlob(
    Utilities.base64Decode(parsed.base64),
    parsed.mimeType,
    'flight_scan'
  );

  var text = ocrImage_(blob);
  var fields = extractFlightFields_(text);
  fields.rawText = text;
  return fields;
}

/** data:image/jpeg;base64,xxxx を MIME タイプと base64 に分解する */
function parseDataUrl_(dataUrl) {
  var m = String(dataUrl || '').match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

/**
 * 画像を Google ドキュメントに変換して OCR テキストを取り出す。
 * 変換でできた一時ファイルは必ず消す。
 */
function ocrImage_(blob) {
  var file = createOcrDoc_(blob);
  try {
    return DocumentApp.openById(file.id).getBody().getText();
  } finally {
    deleteFile_(file.id);
  }
}

/** Drive 詳細サービスは v2 と v3 で呼び方が違うので両対応にする */
function createOcrDoc_(blob) {
  var name = 'flight_log_ocr_' + Date.now();

  if (Drive.Files.create) {
    return Drive.Files.create(
      { name: name, mimeType: MimeType.GOOGLE_DOCS },
      blob,
      { ocrLanguage: 'ja' }
    );
  }
  return Drive.Files.insert(
    { title: name, mimeType: MimeType.GOOGLE_DOCS },
    blob,
    { ocr: true, ocrLanguage: 'ja' }
  );
}

/** 一時ファイルを消す。消せない場合もゴミ箱送りまでは必ずやる */
function deleteFile_(fileId) {
  try {
    Drive.Files.remove(fileId);
  } catch (e) {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e2) {
      Logger.log('一時ファイルを削除できませんでした: ' + fileId);
    }
  }
}

/* ---------- テキストからの項目抽出 ---------- */

/** OCR テキストから搭乗情報を拾う */
function extractFlightFields_(text) {
  var t = normalizeOcrText_(text);
  var flightNo = findFlightNo_(t);
  var route = findRoute_(t);

  return {
    date: findDate_(t),
    flightNo: flightNo,
    airline: flightNo ? airlineFromFlightNo_(flightNo) : '',
    dep: route.dep,
    arr: route.arr,
    registration: findRegistration_(t),
    aircraftType: findAircraftType_(t)
  };
}

/** 全角の英数字と記号を半角に寄せる。搭乗券の全角表記がそのまま返ることがある */
function normalizeOcrText_(text) {
  return String(text === null || text === undefined ? '' : text)
    // 全角ASCIIの範囲。リテラル文字で書けばエスケープを挟まずに済む
    .replace(/[！-～]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    })
    .replace(/\u3000/g, ' ')
    .toUpperCase();
}

/**
 * 登録記号。日本籍（JA + 英数4文字）だけを拾う。
 * 海外籍は区切りの無い表記が搭乗券上の他のコードと衝突しやすく、
 * 誤った機体をマスタに登録すると重複判定が壊れるため、あえて見ない。
 */
function findRegistration_(t) {
  var m = t.match(/\bJA[-\s]?(\d{2}[0-9A-Z]{2})\b/);
  return m ? 'JA' + m[1] : '';
}

/**
 * 便名。頭2文字が AIRLINE_CODES にあるものだけを信用する。
 * 搭乗券は座席番号・ゲート番号・予約番号と数字だらけなので、
 * 既知の航空会社コードに一致しないものは拾わない。
 */
function findFlightNo_(t) {
  var re = /\b([A-Z0-9]{2})[\s-]?(\d{1,4})\b/g;
  var m;
  while ((m = re.exec(t)) !== null) {
    // NH0262 のようなゼロ詰めを NH262 に寄せる
    if (AIRLINE_CODES[m[1]]) return m[1] + String(Number(m[2]));
  }
  return '';
}

/**
 * 出発・到着。空港コード（HND）と日本語名（羽田）の両方を見て、
 * テキストに現れた順の最初の 2 つを出発・到着とみなす。
 */
function findRoute_(t) {
  var hits = [];
  var seen = {};

  // 3レターの大文字トークンを一度に拾い、対照表にあるものだけ残す。
  // コードごとに正規表現を組み立てるより速く、文字列内の \b を
  // エスケープし損ねる事故も起きない
  var re = /\b[A-Z]{3}\b/g;
  var m;
  while ((m = re.exec(t)) !== null) {
    if (AIRPORT_NAMES[m[0]] && !seen[m[0]]) {
      seen[m[0]] = true;
      hits.push({ index: m.index, code: m[0] });
    }
  }

  // 日本語名も見る。ただしカタカナだけの海外都市名は他の語と
  // 紛れやすいので、漢字を含むものに限る
  Object.keys(AIRPORT_NAMES).forEach(function (code) {
    if (seen[code]) return;
    var name = AIRPORT_NAMES[code];
    if (!/[\u4e00-\u9fa5]/.test(name)) return;
    var at = t.indexOf(name);
    if (at < 0) return;
    seen[code] = true;
    hits.push({ index: at, code: code });
  });

  hits.sort(function (a, b) { return a.index - b.index; });
  return {
    dep: hits[0] ? hits[0].code : '',
    arr: hits[1] ? hits[1].code : ''
  };
}

var MONTHS_ = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * 搭乗日。年月日・スラッシュ区切り・搭乗券の 21SEP26 形式に対応する。
 * 年の無い表記は今年として扱う。
 */
function findDate_(t) {
  var thisYear = new Date().getFullYear();

  var m = t.match(/(20\d{2})\s*[年\/\-.]\s*(\d{1,2})\s*[月\/\-.]\s*(\d{1,2})/);
  if (m) return ymd_(m[1], m[2], m[3]);

  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return ymd_(thisYear, m[1], m[2]);

  m = t.match(/\b(\d{1,2})\s?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s?(\d{2})?\b/);
  if (m) {
    var year = m[3] ? 2000 + Number(m[3]) : thisYear;
    return ymd_(year, MONTHS_.indexOf(m[2]) + 1, m[1]);
  }

  return '';
}

/** 年月日を yyyy-MM-dd に組む */
function ymd_(y, m, d) {
  return String(y) + '-' + ('0' + Number(m)).slice(-2) + '-' + ('0' + Number(d)).slice(-2);
}

/**
 * 機材型式。BOEING 787-9 / B787-9 / エアバス A350-900 のような表記を
 * B787-9 / A350-900 の形に寄せる。
 */
function findAircraftType_(t) {
  var b = t.match(/\b(?:BOEING|B)\s*-?\s*(7[0-9]{2})(?:\s*-\s*(\d{1,3}))?\b/);
  if (b) return 'B' + b[1] + (b[2] ? '-' + b[2] : '');

  var a = t.match(/\bA\s*-?\s*([23][0-9]{2})(?:\s*-\s*(\d{1,3}))?(NEO)?\b/);
  if (a) return 'A' + a[1] + (a[2] ? '-' + a[2] : '') + (a[3] ? 'neo' : '');

  return '';
}

/**
 * 抽出ロジックの動作確認用。OCR を通さずテキストだけで試せる。
 * 読み取りが期待どおりでないとき、GAS エディタから実行して
 * Logger の出力を見ながら上の正規表現を調整する。
 */
function testExtract() {
  var sample = [
    '搭乗券 BOARDING PASS',
    'ANA NH 262',
    '東京(羽田) HND → 大阪(伊丹) ITM',
    '2026年9月21日',
    'BOEING 787-9  JA873A',
    'SEAT 32A  GATE 21'
  ].join('\n');

  var result = extractFlightFields_(sample);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
