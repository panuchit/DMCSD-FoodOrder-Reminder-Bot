// scheduled_bot.js - Thursday/Friday Food Order Reminder Bot
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const fs = require('fs').promises;
const https = require('https');

const app = express();

// Configuration
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || 'LMo3ZmLIU5D60k5+T7EuTAwx5+2nMSL6PjP0flNDUIh0mxB0ON9B7Q2Ict/e5iTVx9bqq7UvjIl1wq3cNXKyewbHxrXghxmkhCfPWR3sMBhTldPwtAoErB2SgEVlhILZhHGoDf6Es8rgzBguWEpc2QdB04t89/1O/w1cDnyilFU=',
  channelSecret: process.env.CHANNEL_SECRET || '0aa9d4d7cda0866949b910ffae506b53'
};

const client = new line.Client(config);

// Your Group ID (replace with the one you got!)
const GROUP_ID = 'C71b4a96977db997ae431e4c73720230f';

// Google Drive file ID for skip dates (extract from your Google Drive share URL)
const SKIP_DATES_FILE_ID = '1qomp6_zAamOxyx8hWPiIRb84RB2wQjk0';

// Local backup file for skip dates
const LOCAL_SKIP_FILE = 'skip_dates.txt';

// Cache for skip dates (to avoid frequent API calls)
let skipDatesCache = new Set();
let lastCacheUpdate = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Download skip dates from Google Drive
 */
async function downloadSkipDates() {
  return new Promise((resolve, reject) => {
    const url = `https://drive.google.com/uc?export=download&id=${SKIP_DATES_FILE_ID}`;
    
    https.get(url, (response) => {
      let data = '';
      
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        resolve(data);
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Load skip dates from Google Drive or local backup
 */
async function loadSkipDates() {
  try {
    console.log('📥 Loading skip dates from Google Drive...');
    
    // Try to download from Google Drive first
    const driveContent = await downloadSkipDates();
    
    // Save to local backup
    await fs.writeFile(LOCAL_SKIP_FILE, driveContent);
    console.log('💾 Skip dates saved to local backup');
    
    // Parse dates
    const dates = parseSkipDates(driveContent);
    skipDatesCache = new Set(dates);
    lastCacheUpdate = Date.now();
    
    console.log(`✅ Loaded ${dates.length} skip dates from Google Drive`);
    return dates;
    
  } catch (error) {
    console.log('⚠️ Failed to load from Google Drive, trying local backup...');
    console.error('Google Drive error:', error.message);
    
    try {
      // Fallback to local file
      const localContent = await fs.readFile(LOCAL_SKIP_FILE, 'utf8');
      const dates = parseSkipDates(localContent);
      skipDatesCache = new Set(dates);
      
      console.log(`📁 Loaded ${dates.length} skip dates from local backup`);
      return dates;
      
    } catch (localError) {
      console.log('⚠️ No local backup found, using empty skip list');
      
      // Create empty local file
      await fs.writeFile(LOCAL_SKIP_FILE, '# Skip dates format: YYYY-MM-DD (one per line)\n# Example:\n# 2024-12-25\n# 2024-01-01\n');
      
      return [];
    }
  }
}

/**
 * Parse skip dates from text content
 * Supports multiple formats: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY
 * Also supports date ranges with "range" or "Range" keyword
 */
function parseSkipDates(content) {
  const lines = content.split('\n');
  const dates = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }
    
    // Check if this is a date range
    if (trimmed.toLowerCase().startsWith('range')) {
      const rangeDates = parseRangeLine(trimmed);
      dates.push(...rangeDates);
      continue;
    }
    
    // Parse single date formats
    const dateString = parseSingleDate(trimmed);
    if (dateString) {
      dates.push(dateString);
    } else {
      console.log(`⚠️ Invalid date format ignored: ${trimmed}`);
    }
  }
  
  return dates;
}

/**
 * Parse a single date from various formats
 */
function parseSingleDate(trimmed) {
  // Format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  // Format: MM/DD/YYYY
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    const [month, day, year] = trimmed.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  // Format: DD/MM/YYYY (European style)
  else if (trimmed.includes('/') && trimmed.split('/')[2]?.length === 4) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      // Assume DD/MM/YYYY if day > 12
      const [first, second, year] = parts;
      if (parseInt(first) > 12) {
        return `${year}-${second.padStart(2, '0')}-${first.padStart(2, '0')}`;
      }
    }
  }
  return null;
}

/**
 * Parse a range line and return array of dates in the range
 * Supports formats:
 * - range 2024-12-20 to 2024-12-25
 * - Range 2024-12-20 - 2024-12-25  
 * - range 12/20/2024 to 12/25/2024
 * - Range 2024-12-20 through 2024-12-25
 */
function parseRangeLine(line) {
  const dates = [];
  
  // Remove "range" or "Range" from the beginning
  let rangePart = line.replace(/^range\s+/i, '').trim();
  
  // Split by different separators
  let startDateStr = '';
  let endDateStr = '';
  
  if (rangePart.includes(' to ')) {
    [startDateStr, endDateStr] = rangePart.split(' to ').map(s => s.trim());
  } else if (rangePart.includes(' - ')) {
    [startDateStr, endDateStr] = rangePart.split(' - ').map(s => s.trim());
  } else if (rangePart.includes(' through ')) {
    [startDateStr, endDateStr] = rangePart.split(' through ').map(s => s.trim());
  } else {
    console.log(`⚠️ Invalid range format: ${line}`);
    return dates;
  }
  
  // Parse start and end dates
  const startDate = parseSingleDate(startDateStr);
  const endDate = parseSingleDate(endDateStr);
  
  if (!startDate || !endDate) {
    console.log(`⚠️ Invalid date in range: ${line}`);
    return dates;
  }
  
  // Generate all dates in the range
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (start > end) {
    console.log(`⚠️ Start date is after end date in range: ${line}`);
    return dates;
  }
  
  const current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0]; // YYYY-MM-DD format
    dates.push(dateStr);
    current.setDate(current.getDate() + 1);
  }
  
  console.log(`📅 Range processed: ${startDate} to ${endDate} (${dates.length} days)`);
  return dates;
}

