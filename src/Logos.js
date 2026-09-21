/**
 * 航空会社ロゴの取得。
 *
 * ロゴは一度だけ外部から取りに行き、base64 にして airlines シートへ保存する。
 * 以後は外部を参照しないので、配信元が止まってもレート制限をかけても
 * 表示は壊れない。ここが「CDN に直リンクし続ける」やり方との違い。
 *
 * 取得元は Constants.js の AIRLINE_LOGO_URL。
 */

/**
 * この航空会社コードの行が airlines に無ければ、ロゴを取りに行って作る。
 *
 * 行が既にある場合は中身を見ずに何もしない。ロゴ列を空にしてあるのは
 * 「この会社はコード表示でよい」という意思表示なので、勝手に埋め直さない。
 */
function ensureAirlineLogo_(code) {
  var c = String(code || '').trim().toUpperCase();
  if (!c) return;

  var known = readAll_(SHEET_AIRLINES, AIRLINE_COLUMNS).some(function (a) {
    return String(a.code || '').trim().toUpperCase() === c;
  });
  if (known) return;

  var logo = fetchAirlineLogo_(c);

  // 取れなかったときは行を作らない。通信の一時的な失敗と「この会社は
  // コード表示でよい」の意思表示を混同すると、一度の失敗でその会社が
  // 永久にコード表示のままになる。行が無ければ次の保存でまた試す
  if (!logo) return;

  upsertAirline_({ code: c, name: AIRLINE_CODES[c] || '', logo: logo });
}

/**
 * ロゴを取得して data URI にする。取れなければ空文字を返す。
 *
 * 取得元は存在しないコードでも 404 を返さずコードごとの生成画像を返すため、
 * 「ロゴが無い」ことをここで自動判定はできない。シートを目視して
 * おかしいものを消す運用で拾う。
 */
function fetchAirlineLogo_(code) {
  var url = AIRLINE_LOGO_URL.replace('{code}', encodeURIComponent(code));

  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';

    var blob = res.getBlob();
    var type = blob.getContentType() || '';
    if (type.indexOf('image/') !== 0) return '';

    return 'data:' + type + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    Logger.log('ロゴを取得できませんでした (' + code + '): ' + e.message);
    return '';
  }
}

/**
 * 既存の搭乗履歴に出てくる航空会社のロゴをまとめて取りに行く。
 * GAS エディタから手動で実行する、最初の一回分の穴埋め用。
 *
 * 以降は保存のたびに saveFlight() が新しい会社の分だけ取るので、
 * 通常この関数を使う必要はない。
 */
function fetchAirlineLogos() {
  var used = {};
  readAll_(SHEET_FLIGHTS, FLIGHT_COLUMNS).forEach(function (f) {
    var c = carrierCode_(f.flight_no);
    if (c) used[c] = true;
  });

  var codes = Object.keys(used).sort();
  if (!codes.length) return logoReport_('搭乗履歴に航空会社コードが見つかりませんでした');

  // シートは最初に一度だけ読む。コードごとに読み直すと行数分の往復になる
  var known = {};
  readAll_(SHEET_AIRLINES, AIRLINE_COLUMNS).forEach(function (a) {
    known[String(a.code || '').trim().toUpperCase()] = true;
  });

  var missing = codes.filter(function (c) { return !known[c]; });
  if (!missing.length) {
    return logoReport_('新しく取得する会社はありません（' + codes.length + ' 社すべて登録済み）');
  }

  var withLogo = [];
  var withoutLogo = [];
  missing.forEach(function (c) {
    var logo = fetchAirlineLogo_(c);
    if (!logo) { withoutLogo.push(c); return; }
    upsertAirline_({ code: c, name: AIRLINE_CODES[c] || '', logo: logo });
    withLogo.push(c);
  });

  var msg = '取得できた: ' + (withLogo.join(', ') || 'なし');
  if (withoutLogo.length) {
    msg += ' / 取得できず: ' + withoutLogo.join(', ') + '（行を作っていないので再実行すれば再試行します）';
  }
  msg += '\nairlines シートを目視して、おかしいロゴは logo 列を空にしてください。';
  return logoReport_(msg);
}

/**
 * 実行結果をログに出しつつ返す。
 * Gemini.js の同種のヘルパーにあえて相乗りしない。Gemini を貼らない構成でも
 * ロゴ取得だけは動いてほしいので、モジュール間の依存を作らない。
 */
function logoReport_(msg) {
  Logger.log(msg);
  return msg;
}
