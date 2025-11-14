/**
 * AZRAEL — WhatsApp Group Management Bot with Baileys
 * Optimized for Railway deployment
 */

const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { Boom } = require('@hapi/boom');

// Load config
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Helpers
function normNumber(n) {
  let s = ('' + n).replace(/\D/g,'');
  if (s.length === 10 && s.startsWith('03')) s = '92' + s.slice(1);
  return s + '@s.whatsapp.net';
}

const OWNER = normNumber(cfg.owner);
const BOT_NAME = cfg.botName || 'AZRAEL-GROUP';
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
async function addWarning(chatId, participantId, reason) {
  if (!warnings[participantId]) warnings[participantId] = { count: 0, lastReason: '' };
  warnings[participantId].count += 1;
  warnings[participantId].lastReason = reason;
  saveWarnings();
  const cnt = warnings[participantId].count;
  
  await sock.sendMessage(chatId, {
    text: `⚠️ Warning ${cnt}/${cfg.warnLimit} — @${participantId.replace('@s.whatsapp.net','')}\nReason: ${reason}`,
    mentions: [participantId]
  });
  
  logEvent(`WARN ${participantId} (${cnt}): ${reason}`);
  if (cnt >= (cfg.warnLimit || 3)) {
    await sock.sendMessage(chatId, {
      text: `🚫 User ${participantId.replace('@s.whatsapp.net','')} reached warning limit. Consider taking action.`
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
  return new Date().getUTCHours() + 5;
}

let sock;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();
  
  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, {}),
    },
    printQRInTerminal: false,
    logger: { level: 'silent' }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('QR Code received, scan it!');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log(`${BOT_NAME} is ready and online!`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Message handling
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    try {
      // Check if message is from group
      const chatId = msg.key.remoteJid;
      if (!chatId.endsWith('@g.us')) return;

      const body = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   msg.message.imageMessage?.caption || '';

      if (!body.trim()) return;

      const senderId = msg.key.participant || msg.key.remoteJid;
      const whitelisted = (cfg.whitelist || []).includes(senderId);

      // Flood control
      if (cfg.floodControl?.enabled) {
        const count = recordMessageForFlood(senderId);
        if (count > (cfg.floodControl.maxMessagesPerWindow || 6)) {
          await sock.sendMessage(chatId, { text: '⚠️ Please avoid spamming.' });
          await addWarning(chatId, senderId, 'Flooding messages');
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
          await sock.sendMessage(chatId, { 
            text: cfg.quietHours.reminderMessage || '🔕 Quiet hours active. Please avoid sending messages.' 
          });
          return;
        }
      }

      // Check for links
      const hasLink = /(https?:\/\/|www\.)/i.test(body);
      const isSticker = !!msg.message.stickerMessage;
      const hasMedia = !!msg.message.imageMessage || !!msg.message.videoMessage || 
                       !!msg.message.documentMessage || !!msg.message.audioMessage;

      if (!whitelisted && senderId !== OWNER) {
        if (cfg.instantWarnOnLink && hasLink) {
          await addWarning(chatId, senderId, 'Shared link');
          return;
        }
        if (cfg.instantWarnOnSticker && isSticker) {
          await addWarning(chatId, senderId, 'Sent sticker');
          return;
        }
        if (cfg.instantWarnOnMedia && hasMedia) {
          await addWarning(chatId, senderId, 'Shared media');
          return;
        }
      }

      // Owner commands
      if (body.startsWith('!') && senderId === OWNER) {
        const parts = body.split(/\s+/);
        const cmd = parts[0].toLowerCase();

        if (cmd === '!rules') {
          await sock.sendMessage(chatId, { text: cfg.groupRulesText });
        }
        else if (cmd === '!status') {
          await sock.sendMessage(chatId, { 
            text: `${BOT_NAME} is online. Warnings stored: ${Object.keys(warnings).length}` 
          });
        }
        else if (cmd === '!warnreset') {
          warnings = {}; 
          saveWarnings(); 
          await sock.sendMessage(chatId, { text: '✅ All warnings cleared.' });
        }
        else if (cmd === '!whitelist' && parts[1]) {
          const sub = parts[1].toLowerCase();
          if (sub === 'add' && parts[2]) {
            const num = normNumber(parts[2]);
            if (!cfg.whitelist.includes(num)) {
              cfg.whitelist.push(num);
              fs.writeFileSync('./config.json', JSON.stringify(cfg, null, 2));
              await sock.sendMessage(chatId, { 
                text: `✅ ${num.replace('@s.whatsapp.net','')} added to whitelist.` 
              });
            } else {
              await sock.sendMessage(chatId, { 
                text: `ℹ️ ${num.replace('@s.whatsapp.net','')} is already in whitelist.` 
              });
            }
          } else if (sub === 'remove' && parts[2]) {
            const num = normNumber(parts[2]);
            cfg.whitelist = cfg.whitelist.filter(w => w !== num);
            fs.writeFileSync('./config.json', JSON.stringify(cfg, null, 2));
            await sock.sendMessage(chatId, { 
              text: `✅ ${num.replace('@s.whatsapp.net','')} removed from whitelist.` 
            });
          } else if (sub === 'list') {
            const list = (cfg.whitelist || []).map(x => x.replace('@s.whatsapp.net','')).join('\n') || 'No users in whitelist';
            await sock.sendMessage(chatId, { text: `📋 Whitelist users:\n${list}` });
          } else {
            await sock.sendMessage(chatId, { text: 'Usage: !whitelist add/remove/list <number>' });
          }
        }
        else if (cmd === '!warn' && parts[1]) {
          const target = normNumber(parts[1]);
          const reason = parts.slice(2).join(' ') || 'No reason provided';
          await addWarning(chatId, target, reason);
        }
        else {
          await sock.sendMessage(chatId, { 
            text: '❌ Unknown command. Available: !rules, !status, !warnreset, !whitelist, !warn' 
          });
        }
        return;
      }

    } catch(e) { 
      console.warn('Message handling error:', e.message); 
    }
  });

  // Group participants update
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id, participants, action } = update;
      
      if (action === 'add') {
        for (let participant of participants) {
          await sock.sendMessage(id, {
            text: `🎓 Welcome @${participant.replace('@s.whatsapp.net','')} to ${cfg.groupName || 'the group'}!\nPlease read rules: type !rules`,
            mentions: [participant]
          });
        }
      } else if (action === 'remove') {
        for (let participant of participants) {
          await sock.sendMessage(id, {
            text: `👋 Goodbye @${participant.replace('@s.whatsapp.net','')}`,
            mentions: [participant]
          });
        }
      }
    } catch(e) {
      console.warn('Group participants update error:', e.message);
    }
  });
}

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
  connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  saveWarnings();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  saveWarnings();
  process.exit(0);
});
