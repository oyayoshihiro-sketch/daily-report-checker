const { getConfigRaw, setConfigRaw, getAllConfigRows } = require('./db');

// 型変換つきのconfig読み書きラッパー
const INT_KEYS = new Set(['late_night_hour', 'volume_lookback_days', 'volume_change_pct', 'volume_min_samples']);
const FLOAT_KEYS = new Set(['sentiment_threshold']);

function get(key) {
  const raw = getConfigRaw(key);
  if (raw === null || raw === undefined) return null;
  if (INT_KEYS.has(key)) return parseInt(raw, 10);
  if (FLOAT_KEYS.has(key)) return parseFloat(raw);
  return raw;
}

const VALID_KEYS = new Set([
  'late_night_hour', 'sentiment_threshold', 'volume_lookback_days',
  'volume_change_pct', 'volume_min_samples', 'summary_cron',
  'report_channel_id', 'workflow_bot_id', 'user_id_regex',
  'sentiment_prompt',
]);

function set(key, value) {
  if (!VALID_KEYS.has(key)) {
    throw new Error(`不明なキー: \`${key}\`\n有効なキー: ${[...VALID_KEYS].join(', ')}`);
  }

  // summary_cronはnode-cronでvalidateできる
  if (key === 'summary_cron') {
    const cron = require('node-cron');
    if (!cron.validate(value)) {
      throw new Error(`無効なcron式: \`${value}\`\n例: \`0 23 * * *\` (毎日23時)`);
    }
  }

  if (key === 'late_night_hour') {
    const h = parseInt(value, 10);
    if (isNaN(h) || h < 0 || h > 23) throw new Error('late_night_hour は 0〜23 の整数で指定してください');
  }

  if (key === 'sentiment_threshold') {
    const v = parseFloat(value);
    if (isNaN(v) || v < 0 || v > 1) throw new Error('sentiment_threshold は 0.0〜1.0 の数値で指定してください');
  }

  if (key === 'volume_change_pct') {
    const v = parseInt(value, 10);
    if (isNaN(v) || v < 1) throw new Error('volume_change_pct は 1以上の整数（%）で指定してください');
  }

  setConfigRaw(key, value);
}

function getAll() {
  return getAllConfigRows();
}

module.exports = { get, set, getAll };
