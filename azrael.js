/**
 * AZRAEL — WhatsApp Study Bot for VU Students
 * STABLE VERSION for Railway
 */

const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// Load config
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Enhanced error handling
process.on('uncaughtException', (error) => {
  console.error('🚨 UNCAUGHT EXCEPTION:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Helpers
function normNumber(n) {
  let s = ('' + n).replace(/\D/g,'');
  if (s.length === 10 && s.startsWith('03')) s = '92' + s.slice(1);
  if (!s.endsWith('@c.us')) return s + '@c.us';
  return s;
}

const OWNER = normNumber(cfg.owner);
const BOT_NAME = cfg.botName || 'AZRAEL';
let warnings = {};
const WARN_FILE = './warnings.json';

// Load warnings if exists
try { 
  if (fs.existsSync(WARN_FILE)) warnings = JSON.parse(fs.readFileSync(WARN_FILE, 'utf8')); 
} catch(e){ 
  console.warn('Warning: Could not load warnings file'); 
}

function saveWarnings(){ 
  try {
    fs.writeFileSync(WARN_FILE, JSON.stringify(warnings, null, 2));
  } catch(e) {
    console.warn('Warning: Could not save warnings');
  }
}

// Logging
function logEvent(text) {
  if (!cfg.logging || !cfg.logging.enabled) return;
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    fs.appendFileSync(cfg.logging.file || 'moderation_log.txt', line);
  } catch(e) {
    console.warn('Could not write to log file');
  }
}

// Simple question detection
function looksLikeQuestion(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.includes('?')) return true;
  const qstarts = ['who','what','when','where','why','how','which','is','are','can','do','does','did','kya','kaun','kab','kahan','kyun','kis','kitna','kaise','kon','kitni'];
  const first = trimmed.split(/\s+/)[0].toLowerCase();
  if (qstarts.includes(first)) return true;
  const keywords = ['assignment','submission','gpa','marks','result','grade','quiz','deadline','due','date','fee','lms','vulms','enrollment','course'];
  for (let k of keywords) if (trimmed.toLowerCase().includes(k)) return true;
  return false;
}

// Warnings
async function addWarning(chat, participantId, reason) {
  if (!warnings[participantId]) warnings[participantId] = { count: 0, lastReason: '' };
  warnings[participantId].count += 1;
  warnings[participantId].lastReason = reason;
  saveWarnings();
  const cnt = warnings[participantId].count;
  
  try {
    const contact = await client.getContactById(participantId);
    await chat.sendMessage(
      `⚠️ Warning ${cnt}/${cfg.warnLimit} — @${participantId.replace('@c.us','')}\nReason: ${reason}`, 
      { mentions: [contact] }
    );
  } catch (e) {
    await chat.sendMessage(`⚠️ Warning ${cnt}/${cfg.warnLimit} — ${participantId.replace('@c.us','')}\nReason: ${reason}`);
  }
  
  logEvent(`WARN ${participantId} (${cnt}): ${reason}`);
  if (cnt >= (cfg.warnLimit || 3)) {
    await chat.sendMessage(`🚫 User ${participantId.replace('@c.us','')} reached warning limit.`);
  }
}

// Flood control
const floodMap = {};
function recordMessageForFlood(userId) {
  const now = Date.now();
  if (!floodMap[userId]) floodMap[userId] = [];
  floodMap[userId].push(now);
  const windowMs = (cfg.floodControl?.windowSeconds || 10) * 1000;
  floodMap[userId] = floodMap[userId].filter(t => t > now - windowMs);
  return floodMap[userId].length;
}

// Client configuration for Railway
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--single-process'
    ]
  }
});

// QR Code
client.on('qr', (qr) => {
  console.log('QR Code received, scan it!');
  qrcode.generate(qr, { small: true });
});

// Ready
client.on('ready', () => {
  console.log(`✅ ${BOT_NAME} is ready and online!`);
});

// Disconnected
client.on('disconnected', (reason) => {
  console.log('❌ Client was logged out:', reason);
  console.log('🔄 Attempting to restart in 10 seconds...');
  setTimeout(() => {
    client.initialize();
  }, 10000);
});

