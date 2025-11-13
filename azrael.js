/**
 * AZRAEL — WhatsApp Study Bot for VU Students
 * USING BAILEYS (No Chromium Required)
 */

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const fs = require('fs');
const express = require('express');

// Load config
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Helpers
function normNumber(n) {
  let s = ('' + n).replace(/\D/g,'');
  if (s.length === 10 && s.startsWith('03')) s = '92' + s.slice(1);
  if (!s.endsWith('@s.whatsapp.net')) return s + '@s.whatsapp.net';
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
async function addWarning(sock, chatId, participantId, reason) {
  if (!warnings[participantId]) warnings[participantId] = { count: 0, lastReason: '' };
  warnings[participantId].count += 1;
  warnings[participantId].lastReason = reason;
  saveWarnings();
  const cnt = warnings[participantId].count;
  
  await sock.sendMessage(chatId, { 
    text: `⚠️ Warning ${cnt}/${cfg.warnLimit} — ${participantId.split('@')[0]}\nReason: ${reason}`
  });
  
  logEvent(`WARN ${participantId} (${cnt}): ${reason}`);
  if (cnt >= (cfg.warnLimit || 3)) {
    await sock.sendMessage(chatId, { 
      text: `🚫 User ${participantId.split('@')[0]} reached warning limit.` 
    });
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

// Karachi time
function getKarachiHour() {
  return new Date().getUTCHours() + 5; // UTC+5 for Karachi
}

// Start bot
async function startBot() {
  console.log('🚀 Starting AZRAEL Bot with Baileys...');
  
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: { level: 'silent' },
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, { level: 'silent' }),
    },
    generateHighQualityLinkPreview: true,
  });

  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);

  // Connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401; // Don't reconnect if logged out
      console.log('Connection closed, reconnecting...', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      }
    } else if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} is ready and online!`);
    }
  });

  // Message handling
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

    const messageType = Object.keys(msg.message)[0];
    let body = '';
    
    if (messageType === 'conversation') {
      body = msg.message.conversation;
    } else if (messageType === 'extendedTextMessage') {
      body = msg.message.extendedTextMessage.text;
    } else if (['imageMessage', 'videoMessage', 'documentMessage'].includes(messageType)) {
      body = msg.message[messageType]?.caption || '';
    }

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    // Only handle group messages
    if (!chatId.endsWith('@g.us')) return;

    await handleMessage(sock, chatId, sender, body, msg);
  });

  // Group participants update
  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;
    
    if (action === 'add') {
      for (const participant of participants) {
        await sock.sendMessage(id, { 
          text: `🎓 Welcome @${participant.split('@')[0]} to ${cfg.groupName || 'the group'}!\nPlease read rules: type !rules or ask ${BOT_NAME}.`,
          mentions: [participant]
        });
      }
    } else if (action === 'remove') {
      for (const participant of participants) {
        await sock.sendMessage(id, { 
          text: `👋 Goodbye @${participant.split('@')[0]}`,
          mentions: [participant]
        });
      }
    }
  });
}

// Message handler
async function handleMessage(sock, chatId, sender, body, msg) {
  try {
    const whitelisted = (cfg.whitelist || []).includes(sender);
    
    if (!body) return;

    // Flood control
    if (cfg.floodControl?.enabled && !whitelisted && sender !== OWNER) {
      const count = recordMessageForFlood(sender);
      if (count > (cfg.floodControl.maxMessagesPerWindow || 6)) {
        await sock.sendMessage(chatId, { text: '⚠️ Please avoid spamming.' });
        await addWarning(sock, chatId, sender, 'Flooding messages');
        return;
      }
    }

    // Quiet hours
    if (cfg.quietHours?.enabled && !whitelisted && sender !== OWNER) {
      const hour = getKarachiHour();
      const start = cfg.quietHours.startHourKarachi;
      const end = cfg.quietHours.endHourKarachi;
      const inQuiet = (start <= end) ? (hour >= start && hour < end) : (hour >= start || hour < end);
      
      if (inQuiet) {
        await sock.sendMessage(chatId, { 
          text: cfg.quietHours.reminderMessage || '🔕 Quiet hours active. Please avoid sending messages.' 
        });
        return;
      }
    }

    // Check for links
    const hasLink = /(https?:\/\/|www\.)/i.test(body);
    if (!whitelisted && sender !== OWNER && cfg.instantWarnOnLink && hasLink) {
      await addWarning(sock, chatId, sender, 'Shared link');
      return;
    }

    // Owner commands
    if (body.startsWith('!') && sender === OWNER) {
      const parts = body.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === '!rules') {
        await sock.sendMessage(chatId, { text: cfg.groupRulesText });
      }
      else if (cmd === '!status') {
        await sock.sendMessage(chatId, { 
          text: `✅ ${BOT_NAME} is online. Warnings stored: ${Object.keys(warnings).length}` 
        });
      }
      else if (cmd === '!warnreset') {
        warnings = {}; 
        saveWarnings(); 
        await sock.sendMessage(chatId, { text: '✅ All warnings cleared.' });
      }
      else if (cmd === '!grouplock') {
        try {
          await sock.groupSettingUpdate(chatId, 'announcement');
          await sock.sendMessage(chatId, { text: '✅ Group locked — only admins can send messages.' });
        } catch(e) {
          await sock.sendMessage(chatId, { text: '❌ Need admin rights for this.' });
        }
      }
      else if (cmd === '!groupunlock') {
        try {
          await sock.groupSettingUpdate(chatId, 'not_announcement');
          await sock.sendMessage(chatId, { text: '✅ Group unlocked — everyone can send messages.' });
        } catch(e) {
          await sock.sendMessage(chatId, { text: '❌ Need admin rights for this.' });
        }
      }
      else {
        await sock.sendMessage(chatId, { 
          text: '✅ Bot is running. Commands: !rules, !status, !warnreset, !grouplock, !groupunlock' 
        });
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
        "Check VU announcements for updates."
      ];
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      await sock.sendMessage(chatId, { text: `💡 ${randomResponse}` });
    }

  } catch(e) { 
    console.warn('Message handling error:', e.message); 
  }
}

// Start the bot
startBot().catch(err => {
  console.error('Failed to start bot:', err);
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
        <p><strong>Mode:</strong> Baileys (No Browser)</p>
        <p><strong>Warnings stored:</strong> ${Object.keys(warnings).length}</p>
        <p>Scan QR code in logs to connect WhatsApp.</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ${BOT_NAME} server running on port ${PORT}`);
  console.log('📱 Using Baileys - No Chromium required!');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  saveWarnings();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down...');
  saveWarnings();
  process.exit(0);
});
