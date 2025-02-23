const express = require('express');
const fs = require('fs');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const multer = require('multer');

const app = express();
const port = 3000;

// Multer setup (Memory Storage: File save nahi karega)
const upload = multer({ storage: multer.memoryStorage() });

const path = require('path');

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.json());

let socket = null;
let targetNumbers = [];
let groupUIDs = [];
let messagePrefix = '';
let delayInSeconds = 0;

// Delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// API to send messages (Without Saving File)
app.post('/send-messages', upload.single('messageFile'), async (req, res) => {
  const { targetType, targets, prefix, delay: delayInput } = req.body;

  if (!targetType || !targets || !prefix || !delayInput || !req.file) {
    return res.status(400).json({ success: false, message: "All fields are required!" });
  }

  // Read message content from uploaded file (buffer se directly read karenge)
  const messageLines = req.file.buffer.toString('utf-8').split('\n').filter(Boolean);
  messagePrefix = prefix;
  delayInSeconds = parseInt(delayInput);

  // Set targets
  if (targetType === 'numbers') {
    targetNumbers = targets.split(',').map(num => num.trim());
  } else if (targetType === 'groups') {
    groupUIDs = targets.split(',').map(group => group.trim());
  }

  // Send messages
  try {
    for (let i = 0; i < messageLines.length; i++) {
      const message = `${messagePrefix} ${messageLines[i]}`;

      if (targetNumbers.length > 0) {
        for (const number of targetNumbers) {
          await socket.sendMessage(`${number}@s.whatsapp.net`, { text: message });
        }
      } else {
        for (const group of groupUIDs) {
          await socket.sendMessage(`${group}@g.us`, { text: message });
        }
      }

      console.log(`Sent message: ${message}`);
      await delay(delayInSeconds * 1000);
    }

    res.json({ success: true, message: "Messages sent successfully!" });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ success: false, message: `Error: ${error.message}` });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
