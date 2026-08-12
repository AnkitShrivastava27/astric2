'use strict';

const axios = require('axios');

const _usernameCache = {};

async function getTelegramBotUsername(token) {
  if (_usernameCache[token]) return _usernameCache[token];
  const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
  const username = res.data?.result?.username;
  if (!username) throw new Error('getMe returned no username');
  _usernameCache[token] = username;
  console.log(`[telegram] Cached bot username: @${username}`);
  return username;
}

async function sendTelegram({ botToken, chatId, text }) {
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'HTML' }
  );
  return res.data;
}

module.exports = { getTelegramBotUsername, sendTelegram };
