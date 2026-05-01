const db = require('./db');
const cfg = require('./config');
const { analyzeEveningReport, analyzeMorningReport } = require('./analyzer');
const { getChannelHistory } = require('./slack');

function todayJst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function calcCharCount(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/\s/g, '')
    .length;
}

// 3-12時 = 朝の日報, それ以外 = 夜の日報
function classifyReportType(postedHour) {
  return (postedHour >= 3 && postedHour <= 12) ? 'morning' : 'evening';
}

async function fetchAndStoreReports(date) {
  const channelId = cfg.get('report_channel_id');
  const workflowBotId = cfg.get('workflow_bot_id');
  const userIdRegex = cfg.get('user_id_regex');

  // 27時制: D日の03:00 JST ～ (D+1)日の02:59 JST をD日分として扱う
  const dateBase = new Date(date + 'T00:00:00+09:00').getTime();
  const oldest = (dateBase + 3  * 3600 * 1000) / 1000;       // D 03:00 JST
  const latest = (dateBase + 27 * 3600 * 1000 - 1) / 1000;   // D+1 02:59:59 JST

  const messages = await getChannelHistory(channelId, oldest, latest);
  console.log(`[checker] Fetched ${messages.length} messages for ${date} (channel: ${channelId})`);
  console.log(`[checker] workflow_bot_id="${workflowBotId || ''}", user_id_regex="${userIdRegex || ''}"`);

  let saved = 0, skippedBot = 0, skippedNoUser = 0, skippedNoMember = 0;

  for (const msg of messages) {
    let userId = msg.user;

    if (msg.subtype === 'bot_message') {
      if (workflowBotId && msg.bot_id !== workflowBotId) {
        skippedBot++;
        continue;
      }
      if (userIdRegex) {
        const m = msg.text?.match(new RegExp(userIdRegex));
        if (m?.[1]) userId = m[1];
      }
      if (!userId) {
        console.log(`[checker] skip bot_message (userId抽出不可): bot_id=${msg.bot_id}, text=${(msg.text || '').slice(0, 60)}`);
        skippedBot++;
        continue;
      }
    }

    if (!userId || !msg.text) { skippedNoUser++; continue; }
    const member = db.getMember(userId);
    if (!member || !member.is_active || member.is_bot) {
      console.log(`[checker] skip user=${userId}: member=${JSON.stringify(member ? { is_active: member.is_active, is_bot: member.is_bot } : null)}`);
      skippedNoMember++;
      continue;
    }

    const postedAt = new Date(parseFloat(msg.ts) * 1000).toISOString();
    const jstHour = new Date(new Date(postedAt).getTime() + 9 * 3600000).getUTCHours();
    const reportType = classifyReportType(jstHour);

    db.upsertReport({
      userId,
      reportDate: date,
      reportType,
      postedAt,
      postedHour: jstHour,
      text: msg.text,
      charCount: calcCharCount(msg.text),
      ts: msg.ts,
      channelId,
    });
    saved++;
  }

  console.log(`[checker] 保存=${saved} (朝/夜自動分類), botスキップ=${skippedBot}, userなし=${skippedNoUser}, メンバー不一致=${skippedNoMember}`);
}

// 投稿時刻による深夜フラグ計算
//   2 = 23:00〜翌5:00（赤）
//   1 = 22:00〜22:59（黄）
//   0 = それ以外
function calcLateNightFlag(postedHour) {
  if (postedHour >= 23 || postedHour < 5) return 2;
  if (postedHour === 22) return 1;
  return 0;
}

// 投稿遅れフラグ: 翌5:00〜13:00（朝〜昼に投稿 = 日報が遅延）
function calcLatePostFlag(postedHour) {
  return (postedHour >= 5 && postedHour <= 13) ? 1 : 0;
}

// 信号ロジック（dual-post対応版）
// 優先順位:
//   1. 23時〜翌5時（lateNightFlag=2）→ 無条件で赤
//   2. 感情スコア <= 0.35 → 赤
//   3. 22時台（lateNightFlag=1）→ 黄
//   4. 感情スコア 0.36~0.59 → 黄
//   5. 振り返りスコア < 0.45 → 黄
//   6. 二回投稿されていない（dualPostFlag=1）→ 黄
//   7. 投稿遅れ（latePostFlag=1）→ 黄
//   8. 文量変化フラグ → 黄
//   9. それ以外 → 青
function calcSignal(lateNightFlag, latePostFlag, sentimentFlag, volumeFlag, sentimentScore, dualPostFlag, reflectionScore) {
  if (lateNightFlag >= 2) return 'red';
  if (sentimentScore !== null && sentimentScore !== undefined) {
    if (sentimentScore <= 0.35) return 'red';
  }
  if (lateNightFlag >= 1) return 'yellow';
  if (sentimentScore !== null && sentimentScore !== undefined) {
    if (sentimentScore < 0.60) return 'yellow';
  }
  if (reflectionScore !== null && reflectionScore !== undefined) {
    if (reflectionScore < 0.45) return 'yellow';
  }
  if (dualPostFlag)  return 'yellow';
  if (latePostFlag)  return 'yellow';
  if (volumeFlag)    return 'yellow';
  return 'green';
}

