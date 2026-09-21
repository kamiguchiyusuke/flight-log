/**
 * シート名・列定義・航空会社コード表。
 * 設定値はすべてこのファイルに集約する。
 */

/** シート名 */
var SHEET_FLIGHTS = 'flights';
var SHEET_AIRCRAFT = 'aircraft';

/** flights シートの列。この配列の順序がそのままシートの列順になる */
var FLIGHT_COLUMNS = [
  'id',
  'date',
  'flight_no',
  'airline',
  'dep',
  'arr',
  'aircraft_type',
  'registration',
  'note',
  'created_at'
];

/** aircraft シート（機体マスタ）の列 */
var AIRCRAFT_COLUMNS = [
  'registration',
  'aircraft_type',
  'airline',
  'note'
];

/**
 * 便名の頭2文字（IATA 航空会社コード）→ 航空会社名。
 * 新しい会社に乗ったらここに1行足すだけでよい。
 * 表にない場合は自動判定されないだけで、手入力すれば普通に記録できる。
 */
var AIRLINE_CODES = {
  // 国内
  NH: '全日空',
  JL: '日本航空',
  BC: 'スカイマーク',
  MM: 'Peach',
  GK: 'ジェットスター・ジャパン',
  '7G': 'スターフライヤー',
  '6J': 'ソラシドエア',
  HD: 'AIRDO',
  FW: 'IBEXエアラインズ',
  JH: 'フジドリームエアラインズ',
  NU: '日本トランスオーシャン航空',
  OC: 'オリエンタルエアブリッジ',
  JC: '日本エアコミューター',
  RC: '琉球エアーコミューター',
  ZG: 'ZIPAIR',
  IJ: 'スプリング・ジャパン',
  MZ: '天草エアライン',
  // 国際
  UA: 'ユナイテッド航空',
  DL: 'デルタ航空',
  AA: 'アメリカン航空',
  SQ: 'シンガポール航空',
  CX: 'キャセイパシフィック航空',
  KE: '大韓航空',
  OZ: 'アシアナ航空',
  CI: 'チャイナエアライン',
  BR: 'エバー航空',
  TG: 'タイ国際航空',
  QF: 'カンタス航空',
  BA: 'ブリティッシュ・エアウェイズ',
  AF: 'エールフランス',
  LH: 'ルフトハンザ ドイツ航空',
  KL: 'KLMオランダ航空'
};
