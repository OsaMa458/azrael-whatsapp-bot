/**
 * AZRAEL — WhatsApp Study Bot for VU Students
 * FIXED VERSION - No node-fetch dependency
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
  console.warn('Could not load warnings file'); 
}

function saveWarnings(){ 
  try {
    fs.writeFileSync(WARN_FILE, JSON.stringify(warnings, null, 2));
  } catch(e) {
    console.warn('Could not save warnings');
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

// Detect Roman Urdu
function isRomanUrdu(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const triggers = ['hai','kya','kia','ke','ka','ki','ko','kyu','kyun','kis','kahan','koi','nahi','yaar','assignment','date','submission','gpa','marks'];
  let hits = 0;
  for (let p of triggers) if (t.includes(p)) hits++;
  return hits >= 1 && /[a-z]/i.test(text);
}

// Question detection
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

// SIMPLIFIED SEARCH - No external dependencies
async function simpleSearch(query) {
  try {
    // Pre-defined responses for common VU questions
    const responses = {
      'assignment': '📝 Assignments are usually due on Sundays. Check VU LMS for exact deadlines.',
      'gpa': '📊 GPA is calculated based on your course grades. Minimum 2.0 GPA required to pass.',
      'quiz': '🧠 Quizzes are available on VU LMS. You have 3 attempts for each quiz.',
      'lms': '🌐 VU LMS: https://lms.vu.edu.pk - Use your VU credentials to login.',
      'vulms': '🌐 VU LMS: https://lms.vu.edu.pk - Use your VU credentials to login.',
      'result': '📈 Check your results at: https://vu.edu.pk/Results/',
      'grade': '🎯 Grades are updated on VU LMS after assignment/quiz evaluation.',
      'submission': '📤 Submit assignments through VU LMS before the deadline.',
      'deadline': '⏰ Assignment deadlines are on Sundays at 11:59 PM.',
      'fee': '💵 Fee details: https://vu.edu.pk/Fee/ - Check with your campus for exact amounts.',
      'enrollment': '🎓 Enrollment process: https://vu.edu.pk/Admissions/'
    };

    const lowerQuery = query.toLowerCase();
    
    // Find matching response
    for (const [key, response] of Object.entries(responses)) {
      if (lowerQuery.includes(key)) {
        return { title: `VU ${key.charAt(0).toUpperCase() + key.slice(1)} Information`, href: response };
      }
    }

    // Default responses based on question type
    if (lowerQuery.includes('when') || lowerQuery.includes('kab')) {
      return { 
        title: 'Check VU LMS for specific dates and deadlines', 
        href: 'https://lms.vu.edu.pk' 
      };
    }
    if (lowerQuery.includes('how') || lowerQuery.includes('kaise')) {
      return { 
        title: 'Step-by-step guide available on VU LMS help section', 
        href: 'https://lms.vu.edu.pk/help' 
      };
    }
    if (lowerQuery.includes('where') || lowerQuery.includes('kahan')) {
      return { 
        title: 'All study resources are available on VU LMS portal', 
        href: 'https://lms.vu.edu.pk' 
      };
    }

    // General study advice
    const studyTips = [
      'Check VU LMS regularly for updates and announcements',
      'Contact your course instructor for specific queries',
      'Join VU student groups for peer support',
      'Refer to course handouts and recommended books',
      'Practice past papers for better preparation'
    ];

    return {
      title: studyTips[Math.floor(Math.random() * studyTips.length)],
      href: 'https://lms.vu.edu.pk'
    };

  } catch(e) { 
    console.warn('Search error:', e.message); 
    return null; 
  }
}

// Compose reply
function composeReply(found, wantRoman) {
  if (!found) {
    if (wantRoman) return `Maaf kijiye, mujhe abhi turant jawab internet se nahin mila. Aap thora alag lafz mein poochain.`;
    return `Sorry, I couldn't find a quick answer. Try rephrasing the question.`;
  }
  if (wantRoman) return `Yeh milaa: ${found.title}\n${found.href}`;
  return `Found: ${found.title}\n${found.href}`;
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
    await chat.sendMessage(`🚫 User ${participantId.replace('@c.us','')} reached warning limit. Consider action.`);
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

// Daily tips
async function broadcastDailyTip() {
  try {
    const tips = cfg.dailyTips || [];
    if (!tips.length) return;
    const tip = tips[Math.floor(Math.random() * tips.length)];
    const chats = await client.getChats();
    for (let c of chats) {
      if (c.isGroup) {
        await c.sendMessage(`📌 Daily Study Tip:\n${tip}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (e) { 
    console.warn('Daily tip error:', e.message); 
  }
}

// Client configuration
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
  console.log('📱 SCAN THIS QR CODE WITH WHATSAPP:');
  qrcode.generate(qr, { small: true });
});

// Ready
client.on('ready', () => {
  console.log(`✅ ${BOT_NAME} is ready and online!`);
  
  // Start daily tips
  if (cfg.dailyTips && cfg.dailyTips.length > 0) {
    const intervalHours = cfg.dailyTipIntervalHours || 24;
    setInterval(broadcastDailyTip, intervalHours * 3600 * 1000);
    console.log(`Daily tips scheduled every ${intervalHours} hours`);
  }
});

// Message handling
client.on('message', async (msg) => {
  try {
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

    // Quiet hours
    if (cfg.quietHours?.enabled && !whitelisted && senderId !== OWNER) {
      const hour = getKarachiHour();
      const start = cfg.quietHours.startHourKarachi;
      const end = cfg.quietHours.endHourKarachi;
      const inQuiet = (start <= end) ? (hour >= start && hour < end) : (hour >= start || hour < end);
      
      if (inQuiet) {
        await chat.sendMessage(cfg.quietHours.reminderMessage || '🔕 Quiet hours active.');
        return;
      }
    }

    // Check links, stickers, media
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
        await chat.sendMessage(`✅ ${BOT_NAME} is online. Warnings: ${Object.keys(warnings).length}`);
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
      else if (cmd === '!kick' && parts[1]) {
        try {
          await chat.removeParticipants([normNumber(parts[1])]);
          await chat.sendMessage(`✅ ${parts[1]} has been kicked.`);
        } catch(e) {
          await chat.sendMessage('❌ Could not kick member. Need admin rights.');
        }
      }
      else if (cmd === '!makeadmin' && parts[1]) {
        try {
          await chat.promoteParticipants([normNumber(parts[1])]);
          await chat.sendMessage(`✅ ${parts[1]} is now admin.`);
        } catch(e) {
          await chat.sendMessage('❌ Could not promote member. Need admin rights.');
        }
      }
      else if (cmd === '!removeadmin' && parts[1]) {
        try {
          await chat.demoteParticipants([normNumber(parts[1])]);
          await chat.sendMessage(`✅ ${parts[1]} admin rights removed.');
        } catch(e) {
          await chat.sendMessage('❌ Could not demote member. Need admin rights.');
        }
      }
      else {
        await chat.sendMessage('❌ Unknown command.');
      }
      return;
    }

    // FAQ & Q&A
    const isQuestion = looksLikeQuestion(body);
    const wantRoman = isRomanUrdu(body);
    
    if (isQuestion && body.length > 3) {
      await chat.sendMessage(`🔎 Searching for: "${body.substring(0,100)}..."`);
      const found = await simpleSearch(body);
      const reply = composeReply(found, wantRoman);
      await chat.sendMessage(reply);
    }

  } catch(e) { 
    console.warn('Message error:', e.message); 
  }
});

// Group events
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
    if (notification.recipientIds) {
      for (let participant of notification.recipientIds) {
        await chat.sendMessage(`👋 Goodbye @${participant.replace('@c.us','')}`);
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
        <p><strong>Features:</strong> All features active</p>
        <p>Scan QR code in logs to connect WhatsApp.</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ${BOT_NAME} server running on port ${PORT}`);
  console.log('📱 SCAN THE QR CODE BELOW:');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down...');
  saveWarnings();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  saveWarnings();
  client.destroy();
  process.exit(0);
});

// Initialize
client.initialize();
