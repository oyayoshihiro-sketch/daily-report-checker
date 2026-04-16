require('dotenv').config();
const db = require('./db');
const { syncChannelMembers } = require('./members');
const { setupScheduler } = require('./scheduler');
const { createServer } = require('./server');

db.getDb();

(async () => {
  await syncChannelMembers();
  setupScheduler();

  const port = process.env.PORT || 3001;
  createServer().listen(port, () => {
    console.log(`🌐 ダッシュボード: http://localhost:${port}`);
  });
})();