// Message handling
client.on('message', async (msg) => {
  try {
    // Ignore if not from group
    if (!msg.from.endsWith('@g.us')) return;
    
    const chat = await msg.getChat();
    const senderId = msg.author || msg.from;
    const body = (msg.body || '').trim();
    
    if (!body) return;

    const whitelisted = (cfg.whitelist || []).includes(senderId);

    // Flood control
    if (cfg.floodControl?.enabled && !whitelisted && senderId !== OWNER) {
      const count = recordMessageForFlood(senderId);
      if (count > (cfg.floodControl.maxMessagesPerWindow || 6)) {
        await chat.sendMessage('⚠️ Please avoid spamming.');
        await addWarning(chat, senderId, 'Flooding messages');
        return;
      }
    }

    // Check for links
    const hasLink = /(https?:\/\/|www\.)/i.test(body);
    if (!whitelisted && senderId !== OWNER && cfg.instantWarnOnLink && hasLink) {
      await addWarning(chat, senderId, 'Shared link');
      return;
    }

    // Owner commands
    if (body.startsWith('!') && senderId === OWNER) {
      const parts = body.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === '!rules') {
        await chat.sendMessage(cfg.groupRulesText);
      }
      else if (cmd === '!status') {
        await chat.sendMessage(`✅ ${BOT_NAME} is online. Warnings: ${Object.keys(warnings).length}`);
      }
      else if (cmd === '!warnreset') {
        warnings = {}; 
        saveWarnings(); 
        await chat.sendMessage('✅ All warnings cleared.');
      }
      else if (cmd === '!grouplock') {
        try {
          await chat.setMessagesAdminsOnly(true);
          await chat.sendMessage('✅ Group locked — only admins can send messages.');
        } catch(e) {
          await chat.sendMessage('❌ Need admin rights for this.');
        }
      }
      else if (cmd === '!groupunlock') {
        try {
          await chat.setMessagesAdminsOnly(false);
          await chat.sendMessage('✅ Group unlocked — everyone can send messages.');
        } catch(e) {
          await chat.sendMessage('❌ Need admin rights for this.');
        }
      }
      else {
        await chat.sendMessage('✅ Bot is running. Commands: !rules, !status, !warnreset, !grouplock, !groupunlock');
      }
      return;
    }

    // FAQ & Q&A
    const isQuestion = looksLikeQuestion(body);
    if (isQuestion && body.length > 3) {
      const responses = [
        "Please check VU LMS for detailed information.",
        "Contact your course instructor for specific queries.", 
        "Check the assignment deadline on VU portal.",
        "For technical issues, contact VU helpline.",
        "Refer to the course outline for deadlines.",
        "Check VU announcement for updates."
      ];
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      await chat.sendMessage(`💡 ${randomResponse}`);
    }

  } catch(e) { 
    console.warn('Message handling error:', e.message); 
  }
});

// Group join/leave events
client.on('group_join', async (notification) => {
  try {
    const chat = await client.getChatById(notification.chatId);
    for (let participant of notification.recipientIds) {
      await chat.sendMessage(`🎓 Welcome ${participant.replace('@c.us','')} to ${cfg.groupName || 'the group'}! Type !rules for guidelines.`);
    }
  } catch(e) {
    console.warn('Group join error:', e.message);
  }
});

client.on('group_leave', async (notification) => {
  try {
    const chat = await client.getChatById(notification.chatId);
    if (notification.recipientIds) {
      for (let participant of notification.recipientIds) {
        await chat.sendMessage(`👋 Goodbye ${participant.replace('@c.us','')}`);
      }
    }
  } catch(e) {
    console.warn('Group leave error:', e.message);
  }
});

// Keep-alive server
const app = express();
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>${BOT_NAME} Bot</title></head>
      <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h1>${BOT_NAME} WhatsApp Bot</h1>
        <p><strong>Status:</strong> Running 🟢</p>
        <p><strong>Warnings stored:</strong> ${Object.keys(warnings).length}</p>
        <p>Scan QR code in logs to connect WhatsApp.</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ${BOT_NAME} server running on port ${PORT}`);
  console.log('📱 Scan the QR code below to connect WhatsApp:');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  saveWarnings();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down...');
  saveWarnings();
  client.destroy();
  process.exit(0);
});

// Initialize client
client.initialize().catch(err => {
  console.error('Failed to initialize client:', err);
});
