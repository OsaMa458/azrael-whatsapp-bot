/**
 * AZRAEL — WhatsApp Group Management Bot
 * Optimized for Railway deployment
 */

const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// Load config
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

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
  console.warn('load warns err', e && e.message); 
}

function saveWarnings(){ 
  fs.writeFileSync(WARN_FILE, JSON.stringify(warnings, null, 2)); 
}

// Logging
function logEvent(text) {
  if (!cfg.logging || !cfg.logging.enabled) return;
  const line = `[${new Date().toISOString()}] ${text}\n`;
  fs.appendFileSync(cfg.logging.file || 'moderation_log.txt', line);
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
    await chat.sendMessage(`🚫 User ${participantId.replace('@c.us','')} reached warning limit. Consider taking action.`);
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

// Client configuration for Railway
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './sessions'
  }),
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
  console.log(`${BOT_NAME} is ready and online!`);
});

// Message handling - GROUP MANAGEMENT ONLY
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
    if (cfg.floodControl?.enabled) {
      const count = recordMessageForFlood(senderId);
      if (count > (cfg.floodControl.maxMessagesPerWindow || 6)) {
        await chat.sendMessage('⚠️ Please avoid spamming.');
        await addWarning(chat, senderId, 'Flooding messages');
        return;
      }
    }

    // Quiet hours
    if (cfg.quietHours?.enabled && !whitelisted && senderId !== OWNER) {
      const hour = getKarachiHour();
      const start = cfg.quietHours.startHourKarachi;
      const end = cfg.quietHours.endHourKarachi;
      const inQuiet = (start <= end) ? (hour >= start && hour < end) : (hour >= start || hour < end);
      
      if (inQuiet) {
        await chat.sendMessage(cfg.quietHours.reminderMessage || '🔕 Quiet hours active. Please avoid sending messages.');
        return;
      }
    }

    // Check for links, stickers, media
    const hasLink = /(https?:\/\/|www\.)/i.test(body);
    const isSticker = msg.type === 'sticker';
    const hasMedia = msg.hasMedia && ['image','video','document','audio'].includes(msg.type);

    if (!whitelisted && senderId !== OWNER) {
      if (cfg.instantWarnOnLink && hasLink) {
        await addWarning(chat, senderId, 'Shared link');
        return;
      }
      if (cfg.instantWarnOnSticker && isSticker) {
        await addWarning(chat, senderId, 'Sent sticker');
        return;
      }
      if (cfg.instantWarnOnMedia && hasMedia) {
        await addWarning(chat, senderId, 'Shared media');
        return;
      }
    }

    // Owner commands
    if (body.startsWith('!') && senderId === OWNER) {
      const parts = body.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === '!rules') {
        await chat.sendMessage(cfg.groupRulesText);
      }
      else if (cmd === '!status') {
        await chat.sendMessage(`${BOT_NAME} is online. Warnings stored: ${Object.keys(warnings).length}`);
      }
      else if (cmd === '!warnreset') {
        warnings = {}; 
        saveWarnings(); 
        await chat.sendMessage('✅ All warnings cleared.');
      }
      else if (cmd === '!whitelist' && parts[1]) {
        const sub = parts[1].toLowerCase();
        if (sub === 'add' && parts[2]) {
          const num = normNumber(parts[2]);
          if (!cfg.whitelist.includes(num)) {
            cfg.whitelist.push(num);
            fs.writeFileSync('./config.json', JSON.stringify(cfg, null, 2));
            await chat.sendMessage(`✅ ${num.replace('@c.us','')} added to whitelist.`);
          } else {
            await chat.sendMessage(`ℹ️ ${num.replace('@c.us','')} is already in whitelist.`);
          }
        } else if (sub === 'remove' && parts[2]) {
          const num = normNumber(parts[2]);
          cfg.whitelist = cfg.whitelist.filter(w => w !== num);
          fs.writeFileSync('./config.json', JSON.stringify(cfg, null, 2));
          await chat.sendMessage(`✅ ${num.replace('@c.us','')} removed from whitelist.`);
        } else if (sub === 'list') {
          const list = (cfg.whitelist || []).map(x => x.replace('@c.us','')).join('\n') || 'No users in whitelist';
          await chat.sendMessage(`📋 Whitelist users:\n${list}`);
        } else {
          await chat.sendMessage('Usage: !whitelist add/remove/list <number>');
        }
      }
      else if (cmd === '!grouplock') {
        await chat.setMessagesAdminsOnly(true);
        await chat.sendMessage('✅ Group locked — only admins can send messages.');
      }
      else if (cmd === '!groupunlock') {
        await chat.setMessagesAdminsOnly(false);
        await chat.sendMessage('✅ Group unlocked — everyone can send messages.');
      }
      else if (cmd === '!kick' && parts[1]) {
        try {
          await chat.removeParticipants([normNumber(parts[1])]);
          await chat.sendMessage(`✅ ${parts[1]} has been kicked.`);
        } catch(e) {
          await chat.sendMessage('❌ Could not kick member. Make sure I have admin rights.');
        }
      }
      else if (cmd === '!ban' && parts[1]) {
        try {
          await chat.removeParticipants([normNumber(parts[1])]);
          await chat.sendMessage(`✅ ${parts[1]} has been banned.`);
        } catch(e) {
          await chat.sendMessage('❌ Could not ban member. Make sure I have admin rights.');
        }
      }
      else if (cmd === '!makeadmin' && parts[1]) {
        try {
          await chat.promoteParticipants([normNumber(parts[1])]);
          await chat.sendMessage(`✅ ${parts[1]} is now admin.`);
        } catch(e) {
          await chat.sendMessage('❌ Could not promote member. Make sure I have admin rights.');
        }
      }
      else if (cmd === '!removeadmin' && parts[1]) {
        try {
          await chat.demoteParticipants([normNumber(parts[1])]);
          await chat.sendMessage(`✅ ${parts[1]} admin rights removed.`);
        } catch(e) {
          await chat.sendMessage('❌ Could not demote member. Make sure I have admin rights.');
        }
      }
      else if (cmd === '!warn' && parts[1]) {
        const target = normNumber(parts[1]);
        const reason = parts.slice(2).join(' ') || 'No reason provided';
        await addWarning(chat, target, reason);
      }
      else {
        await chat.sendMessage('❌ Unknown command. Available: !rules, !status, !warnreset, !whitelist, !grouplock, !groupunlock, !kick, !ban, !makeadmin, !removeadmin, !warn');
      }
      return;
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
      try {
        const contact = await client.getContactById(participant);
        await chat.sendMessage(
          `🎓 Welcome @${participant.replace('@c.us','')} to ${cfg.groupName || 'the group'}!\nPlease read rules: type !rules`,
          { mentions: [contact] }
        );
      } catch (e) {
        await chat.sendMessage(`🎓 Welcome ${participant.replace('@c.us','')} to ${cfg.groupName || 'the group'}!\nPlease read rules: type !rules`);
      }
    }
  } catch(e) {
    console.warn('Group join error:', e.message);
  }
});

client.on('group_leave', async (notification) => {
  try {
    const chat = await client.getChatById(notification.chatId);
    if (notification.recipientIds && notification.recipientIds.length > 0) {
      for (let participant of notification.recipientIds) {
        await chat.sendMessage(`👋 Goodbye @${participant.replace('@c.us','')}`);
      }
    }
  } catch(e) {
    console.warn('Group leave error:', e.message);
  }
});

// Error handling
client.on('auth_failure', () => {
  console.log('Authentication failed. Please restart the bot.');
});

client.on('disconnected', (reason) => {
  console.log('Client was logged out:', reason);
  // Auto-restart after 5 seconds
  setTimeout(() => {
    console.log('Attempting to restart...');
    client.initialize();
  }, 5000);
});

// Keep-alive server
const app = express();
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>${BOT_NAME} Group Bot</title></head>
      <body>
        <h1>${BOT_NAME} WhatsApp Group Management Bot</h1>
        <p>Status: Running</p>
        <p>Warnings stored: ${Object.keys(warnings).length}</p>
        <p>Scan the QR code in logs to connect.</p>
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
  console.log('Shutting down...');
  saveWarnings();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  saveWarnings();
  client.destroy();
  process.exit(0);
});

// Initialize client
client.initialize();
