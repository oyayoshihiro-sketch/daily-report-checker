const nodemailer = require('nodemailer');

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendInvitation({ to, inviterName, inviteUrl, role }) {
  const roleLabel = role === 'admin' ? '管理者' : '閲覧者';
  await createTransport().sendMail({
    from: `"日報チェッカー" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject: '【日報チェッカー】招待が届いています',
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
  <div style="background:#0f172a;padding:20px 24px;border-radius:8px 8px 0 0">
    <p style="color:#fff;font-size:18px;font-weight:700;margin:0">📊 日報チェッカー</p>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;padding:28px 24px;border-radius:0 0 8px 8px">
    <h2 style="font-size:20px;margin:0 0 12px">招待が届いています</h2>
    <p style="color:#334155;margin:0 0 20px">
      <strong>${inviterName}</strong> さんから <strong>${roleLabel}</strong> として招待されました。<br>
      以下のボタンからパスワードを設定してください。
    </p>
    <a href="${inviteUrl}" style="display:inline-block;padding:12px 28px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">
      パスワードを設定してログイン →
    </a>
    <p style="margin:24px 0 0;color:#94a3b8;font-size:12px">
      ※ リンクの有効期限は24時間です。<br>
      <a href="${inviteUrl}" style="color:#94a3b8">${inviteUrl}</a>
    </p>
  </div>
</div>`,
  });
}

module.exports = { sendInvitation };