async function checkMember(member, date) {
  const morningReport = db.getReportByType(member.user_id, date, 'morning');
  const eveningReport = db.getReportByType(member.user_id, date, 'evening');
  const morningPosted = !!morningReport;
  const eveningPosted = !!eveningReport;
  const posted = morningPosted || eveningPosted;

  if (!posted) {
    db.upsertCheck({
      userId: member.user_id, checkDate: date, posted: 0,
      lateNightFlag: 0, latePostFlag: 0, sentimentFlag: 0, sentimentScore: null,
      volumeFlag: 0, volumeRatio: null, flagCount: 0,
      signal: null, sentimentSummary: null, praisePoints: null, followPoints: null,
      morningPosted: 0, eveningPosted: 0, dualPostFlag: 0,
      morningSummary: null, winsText: null, lossesText: null, reflectionScore: null, growthNote: null,
    });
    return;
  }

  // 二回投稿フラグ: 両方投稿できていない場合
  const dualPostFlag = !(morningPosted && eveningPosted) ? 1 : 0;

  // 時刻フラグは夕方の投稿を優先、なければ朝を使用
  const primaryReport = eveningReport || morningReport;
  const lateNightFlag = calcLateNightFlag(primaryReport.posted_hour);
  const latePostFlag  = calcLatePostFlag(primaryReport.posted_hour);

  // 夜の日報分析
  let sentimentFlag = 0, sentimentScore = null, sentimentSummary = null;
  let praisePoints = null, followPoints = null;
  let winsText = null, lossesText = null, reflectionScore = null, growthNote = null;

  if (eveningReport) {
    try {
      const prevCheck = db.getLatestCheck(member.user_id);
      const prevScore = prevCheck && prevCheck.check_date !== date ? prevCheck.sentiment_score : null;
      const r = await analyzeEveningReport(eveningReport.text, prevScore);
      sentimentScore   = r.score;
      sentimentSummary = r.summary  || null;
      praisePoints     = r.praise   || null;
      followPoints     = r.follow   || null;
      winsText         = r.wins     || null;
      lossesText       = r.losses   || null;
      reflectionScore  = r.reflection_score != null ? r.reflection_score : null;
      growthNote       = r.growth_note || null;
      sentimentFlag    = r.score < cfg.get('sentiment_threshold') ? 1 : 0;
    } catch (e) {
      console.error('[checker] evening sentiment error:', e.message);
    }
  }

  // 朝の日報分析
  let morningSummary = null;
  if (morningReport) {
    try {
      const mr = await analyzeMorningReport(morningReport.text);
      morningSummary = mr.summary || null;
      // 朝のスコアが取れて、夕方のスコアがない場合は朝スコアを使用
      if (sentimentScore === null && mr.score != null) {
        sentimentScore = mr.score;
        sentimentFlag  = mr.score < cfg.get('sentiment_threshold') ? 1 : 0;
        sentimentSummary = mr.summary || null;
        praisePoints   = mr.praise || null;
        followPoints   = mr.follow || null;
      }
    } catch (e) {
      console.error('[checker] morning sentiment error:', e.message);
    }
  }

  // 文量チェック（夜の日報で比較、なければ朝で代替）
  const targetReport = eveningReport || morningReport;
  const reportTypeForVolume = eveningReport ? 'evening' : 'morning';
  const past = db.getRecentReportsByType(member.user_id, reportTypeForVolume, cfg.get('volume_lookback_days') + 1)
    .filter(r => r.report_date !== date);
  let volumeFlag = 0, volumeRatio = null;
  if (past.length >= cfg.get('volume_min_samples')) {
    const avg = past.reduce((s, r) => s + r.char_count, 0) / past.length;
    if (avg > 0) {
      volumeRatio = targetReport.char_count / avg;
      volumeFlag = Math.abs(volumeRatio - 1) * 100 >= cfg.get('volume_change_pct') ? 1 : 0;
    }
  }

  const flagCount = lateNightFlag + latePostFlag + sentimentFlag + volumeFlag + dualPostFlag;
  const signal    = calcSignal(lateNightFlag, latePostFlag, sentimentFlag, volumeFlag, sentimentScore, dualPostFlag, reflectionScore);

  db.upsertCheck({
    userId: member.user_id, checkDate: date, posted: 1,
    lateNightFlag, latePostFlag, sentimentFlag, sentimentScore,
    volumeFlag, volumeRatio, flagCount,
    signal, sentimentSummary, praisePoints, followPoints,
    morningPosted: morningPosted ? 1 : 0,
    eveningPosted: eveningPosted ? 1 : 0,
    dualPostFlag,
    morningSummary, winsText, lossesText, reflectionScore, growthNote,
  });
}

async function runCheckForDate(date) {
  date = date || todayJst();
  console.log(`[checker] Running check for ${date}`);
  await fetchAndStoreReports(date);
  const members = db.getActiveMembers();
  await Promise.all(members.map(m => checkMember(m, date)));
  return members;
}

module.exports = { runCheckForDate, todayJst };
