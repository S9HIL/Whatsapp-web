const express = require('express');
const fs = require('fs');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const port = 3000;

// Multer setup for file upload
const upload = multer({ dest: 'uploads/' });

// Serve static files (HTML, CSS, JS)
app.use(express.static('public'));
app.use(express.json());

let socket = null;
let messageProcesses = {}; // Store message processes by batch ID

// Delay function to wait for specified milliseconds
const delay = (ms, isStopped) => {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (isStopped()) {
        clearInterval(interval);
        resolve(true); // Stop the delay if process is stopped
      }
    }, 100);
    setTimeout(() => {
      clearInterval(interval);
      resolve(false); // Continue the delay
    }, ms);
  });
};

// Initialize WhatsApp connection
async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  socket = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: state,
  });

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("WhatsApp connected successfully!");
    }

    if (connection === "close" && lastDisconnect?.error) {
      console.log("Connection closed. Reconnecting...");
      setTimeout(initWhatsApp, 5000);
    }
  });

  socket.ev.on("creds.update", saveCreds);
}

// Start WhatsApp connection
initWhatsApp();

// API to request pairing code
app.post('/request-pairing-code', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: "Phone number is required!" });
  }

  try {
    const pairingCode = await socket.requestPairingCode(phoneNumber);
    res.json({ success: true, pairingCode });
  } catch (error) {
    res.status(500).json({ success: false, message: `Error: ${error.message}` });
  }
});

// API to send messages
app.post('/send-messages', upload.single('messageFile'), async (req, res) => {
  const { targetType, targets, prefix, delay: delayInput } = req.body;

  // Validate inputs
  if (!targetType || !targets || !prefix || !delayInput || !req.file) {
    return res.status(400).json({ success: false, message: "All fields are required!" });
  }

  // Generate a unique batch ID
  const batchId = uuidv4();

  // Read message file
  const messageLines = fs.readFileSync(req.file.path, 'utf-8').split('\n').filter(Boolean);
  const messagePrefix = prefix;
  const delayInSeconds = parseInt(delayInput);

  // Set targets
  const targetNumbers = targetType === 'numbers' ? targets.split(',').map(num => num.trim()) : [];
  const groupUIDs = targetType === 'groups' ? targets.split(',').map(group => group.trim()) : [];

  // Store the message process
  messageProcesses[batchId] = {
    targetNumbers,
    groupUIDs,
    messageLines,
    messagePrefix,
    delayInSeconds,
    isStopped: false,
  };

  // Send messages in the background
  sendMessages(batchId);

  res.json({ success: true, batchId });
});

// Function to send messages
async function sendMessages(batchId) {
  const process = messageProcesses[batchId];
  if (!process) return;

  for (let i = 0; i < process.messageLines.length; i++) {
    if (process.isStopped) break;

    const message = `${process.messagePrefix} ${process.messageLines[i]}`;

    if (process.targetNumbers.length > 0) {
      for (const number of process.targetNumbers) {
        await socket.sendMessage(`${number}@s.whatsapp.net`, { text: message });
      }
    } else {
      for (const group of process.groupUIDs) {
        await socket.sendMessage(`${group}@g.us`, { text: message });
      }
    }

    console.log(`Sent message: ${message}`);
    const isStopped = await delay(process.delayInSeconds * 1000, () => process.isStopped);
    if (isStopped) break;
  }
}

// API to stop messages
app.post('/stop-messages', async (req, res) => {
  const { batchId } = req.body;

  if (!batchId || !messageProcesses[batchId]) {
    return res.status(400).json({ success: false, message: "Invalid batch ID!" });
  }

  messageProcesses[batchId].isStopped = true;
  res.json({ success: true });
});

// API to restart messages
app.post('/restart-messages', async (req, res) => {
  const { batchId } = req.body;

  if (!batchId || !messageProcesses[batchId]) {
    return res.status(400).json({ success: false, message: "Invalid batch ID!" });
  }

  messageProcesses[batchId].isStopped = false;
  sendMessages(batchId);
  res.json({ success: true });
});

// Route to track messages
app.get('/track-messages', (req, res) => {
  const { batchId } = req.query;

  if (!batchId || !messageProcesses[batchId]) {
    return res.status(400).send("Invalid batch ID!");
  }

  // Render the messages.html page with the batch ID
  res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

// Route for Server-Sent Events (SSE)
app.get('/message-events', (req, res) => {
  const { batchId } = req.query;

  if (!batchId || !messageProcesses[batchId]) {
    return res.status(400).send("Invalid batch ID!");
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const process = messageProcesses[batchId];

  // Function to send messages as events
  const sendMessageEvent = (message) => {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  // Simulate sending messages
  let index = 0;
  const sendNextMessage = () => {
    if (index >= process.messageLines.length || process.isStopped) {
      res.end();
      return;
    }

    const message = {
      time: new Date().toLocaleTimeString(),
      from: 'You',
      to: process.targetNumbers.join(', ') || process.groupUIDs.join(', '),
      text: `${process.messagePrefix} ${process.messageLines[index]}`,
    };

    sendMessageEvent(message);
    index++;

    setTimeout(sendNextMessage, process.delayInSeconds * 1000);
  };

  sendNextMessage();
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
