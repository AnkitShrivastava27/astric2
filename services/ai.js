'use strict';

const { db } = require('../config/firebase');
const {
  DEEPSEEK_API_KEY, GROK_API_KEY, OPENAI_API_KEY, DEFAULT_AI_LIMITS,
} = require('../config/env');

const AI_CHAT_PROVIDERS = {
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', key: DEEPSEEK_API_KEY, defaultModel: 'deepseek-chat' },
  grok: { url: 'https://api.x.ai/v1/chat/completions', key: GROK_API_KEY, defaultModel: 'grok-4' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', key: OPENAI_API_KEY, defaultModel: 'gpt-4o' },
};
const GROK_IMAGE_URL = 'https://api.x.ai/v1/images/generations';

function currentMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

async function getAiLimitsConfig() {
  const snap = await db.collection('ai_limits').doc('config').get();
  return snap.exists ? { ...DEFAULT_AI_LIMITS, ...snap.data() } : { ...DEFAULT_AI_LIMITS };
}

async function getImageLimitsConfig() {
  const snap = await db.collection('config').doc('ai_limits').get();
  const defaults = { basic_images: 3, standard_images: 20, premium_images: 100 };
  return snap.exists ? { ...defaults, ...snap.data() } : defaults;
}

module.exports = {
  AI_CHAT_PROVIDERS, GROK_API_KEY, OPENAI_API_KEY, GROK_IMAGE_URL,
  currentMonthKey, getAiLimitsConfig, getImageLimitsConfig,
};