/**
 * Check if today should be skipped
 */
async function shouldSkipToday() {
  const now = Date.now();
  
  // Update cache if needed
  if (now - lastCacheUpdate > CACHE_DURATION) {
    await loadSkipDates();
  }
  
  // Get today's date in LA timezone
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles'
  }); // Returns YYYY-MM-DD format
  
  const shouldSkip = skipDatesCache.has(today);
  
  if (shouldSkip) {
    console.log(`⏭️ Skipping message today (${today}) - date found in skip list`);
  }
  
  return shouldSkip;
}

/**
 * Send food order reminder message
 */
async function sendFoodOrderReminder() {
  try {
    // Check if we should skip today
    const skip = await shouldSkipToday();
    if (skip) {
      return;
    }
    
    const message = `สั่งอาหารจากร้านคุณแซม จากเมนู https://drive.google.com/file/u/0/d/17xXK5ReUxlbxtryTTpBtgaFnZSRJBsrs/view สำหรับมื้อเพลวันพรุ่งนี้ ภายในวันนี้ครับ`;
    
    const result = await client.pushMessage(GROUP_ID, {
      type: 'text',
      text: message
    });
    
    const today = new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    console.log('✅ Food order reminder sent successfully!');
    console.log('📅 LA Time:', today);
    console.log('📱 Message sent to group:', GROUP_ID);
    
    return result;
    
  } catch (error) {
    console.error('❌ Error sending food order reminder:', error.message);
  }
}

// Schedule Thursday 3 PM (LA Time)
cron.schedule('0 15 * * 4', () => {
  console.log('🍽️ Thursday 3 PM - Sending food order reminder...');
  sendFoodOrderReminder();
}, {
  timezone: "America/Los_Angeles"
});

// Schedule Friday 3 PM (LA Time)
cron.schedule('0 15 * * 5', () => {
  console.log('🍽️ Friday 3 PM - Sending food order reminder...');
  sendFoodOrderReminder();
}, {
  timezone: "America/Los_Angeles"
});

// Add this TEMPORARY test schedule (in addition to existing ones)
cron.schedule('30 17 * * *', () => {  // 6 PM every day
  console.log('🧪 TEST - 17:30 PM - Sending food order reminder...');
  sendFoodOrderReminder();
}, {
  timezone: "America/Los_Angeles"
});

// Manual test function
async function sendTestMessage() {
  console.log('🧪 Sending test food order reminder...');
  
  const skip = await shouldSkipToday();
  
  const testMessage = `🧪 **TEST MESSAGE**

${skip ? '⏭️ (Would be skipped today due to skip list)' : '✅ (Would be sent normally)'}

สั่งอาหารจากร้านคุณแซม จากเมนู https://drive.google.com/file/u/0/d/17xXK5ReUxlbxtryTTpBtgaFnZSRJBsrs/view สำหรับมื้อเพลวันพรุ่งนี้ ภายในวันนี้ครับ

📅 Scheduled for: Thursday & Friday 3 PM (LA Time)
🎯 Group ID: ${GROUP_ID}
📁 Skip dates loaded: ${skipDatesCache.size} dates`;
  
  await client.pushMessage(GROUP_ID, {
    type: 'text',
    text: testMessage
  });
}

