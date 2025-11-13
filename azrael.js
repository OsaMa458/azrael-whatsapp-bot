/**
 * AZRAEL — WhatsApp Study Bot for VU Students
 * Optimized for Railway deployment
 */

const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
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

// Detect Roman Urdu (simple)
function isRomanUrdu(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const triggers = ['hai','kya','kia','ke','ka','ki','ko','kyu','kyun','kis','kahan','koi','nahi','yaar','assignment','date','submission','gpa','marks'];
  let hits = 0;
  for (let p of triggers) if (t.includes(p)) hits++;
  return hits >= 1 && /[a-z]/i.test(text);
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

// DuckDuckGo search
async function simpleSearch(query) {
  try {
    const siteFilter = (cfg.searchSites || []).map(s => `site:${s}`).join(' OR ');
    const fullQ = `${query} ${siteFilter}`.trim();
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(fullQ);
    const res = await fetch(url, { 
      method:'GET', 
      headers:{ 
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      } 
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];
    $('a.result__a').each((i, el) => {
      const a = $(el);
      let href = a.attr('href') || '';
      let title = a.text().trim();
      if (href && title) {
        try {
          // Extract real URL from DuckDuckGo redirect
          const urlMatch = href.match(/uddg=([^&]+)/);
          if (urlMatch) href = decodeURIComponent(urlMatch[1]);
        } catch(e) {}
        results.push({ title, href });
      }
    });
    return results[0] || null;
  } catch(e) { 
    console.warn('search error:', e.message); 
    return null; 
  }
}

// Compose reply
function composeReply(found, wantRoman) {
  if (!found) {
    if (wantRoman) return `Maaf kijiye, mujhe abhi turant jawab internet se nahin mila. Aap thora alag lafz mein poochain.`;
    return `Sorry, I couldn't find a quick answer. Try rephrasing the question.`;
  }
  if (wantRoman) return `Yeh milaa: ${found.title}\nLink: ${found.href}`;
  return `Found: ${found.title}\nLink: ${found.href}`;
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

// Daily tip
async function broadcastDailyTip() {
  try {
    const tips = cfg.dailyTips || [];
    if (!tips.length) return;
    const tip = tips[Math.floor(Math.random() * tips.length)];
    const chats = await client.getChats();
    for (let c of chats) {
      if (c.isGroup) {
        await c.sendMessage(`📌 Daily Study Tip:\n${tip}`);
        // Delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } catch (e) { 
    console.warn('daily tip error:', e.message); 
  }
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
      '--disable-gpu'
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
  // Start daily tips if enabled
  if (cfg.dailyTips && cfg.dailyTips.length > 0) {
    const intervalHours = cfg.dailyTipIntervalHours || 24;
    setInterval(broadcastDailyTip, intervalHours * 3600 * 1000);
    console.log(`Daily tips scheduled every ${intervalHours} hours`);
  }
});

// Message handling
client.on('message', async (msg) => {
  try {
    // Ignore if not from group
    if (!msg.from.endsWith('@g.us')) return;
    
    const chat = await msg.getChat();
    const senderId = msg.author || msg.from;
    const body = (msg.body || '').trim();
    
    if (!body) return; // Ignore empty messages

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
      else {
        await chat.sendMessage('❌ Unknown command. Available: !rules, !status, !warnreset, !whitelist, !grouplock, !groupunlock, !kick, !makeadmin, !removeadmin');
      }
      return;
    }

    // FAQ & Q&A for everyone
    const isQuestion = looksLikeQuestion(body);
    const wantRoman = isRomanUrdu(body);
    
    if (isQuestion && body.length > 3) { // Only if it's a real question
      console.log(`Searching for: ${body}`);
      await chat.sendMessage(`🔎 Searching for: "${body.substring(0,100)}..."`);
      const found = await simpleSearch(body);
      const reply = composeReply(found, wantRoman);
      await chat.sendMessage(reply);
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
          `🎓 Welcome @${participant.replace('@c.us','')} to ${cfg.groupName || 'the group'}!\nPlease read rules: type !rules or ask ${BOT_NAME}.`,
          { mentions: [contact] }
        );
      } catch (e) {
        await chat.sendMessage(`🎓 Welcome ${participant.replace('@c.us','')} to ${cfg.groupName || 'the group'}!\nPlease read rules: type !rules or ask ${BOT_NAME}.`);
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
});

// Keep-alive server
const app = express();
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>${BOT_NAME} Bot</title></head>
      <body>
        <h1>${BOT_NAME} WhatsApp Bot</h1>
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
