/**
 * Gemini API で画像から搭乗情報を読み取る。
 *
 * スクリプトプロパティに GEMINI_API_KEY を入れると有効になる。
 * 入っていなければ何もせず、ドライブの OCR が使われる（Ocr.js の scanImage を見よ）。
 *
 * OCR との違いは、文字を読むだけでなく画面の意味を解釈できること。
 * 表に無い航空会社や、崩れたレイアウトに強い。
 */

/** 使うモデル。無料枠の対象や名称は変わるので、変えるときはここだけ直す */
var GEMINI_MODEL = 'gemini-2.5-flash';

/** キーが設定されていなければ空文字 */
function geminiApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

/**
 * 画像を Gemini に渡して項目を取り出す。
 * 失敗したら例外を投げる。呼び出し側（scanImage）が OCR に切り替える。
 */
function geminiScan_(blob) {
  var text = geminiRequest_(blob);
  var data = parseJsonLoosely_(text);

  // 便名から引ける場合は自前の表を優先する。表記を AIRLINE_CODES に
  // そろえておかないと、あとで航空会社別に数えるときにぶれるため
  var flightNo = normalizeFlightNo_(data.flightNo || '');
  var airline = airlineFromFlightNo_(flightNo) || String(data.airline || '').trim();

  return {
    date: toDateString_(data.date || ''),
    flightNo: flightNo,
    airline: airline,
    dep: String(data.dep || '').trim().toUpperCase(),
    arr: String(data.arr || '').trim().toUpperCase(),
    registration: String(data.registration || '').trim().toUpperCase(),
    aircraftType: String(data.aircraftType || '').trim(),
    rawText: String(data.rawText || ''),
    engine: 'gemini'
  };
}

/** Gemini を呼んで、応答本文のテキストを返す */
function geminiRequest_(blob) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(geminiApiKey_());

  var payload = {
    contents: [{
      parts: [
        { text: geminiPrompt_() },
        {
          inline_data: {
            mime_type: blob.getContentType(),
            data: Utilities.base64Encode(blob.getBytes())
          }
        }
      ]
    }],
    generationConfig: {
      // 抽出作業なので毎回同じ答えが返ってほしい
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 2048
    }
  };

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code === 429) throw new Error('Gemini のレート制限に達しました');
  if (code !== 200) throw new Error('Gemini API エラー (' + code + ')');

  var body = JSON.parse(res.getContentText());
  var candidate = body && body.candidates && body.candidates[0];
  var part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];

  if (!part || !part.text) throw new Error('Gemini の応答が空でした');
  return part.text;
}

/** 抽出の指示文 */
function geminiPrompt_() {
  var thisYear = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy');

  return [
    'この画像は搭乗券、航空会社アプリの画面、またはフライト情報の画面です。',
    '読み取れる範囲で次の項目を JSON で返してください。',
    '',
    '- date: 搭乗日。yyyy-MM-dd 形式',
    '- flightNo: 便名。空白とゼロ詰めを除いた形（NH 0262 なら NH262）',
    '- airline: 航空会社名。日本語（例: 全日空、日本航空）',
    '- dep: 出発空港の IATA 3レターコード（例: HND）',
    '- arr: 到着空港の IATA 3レターコード（例: ITM）',
    '- registration: 機体の登録記号（例: JA873A）',
    '- aircraftType: 機材型式（例: B787-9、A350-900）',
    '- rawText: 画像から読み取れた文字をそのまま',
    '',
    '規則:',
    '- 読み取れない項目は空文字 "" にする。推測で埋めない',
    '- 年が書かれていない日付は ' + thisYear + ' 年として扱う',
    '- 空港が日本語名（羽田、伊丹など）で書かれている場合は IATA コードに直す',
    '- 座席番号・ゲート番号・予約番号を便名と取り違えないこと',
    '- 登録記号は機体そのものの番号。便名や予約番号とは別物',
    '',
    'JSON 以外の文字は出力しないでください。'
  ].join('\n');
}

/**
 * ```json で囲まれていても素の JSON でも読めるようにする。
 * responseMimeType を指定しても囲まれて返ることがあるため。
 */
function parseJsonLoosely_(text) {
  var s = String(text === null || text === undefined ? '' : text).trim();

  var fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    s = fence[1].trim();
  } else {
    var braces = s.match(/\{[\s\S]*\}/);
    if (braces) s = braces[0];
  }

  return JSON.parse(s);
}

/**
 * どちらの方式で読み取られるかを確認する。GAS エディタから実行する。
 * キーを設定したのに OCR のままのとき、設定先を間違えていないか確かめるのに使う。
 */
function checkScanEngine() {
  var key = geminiApiKey_();
  var msg = key
    ? 'Gemini を使います（モデル: ' + GEMINI_MODEL + '、キー末尾: ...' + key.slice(-4) + '）'
    : 'GEMINI_API_KEY が未設定のため、ドライブの OCR を使います';
  Logger.log(msg);
  return msg;
}