// Webhook endpoint (optional)
app.use('/webhook', line.middleware(config), (req, res) => {
  console.log('📨 Webhook received');
  req.body.events.forEach(event => {
    if (event.type === 'message') {
      const text = event.message.text?.toLowerCase();
      if (text === 'test food' || text === 'test bot') {
        sendTestMessage();
      } else if (text === 'reload skip dates') {
        loadSkipDates().then(() => {
          client.replyMessage(event.replyToken, {
            type: 'text',
            text: `🔄 Skip dates reloaded!\n📊 Total skip dates: ${skipDatesCache.size}`
          });
        });
      } else if (text === 'show skip dates') {
        const dates = Array.from(skipDatesCache).sort().slice(0, 20);
        const message = dates.length > 0 
          ? `📅 Skip dates:\n${dates.join('\n')}${skipDatesCache.size > 20 ? `\n... and ${skipDatesCache.size - 20} more` : ''}`
          : '📅 No skip dates configured';
        
        client.replyMessage(event.replyToken, {
          type: 'text',
          text: message
        });
      }
    }
  });
  res.status(200).end();
});

// Admin endpoints
app.get('/skip-dates', async (req, res) => {
  await loadSkipDates();
  const dates = Array.from(skipDatesCache).sort();
  res.json({
    skipDates: dates,
    count: dates.length,
    lastUpdate: new Date(lastCacheUpdate).toISOString()
  });
});

app.get('/test', (req, res) => {
  sendTestMessage();
  res.send('Test food order reminder sent! Check your LINE group.');
});

// Health check endpoint
app.get('/health', (req, res) => {
  const laTime = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  
  res.json({ 
    status: 'Food Order Bot is running',
    time: new Date().toISOString(),
    laTime: laTime,
    groupId: GROUP_ID,
    schedules: [
      'Thursday 3:00 PM (LA Time) - Food order reminder',
      'Friday 3:00 PM (LA Time) - Food order reminder'
    ],
    skipDatesCount: skipDatesCache.size,
    lastSkipDatesUpdate: lastCacheUpdate ? new Date(lastCacheUpdate).toISOString() : 'Not loaded'
  });
});

// Status page
app.get('/', (req, res) => {
  const laTime = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  
  res.send(`
    <h1>🍽️ LINE Food Order Reminder Bot</h1>
    <h2>Status: Running ✅</h2>
    
    <h3>📅 Schedule:</h3>
    <ul>
      <li><strong>Thursday 3:00 PM (LA Time)</strong> - Food order reminder</li>
      <li><strong>Friday 3:00 PM (LA Time)</strong> - Food order reminder</li>
    </ul>
    
    <h3>🕒 Current Time:</h3>
    <p><strong>LA Time:</strong> ${laTime}</p>
    
    <h3>🎯 Configuration:</h3>
    <p><strong>Group ID:</strong> <code>${GROUP_ID}</code></p>
    <p><strong>Skip Dates:</strong> ${skipDatesCache.size} dates loaded</p>
    
    <h3>🧪 Testing:</h3>
    <ul>
      <li><a href="/test">Send test message</a></li>
      <li><a href="/skip-dates">View skip dates (JSON)</a></li>
      <li>Send "test food" in LINE group</li>
      <li>Send "show skip dates" in LINE group</li>
      <li>Send "reload skip dates" in LINE group</li>
    </ul>
    
    <h3>⚙️ Admin Commands (in LINE group):</h3>
    <ul>
      <li><code>test food</code> - Send test message</li>
      <li><code>show skip dates</code> - Show configured skip dates</li>
      <li><code>reload skip dates</code> - Reload skip dates from Google Drive</li>
    </ul>
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log('🚀 LINE Food Order Reminder Bot Started!');
  console.log('📍 Server running on port:', port);
  console.log('🎯 Target Group ID:', GROUP_ID);
  
  const laTime = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  console.log('🕒 Current LA Time:', laTime);
  
  console.log('\n📅 Scheduled Messages:');
  console.log('   🍽️ Thursday 3:00 PM (LA Time) - Food order reminder');
  console.log('   🍽️ Friday 3:00 PM (LA Time) - Food order reminder');
  
  console.log('\n🧪 Test options:');
  console.log('   • Visit http://localhost:' + port + '/test');
  console.log('   • Send "test food" message in LINE group');
  console.log('   • Send "show skip dates" in LINE group');
  
  // Load skip dates on startup
  console.log('\n📥 Loading skip dates...');
  await loadSkipDates();
  
  console.log('\n🔍 Bot is waiting for scheduled times...');
});

// Load skip dates on startup
loadSkipDates();